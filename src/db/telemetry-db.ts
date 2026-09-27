/**
 * src/db/telemetry-db.ts
 * Neon Serverless Postgres Telemetry Persistence & Downsampling Engine
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Bounded memory and network transfer; time-bucketed downsampling returns <360 points for any range up to 30 days.
 * - Ghemawat: Radical simplicity and zero-bloat; gracefully handles missing DB credentials without breaking live memory streaming.
 * - Anti-Shortcut Law: Deterministic BigInt conversions and fail-safe database error boundaries.
 */

import { neonConfig } from '@neondatabase/serverless';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient, Prisma } from '@prisma/client';
import ws from 'ws';
import type {
  ZodiacFullTelemetrySnapshot,
  ZodiacTimeSeriesPoint,
  JetsonTimeSeriesPoint,
  CoralTimeSeriesPoint,
  WorkstationTimeSeriesPoint,
} from '../sdn/zodiac-telemetry.js';

// Required for Node.js environments connecting to Neon WebSockets
neonConfig.webSocketConstructor = ws;

// Global singleton instance for Vercel Serverless container reuse
let globalPrisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient | null {
  const dbUrl = process.env['DATABASE_URL'] || process.env['agentic_POSTGRES_PRISMA_URL'] || process.env['agentic_DATABASE_URL'] || process.env['POSTGRES_PRISMA_URL'];
  if (!dbUrl) {
    return null;
  }

  if (!globalPrisma) {
    try {
      const adapter = new PrismaNeon({ connectionString: dbUrl });
      globalPrisma = new PrismaClient({
        adapter,
        log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
      });
    } catch (err: unknown) {
      console.warn('[!] [Telemetry DB] Failed to initialize PrismaNeon adapter:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return globalPrisma;
}

// Track last persisted timestamp to enforce the 10-second batching cadence
let lastPersistedTimestampMs = 0;
let isPersisting = false;
const BATCH_INTERVAL_MS = 10_000; // 10 seconds cadence
const DB_TIMEOUT_MS = 2500; // 2.5s execution deadline for DB queries (Dean Latency Invariant)

export function isPersistingTelemetry(): boolean {
  return isPersisting;
}

/**
 * Persists a telemetry snapshot to Neon Postgres if at least 10 seconds have elapsed
 * since the previous write (or if force = true).
 * Bounded with in-flight mutex to prevent concurrent persistence stampedes.
 */
export async function persistTelemetrySnapshot(
  snapshot: ZodiacFullTelemetrySnapshot,
  force: boolean = false
): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return false; // Database not configured
  }

  const nowMs = Date.now();
  if (!force && (isPersisting || nowMs - lastPersistedTimestampMs < BATCH_INTERVAL_MS)) {
    return false; // Throttle to 10s cadence and prevent concurrent connection pool exhaustion
  }

  isPersisting = true;
  lastPersistedTimestampMs = nowMs;

  try {
    const system = snapshot.system;
    const ports = snapshot.ports || [];
    const openflow = snapshot.openflow;

    let totalRxBytes = 0n;
    let totalTxBytes = 0n;
    let totalRxPackets = 0n;
    let totalTxPackets = 0n;

    for (const p of ports) {
      totalRxBytes += BigInt(p.rxBytes || '0');
      totalTxBytes += BigInt(p.txBytes || '0');
      totalRxPackets += BigInt(p.rxPackets || '0');
      totalTxPackets += BigInt(p.txPackets || '0');
    }

    const latestPoint = snapshot.timeSeries && snapshot.timeSeries.length > 0
      ? snapshot.timeSeries[snapshot.timeSeries.length - 1]
      : null;

    const rxRatePps = latestPoint ? BigInt(latestPoint.rxRatePps || '0') : 0n;
    const txRatePps = latestPoint ? BigInt(latestPoint.txRatePps || '0') : 0n;
    const rxRateBps = latestPoint ? BigInt(latestPoint.rxRateBps || '0') : 0n;
    const txRateBps = latestPoint ? BigInt(latestPoint.txRateBps || '0') : 0n;
    const latencyNs = latestPoint ? BigInt(latestPoint.latencyNs || '0') : BigInt(openflow?.lastHeartbeatLatencyNs || '0');

function serializeJetsonPointExplicit(point: JetsonTimeSeriesPoint): Record<string, unknown> {
  return {
    timestampMs: point.timestampMs,
    cpuUtilizationPct: point.cpuUtilizationPct,
    gpuUtilizationPct: point.gpuUtilizationPct,
    cpuTempC: point.cpuTempC,
    gpuTempC: point.gpuTempC,
    junctionTempC: point.junctionTempC,
    powerWatts: point.powerWatts,
    ramUsedBytes: point.ramUsedBytes.toString(),
    nvmeReadRateBps: point.nvmeReadRateBps.toString(),
    nvmeWriteRateBps: point.nvmeWriteRateBps.toString(),
    sdnPortRateBps: point.sdnPortRateBps.toString(),
    wifiPortRateBps: point.wifiPortRateBps.toString(),
  };
}

function serializeCoralPointExplicit(point: CoralTimeSeriesPoint): Record<string, unknown> {
  return {
    timestampMs: point.timestampMs,
    inferencesPerSecond: point.inferencesPerSecond.toString(),
    tapPacketsPerSecond: point.tapPacketsPerSecond.toString(),
    latencyP50Us: point.latencyP50Us.toString(),
    latencyP99Us: point.latencyP99Us.toString(),
    usbThroughputKbps: point.usbThroughputKbps.toString(),
    coral1Ips: (point.coral1Ips ?? 0n).toString(),
    coral2Ips: (point.coral2Ips ?? 0n).toString(),
    coral1LatencyP50Us: (point.coral1LatencyP50Us ?? 0n).toString(),
    coral2LatencyP50Us: (point.coral2LatencyP50Us ?? 0n).toString(),
  };
}

function serializeWorkstationPointExplicit(point: WorkstationTimeSeriesPoint): Record<string, unknown> {
  return {
    timestampMs: point.timestampMs,
    cpuUtilizationPct: point.cpuUtilizationPct,
    gpuUtilizationPct: point.gpuUtilizationPct,
    gpuMemoryUsedBytes: point.gpuMemoryUsedBytes.toString(),
    ramUsedBytes: point.ramUsedBytes.toString(),
    tokensPerSecond: point.tokensPerSecond,
    promptTokensPerSecond: point.promptTokensPerSecond,
    totalPromptTokens: point.totalPromptTokens.toString(),
    totalCompletionTokens: point.totalCompletionTokens.toString(),
    totalTokens: point.totalTokens.toString(),
  };
}

    let jetsonJson: Record<string, unknown> | null = null;
    if (snapshot.jetson) {
      const latestJetson = snapshot.jetson.timeSeries && snapshot.jetson.timeSeries.length > 0
        ? snapshot.jetson.timeSeries[snapshot.jetson.timeSeries.length - 1]
        : null;
      if (latestJetson) {
        jetsonJson = serializeJetsonPointExplicit(latestJetson);
      } else {
        const sdnIf = snapshot.jetson.interfaces?.find((i) => i.name === 'enP8p1s0');
        const wifiIf = snapshot.jetson.interfaces?.find((i) => i.name === 'wlP1p1s0');
        jetsonJson = {
          timestampMs: nowMs,
          cpuUtilizationPct: snapshot.jetson.cpuUtilizationPct ?? 0,
          gpuUtilizationPct: snapshot.jetson.gpuUtilizationPct ?? 0,
          cpuTempC: snapshot.jetson.temperatures?.cpuC ?? 0,
          gpuTempC: snapshot.jetson.temperatures?.gpuC ?? 0,
          junctionTempC: snapshot.jetson.temperatures?.junctionC ?? 0,
          powerWatts: snapshot.jetson.powerMw?.vddIn ? parseFloat((snapshot.jetson.powerMw.vddIn / 1000).toFixed(2)) : 0,
          ramUsedBytes: (snapshot.jetson.ramUsedBytes ?? 0n).toString(),
          nvmeReadRateBps: (snapshot.jetson.nvmeReadRateBps ?? 0n).toString(),
          nvmeWriteRateBps: (snapshot.jetson.nvmeWriteRateBps ?? 0n).toString(),
          sdnPortRateBps: (sdnIf?.rxRateBps ?? 0n).toString(),
          wifiPortRateBps: (wifiIf?.rxRateBps ?? 0n).toString(),
        };
      }
    }

    let coralJson: Record<string, unknown> | null = null;
    if (snapshot.coral) {
      const latestCoral = snapshot.coral.timeSeries && snapshot.coral.timeSeries.length > 0
        ? snapshot.coral.timeSeries[snapshot.coral.timeSeries.length - 1]
        : null;
      if (latestCoral) {
        coralJson = serializeCoralPointExplicit(latestCoral);
      } else {
        const infPerSec = snapshot.coral.inferencesPerSecond ?? 0n;
        coralJson = {
          timestampMs: nowMs,
          inferencesPerSecond: infPerSec.toString(),
          tapPacketsPerSecond: '0',
          latencyP50Us: ((snapshot.coral.latencyP50Ns ?? 0n) / 1000n).toString(),
          latencyP99Us: ((snapshot.coral.latencyP99Ns ?? 0n) / 1000n).toString(),
          // Council Invariant 2 & 6: Physical truth integer BigInt throughput. 0n when idle/standby.
          usbThroughputKbps: infPerSec > 0n
            ? ((infPerSec * 300n * 8n) / 1000n).toString()
            : '0',
          coral1Ips: '0',
          coral2Ips: '0',
          coral1LatencyP50Us: '0',
          coral2LatencyP50Us: '0',
        };
      }
    }

    let workstationJson: Record<string, unknown> | null = null;
    if (snapshot.workstation) {
      const latestWs = snapshot.workstation.timeSeries && snapshot.workstation.timeSeries.length > 0
        ? snapshot.workstation.timeSeries[snapshot.workstation.timeSeries.length - 1]
        : null;
      if (latestWs) {
        workstationJson = serializeWorkstationPointExplicit(latestWs);
      }
    }

    const writePromise = prisma.zodiacTelemetryPoint.create({
      data: {
        timestampMs: BigInt(nowMs),
        source: snapshot.source,
        cpuTemperatureC: system?.cpuTemperatureC ?? null,
        latencyNs,
        totalRxBytes,
        totalTxBytes,
        totalRxPackets,
        totalTxPackets,
        rxRatePps,
        txRatePps,
        rxRateBps,
        txRateBps,
        portsJson: JSON.parse(JSON.stringify(ports, (_, v) => typeof v === 'bigint' ? v.toString() : v)),
        jetsonJson: jetsonJson as Prisma.InputJsonValue,
        coralJson: coralJson as Prisma.InputJsonValue,
        workstationJson: workstationJson as Prisma.InputJsonValue,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Telemetry DB write timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
      t.unref?.();
    });

    writePromise.catch((err: unknown) => {
      // Council Invariant 1: Catch background rejection post-timeout to prevent process crash
      console.warn('[!] [Telemetry DB] Background snapshot persist rejected post-timeout:', err instanceof Error ? err.message : String(err));
    });

    await Promise.race([writePromise, timeoutPromise]);

    return true;
  } catch (err: unknown) {
    console.warn('[!] [Telemetry DB] Failed to persist snapshot to Neon Postgres:', err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    isPersisting = false;
  }
}

export interface DownsampleConfig {
  readonly bucketSeconds: number;
  readonly maxPoints: number;
}

export type HistoricalRange = '1h' | '6h' | '24h' | '7d' | '30d';

export const RANGE_CONFIGS: Record<HistoricalRange, DownsampleConfig> = {
  '1h':  { bucketSeconds: 30,    maxPoints: 120 },
  '6h':  { bucketSeconds: 120,   maxPoints: 180 },
  '24h': { bucketSeconds: 300,   maxPoints: 288 },
  '7d':  { bucketSeconds: 1800,  maxPoints: 336 },
  '30d': { bucketSeconds: 7200,  maxPoints: 360 },
};

export const RANGE_DURATION_MS: Record<HistoricalRange, number> = {
  '1h':  60 * 60 * 1000,
  '6h':  6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function isValidRange(range: string | null | undefined): range is HistoricalRange {
  return (
    range === '1h' ||
    range === '6h' ||
    range === '24h' ||
    range === '7d' ||
    range === '30d'
  );
}

/**
 * Sanjay Ghemawat - Algorithmic Efficiency Invariant:
 * Bisection search (lower_bound) to find the first index where timestampMs >= cutoffMs
 * in an array strictly chronologically ordered by timestampMs in O(log N) time.
 */
export function findCutoffIndex<T extends { readonly timestampMs: number }>(
  points: readonly T[],
  cutoffMs: number
): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid]!.timestampMs < cutoffMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Pure deterministic bucketing function to downsample an array of raw time-series points
 * into a bounded window of averaged points (Dean Latency & Memory Invariant).
 */
export function downsamplePoints(
  rawPoints: readonly ZodiacTimeSeriesPoint[],
  maxPoints: number = 360
): ZodiacTimeSeriesPoint[] {
  if (rawPoints.length <= maxPoints) {
    return [...rawPoints];
  }

  const bucketSize = Math.ceil(rawPoints.length / maxPoints);
  const downsampled: ZodiacTimeSeriesPoint[] = [];

  for (let i = 0; i < rawPoints.length; i += bucketSize) {
    const chunk = rawPoints.slice(i, i + bucketSize);
    if (chunk.length === 0) continue;

    const midPoint = chunk[Math.floor(chunk.length / 2)];
    const lastPoint = chunk[chunk.length - 1];
    if (!midPoint || !lastPoint) continue;

    let sumRxRatePps = 0n;
    let sumTxRatePps = 0n;
    let sumRxRateBps = 0n;
    let sumTxRateBps = 0n;
    let sumLatency = 0n;
    let tempSum = 0;
    let tempCount = 0;

    for (const pt of chunk) {
      sumRxRatePps += BigInt(pt.rxRatePps || 0);
      sumTxRatePps += BigInt(pt.txRatePps || 0);
      sumRxRateBps += BigInt(pt.rxRateBps || 0);
      sumTxRateBps += BigInt(pt.txRateBps || 0);
      sumLatency += BigInt(pt.latencyNs || 0);
      if (pt.cpuTemperatureC !== null && pt.cpuTemperatureC !== undefined) {
        tempSum += pt.cpuTemperatureC;
        tempCount++;
      }
    }

    const countBig = BigInt(chunk.length);
    const isLastChunk = i + bucketSize >= rawPoints.length;

    downsampled.push({
      timestampMs: isLastChunk ? lastPoint.timestampMs : midPoint.timestampMs,
      rxBytes: BigInt(lastPoint.rxBytes || 0),
      txBytes: BigInt(lastPoint.txBytes || 0),
      rxPackets: BigInt(lastPoint.rxPackets || 0),
      txPackets: BigInt(lastPoint.txPackets || 0),
      rxRatePps: sumRxRatePps / countBig,
      txRatePps: sumTxRatePps / countBig,
      rxRateBps: sumRxRateBps / countBig,
      txRateBps: sumTxRateBps / countBig,
      cpuTemperatureC: tempCount > 0 ? Math.round(tempSum / tempCount) : null,
      latencyNs: sumLatency / countBig,
      ...(lastPoint.activeFlows !== undefined ? { activeFlows: lastPoint.activeFlows } : {}),
      ...(lastPoint.tableLookups !== undefined ? { tableLookups: lastPoint.tableLookups } : {}),
      ...(lastPoint.tableMatches !== undefined ? { tableMatches: lastPoint.tableMatches } : {}),
      ports: lastPoint.ports,
    });
  }

  return downsampled;
}

/**
 * Pure deterministic bucketing function to downsample an array of raw Jetson time-series points
 * into a bounded window of averaged points (Dean Latency & Memory Invariant).
 */
export function downsampleJetsonPoints(
  rawPoints: readonly JetsonTimeSeriesPoint[],
  maxPoints: number = 360
): JetsonTimeSeriesPoint[] {
  if (rawPoints.length <= maxPoints) {
    return [...rawPoints];
  }

  const bucketSize = Math.ceil(rawPoints.length / maxPoints);
  const downsampled: JetsonTimeSeriesPoint[] = [];

  for (let i = 0; i < rawPoints.length; i += bucketSize) {
    const chunk = rawPoints.slice(i, i + bucketSize);
    if (chunk.length === 0) continue;

    const midPoint = chunk[Math.floor(chunk.length / 2)];
    const lastPoint = chunk[chunk.length - 1];
    if (!midPoint || !lastPoint) continue;

    let sumCpuUtil = 0;
    let sumGpuUtil = 0;
    let sumCpuTemp = 0;
    let cpuTempCount = 0;
    let sumGpuTemp = 0;
    let gpuTempCount = 0;
    let sumJuncTemp = 0;
    let juncTempCount = 0;
    let sumPower = 0;
    let sumRam = 0n;
    let sumNvmeRead = 0n;
    let sumNvmeWrite = 0n;
    let sumSdn = 0n;
    let sumWifi = 0n;

    for (const pt of chunk) {
      sumCpuUtil += pt.cpuUtilizationPct;
      sumGpuUtil += pt.gpuUtilizationPct;
      if (pt.cpuTempC !== null && pt.cpuTempC !== undefined) {
        sumCpuTemp += pt.cpuTempC;
        cpuTempCount++;
      }
      if (pt.gpuTempC !== null && pt.gpuTempC !== undefined) {
        sumGpuTemp += pt.gpuTempC;
        gpuTempCount++;
      }
      if (pt.junctionTempC !== null && pt.junctionTempC !== undefined) {
        sumJuncTemp += pt.junctionTempC;
        juncTempCount++;
      }
      sumPower += pt.powerWatts;
      sumRam += BigInt(pt.ramUsedBytes || 0);
      sumNvmeRead += BigInt(pt.nvmeReadRateBps || 0);
      sumNvmeWrite += BigInt(pt.nvmeWriteRateBps || 0);
      sumSdn += BigInt(pt.sdnPortRateBps || 0);
      sumWifi += BigInt(pt.wifiPortRateBps || 0);
    }

    const count = chunk.length;
    const countBig = BigInt(count);
    const isLastChunk = i + bucketSize >= rawPoints.length;

    downsampled.push({
      timestampMs: isLastChunk ? lastPoint.timestampMs : midPoint.timestampMs,
      cpuUtilizationPct: Math.round(sumCpuUtil / count),
      gpuUtilizationPct: Math.round(sumGpuUtil / count),
      cpuTempC: cpuTempCount > 0 ? Math.round(sumCpuTemp / cpuTempCount) : null,
      gpuTempC: gpuTempCount > 0 ? Math.round(sumGpuTemp / gpuTempCount) : null,
      junctionTempC: juncTempCount > 0 ? Math.round(sumJuncTemp / juncTempCount) : null,
      powerWatts: count > 0 ? Math.round((sumPower * 100) / count) / 100 : 0,
      ramUsedBytes: sumRam / countBig,
      nvmeReadRateBps: sumNvmeRead / countBig,
      nvmeWriteRateBps: sumNvmeWrite / countBig,
      sdnPortRateBps: sumSdn / countBig,
      wifiPortRateBps: sumWifi / countBig,
    });
  }

  return downsampled;
}

/**
 * Pure deterministic bucketing function to downsample an array of raw Coral Edge TPU time-series points
 * into a bounded window of averaged points (Dean Latency & Memory Invariant).
 */
export function downsampleCoralPoints(
  rawPoints: readonly CoralTimeSeriesPoint[],
  maxPoints: number = 360
): CoralTimeSeriesPoint[] {
  if (rawPoints.length <= maxPoints) {
    return [...rawPoints];
  }

  const bucketSize = Math.ceil(rawPoints.length / maxPoints);
  const downsampled: CoralTimeSeriesPoint[] = [];

  for (let i = 0; i < rawPoints.length; i += bucketSize) {
    const chunk = rawPoints.slice(i, i + bucketSize);
    if (chunk.length === 0) continue;

    const midPoint = chunk[Math.floor(chunk.length / 2)];
    const lastPoint = chunk[chunk.length - 1];
    if (!midPoint || !lastPoint) continue;

    let sumIps = 0n;
    let sumTap = 0n;
    let sumLatP50 = 0n;
    let sumLatP99 = 0n;
    let sumUsb = 0n;
    let sumCoral1Ips = 0n;
    let sumCoral2Ips = 0n;
    let sumCoral1LatP50 = 0n;
    let sumCoral2LatP50 = 0n;

    for (const pt of chunk) {
      sumIps += pt.inferencesPerSecond ?? 0n;
      sumTap += pt.tapPacketsPerSecond ?? 0n;
      sumLatP50 += pt.latencyP50Us ?? 0n;
      sumLatP99 += pt.latencyP99Us ?? 0n;
      sumUsb += pt.usbThroughputKbps ?? 0n;
      sumCoral1Ips += pt.coral1Ips ?? 0n;
      sumCoral2Ips += pt.coral2Ips ?? 0n;
      sumCoral1LatP50 += pt.coral1LatencyP50Us ?? 0n;
      sumCoral2LatP50 += pt.coral2LatencyP50Us ?? 0n;
    }

    const countBig = BigInt(chunk.length);
    const isLastChunk = i + bucketSize >= rawPoints.length;

    downsampled.push({
      timestampMs: isLastChunk ? lastPoint.timestampMs : midPoint.timestampMs,
      inferencesPerSecond: sumIps / countBig,
      tapPacketsPerSecond: sumTap / countBig,
      latencyP50Us: sumLatP50 / countBig,
      latencyP99Us: sumLatP99 / countBig,
      // Council Invariant 2: Banish floating point from bandwidth metering. Strict BigInt integer units.
      usbThroughputKbps: sumUsb / countBig,
      coral1Ips: sumCoral1Ips / countBig,
      coral2Ips: sumCoral2Ips / countBig,
      coral1LatencyP50Us: sumCoral1LatP50 / countBig,
      coral2LatencyP50Us: sumCoral2LatP50 / countBig,
    });
  }

  return downsampled;
}

/**
 * Pure deterministic bucketing function to downsample an array of raw Workstation time-series points
 * into a bounded window of averaged points (Dean Latency & Ghemawat Memory Invariants).
 */
export function downsampleWorkstationPoints(
  rawPoints: readonly WorkstationTimeSeriesPoint[],
  maxPoints: number = 360
): WorkstationTimeSeriesPoint[] {
  if (rawPoints.length <= maxPoints) {
    return [...rawPoints];
  }

  const bucketSize = Math.ceil(rawPoints.length / maxPoints);
  const downsampled: WorkstationTimeSeriesPoint[] = [];

  for (let i = 0; i < rawPoints.length; i += bucketSize) {
    const chunk = rawPoints.slice(i, i + bucketSize);
    if (chunk.length === 0) continue;

    const midPoint = chunk[Math.floor(chunk.length / 2)];
    const lastPoint = chunk[chunk.length - 1];
    if (!midPoint || !lastPoint) continue;

    let sumCpu = 0;
    let sumGpu = 0;
    let sumGpuMem = 0n;
    let sumRam = 0n;
    let sumTok = 0;
    let sumPromptTok = 0;

    for (const pt of chunk) {
      sumCpu += pt.cpuUtilizationPct;
      sumGpu += pt.gpuUtilizationPct;
      sumGpuMem += BigInt(pt.gpuMemoryUsedBytes || 0);
      sumRam += BigInt(pt.ramUsedBytes || 0);
      sumTok += pt.tokensPerSecond;
      sumPromptTok += pt.promptTokensPerSecond;
    }

    const count = chunk.length;
    const countBig = BigInt(count);
    const isLastChunk = i + bucketSize >= rawPoints.length;
    // Council Invariant 2 (Deterministic Integer Arithmetic): Pure integer rounding with half-count offset.
    const halfCount = Math.floor(count / 2);

    downsampled.push({
      timestampMs: isLastChunk ? lastPoint.timestampMs : midPoint.timestampMs,
      cpuUtilizationPct: Math.floor((sumCpu + halfCount) / count),
      gpuUtilizationPct: Math.floor((sumGpu + halfCount) / count),
      gpuMemoryUsedBytes: sumGpuMem / countBig,
      ramUsedBytes: sumRam / countBig,
      tokensPerSecond: Math.floor((sumTok + halfCount) / count),
      promptTokensPerSecond: Math.floor((sumPromptTok + halfCount) / count),
      totalPromptTokens: BigInt(lastPoint.totalPromptTokens || 0),
      totalCompletionTokens: BigInt(lastPoint.totalCompletionTokens || 0),
      totalTokens: BigInt(lastPoint.totalTokens || 0),
    });
  }

  return downsampled;
}

export interface MultiDeviceHistoricalTelemetry {
  readonly timeSeries: ZodiacTimeSeriesPoint[];
  readonly jetsonTimeSeries: JetsonTimeSeriesPoint[];
  readonly coralTimeSeries: CoralTimeSeriesPoint[];
  readonly workstationTimeSeries: WorkstationTimeSeriesPoint[];
}

function parseHistoricalJetsonPoint(raw: unknown, defaultTimestampMs: number): JetsonTimeSeriesPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  return {
    timestampMs: typeof p['timestampMs'] === 'number' ? p['timestampMs'] : defaultTimestampMs,
    cpuUtilizationPct: Number(p['cpuUtilizationPct'] ?? 0),
    gpuUtilizationPct: Number(p['gpuUtilizationPct'] ?? 0),
    cpuTempC: Number(p['cpuTempC'] ?? 0),
    gpuTempC: Number(p['gpuTempC'] ?? 0),
    junctionTempC: Number(p['junctionTempC'] ?? 0),
    powerWatts: Number(p['powerWatts'] ?? 0),
    ramUsedBytes: BigInt(String(p['ramUsedBytes'] ?? 0)),
    nvmeReadRateBps: BigInt(String(p['nvmeReadRateBps'] ?? 0)),
    nvmeWriteRateBps: BigInt(String(p['nvmeWriteRateBps'] ?? 0)),
    sdnPortRateBps: BigInt(String(p['sdnPortRateBps'] ?? 0)),
    wifiPortRateBps: BigInt(String(p['wifiPortRateBps'] ?? 0)),
  };
}

function parseHistoricalCoralPoint(raw: unknown, defaultTimestampMs: number): CoralTimeSeriesPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  return {
    timestampMs: typeof p['timestampMs'] === 'number' ? p['timestampMs'] : defaultTimestampMs,
    inferencesPerSecond: BigInt(String(p['inferencesPerSecond'] ?? 0)),
    tapPacketsPerSecond: BigInt(String(p['tapPacketsPerSecond'] ?? 0)),
    latencyP50Us: BigInt(String(p['latencyP50Us'] ?? 0)),
    latencyP99Us: BigInt(String(p['latencyP99Us'] ?? 0)),
    usbThroughputKbps: BigInt(String(p['usbThroughputKbps'] ?? 0)),
    coral1Ips: BigInt(String(p['coral1Ips'] ?? 0)),
    coral2Ips: BigInt(String(p['coral2Ips'] ?? 0)),
    coral1LatencyP50Us: BigInt(String(p['coral1LatencyP50Us'] ?? 0)),
    coral2LatencyP50Us: BigInt(String(p['coral2LatencyP50Us'] ?? 0)),
  };
}

// Council Invariant 2: accepts both JSON number and string-encoded number (e.g. from legacy agents),
// rejects NaN / Infinity / non-numeric strings. Returns null so callers drop the point rather than
// propagating a corrupt value into downstream SLA aggregations.
function parseFiniteInt(raw: unknown): number | null {
  // Empty/whitespace strings must be rejected before Number() coercion: Number("") === 0,
  // which would pass isFinite and silently record a fabricated zero into SLA aggregations.
  const n = typeof raw === 'number' ? raw
          : (typeof raw === 'string' && raw.trim() !== '') ? Number(raw)
          : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function parseHistoricalWorkstationPoint(raw: unknown, defaultTimestampMs: number): WorkstationTimeSeriesPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const cpuUtil = parseFiniteInt(p['cpuUtilizationPct']);
  const gpuUtil = parseFiniteInt(p['gpuUtilizationPct']);
  const tps     = parseFiniteInt(p['tokensPerSecond']);
  const ptps    = parseFiniteInt(p['promptTokensPerSecond']);
  if (cpuUtil === null || gpuUtil === null || tps === null || ptps === null) return null;
  return {
    timestampMs: typeof p['timestampMs'] === 'number' ? p['timestampMs'] : defaultTimestampMs,
    cpuUtilizationPct: cpuUtil,
    gpuUtilizationPct: gpuUtil,
    gpuMemoryUsedBytes: BigInt(String(p['gpuMemoryUsedBytes'] ?? 0)),
    ramUsedBytes: BigInt(String(p['ramUsedBytes'] ?? 0)),
    tokensPerSecond: tps,
    promptTokensPerSecond: ptps,
    totalPromptTokens: BigInt(String(p['totalPromptTokens'] ?? 0)),
    totalCompletionTokens: BigInt(String(p['totalCompletionTokens'] ?? 0)),
    totalTokens: BigInt(String(p['totalTokens'] ?? 0)),
  };
}

/**
 * Fetches historical telemetry from Neon Postgres within the specified time range for all appliances
 * (Zodiac FX switch, NVIDIA Jetson Orin Nano, Google Coral Edge TPU),
 * applying time-bucketed aggregation to guarantee <= 360 points in the response.
 */
export async function getHistoricalMultiDeviceTelemetry(
  range: '1h' | '6h' | '24h' | '7d' | '30d'
): Promise<MultiDeviceHistoricalTelemetry> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return { timeSeries: [], jetsonTimeSeries: [], coralTimeSeries: [], workstationTimeSeries: [] };
  }

  const config = RANGE_CONFIGS[range] ?? { bucketSeconds: 300, maxPoints: 288 };
  const durationMs = RANGE_DURATION_MS[range] ?? (24 * 60 * 60 * 1000);
  const cutoffMs = BigInt(Date.now() - durationMs);
  const bucketMs = BigInt(config.bucketSeconds * 1000);

  const queryPromise = prisma.$queryRaw<Array<{
      bucketTime: bigint;
      cpuTemperatureC: number | null;
      latencyNs: bigint | null;
      totalRxBytes: bigint | null;
      totalTxBytes: bigint | null;
      totalRxPackets: bigint | null;
      totalTxPackets: bigint | null;
      rxRatePps: bigint | null;
      txRatePps: bigint | null;
      rxRateBps: bigint | null;
      txRateBps: bigint | null;
      jetsonJson: unknown;
      coralJson: unknown;
      workstationJson: unknown;
    }>>(
      Prisma.sql`
        WITH RawWindow AS (
          SELECT
            (FLOOR("timestampMs" / ${bucketMs}) * ${bucketMs})::bigint AS "bucketTime",
            "timestampMs",
            "cpuTemperatureC",
            "latencyNs",
            "totalRxBytes",
            "totalTxBytes",
            "totalRxPackets",
            "totalTxPackets",
            "rxRatePps",
            "txRatePps",
            "rxRateBps",
            "txRateBps",
            "jetsonJson",
            "coralJson",
            "workstationJson"
          FROM "ZodiacTelemetryPoint"
          WHERE "timestampMs" >= ${cutoffMs}
        ),
        BucketAgg AS (
          SELECT
            "bucketTime",
            ROUND(AVG("cpuTemperatureC"))::int AS "cpuTemperatureC",
            CAST(COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY "latencyNs"), 0) AS BIGINT) AS "latencyNs",
            MAX("totalRxBytes") AS "totalRxBytes",
            MAX("totalTxBytes") AS "totalTxBytes",
            MAX("totalRxPackets") AS "totalRxPackets",
            MAX("totalTxPackets") AS "totalTxPackets",
            CAST(COALESCE(AVG("rxRatePps"), 0) AS BIGINT) AS "rxRatePps",
            CAST(COALESCE(AVG("txRatePps"), 0) AS BIGINT) AS "txRatePps",
            CAST(COALESCE(AVG("rxRateBps"), 0) AS BIGINT) AS "rxRateBps",
            CAST(COALESCE(AVG("txRateBps"), 0) AS BIGINT) AS "txRateBps"
          FROM RawWindow
          GROUP BY "bucketTime"
        ),
        LatestJsonPerBucket AS (
          SELECT DISTINCT ON ("bucketTime")
            "bucketTime",
            "jetsonJson",
            "coralJson",
            "workstationJson"
          FROM RawWindow
          ORDER BY "bucketTime", "timestampMs" DESC
        )
        SELECT
          b."bucketTime",
          b."cpuTemperatureC",
          b."latencyNs",
          b."totalRxBytes",
          b."totalTxBytes",
          b."totalRxPackets",
          b."totalTxPackets",
          b."rxRatePps",
          b."txRatePps",
          b."rxRateBps",
          b."txRateBps",
          j."jetsonJson",
          j."coralJson",
          j."workstationJson"
        FROM BucketAgg b
        LEFT JOIN LatestJsonPerBucket j ON b."bucketTime" = j."bucketTime"
        ORDER BY b."bucketTime" ASC
        LIMIT ${config.maxPoints};
      `
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Historical telemetry DB query timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
      t.unref?.();
    });

    queryPromise.catch((err: unknown) => {
      // Council Invariant 1: Catch background query failure post-timeout
      console.warn('[!] [Telemetry DB] Background query rejected post-timeout:', err instanceof Error ? err.message : String(err));
    });

    const rows = await Promise.race([queryPromise, timeoutPromise]);

    const timeSeries: ZodiacTimeSeriesPoint[] = [];
    const jetsonTimeSeries: JetsonTimeSeriesPoint[] = [];
    const coralTimeSeries: CoralTimeSeriesPoint[] = [];
    const workstationTimeSeries: WorkstationTimeSeriesPoint[] = [];

    for (const r of rows) {
      const bucketTime = Number(r.bucketTime);
      timeSeries.push({
        timestampMs: bucketTime,
        rxBytes: r.totalRxBytes ?? 0n,
        txBytes: r.totalTxBytes ?? 0n,
        rxPackets: r.totalRxPackets ?? 0n,
        txPackets: r.totalTxPackets ?? 0n,
        rxRatePps: r.rxRatePps ?? 0n,
        txRatePps: r.txRatePps ?? 0n,
        rxRateBps: r.rxRateBps ?? 0n,
        txRateBps: r.txRateBps ?? 0n,
        cpuTemperatureC: r.cpuTemperatureC ?? null,
        latencyNs: r.latencyNs ?? 0n,
      });

      const jp = parseHistoricalJetsonPoint(r.jetsonJson, bucketTime);
      if (jp) jetsonTimeSeries.push(jp);

      const cp = parseHistoricalCoralPoint(r.coralJson, bucketTime);
      if (cp) coralTimeSeries.push(cp);

      const wp = parseHistoricalWorkstationPoint(r.workstationJson, bucketTime);
      if (wp) workstationTimeSeries.push(wp);
    }

  return {
    timeSeries,
    jetsonTimeSeries,
    coralTimeSeries,
    workstationTimeSeries,
  };
  // Errors propagate to the caller (api/zodiac.ts range handler) so it can decide
  // the appropriate fallback. Swallowing DB failures would silently serve "zero history"
  // and corrupt downstream aggregations or SLA monitors that rely on this series.
}

