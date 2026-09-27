/**
 * api/zodiac.ts
 * Vercel Serverless Function — Zodiac FX Telemetry Endpoint
 *
 * Provides real-time and cached telemetry snapshots for the Vercel web app.
 * Adheres to Council Invariants:
 * - Dean & Ghemawat: Deterministic serialization of 64-bit BigInt metrics.
 * - Hassabis & Ghemawat: Fail-Closed isolation & Default-Drop. All unhandled HTTP methods rejected with 405.
 * - Anti-Shortcut Law: Guaranteed serverless promise lifecycle, stream error listeners, and strict payload type guards.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createDefaultZodiacSnapshot,
  resolveVerifiedProvenance,
  CLOUD_RELAY_BOUNDS,
  type ZodiacFullTelemetrySnapshot,
} from '../src/sdn/zodiac-telemetry.js';
import { requireOperatorAuth, isLocalDev } from '../src/auth/google-auth.js';
import {
  persistTelemetrySnapshot,
  getHistoricalMultiDeviceTelemetry,
  isValidRange,
  isPersistingTelemetry,
  findCutoffIndex,
} from '../src/db/telemetry-db.js';

const MAX_PAYLOAD_BYTES = CLOUD_RELAY_BOUNDS.MAX_PAYLOAD_BYTES;
const MAX_SERVERLESS_BUFFER_POINTS = CLOUD_RELAY_BOUNDS.MAX_SERVERLESS_POINTS;

// In-memory cache for cloud serverless execution
let latestSnapshot: ZodiacFullTelemetrySnapshot = createDefaultZodiacSnapshot();

/**
 * Merges incoming time series points into existing in-memory buffer,
 * preserving continuity across bridge pushes and serverless invocations.
 * Sanjay Ghemawat Invariant: Strict monotone retention — never destroys
 * existing points when incoming payload contains identical or older timestamps.
 */
function mergeRollingSeries<T extends { timestampMs: number }>(
  existing: T[] | undefined,
  incoming: T[] | undefined,
  limit: number = MAX_SERVERLESS_BUFFER_POINTS
): T[] | undefined {
  if (!incoming || !Array.isArray(incoming) || incoming.length === 0) {
    return existing ? (existing.length > limit ? existing.slice(-limit) : existing) : undefined;
  }
  if (!existing || !Array.isArray(existing) || existing.length === 0) {
    return incoming.length > limit ? incoming.slice(-limit) : incoming;
  }
  const lastExistingTs = existing[existing.length - 1]?.timestampMs ?? 0;
  const newPoints = incoming.filter((p) => p.timestampMs > lastExistingTs);
  if (newPoints.length > 0) {
    const combined = existing.concat(newPoints);
    return combined.length > limit ? combined.slice(-limit) : combined;
  }
  // Council Invariant (Sanjay Ghemawat): If no strictly newer points are present
  // (lastIncomingTs <= lastExistingTs), ALWAYS retain existing buffer to prevent
  // destructive truncations of accumulated historical telemetry.
  return existing.length > limit ? existing.slice(-limit) : existing;
}

function serializeWithBigInt(obj: unknown): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

function isJsonObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidWorkstationPayload(val: unknown): boolean {
  if (!isJsonObject(val)) {
    return false;
  }
  if ('detected' in val && typeof val['detected'] !== 'boolean') {
    return false;
  }
  if ('cpuUtilizationPct' in val && (typeof val['cpuUtilizationPct'] !== 'number' || !Number.isFinite(val['cpuUtilizationPct']))) {
    return false;
  }
  if ('gpuUtilizationPct' in val && (typeof val['gpuUtilizationPct'] !== 'number' || !Number.isFinite(val['gpuUtilizationPct']))) {
    return false;
  }
  // Council Invariant 2 (Determinism in Telemetry): Wire token counters MUST serialize as decimal strings
  if ('totalTokens' in val && typeof val['totalTokens'] !== 'string') {
    return false;
  }
  if ('totalPromptTokens' in val && typeof val['totalPromptTokens'] !== 'string') {
    return false;
  }
  if ('totalCompletionTokens' in val && typeof val['totalCompletionTokens'] !== 'string') {
    return false;
  }
  if ('totalInferences' in val && typeof val['totalInferences'] !== 'string') {
    return false;
  }
  if ('tokensPerSecond' in val && (typeof val['tokensPerSecond'] !== 'number' || !Number.isFinite(val['tokensPerSecond']))) {
    return false;
  }
  if ('promptTokensPerSecond' in val && (typeof val['promptTokensPerSecond'] !== 'number' || !Number.isFinite(val['promptTokensPerSecond']))) {
    return false;
  }
  if ('timeSeries' in val && !Array.isArray(val['timeSeries'])) {
    return false;
  }
  return true;
}

