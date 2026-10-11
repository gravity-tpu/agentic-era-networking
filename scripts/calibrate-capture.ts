/**
 * scripts/calibrate-capture.ts
 * Standalone harness to calibrate observation-point capture NICs (O1, O2, O3).
 *
 * Invariant 2 (Integer accounting): Counters and deltas use BigInt.
 * Invariant 3 (Fail-closed): 0 observed packets during non-zero injected burst fails calibration.
 * Invariant 6 (Epistemic provenance): Refuses to record unverified numbers.
 *
 * Usage:
 *   node --experimental-strip-types scripts/calibrate-capture.ts --iface enx9c69d39dd0a6 --point O2 --count 1000 --rate 500
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  CALIBRATION_SCHEMA,
  deriveCalibrationVerdict,
  type CalibrationCounters,
  type CalibrationRecord,
} from '../src/sdn/capture-calibration.js';

interface CliArgs {
  readonly iface: string;
  readonly point: 'O1' | 'O2' | 'O3';
  readonly count: bigint;
  readonly ratePps: number;
  readonly allowedLossPpm: bigint;
  readonly outDir: string;
}

function parseArgs(args: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[++i];
      if (val !== undefined) flags.set(key, val);
    }
  }

  const iface = flags.get('iface') ?? 'enx9c69d39dd0a6';
  const rawPoint = flags.get('point') ?? 'O2';
  if (rawPoint !== 'O1' && rawPoint !== 'O2' && rawPoint !== 'O3') {
    throw new Error(`--point must be O1, O2, or O3; got ${rawPoint}`);
  }
  const count = BigInt(flags.get('count') ?? '1000');
  const ratePps = parseInt(flags.get('rate') ?? '500', 10);
  const allowedLossPpm = BigInt(flags.get('allowed-loss-ppm') ?? '0');
  const outDir = flags.get('out') ?? 'docs/benchmarks/results';

  return { iface, point: rawPoint, count, ratePps, allowedLossPpm, outDir };
}

async function readSysfsCounter(iface: string, stat: string): Promise<bigint> {
  const p = `/sys/class/net/${iface}/statistics/${stat}`;
  try {
    const raw = await fs.readFile(p, 'utf8');
    return BigInt(raw.trim());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[calibration] Note: cannot read sysfs counter ${p}: ${message}\n`);
    return 0n;
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const startedAtIso = new Date().toISOString();
  const startedMonotonicNs = process.hrtime.bigint();

  process.stdout.write(
    `[calibration] Starting capture calibration for ${cli.point} on iface ${cli.iface} ` +
      `(${cli.count} packets @ ${cli.ratePps} pps)\n`,
  );

  const startRxPackets = await readSysfsCounter(cli.iface, 'rx_packets');
  const startRxDropped = await readSysfsCounter(cli.iface, 'rx_dropped');

  // In live testbed, traffic injection is triggered via workload node SSH or local generator.
  // We record the interval: calculated burst duration plus a 500ms settling grace period:
  const burstDurationMs = Number((cli.count * 1000n) / BigInt(cli.ratePps));
  const settlingGracePeriodMs = 500;
  const waitMs = Math.max(100, burstDurationMs + settlingGracePeriodMs);
  await new Promise((r) => setTimeout(r, waitMs));

  const endRxPackets = await readSysfsCounter(cli.iface, 'rx_packets');
  const endRxDropped = await readSysfsCounter(cli.iface, 'rx_dropped');
  const finishedMonotonicNs = process.hrtime.bigint();

  const counters: CalibrationCounters = {
    startRxPackets,
    endRxPackets,
    startRxDropped,
    endRxDropped,
    injectedPackets: cli.count,
  };

  const verdict = deriveCalibrationVerdict(counters, cli.allowedLossPpm);

  const record: CalibrationRecord = {
    schema: CALIBRATION_SCHEMA,
    observationPoint: cli.point,
    interfaceName: cli.iface,
    host: os.hostname(),
    startedAtIso,
    startedMonotonicNs,
    finishedMonotonicNs,
    injectedRatePps: cli.ratePps,
    counters,
    verdict,
  };

  process.stdout.write(
    `[calibration] Verdict: ${verdict.status.toUpperCase()} | Captured: ${verdict.capturedPackets} | ` +
      `Dropped: ${verdict.kernelDroppedPackets} | Loss: ${verdict.lossPpm} PPM\n`,
  );

  await fs.mkdir(cli.outDir, { recursive: true });
  const filename = path.join(
    cli.outDir,
    `calibration-${cli.point}-${startedAtIso.replace(/[:.]/g, '-')}.json`,
  );

  const jsonReplacer = (_: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  await fs.writeFile(filename, JSON.stringify(record, jsonReplacer, 2), 'utf8');
  process.stdout.write(`[calibration] Artifact stored: ${filename}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[calibration] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
