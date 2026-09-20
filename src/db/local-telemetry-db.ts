/**
 * src/db/local-telemetry-db.ts
 * Local disk-backed historical telemetry store for the Zodiac bridge server.
 *
 * Appends one averaged data point per device type (Zodiac, Jetson, Coral) to per-day
 * JSONL files every 30 seconds, supporting 30-day persistent history without Neon/cloud.
 * Historical queries read relevant day files in parallel via async I/O, never blocking
 * the SDN OpenFlow event loop.
 *
 * Storage layout (under HISTORY_DIR resolved below):
 *   zodiac-YYYY-MM-DD.jsonl   — ZodiacTimeSeriesPoint, one JSON object per line
 *   jetson-YYYY-MM-DD.jsonl   — JetsonTimeSeriesPoint, one JSON object per line
 *   coral-YYYY-MM-DD.jsonl    — CoralTimeSeriesPoint,  one JSON object per line
 *
 * Council Invariants Enforced:
 * - Jeff Dean: All file I/O is async (never blocks the Node.js event loop); parallel
 *   Promise.all reads across day files for minimum query latency.
 * - Sanjay Ghemawat: Append-only JSONL; zero new dependencies; flat data layout.
 * - Anti-Shortcut Law: BigInt → string round-trips preserve 64-bit invariants;
 *   corrupt JSONL lines are counted and logged rather than silently swallowed.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ZodiacTimeSeriesPoint,
  JetsonTimeSeriesPoint,
  CoralTimeSeriesPoint,
  ZodiacPortSeriesPoint,
} from '../sdn/zodiac-telemetry.js';
import {
  type HistoricalRange,
  RANGE_CONFIGS,
  RANGE_DURATION_MS,
  downsamplePoints,
  downsampleJetsonPoints,
  downsampleCoralPoints,
} from './telemetry-db.js';

export const LOCAL_HISTORY_RETENTION_DAYS = 30;

// Tracks corrupt JSONL lines seen since process start (observable via logs, not silently dropped)
let corruptLinesTotal = 0;

// ─── Directory resolution ────────────────────────────────────────────────────

function resolveHistoryDir(): string {
  const candidates: string[] = [
    process.env['STATE_DIRECTORY'] ? path.join(process.env['STATE_DIRECTORY'], 'history') : '',
    '/var/lib/zodiac/history',
    path.join(process.env['HOME'] ?? '', 'zodiac-history'),
    '/tmp/zodiac-history',
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return dir;
    } catch (err: unknown) {
      console.warn(`[!] [Local Telemetry DB] Directory ${dir} not usable:`, err instanceof Error ? err.message : String(err));
    }
  }
  console.warn('[!] [Local Telemetry DB] No writable history directory found; falling back to /tmp/zodiac-history.');
  try {
    fs.mkdirSync('/tmp/zodiac-history', { recursive: true });
  } catch (mkdirErr: unknown) {
    console.warn('[!] [Local Telemetry DB] Failed to create /tmp/zodiac-history:', mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr));
  }
  return '/tmp/zodiac-history';
}

const HISTORY_DIR = resolveHistoryDir();

// ─── File path helpers ───────────────────────────────────────────────────────

// UTC dates for cross-timezone consistency between Jetson and Vercel.
function utcDateSuffix(ms: number): string {
  const d  = new Date(ms);
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

const zodiacFile = (suffix: string) => path.join(HISTORY_DIR, `zodiac-${suffix}.jsonl`);
const jetsonFile = (suffix: string) => path.join(HISTORY_DIR, `jetson-${suffix}.jsonl`);
const coralFile  = (suffix: string) => path.join(HISTORY_DIR, `coral-${suffix}.jsonl`);

const bigintReplacer = (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v;

// ─── Write path (async, fire-and-forget from callers) ───────────────────────

/**
 * Append one averaged data point per device type to today's JSONL history files.
 *
 * Called by ZodiacBridgeServer every STATE_FLUSH_INTERVAL_MS (30 s) with all raw
 * points accumulated since the previous call. Uses downsamplePoints(pts, 1) to average
 * them into a single representative point per call — ~150 B × 3 files per flush tick.
 * All writes are async so the SDN OpenFlow event loop is never stalled.
 */