function isValidTelemetryPayload(val: unknown): val is Partial<ZodiacFullTelemetrySnapshot> {
  if (!isJsonObject(val)) {
    return false;
  }
  if ('system' in val && !isJsonObject(val['system'])) {
    return false;
  }
  if ('ports' in val && !Array.isArray(val['ports'])) {
    return false;
  }
  if ('openflow' in val && !isJsonObject(val['openflow'])) {
    return false;
  }
  if ('timeSeries' in val && !Array.isArray(val['timeSeries'])) {
    return false;
  }
  if ('workstation' in val && !isValidWorkstationPayload(val['workstation'])) {
    return false;
  }
  return true;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS Headers for cloud / local bridging
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;

    try {
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesReceived += buf.length;
        if (bytesReceived > MAX_PAYLOAD_BYTES) {
          req.destroy();
          res.statusCode = 413;
          res.end(JSON.stringify({ error: 'Payload Too Large: Maximum telemetry push size is 256KB' }));
          return;
        }
        chunks.push(buf);
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `Request stream failure: ${err instanceof Error ? err.message : String(err)}` }));
      }
      return;
    }

    try {
      const body = Buffer.concat(chunks).toString('utf-8');
      const parsed: unknown = JSON.parse(body);

      if (!isValidTelemetryPayload(parsed)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid payload: telemetry snapshot must be a JSON object' }));
        return;
      }

      const isLoopback = isLocalDev(req);

      const bridgeSecret = typeof req.headers['x-zodiac-bridge-secret'] === 'string'
        ? req.headers['x-zodiac-bridge-secret']
        : undefined;

      const verifiedSource = resolveVerifiedProvenance(parsed.source, {
        isLoopback,
        bridgeSecret,
        expectedSecret: process.env['ZODIAC_BRIDGE_SECRET'],
      });

      const mergedZodiacSeries = mergeRollingSeries(
        latestSnapshot.timeSeries,
        parsed.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      ) ?? [];

      const mergedJetsonSeries = mergeRollingSeries(
        latestSnapshot.jetson?.timeSeries,
        parsed.jetson?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      const mergedCoralSeries = mergeRollingSeries(
        latestSnapshot.coral?.timeSeries,
        parsed.coral?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      const mergedWorkstationSeries = mergeRollingSeries(
        latestSnapshot.workstation?.timeSeries,
        parsed.workstation?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      latestSnapshot = {
        ...latestSnapshot,
        ...parsed,
        timeSeries: mergedZodiacSeries,
        source: verifiedSource,
        system: {
          ...latestSnapshot.system,
          ...(parsed.system ?? {}),
          timestampNs: process.hrtime.bigint(),
        },
        ...(parsed.jetson ? {
          jetson: {
            ...latestSnapshot.jetson,
            ...parsed.jetson,
            ...(mergedJetsonSeries ? { timeSeries: mergedJetsonSeries } : {}),
          }
        } : {}),
        ...(parsed.coral ? {
          coral: {
            ...latestSnapshot.coral,
            ...parsed.coral,
            ...(mergedCoralSeries ? { timeSeries: mergedCoralSeries } : {}),
          }
        } : {}),
        ...(parsed.workstation ? {
          workstation: {
            ...latestSnapshot.workstation,
            ...parsed.workstation,
            ...(mergedWorkstationSeries ? { timeSeries: mergedWorkstationSeries } : {}),
          }
        } : {}),
      };

      // Persist to Neon Postgres (10-second batched cadence, Ghemawat Backpressure Invariant)
      // In serverless, un-awaited promises are killed on res.end(), so await with a configurable Dean latency deadline.
      if (!isPersistingTelemetry()) {
        const timeoutMs = Number(process.env['TELEMETRY_PERSIST_TIMEOUT_MS'] ?? 1500);
        let timerId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<{ timedOut: true; error?: undefined }>((resolve) => {
          timerId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
          timerId.unref?.();
        });

        // Council Invariant: Prevent unhandled promise rejections if timeoutPromise wins the race
        const persistTask = persistTelemetrySnapshot(latestSnapshot)
          .then(() => ({ timedOut: false as const, error: undefined }))
          .catch((err: unknown) => {
            console.warn('[!] [DB] Telemetry persist to Neon failed:', err instanceof Error ? err.message : String(err));
            return { timedOut: false as const, error: err };
          });

        try {
          const raceResult = await Promise.race([
            persistTask,
            timeoutPromise,
          ]);
          if (raceResult.timedOut) {
            console.warn(`[!] [DB] Telemetry persist to Neon timed out after ${timeoutMs}ms`);
          }
        } finally {
          if (timerId !== undefined) {
            clearTimeout(timerId);
          }
        }
      }

      res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', synced: true, provenance: latestSnapshot.source }));
    } catch (err: unknown) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }));
    }
    return;
  }

  if (req.method === 'GET') {
    // Council Invariant 3: Fail-Closed Isolation & Operator Authentication Guard
    const user = requireOperatorAuth(req, res);
    if (!user) {
      return; // 401 response already handled by requireOperatorAuth
    }

    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);

    // Flow Rule Registry — served from cached snapshot pushed by the bridge
    if (url.searchParams.get('section') === 'flows') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
      res.statusCode = 200;
      res.end(JSON.stringify({
        dataSource: 'cloud_snapshot',
        note: 'Controller-pushed flow rules relayed from bridge. May be up to 30s stale.',
        rules: latestSnapshot.openflow.rules ?? [],
        totalRules: latestSnapshot.openflow.rules?.length ?? 0,
        timestamp: Date.now(),
      }));
      return;
    }

    // Historical Range Query from Neon Postgres (up to 30 days)
    const range = url.searchParams.get('range');
    if (isValidRange(range)) {
      const multi = await getHistoricalMultiDeviceTelemetry(range);
      if (multi.timeSeries.length > 0 || multi.jetsonTimeSeries.length > 0 || multi.coralTimeSeries.length > 0) {
        res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
        res.statusCode = 200;
        res.end(serializeWithBigInt({
          ...latestSnapshot,
          timeSeries: multi.timeSeries,
          ...(latestSnapshot.jetson ? {
            jetson: {
              ...latestSnapshot.jetson,
              timeSeries: multi.jetsonTimeSeries,
            },
          } : {}),
          ...(latestSnapshot.coral ? {
            coral: {
              ...latestSnapshot.coral,
              timeSeries: multi.coralTimeSeries,
            },
          } : {}),
        }));
        return;
      }
    }

    // Delta polling: ?since=<timestampMs> strips timeSeries to only points newer than
    // the client's last known timestamp. After the first full-payload request, each
    // subsequent 2s poll sends 1–2 new points (~1 KB) instead of all 360 (~80 KB),
    // reducing Vercel Fast Origin Transfer by ~98% on the Hobby plan.
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    // Math.floor enforces integer semantics: a float like 1700000000.5 would make
    // sinceMs + 1 = 1700000001.5, altering the strict > sinceMs boundary in trimSince.
    const sinceMs = Number.isFinite(sinceRaw) && sinceRaw > 0 && sinceRaw < Date.now()
      ? Math.floor(sinceRaw)
      : 0;

    if (sinceMs > 0) {
      // O(log N) binary search to the first point strictly newer than sinceMs,
      // then a single slice. Chronological sort invariant holds because mergeRollingSeries
      // only appends strictly-newer timestamps. Always returns T[] (never undefined)
      // to maintain a stable iterable API contract; returns [] when no new points exist.
      const trimSince = <T extends { readonly timestampMs: number }>(
        series: readonly T[] | undefined
      ): T[] => {
        if (!series || series.length === 0) return [];
        const idx = findCutoffIndex(series, sinceMs + 1);
        return series.slice(idx) as T[];
      };

      res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
      res.statusCode = 200;
      res.end(serializeWithBigInt({
        ...latestSnapshot,
        timeSeries: trimSince(latestSnapshot.timeSeries),
        ...(latestSnapshot.jetson ? {
          jetson: { ...latestSnapshot.jetson, timeSeries: trimSince(latestSnapshot.jetson.timeSeries) },
        } : {}),
        ...(latestSnapshot.coral ? {
          coral: { ...latestSnapshot.coral, timeSeries: trimSince(latestSnapshot.coral.timeSeries) },
        } : {}),
        ...(latestSnapshot.workstation ? {
          workstation: { ...latestSnapshot.workstation, timeSeries: trimSince(latestSnapshot.workstation.timeSeries) },
        } : {}),
      }));
      return;
    }

    res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
    res.statusCode = 200;
    res.end(serializeWithBigInt(latestSnapshot));
    return;
  }

  // Fail-Closed: Default Drop all unhandled HTTP methods (PUT, DELETE, PATCH, etc.)
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  res.statusCode = 405;
  res.end(JSON.stringify({
    error: `Method Not Allowed: ${req.method ?? 'UNKNOWN'}. Invariant: Fail-Closed Default Drop.`,
  }));
}
