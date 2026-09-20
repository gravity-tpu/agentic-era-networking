/**
 * src/db/local-telemetry-db.ts
 * Local disk-backed historical telemetry store for the Zodiac bridge server.
 *
 * Appends one averaged data point per 30-second flush cycle to per-day JSONL files,
 * supporting 30-day persistent history without requiring Neon/cloud connectivity.
 * On restart the rolling in-memory buffer is replaced by data read from these files.
 *
 * Storage layout (under HISTORY_DIR, resolved below):
 *   zodiac-YYYY-MM-DD.jsonl   — ZodiacTimeSeriesPoint, one JSON object per line
 *   jetson-YYYY-MM-DD.jsonl   — JetsonTimeSeriesPoint, one JSON object per line
 *   coral-YYYY-MM-DD.jsonl    — CoralTimeSeriesPoint,  one JSON object per line
 *
 * Council Invariants Enforced:
 * - Jeff Dean: bounded reads per query; O(log N) downsampling reuses existing functions.
 * - Sanjay Ghemawat: append-only JSONL (no rewrite on append); zero new dependencies.
 * - Anti-Shortcut Law: BigInt → string serialization preserves 64-bit invariants across
 *   disk round-trips; corrupt JSONL lines are skipped rather than crashing the server.
 */

import fs from 'node:fs';
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
    } catch {
      // try next candidate
    }
  }
  // Last resort — best-effort create even if subsequent writes fail (we log those)
  try { fs.mkdirSync('/tmp/zodiac-history', { recursive: true }); } catch { /* ignore */ }
  return '/tmp/zodiac-history';
}

const HISTORY_DIR = resolveHistoryDir();

// ─── File path helpers ───────────────────────────────────────────────────────

// Use UTC dates for cross-timezone consistency across Jetson (JST) and Vercel (UTC).
function utcDateSuffix(ms: number): string {
  const d = new Date(ms);
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

const zodiacFile = (suffix: string) => path.join(HISTORY_DIR, `zodiac-${suffix}.jsonl`);
const jetsonFile = (suffix: string) => path.join(HISTORY_DIR, `jetson-${suffix}.jsonl`);
const coralFile  = (suffix: string) => path.join(HISTORY_DIR, `coral-${suffix}.jsonl`);

const bigintReplacer = (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v;

// ─── Write path ──────────────────────────────────────────────────────────────

/**
 * Append one averaged data point per device type to today's JSONL history files.
 *
 * Called by ZodiacBridgeServer every STATE_FLUSH_INTERVAL_MS (30 s) with all raw
 * points accumulated since the previous call. Uses downsamplePoints(pts, 1) to average
 * them into a single representative point per flush, keeping file growth bounded at
 * ~2 points/min = 2880/day × ~150 B ≈ 430 KB/day per device type (13 MB/30 days total).
 */
export function appendLocalHistoryPoints(
  newZodiacPoints: ZodiacTimeSeriesPoint[],
  newJetsonPoints: JetsonTimeSeriesPoint[],
  newCoralPoints: CoralTimeSeriesPoint[],
): void {
  if (newZodiacPoints.length === 0 && newJetsonPoints.length === 0 && newCoralPoints.length === 0) {
    return;
  }

  const suffix = utcDateSuffix(Date.now());

  // Average each device's window into a single representative point before appending.
  // Spreading into a new array avoids mutating the caller's slice references.
  if (newZodiacPoints.length > 0) {
    try {
      const summary = downsamplePoints([...newZodiacPoints], 1);
      if (summary.length > 0) {
        fs.appendFileSync(zodiacFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n');
      }
    } catch (err: unknown) {
      console.warn('[!] [Local Telemetry DB] Failed to append zodiac history:', err instanceof Error ? err.message : String(err));
    }
  }

  if (newJetsonPoints.length > 0) {
    try {
      const summary = downsampleJetsonPoints([...newJetsonPoints], 1);
      if (summary.length > 0) {
        fs.appendFileSync(jetsonFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n');
      }
    } catch (err: unknown) {
      console.warn('[!] [Local Telemetry DB] Failed to append jetson history:', err instanceof Error ? err.message : String(err));
    }
  }

  if (newCoralPoints.length > 0) {
    try {
      const summary = downsampleCoralPoints([...newCoralPoints], 1);
      if (summary.length > 0) {
        fs.appendFileSync(coralFile(suffix), JSON.stringify(summary[0], bigintReplacer) + '\n');
      }
    } catch (err: unknown) {
      console.warn('[!] [Local Telemetry DB] Failed to append coral history:', err instanceof Error ? err.message : String(err));
    }
  }
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
    cpuTempC:          p['cpuTempC'] !== null && p['cpuTempC'] !== undefined
      ? Number(p['cpuTempC']) : null,
    gpuTempC:          p['gpuTempC'] !== null && p['gpuTempC'] !== undefined
      ? Number(p['gpuTempC']) : null,
    junctionTempC:     p['junctionTempC'] !== null && p['junctionTempC'] !== undefined
      ? Number(p['junctionTempC']) : null,
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
    timestampMs:        Number(p['timestampMs'] ?? 0),
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

// ─── Read path (per-file helpers) ────────────────────────────────────────────

function readZodiacFile(filePath: string, cutoffMs: number): ZodiacTimeSeriesPoint[] {
  try {
    const result: ZodiacTimeSeriesPoint[] = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseZodiacLine(p));
      } catch { /* skip corrupt line; Anti-Shortcut: explicit degradation */ }
    }
    return result;
  } catch {
    return []; // file doesn't exist yet or unreadable — normal on first run
  }
}

function readJetsonFile(filePath: string, cutoffMs: number): JetsonTimeSeriesPoint[] {
  try {
    const result: JetsonTimeSeriesPoint[] = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseJetsonLine(p));
      } catch { /* skip corrupt line */ }
    }
    return result;
  } catch {
    return [];
  }
}

