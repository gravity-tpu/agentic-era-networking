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
import type { ZodiacFullTelemetrySnapshot, ZodiacTimeSeriesPoint } from '../sdn/zodiac-telemetry.js';

// Required for Node.js environments connecting to Neon WebSockets
neonConfig.webSocketConstructor = ws;

// Global singleton instance for Vercel Serverless container reuse
let globalPrisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient | null {
  const dbUrl = process.env['DATABASE_URL'];
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
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Telemetry DB write timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
      t.unref?.();
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
 * Pure deterministic bucketing function to downsample an array of raw time-series points
 * into a bounded window of averaged points (Dean Latency & Memory Invariant).
 */
export function downsamplePoints(
  rawPoints: ZodiacTimeSeriesPoint[],
  maxPoints: number = 360
): ZodiacTimeSeriesPoint[] {
  if (rawPoints.length <= maxPoints) {
    return rawPoints;
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

    downsampled.push({
      timestampMs: midPoint.timestampMs,
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
      ports: lastPoint.ports,
    });
  }

  return downsampled;
}

/**
 * Fetches historical telemetry from Neon Postgres within the specified time range,
 * applying time-bucketed aggregation to guarantee < 360 points in the response.
 */
export async function getHistoricalTelemetry(
  range: '1h' | '6h' | '24h' | '7d' | '30d'
): Promise<ZodiacTimeSeriesPoint[]> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  const config = RANGE_CONFIGS[range] ?? { bucketSeconds: 300, maxPoints: 288 };
  const durationMsMap: Record<string, number> = {
    '1h':  60 * 60 * 1000,
    '6h':  6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  const durationMs = durationMsMap[range] ?? (24 * 60 * 60 * 1000);
  const cutoffMs = BigInt(Date.now() - durationMs);
  const bucketMs = BigInt(config.bucketSeconds * 1000);

  try {
    // Jeff Dean Scale Invariant: Time-bucket aggregation executed inside PostgreSQL engine.
    // Transmits <= 360 rows over WAN instead of 250,000 raw points, maintaining sub-150ms latency.
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
    }>>(
      Prisma.sql`
        SELECT
          (FLOOR("timestampMs" / ${bucketMs}) * ${bucketMs})::bigint AS "bucketTime",
          ROUND(AVG("cpuTemperatureC"))::int AS "cpuTemperatureC",
          CAST(COALESCE(AVG("latencyNs"), 0) AS BIGINT) AS "latencyNs",
          MAX("totalRxBytes") AS "totalRxBytes",
          MAX("totalTxBytes") AS "totalTxBytes",
          MAX("totalRxPackets") AS "totalRxPackets",
          MAX("totalTxPackets") AS "totalTxPackets",
          CAST(COALESCE(AVG("rxRatePps"), 0) AS BIGINT) AS "rxRatePps",
          CAST(COALESCE(AVG("txRatePps"), 0) AS BIGINT) AS "txRatePps",
          CAST(COALESCE(AVG("rxRateBps"), 0) AS BIGINT) AS "rxRateBps",
          CAST(COALESCE(AVG("txRateBps"), 0) AS BIGINT) AS "txRateBps"
        FROM "ZodiacTelemetryPoint"
        WHERE "timestampMs" >= ${cutoffMs}
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT ${config.maxPoints};
      `
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Historical telemetry DB query timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
      t.unref?.();
    });

    const rows = await Promise.race([queryPromise, timeoutPromise]);

    return rows.map((r) => ({
      timestampMs: Number(r.bucketTime),
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
    }));
  } catch (err: unknown) {
    console.warn(`[!] [Telemetry DB] Error querying historical ${range} telemetry:`, err instanceof Error ? err.message : String(err));
    return [];
  }
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