export async function appendLocalHistoryPoints(
  newZodiacPoints: ZodiacTimeSeriesPoint[],
  newJetsonPoints: JetsonTimeSeriesPoint[],
  newCoralPoints: CoralTimeSeriesPoint[],
): Promise<void> {
  if (newZodiacPoints.length === 0 && newJetsonPoints.length === 0 && newCoralPoints.length === 0) {
    return;
  }

  const suffix = utcDateSuffix(Date.now());
  const writes: Promise<void>[] = [];

  if (newZodiacPoints.length > 0) {
    const summary = downsamplePoints([...newZodiacPoints], 1);
    if (summary.length > 0) {
      writes.push(
        fsp.appendFile(zodiacFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n').catch((err: unknown) => {
          console.warn('[!] [Local Telemetry DB] Failed to append zodiac history:', err instanceof Error ? err.message : String(err));
        })
      );
    }
  }

  if (newJetsonPoints.length > 0) {
    const summary = downsampleJetsonPoints([...newJetsonPoints], 1);
    if (summary.length > 0) {
      writes.push(
        fsp.appendFile(jetsonFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n').catch((err: unknown) => {
          console.warn('[!] [Local Telemetry DB] Failed to append jetson history:', err instanceof Error ? err.message : String(err));
        })
      );
    }
  }

  if (newCoralPoints.length > 0) {
    const summary = downsampleCoralPoints([...newCoralPoints], 1);
    if (summary.length > 0) {
      writes.push(
        fsp.appendFile(coralFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n').catch((err: unknown) => {
          console.warn('[!] [Local Telemetry DB] Failed to append coral history:', err instanceof Error ? err.message : String(err));
        })
      );
    }
  }

  await Promise.all(writes);
}

// ─── Deserialization helpers ─────────────────────────────────────────────────

function deserializePorts(raw: Record<string, unknown>): Record<number, ZodiacPortSeriesPoint> {
  const res: Record<number, ZodiacPortSeriesPoint> = {};
  for (const [key, val] of Object.entries(raw)) {
    const portNum = Number(key);
    if (!Number.isNaN(portNum) && val && typeof val === 'object') {
      const v = val as Record<string, unknown>;
      res[portNum] = {
        rxPackets: BigInt(String(v['rxPackets'] ?? '0')),
        txPackets: BigInt(String(v['txPackets'] ?? '0')),
        rxBytes:   BigInt(String(v['rxBytes']   ?? '0')),
        txBytes:   BigInt(String(v['txBytes']   ?? '0')),
        rxRatePps: BigInt(String(v['rxRatePps'] ?? '0')),
        txRatePps: BigInt(String(v['txRatePps'] ?? '0')),
        rxRateBps: BigInt(String(v['rxRateBps'] ?? '0')),
        txRateBps: BigInt(String(v['txRateBps'] ?? '0')),
      };
    }
  }
  return res;
}

function parseZodiacLine(p: Record<string, unknown>): ZodiacTimeSeriesPoint {
  const portsObj = p['ports'] && typeof p['ports'] === 'object'
    ? deserializePorts(p['ports'] as Record<string, unknown>)
    : undefined;
  return {
    timestampMs:     Number(p['timestampMs'] ?? 0),
    rxBytes:         BigInt(String(p['rxBytes']         ?? '0')),
    txBytes:         BigInt(String(p['txBytes']         ?? '0')),
    rxPackets:       BigInt(String(p['rxPackets']       ?? '0')),
    txPackets:       BigInt(String(p['txPackets']       ?? '0')),
    rxRatePps:       BigInt(String(p['rxRatePps']       ?? '0')),
    txRatePps:       BigInt(String(p['txRatePps']       ?? '0')),
    rxRateBps:       BigInt(String(p['rxRateBps']       ?? '0')),
    txRateBps:       BigInt(String(p['txRateBps']       ?? '0')),
    cpuTemperatureC: p['cpuTemperatureC'] !== null && p['cpuTemperatureC'] !== undefined
      ? Number(p['cpuTemperatureC']) : null,
    latencyNs:       BigInt(String(p['latencyNs']       ?? '0')),
    ports: portsObj,
  };
}