function readCoralFile(filePath: string, cutoffMs: number): CoralTimeSeriesPoint[] {
  try {
    const result: CoralTimeSeriesPoint[] = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        if (Number(p['timestampMs'] ?? 0) >= cutoffMs) result.push(parseCoralLine(p));
      } catch { /* skip corrupt line */ }
    }
    return result;
  } catch {
    return [];
  }
}

// ─── Public query API ────────────────────────────────────────────────────────

export interface LocalHistoricalResult {
  timeSeries: ZodiacTimeSeriesPoint[];
  jetsonTimeSeries: JetsonTimeSeriesPoint[];
  coralTimeSeries: CoralTimeSeriesPoint[];
}

/**
 * Read all local JSONL history files that overlap the requested time range,
 * filter by cutoff timestamp, then downsample to the range's configured maxPoints.
 *
 * Synchronous I/O is intentional: historical queries are user-initiated (low frequency)
 * and this is the same approach used by loadTelemetryState in telemetry-state-store.ts.
 * Worst-case read for 30d: ~13 MB total across 31 files ≈ 50–150 ms on NVMe SSD.
 */
export function queryLocalHistory(range: HistoricalRange): LocalHistoricalResult {
  const config   = RANGE_CONFIGS[range];
  const windowMs = RANGE_DURATION_MS[range];
  const nowMs    = Date.now();
  const cutoffMs = nowMs - windowMs;

  // Number of calendar day files to scan (+1 for UTC-boundary overlap)
  const DAY_MS      = 24 * 60 * 60 * 1000;
  const daysToScan  = Math.ceil(windowMs / DAY_MS) + 1;

  const zodiacPoints: ZodiacTimeSeriesPoint[] = [];
  const jetsonPoints: JetsonTimeSeriesPoint[] = [];
  const coralPoints:  CoralTimeSeriesPoint[]  = [];

  for (let i = 0; i <= daysToScan; i++) {
    const suffix = utcDateSuffix(nowMs - i * DAY_MS);
    zodiacPoints.push(...readZodiacFile(zodiacFile(suffix), cutoffMs));
    jetsonPoints.push(...readJetsonFile(jetsonFile(suffix), cutoffMs));
    coralPoints.push(...readCoralFile(coralFile(suffix), cutoffMs));
  }

  // Files scanned newest-first; sort before downsampling (required by downsamplePoints)
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
 * Delete JSONL files older than retentionDays. Called once on bridge server startup.
 * Fast synchronous directory scan — acceptable at startup, not on the hot path.
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
        } catch (unlinkErr: unknown) {
          console.warn(`[!] [Local Telemetry DB] Failed to delete old history file ${entry}:`,
            unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
        }
      }
    }
  } catch (err: unknown) {
    console.warn('[!] [Local Telemetry DB] Failed to prune local history:', err instanceof Error ? err.message : String(err));
  }
}