/**
 * Fetches historical telemetry from Neon Postgres within the specified time range,
 * applying time-bucketed aggregation to guarantee < 360 points in the response.
 */
export async function getHistoricalTelemetry(
  range: '1h' | '6h' | '24h' | '7d' | '30d'
): Promise<ZodiacTimeSeriesPoint[]> {
  const result = await getHistoricalMultiDeviceTelemetry(range);
  return result.timeSeries;
}

/**
 * Prunes records older than retentionDays (default 30 days) to prevent table bloat.
 * Uses indexed BigInt timestampMs column for fast, sub-second execution.
 */
export async function pruneOldTelemetry(retentionDays: number = 30): Promise<number> {
  const prisma = getPrismaClient();
  if (!prisma) return 0;

  const cutoffMs = BigInt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const result = await prisma.zodiacTelemetryPoint.deleteMany({
      where: {
        timestampMs: { lt: cutoffMs },
      },
    });
    return result.count;
  } catch (err: unknown) {
    console.warn('[!] [Telemetry DB] Pruning error:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/**
 * Upserts operator user records upon successful Google SSO authentication.
 */
export async function upsertUser(
  email: string,
  name?: string | null,
  picture?: string | null
): Promise<{ id: string; email: string; name: string | null; role: string } | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  try {
    const updateData: { lastLoginAt: Date; name?: string; picture?: string } = {
      lastLoginAt: new Date(),
    };
    if (name) updateData.name = name;
    if (picture) updateData.picture = picture;

    const user = await prisma.user.upsert({
      where: { email },
      update: updateData,
      create: {
        email,
        name: name ?? null,
        picture: picture ?? null,
        role: 'operator',
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
    return user;
  } catch (err: unknown) {
    console.warn('[!] [User DB] Failed to upsert user record:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