function parseJetsonLine(p: Record<string, unknown>): JetsonTimeSeriesPoint {
  return {
    timestampMs:       Number(p['timestampMs'] ?? 0),
    cpuUtilizationPct: Number(p['cpuUtilizationPct'] ?? 0),
    gpuUtilizationPct: Number(p['gpuUtilizationPct'] ?? 0),
    cpuTempC:          p['cpuTempC'] !== null && p['cpuTempC'] !== undefined ? Number(p['cpuTempC']) : null,
    gpuTempC:          p['gpuTempC'] !== null && p['gpuTempC'] !== undefined ? Number(p['gpuTempC']) : null,
    junctionTempC:     p['junctionTempC'] !== null && p['junctionTempC'] !== undefined ? Number(p['junctionTempC']) : null,
    powerWatts:        Number(p['powerWatts'] ?? 0),
    ramUsedBytes:      BigInt(String(p['ramUsedBytes']      ?? '0')),
    nvmeReadRateBps:   BigInt(String(p['nvmeReadRateBps']   ?? '0')),
    nvmeWriteRateBps:  BigInt(String(p['nvmeWriteRateBps']  ?? '0')),
    sdnPortRateBps:    BigInt(String(p['sdnPortRateBps']    ?? '0')),
    wifiPortRateBps:   BigInt(String(p['wifiPortRateBps']   ?? '0')),
  };
}

function parseCoralLine(p: Record<string, unknown>): CoralTimeSeriesPoint {
  return {
    timestampMs:         Number(p['timestampMs'] ?? 0),
    inferencesPerSecond: BigInt(String(p['inferencesPerSecond'] ?? '0')),
    tapPacketsPerSecond: BigInt(String(p['tapPacketsPerSecond'] ?? '0')),
    latencyP50Us:        BigInt(String(p['latencyP50Us']        ?? '0')),
    latencyP99Us:        BigInt(String(p['latencyP99Us']        ?? '0')),
    usbThroughputKbps:   BigInt(String(p['usbThroughputKbps']  ?? '0')),
    coral1Ips:           BigInt(String(p['coral1Ips']           ?? '0')),
    coral2Ips:           BigInt(String(p['coral2Ips']           ?? '0')),
    coral1LatencyP50Us:  BigInt(String(p['coral1LatencyP50Us'] ?? '0')),
    coral2LatencyP50Us:  BigInt(String(p['coral2LatencyP50Us'] ?? '0')),
  };
}

// ─── Async read path ─────────────────────────────────────────────────────────

