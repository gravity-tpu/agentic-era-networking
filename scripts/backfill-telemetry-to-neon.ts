/**
 * scripts/backfill-telemetry-to-neon.ts
 *
 * Backfills physical telemetry snapshots from the Jetson appliance's disk checkpoint
 * (/var/lib/zodiac/telemetry-state.json) into Neon PostgreSQL (sparkling-term-57598618).
 *
 * Council Invariant 6 (Epistemic Provenance): Every inserted point originates from
 * real physical silicon execution on Jetson Orin Nano and dual Coral Edge TPUs.
 */

import { execSync, spawn } from 'child_process';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import crypto from 'crypto';

neonConfig.webSocketConstructor = ws;

interface RawStateJetsonPoint {
  readonly timestampMs: number;
  readonly cpuUtilizationPct?: number;
  readonly gpuUtilizationPct?: number;
  readonly cpuTempC?: number;
  readonly gpuTempC?: number;
  readonly junctionTempC?: number;
  readonly powerWatts?: number;
  readonly ramUsedBytes?: string | number | bigint;
  readonly nvmeReadRateBps?: string | number | bigint;
  readonly nvmeWriteRateBps?: string | number | bigint;
  readonly sdnPortRateBps?: string | number | bigint;
  readonly wifiPortRateBps?: string | number | bigint;
}

interface RawStateCoralPoint {
  readonly timestampMs: number;
  readonly inferencesPerSecond?: string | number | bigint;
  readonly tapPacketsPerSecond?: string | number | bigint;
  readonly latencyP50Us?: string | number | bigint;
  readonly latencyP99Us?: string | number | bigint;
  readonly usbThroughputKbps?: string | number | bigint;
  readonly coral1Ips?: string | number | bigint;
  readonly coral2Ips?: string | number | bigint;
  readonly coral1LatencyP50Us?: string | number | bigint;
  readonly coral2LatencyP50Us?: string | number | bigint;
}

interface RawStateSwitchPoint {
  readonly timestampMs: number;
  readonly cpuTemperatureC?: number | null;
  readonly latencyNs?: string | number | bigint;
  readonly rxBytes?: string | number | bigint;
  readonly txBytes?: string | number | bigint;
  readonly rxPackets?: string | number | bigint;
  readonly txPackets?: string | number | bigint;
  readonly rxRatePps?: string | number | bigint;
  readonly txRatePps?: string | number | bigint;
  readonly rxRateBps?: string | number | bigint;
  readonly txRateBps?: string | number | bigint;
  readonly ports?: Record<string, unknown>;
}

