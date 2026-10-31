/**
 * scripts/sync-local-history-to-neon.ts
 *
 * Backfills Neon Postgres with verified historical telemetry recorded on the
 * physical Jetson testbed from /tmp/zodiac-history-sync (or /var/lib/zodiac/history).
 *
 * Council Invariants Enforced:
 * - Integer Accounting (Invariant 2): BigInt precision for all counters, bytes and nanoseconds.
 * - Epistemic Provenance (Invariant 6): Physical provenance preserved ('live_hardware').
 * - Dean Latency & Ghemawat Simplicity: 5-minute sampling interval (288 pts/day), batched bulk inserts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getPrismaClient, getHistoricalMultiDeviceTelemetry } from '../dist/db/telemetry-db.js';

const SYNC_DIR = fs.existsSync('/tmp/zodiac-history-sync')
  ? '/tmp/zodiac-history-sync'
  : '/var/lib/zodiac/history';

function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: T[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines
    }
  }
  return results;
}

interface RawZodiacLine {
  timestampMs: number;
  rxBytes?: string | number;
  txBytes?: string | number;
  rxPackets?: string | number;
  txPackets?: string | number;
  rxRatePps?: string | number;
  txRatePps?: string | number;
  rxRateBps?: string | number;
  txRateBps?: string | number;
  cpuTemperatureC?: number | null;
  latencyNs?: string | number;
  ports?: Record<string, unknown>;
}

interface RawDeviceLine {
  timestampMs: number;
  [key: string]: unknown;
}

async function main() {
  console.log(`[*] Starting sync from local history directory: ${SYNC_DIR}`);
  const prisma = getPrismaClient();
  if (!prisma) {
    console.error('[!] Prisma client unavailable. Ensure ZODIAC_DATABASE_URL is set.');
    process.exit(1);
  }

  const entries = fs.readdirSync(SYNC_DIR);
  const zodiacFiles = entries
    .filter((f) => f.startsWith('zodiac-') && f.endsWith('.jsonl'))
    .sort();

  console.log(`[*] Found ${zodiacFiles.length} daily Zodiac history files.`);

  let totalInserted = 0;

  for (const zFile of zodiacFiles) {
    const match = /zodiac-(\d{4}-\d{2}-\d{2})\.jsonl/.exec(zFile);
    if (!match?.[1]) continue;
    const dateStr = match[1];

    const zodiacPath = path.join(SYNC_DIR, zFile);
    const jetsonPath = path.join(SYNC_DIR, `jetson-${dateStr}.jsonl`);
    const coralPath = path.join(SYNC_DIR, `coral-${dateStr}.jsonl`);
    const workstationPath = path.join(SYNC_DIR, `workstation-${dateStr}.jsonl`);

    const zodiacLines = readJsonlFile<RawZodiacLine>(zodiacPath);
    if (zodiacLines.length === 0) continue;

    const jetsonLines = readJsonlFile<RawDeviceLine>(jetsonPath);
    const coralLines = readJsonlFile<RawDeviceLine>(coralPath);
    const wsLines = readJsonlFile<RawDeviceLine>(workstationPath);

    const jetsonMap = new Map<number, RawDeviceLine>();
    for (const pt of jetsonLines) jetsonMap.set(pt.timestampMs, pt);

    const coralMap = new Map<number, RawDeviceLine>();
    for (const pt of coralLines) coralMap.set(pt.timestampMs, pt);

    const wsMap = new Map<number, RawDeviceLine>();
    for (const pt of wsLines) wsMap.set(pt.timestampMs, pt);

    // Stride to sample at roughly 5-minute intervals (288 points per day).
    // If a day has 2880 lines (30s interval), stride = 10.
    const TARGET_POINTS_PER_DAY = 288;
    const stride = Math.max(1, Math.floor(zodiacLines.length / TARGET_POINTS_PER_DAY));

    const pointsToInsert = [];

    for (let i = 0; i < zodiacLines.length; i += stride) {
      const z = zodiacLines[i];
      if (!z) continue;

      const ts = z.timestampMs;
      const jetson = jetsonMap.get(ts) ?? null;
      const coral = coralMap.get(ts) ?? null;
      const ws = wsMap.get(ts) ?? null;

      pointsToInsert.push({
        timestampMs: BigInt(ts),
        source: 'live_hardware',
        cpuTemperatureC: z.cpuTemperatureC ?? null,
        latencyNs: BigInt(String(z.latencyNs ?? '0')),
        totalRxBytes: BigInt(String(z.rxBytes ?? '0')),
        totalTxBytes: BigInt(String(z.txBytes ?? '0')),
        totalRxPackets: BigInt(String(z.rxPackets ?? '0')),
        totalTxPackets: BigInt(String(z.txPackets ?? '0')),
        rxRatePps: BigInt(String(z.rxRatePps ?? '0')),
        txRatePps: BigInt(String(z.txRatePps ?? '0')),
        rxRateBps: BigInt(String(z.rxRateBps ?? '0')),
        txRateBps: BigInt(String(z.txRateBps ?? '0')),
        portsJson: z.ports ?? [],
        jetsonJson: (jetson as any) ?? null,
        coralJson: (coral as any) ?? null,
        workstationJson: (ws as any) ?? null,
      });
    }

    // Insert in batches of 100
    const BATCH_SIZE = 100;
    for (let b = 0; b < pointsToInsert.length; b += BATCH_SIZE) {
      const batch = pointsToInsert.slice(b, b + BATCH_SIZE);
      await prisma.zodiacTelemetryPoint.createMany({
        data: batch,
        skipDuplicates: true,
      });
      totalInserted += batch.length;
    }

    console.log(`[+] Synced ${dateStr}: inserted ${pointsToInsert.length} points.`);
  }

  console.log(`\n[✔] Sync complete! Total points backfilled: ${totalInserted}`);

  const totalCount = await prisma.zodiacTelemetryPoint.count();
  const earliest = await prisma.zodiacTelemetryPoint.findFirst({ orderBy: { timestampMs: 'asc' } });
  const latest = await prisma.zodiacTelemetryPoint.findFirst({ orderBy: { timestampMs: 'desc' } });

  console.log(`\n[*] Neon Postgres Telemetry Summary:`);
  console.log(`    Total Rows: ${totalCount}`);
  console.log(`    Earliest:   ${earliest?.timestampMs ? new Date(Number(earliest.timestampMs)).toISOString() : 'none'}`);
  console.log(`    Latest:     ${latest?.timestampMs ? new Date(Number(latest.timestampMs)).toISOString() : 'none'}`);

  console.log(`\n[*] Testing getHistoricalMultiDeviceTelemetry('30d')...`);
  const t0 = Date.now();
  const historical30d = await getHistoricalMultiDeviceTelemetry('30d');
  const elapsed = Date.now() - t0;
  console.log(`    Query took ${elapsed}ms`);
  console.log(`    Points returned: Zodiac=${historical30d.timeSeries.length}, Jetson=${historical30d.jetsonTimeSeries.length}, Coral=${historical30d.coralTimeSeries.length}`);
  if (historical30d.timeSeries.length > 0) {
    console.log(`    Earliest point: ${new Date(historical30d.timeSeries[0]!.timestampMs).toISOString()}`);
    console.log(`    Latest point:   ${new Date(historical30d.timeSeries[historical30d.timeSeries.length - 1]!.timestampMs).toISOString()}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[!] Sync failed:', err);
  process.exit(1);
});