async function readZodiacFile(filePath: string, cutoffMs: number): Promise<ZodiacTimeSeriesPoint[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // normal on first run
    console.warn(`[!] [Local Telemetry DB] I/O error reading ${path.basename(filePath)}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
  const result: ZodiacTimeSeriesPoint[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Record<string, unknown>;
      if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseZodiacLine(p));
    } catch (parseErr: unknown) {
      corruptLinesTotal++;
      console.warn(`[!] [Local Telemetry DB] Skipping corrupt zodiac line in ${path.basename(filePath)} (total skipped: ${corruptLinesTotal}):`, parseErr instanceof Error ? parseErr.message : String(parseErr));
    }
  }
  return result;
}

async function readJetsonFile(filePath: string, cutoffMs: number): Promise<JetsonTimeSeriesPoint[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[!] [Local Telemetry DB] I/O error reading ${path.basename(filePath)}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
  const result: JetsonTimeSeriesPoint[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Record<string, unknown>;
      if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseJetsonLine(p));
    } catch (parseErr: unknown) {
      corruptLinesTotal++;
      console.warn(`[!] [Local Telemetry DB] Skipping corrupt jetson line in ${path.basename(filePath)} (total skipped: ${corruptLinesTotal}):`, parseErr instanceof Error ? parseErr.message : String(parseErr));
    }
  }
  return result;
}

async function readCoralFile(filePath: string, cutoffMs: number): Promise<CoralTimeSeriesPoint[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[!] [Local Telemetry DB] I/O error reading ${path.basename(filePath)}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
  const result: CoralTimeSeriesPoint[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Record<string, unknown>;
      if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseCoralLine(p));
    } catch (parseErr: unknown) {
      corruptLinesTotal++;
      console.warn(`[!] [Local Telemetry DB] Skipping corrupt coral line in ${path.basename(filePath)} (total skipped: ${corruptLinesTotal}):`, parseErr instanceof Error ? parseErr.message : String(parseErr));
    }
  }
  return result;
}

// ─── Public query API ────────────────────────────────────────────────────────

export interface LocalHistoricalResult {
  timeSeries: ZodiacTimeSeriesPoint[];
  jetsonTimeSeries: JetsonTimeSeriesPoint[];
  coralTimeSeries: CoralTimeSeriesPoint[];
}

/**
 * Read all local JSONL history files overlapping the requested time range and
 * downsample to the range's configured maxPoints.
 *
 * All file reads are async and fanned out in parallel across the three device types
 * to keep total query latency bounded (worst case 30d: ~13 MB, three-way parallel read).
 * Never blocks the SDN OpenFlow event loop (Jeff Dean latency invariant).
 */
export async function queryLocalHistory(range: HistoricalRange): Promise<LocalHistoricalResult> {
  const config   = RANGE_CONFIGS[range];
  const windowMs = RANGE_DURATION_MS[range];
  const nowMs    = Date.now();
  const cutoffMs = nowMs - windowMs;

  // Suffixes for every UTC calendar day that overlaps the window (+1 for boundary)
  const DAY_MS     = 24 * 60 * 60 * 1000;
  const daysToScan = Math.ceil(windowMs / DAY_MS) + 1;
  const suffixes: string[] = [];
  for (let i = 0; i <= daysToScan; i++) {
    suffixes.push(utcDateSuffix(nowMs - i * DAY_MS));
  }

  // Parallel reads across all three device types simultaneously
  const [zodiacArrays, jetsonArrays, coralArrays] = await Promise.all([
    Promise.all(suffixes.map(s => readZodiacFile(zodiacFile(s), cutoffMs))),
    Promise.all(suffixes.map(s => readJetsonFile(jetsonFile(s), cutoffMs))),
    Promise.all(suffixes.map(s => readCoralFile(coralFile(s), cutoffMs))),
  ]);

  const zodiacPoints = zodiacArrays.flat();
  const jetsonPoints = jetsonArrays.flat();
  const coralPoints  = coralArrays.flat();

  // Files are scanned newest-first (i=0 is today); sort ascending before downsampling
  zodiacPoints.sort((a, b) => a.timestampMs - b.timestampMs);
  jetsonPoints.sort((a, b) => a.timestampMs - b.timestampMs);
  coralPoints.sort((a, b)  => a.timestampMs - b.timestampMs);

  return {
    timeSeries:       downsamplePoints(zodiacPoints, config.maxPoints),
    jetsonTimeSeries: downsampleJetsonPoints(jetsonPoints, config.maxPoints),
    coralTimeSeries:  downsampleCoralPoints(coralPoints, config.maxPoints),
  };
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

/**
 * Delete JSONL files older than retentionDays. Called once synchronously on bridge
 * server startup before the HTTP server begins accepting connections, so blocking
 * a directory scan at that point is safe (no live OpenFlow traffic yet).
 */
export function pruneLocalHistory(retentionDays: number = LOCAL_HISTORY_RETENTION_DAYS): void {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(HISTORY_DIR)) {
      if (!entry.endsWith('.jsonl')) continue;
      const match = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
      if (!match?.[1]) continue;
      const dayMs = new Date(match[1]).getTime();
      if (Number.isFinite(dayMs) && dayMs < cutoffMs) {
        try {
          fs.unlinkSync(path.join(HISTORY_DIR, entry));
          console.log(`[+] [Local Telemetry DB] Pruned expired history file: ${entry}`);
        } catch (unlinkErr: unknown) {
          console.warn(`[!] [Local Telemetry DB] Failed to delete ${entry}:`, unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
        }
      }
    }
  } catch (err: unknown) {
    console.warn('[!] [Local Telemetry DB] Failed to prune local history:', err instanceof Error ? err.message : String(err));
  }
}