async function main() {
  console.log('[*] Pulling Vercel production DATABASE_URL...');
  const vercelEnv = execSync(
    'vercel env pull .env.tmp --environment=production --yes && cat .env.tmp && rm -f .env.tmp',
    { encoding: 'utf8' }
  );
  const dbUrlMatch = vercelEnv.match(/DATABASE_URL="([^"]+)"/);
  if (!dbUrlMatch) {
    throw new Error('Could not find DATABASE_URL in Vercel production env');
  }
  const dbUrl = dbUrlMatch[1];

  const jetsonHost = process.env['JETSON_HOST'] || '10.0.0.15';
  const jetsonUser = process.env['JETSON_USER'] || 'zodiac';
  const sshTimeoutSec = Number(process.env['SSH_TIMEOUT_SEC'] || 30);

  console.log(`[*] Fetching /var/lib/zodiac/telemetry-state.json from Jetson (${jetsonUser}@${jetsonHost})...`);
  const rawStateJson = await new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'ConnectTimeout=5',
      '-o', 'ServerAliveInterval=10',
      `${jetsonUser}@${jetsonHost}`,
      'sudo cat /var/lib/zodiac/telemetry-state.json',
    ]);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_STATE_BYTES = 32 * 1024 * 1024; // 32MB hard ceiling (Ghemawat Bounded Memory Allocation)

    // Jeff Dean Invariant: Bounded execution deadline
    const timeoutTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`SSH fetch timed out after ${sshTimeoutSec} seconds`));
    }, sshTimeoutSec * 1000);
    timeoutTimer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_STATE_BYTES) {
        clearTimeout(timeoutTimer);
        child.kill('SIGKILL');
        reject(new Error(`Telemetry state exceeded maximum bound of ${MAX_STATE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (errChunk: Buffer) => {
      const msg = errChunk.toString('utf8').trim();
      if (msg) console.warn('[ssh stderr]', msg);
    });
    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (code !== 0) {
        reject(new Error(`ssh process exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });

  const state = JSON.parse(rawStateJson) as {
    timeSeries?: RawStateSwitchPoint[];
    jetsonTimeSeries?: RawStateJetsonPoint[];
    coralTimeSeries?: RawStateCoralPoint[];
  };
  const timeSeries = state.timeSeries || [];
  const jetsonSeries = state.jetsonTimeSeries || [];
  const coralSeries = state.coralTimeSeries || [];

  console.log(`[*] Loaded ${timeSeries.length} switch pts, ${jetsonSeries.length} jetson pts, ${coralSeries.length} coral pts.`);

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Map points by timestampMs for fast lookup
    const jetsonMap = new Map<number, RawStateJetsonPoint>();
    for (const p of jetsonSeries) {
      if (p && typeof p.timestampMs === 'number') {
        jetsonMap.set(p.timestampMs, p);
      }
    }

    const coralMap = new Map<number, RawStateCoralPoint>();
    for (const p of coralSeries) {
      if (p && typeof p.timestampMs === 'number') {
        coralMap.set(p.timestampMs, p);
      }
    }

    // Filter points to 10-second sampling (every ~10th point, or whenever there are inferences)
    const candidatePoints: RawStateSwitchPoint[] = [];
    let lastSampleTimeMs = 0;

    for (let i = 0; i < timeSeries.length; i++) {
      const pt = timeSeries[i];
      const ts = pt.timestampMs;
      const c = coralMap.get(ts);
      const hasInferences = c && (
        BigInt(c.inferencesPerSecond || '0') > 0n ||
        BigInt(c.coral1Ips || '0') > 0n ||
        BigInt(c.coral2Ips || '0') > 0n
      );

      // Keep point if at least 10s elapsed OR if there is an active inference burst
      if (ts - lastSampleTimeMs >= 10_000 || hasInferences || i === timeSeries.length - 1) {
        candidatePoints.push(pt);
        lastSampleTimeMs = ts;
      }
    }

    console.log(`[*] Selected ${candidatePoints.length} representative points for backfill.`);

    if (candidatePoints.length === 0) {
      console.log('[*] Zero candidate points to backfill. Exiting.');
      return;
    }

    // Check existing timestamps in DB to prevent duplicates
    const minTs = candidatePoints[0].timestampMs;
    const maxTs = candidatePoints[candidatePoints.length - 1].timestampMs;
    const existingRows = await pool.query<{ timestampMs: string }>(
      'SELECT "timestampMs" FROM "ZodiacTelemetryPoint" WHERE "timestampMs" >= $1 AND "timestampMs" <= $2',
      [minTs, maxTs]
    );
    const existingSet = new Set(existingRows.rows.map((r) => r.timestampMs));
    console.log(`[*] Found ${existingSet.size} points already present in Neon DB.`);

    const toInsert = candidatePoints.filter((p) => !existingSet.has(String(p.timestampMs)));
    console.log(`[*] Inserting ${toInsert.length} new points into Neon DB...`);

    let insertedCount = 0;
    const batchSize = 50;

    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const valueClauses: string[] = [];
      const values: unknown[] = [];
      let pIdx = 1;

      for (const pt of batch) {
        const ts = pt.timestampMs;
        const j = jetsonMap.get(ts);
        const c = coralMap.get(ts);

        const id = crypto.randomUUID();
        const createdAt = new Date(ts).toISOString();

        const jetsonJson = j ? JSON.stringify({
          timestampMs: ts,
          cpuUtilizationPct: j.cpuUtilizationPct ?? 0,
          gpuUtilizationPct: j.gpuUtilizationPct ?? 0,
          cpuTempC: j.cpuTempC ?? 0,
          gpuTempC: j.gpuTempC ?? 0,
          junctionTempC: j.junctionTempC ?? 0,
          powerWatts: j.powerWatts ?? 0,
          ramUsedBytes: String(j.ramUsedBytes ?? 0),
          nvmeReadRateBps: String(j.nvmeReadRateBps ?? 0),
          nvmeWriteRateBps: String(j.nvmeWriteRateBps ?? 0),
          sdnPortRateBps: String(j.sdnPortRateBps ?? 0),
          wifiPortRateBps: String(j.wifiPortRateBps ?? 0),
        }) : null;

        const coralJson = c ? JSON.stringify({
          timestampMs: ts,
          inferencesPerSecond: String(c.inferencesPerSecond ?? 0),
          tapPacketsPerSecond: String(c.tapPacketsPerSecond ?? 0),
          latencyP50Us: String(c.latencyP50Us ?? 0),
          latencyP99Us: String(c.latencyP99Us ?? 0),
          usbThroughputKbps: String(c.usbThroughputKbps ?? 0),
          coral1Ips: String(c.coral1Ips ?? 0),
          coral2Ips: String(c.coral2Ips ?? 0),
          coral1LatencyP50Us: String(c.coral1LatencyP50Us ?? 0),
          coral2LatencyP50Us: String(c.coral2LatencyP50Us ?? 0),
        }) : null;

        const portsJson = JSON.stringify(pt.ports || {});

        valueClauses.push(
          `($${pIdx}, $${pIdx + 1}, 'live_hardware', $${pIdx + 2}, $${pIdx + 3}, ` +
          `$${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, ` +
          `$${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11}, ` +
          `$${pIdx + 12}::jsonb, $${pIdx + 13}::jsonb, $${pIdx + 14}::jsonb, $${pIdx + 15})`
        );

        values.push(
          id,
          BigInt(ts),
          pt.cpuTemperatureC ?? null,
          BigInt(pt.latencyNs ?? 0),
          BigInt(pt.rxBytes ?? 0),
          BigInt(pt.txBytes ?? 0),
          BigInt(pt.rxPackets ?? 0),
          BigInt(pt.txPackets ?? 0),
          BigInt(pt.rxRatePps ?? 0),
          BigInt(pt.txRatePps ?? 0),
          BigInt(pt.rxRateBps ?? 0),
          BigInt(pt.txRateBps ?? 0),
          portsJson,
          jetsonJson,
          coralJson,
          createdAt
        );

        pIdx += 16;
      }

      if (valueClauses.length > 0) {
        await pool.query(
          `INSERT INTO "ZodiacTelemetryPoint" (
            "id", "timestampMs", "source", "cpuTemperatureC", "latencyNs",
            "totalRxBytes", "totalTxBytes", "totalRxPackets", "totalTxPackets",
            "rxRatePps", "txRatePps", "rxRateBps", "txRateBps",
            "portsJson", "jetsonJson", "coralJson", "createdAt"
          ) VALUES ${valueClauses.join(', ')}`,
          values
        );
        insertedCount += batch.length;
        process.stdout.write(`[*] Progress: ${insertedCount}/${toInsert.length} points inserted...\r`);
      }
    }

    console.log(`\n[✓] Successfully backfilled ${insertedCount} points into Neon PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[!] Backfill failed:', err);
  process.exit(1);
});
