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
  type WorkstationTimeSeriesPoint,
} from '../src/sdn/zodiac-telemetry.js';
import { requireOperatorAuth, isLocalDev, IS_PRODUCTION } from '../src/auth/google-auth.js';
import { checkRateLimit, getClientIp, rejectRateLimited } from '../src/security/rate-limiter.js';
import { verifyBridgeAttestation } from '../src/security/request-attestation.js';
import {
  INITIAL_RELAY_AUTHORITY,
  decideRelayPush,
  isRelayLiveFresh,
  nextRelayAuthority,
  readBridgeId,
  type IncomingPush,
  type RelayAuthorityState,
} from '../src/sdn/relay-authority.js';
import {
  persistTelemetrySnapshot,
  getHistoricalMultiDeviceTelemetry,
  getLatestTelemetrySnapshotFromDb,
  hasFreshLiveTelemetryRow,
  isValidRange,
  isPersistingTelemetry,
  findCutoffIndex,
  downsampleWorkstationPoints,
  RANGE_CONFIGS,
  RANGE_DURATION_MS,
} from '../src/db/telemetry-db.js';

const MAX_PAYLOAD_BYTES = CLOUD_RELAY_BOUNDS.MAX_PAYLOAD_BYTES;
const MAX_SERVERLESS_BUFFER_POINTS = CLOUD_RELAY_BOUNDS.MAX_SERVERLESS_POINTS;

// In-memory cache for cloud serverless execution
let latestSnapshot: ZodiacFullTelemetrySnapshot = createDefaultZodiacSnapshot();

// Which relay pushes may overwrite latestSnapshot (see src/sdn/relay-authority.ts). Per instance, like latestSnapshot;
// the shared database covers the instances that have not seen the real bridge.
let relayAuthority: RelayAuthorityState = INITIAL_RELAY_AUTHORITY;
let ignoredPushesSinceLog = 0;
let lastIgnoredLogMs = 0;
const IGNORED_PUSH_LOG_INTERVAL_MS = 60_000;

/**
 * Merges incoming time series points into existing in-memory buffer,
 * preserving continuity across bridge pushes and serverless invocations.
 * Sanjay Ghemawat Invariant: Cache-friendly flat O(N) two-pointer merge with strict deduplication.
 * Bounded to limit while preserving the earliest historical anchor if truncating.
 */
export function mergeRollingSeries<T extends { readonly timestampMs: number }>(
  existing: readonly T[] | undefined,
  incoming: readonly T[] | undefined,
  limit: number = MAX_SERVERLESS_BUFFER_POINTS
): readonly T[] | undefined {
  if (!incoming || !Array.isArray(incoming) || incoming.length === 0) {
    return existing ? (existing.length > limit ? existing.slice(-limit) : existing) : undefined;
  }
  if (!existing || !Array.isArray(existing) || existing.length === 0) {
    return incoming.length > limit ? incoming.slice(-limit) : incoming;
  }

  // Sanjay Ghemawat Invariant: Flat O(N) two-pointer merge with zero heap churn
  const result: T[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < incoming.length) {
    const pExisting = existing[i]!;
    const pIncoming = incoming[j]!;
    if (pExisting.timestampMs < pIncoming.timestampMs) {
      result.push(pExisting);
      i++;
    } else if (pExisting.timestampMs > pIncoming.timestampMs) {
      result.push(pIncoming);
      j++;
    } else {
      // Identical timestamp: favor incoming payload (live physical truth)
      result.push(pIncoming);
      i++;
      j++;
    }
  }
  while (i < existing.length) {
    result.push(existing[i]!);
    i++;
  }
  while (j < incoming.length) {
    result.push(incoming[j]!);
    j++;
  }

  if (result.length <= limit) {
    return result;
  }

  // Bounded buffer with anchor preservation: if truncation is required,
  // ensure the historical anchor (result[0]) is preserved alongside recent live points.
  const sliced = result.slice(-(limit - 1));
  const anchor = result[0];
  if (anchor && sliced[0] && anchor.timestampMs < sliced[0].timestampMs) {
    return [anchor, ...sliced];
  }
  return result.slice(-limit);
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
  if ('tokensPerSecond' in val && (typeof val['tokensPerSecond'] !== 'number' || !Number.isInteger(val['tokensPerSecond']))) {
    return false;
  }
  if ('promptTokensPerSecond' in val && (typeof val['promptTokensPerSecond'] !== 'number' || !Number.isInteger(val['promptTokensPerSecond']))) {
    return false;
  }
  if ('timeSeries' in val && !Array.isArray(val['timeSeries'])) {
    return false;
  }
  return true;
}

function isValidSafeCounter(val: unknown): boolean {
  return typeof val === 'string' || typeof val === 'bigint' || (typeof val === 'number' && Number.isSafeInteger(val));
}

function isValidRpi5InterfacePayload(iface: unknown): boolean {
  if (!isJsonObject(iface)) return false;
  if ('name' in iface && typeof iface['name'] !== 'string') return false;
  if ('status' in iface && typeof iface['status'] !== 'string') return false;
  const counterKeys = [
    'rxBytes', 'txBytes', 'rxPackets', 'txPackets',
    'rxRateBps', 'txRateBps', 'rxRatePps', 'txRatePps',
    'rxDropped', 'txDropped', 'rxErrors', 'txErrors'
  ];
  for (const k of counterKeys) {
    if (k in iface && !isValidSafeCounter(iface[k])) {
      return false;
    }
  }
  return true;
}

function isValidRpi5Payload(val: unknown): boolean {
  if (!isJsonObject(val)) {
    return false;
  }
  if ('status' in val && typeof val['status'] !== 'string') {
    return false;
  }
  // Council Invariants 2 & 3: Fail-closed deep validation of nested interface telemetry
  if ('interfaces' in val) {
    if (!Array.isArray(val['interfaces'])) return false;
    for (const iface of val['interfaces']) {
      if (!isValidRpi5InterfacePayload(iface)) return false;
    }
  }
  if ('timeSeries' in val && !Array.isArray(val['timeSeries'])) {
    return false;
  }
  if ('hailo' in val && isJsonObject(val['hailo'])) {
    const h = val['hailo'];
    // Council Invariant 2 (Determinism & Monotonic Clocks - Jeff Dean):
    // Latency must be measured and transmitted in monotonic integer nanoseconds (BigInt/safe integer).
    // Floating-point representations for latency telemetry are strictly forbidden.
    if ('avgInferenceLatencyNs' in h && !isValidSafeCounter(h['avgInferenceLatencyNs'])) {
      return false;
    }
    if ('avgInferenceLatencyMs' in h && !isValidSafeCounter(h['avgInferenceLatencyMs'])) {
      return false;
    }
    if ('totalInferences' in h && !isValidSafeCounter(h['totalInferences'])) {
      return false;
    }
    if ('inferencesPerSecond' in h && !isValidSafeCounter(h['inferencesPerSecond'])) {
      return false;
    }
  }
  // Council Invariant 2 (Determinism): Allow decimal string, BigInt, or safe integer number to prevent float precision loss
  if ('ramUsedBytes' in val && !isValidSafeCounter(val['ramUsedBytes'])) {
    return false;
  }
  if ('ramTotalBytes' in val && !isValidSafeCounter(val['ramTotalBytes'])) {
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
  if ('rpi5' in val && !isValidRpi5Payload(val['rpi5'])) {
    return false;
  }
  return true;
}

// One-time deprecation notice flag: logged once per warm instance when a POST arrives

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 0.6B — Per-IP rate limiting before any processing.
  if (req.method === 'GET' || req.method === 'POST') {
    const ip = getClientIp(req);
    const limit = req.method === 'GET' ? 120 : 60;
    const rl = checkRateLimit(ip, limit);
    if (!rl.allowed) {
      rejectRateLimited(res, rl.retryAfterSecs);
      return;
    }
  }

  // CORS Headers for cloud / local bridging
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
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
      const bodyBuf = Buffer.concat(chunks);

      // 0.6C — HMAC replay protection: fail-closed when secret is configured.
      // If ZODIAC_BRIDGE_SECRET is set, ALL relays must carry valid attestation headers.
      // Missing or invalid headers → 401. If the secret is absent, attestation is disabled
      // (bootstrap / unconfigured state) and a warning is emitted on every request.
      const secret = process.env['ZODIAC_BRIDGE_SECRET'];
      if (secret) {
        const tsHeader = req.headers['x-timestamp-ns'];
        const sigHeader = req.headers['x-zodiac-signature'];
        const attestation = verifyBridgeAttestation(tsHeader, sigHeader, bodyBuf, secret);
        if (!attestation.valid) {
          console.warn(`[!] [Attestation] Bridge relay rejected: ${attestation.reason}`);
          res.statusCode = 401;
          res.end(JSON.stringify({ error: `Attestation failed: ${attestation.reason}` }));
          return;
        }
      } else if (IS_PRODUCTION) {
        // Production with no secret — INV-002 fail-closed: misconfigured environment must not accept relay payloads.
        console.error('[!] [Attestation] ZODIAC_BRIDGE_SECRET not configured in production — dropping relay (INV-002).');
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Server misconfiguration: ZODIAC_BRIDGE_SECRET not configured' }));
        return;
      } else {
        console.warn('[!] [Attestation] ZODIAC_BRIDGE_SECRET not set — replay protection inactive (local dev only).');
      }

      const body = bodyBuf.toString('utf-8');
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

      // Which pushes may overwrite the live snapshot: a push with no hardware behind it (for example a development
      // bridge on a laptop pointed at production) must not displace a fresh live snapshot or have its series merged in.
      const nowMs = Date.now();
      const staleMs = CLOUD_RELAY_BOUNDS.BRIDGE_PUSH_CADENCE_MS * CLOUD_RELAY_BOUNDS.MAX_MISSED_PUSH_CYCLES;
      const incoming: IncomingPush = { verifiedSource, bridgeId: readBridgeId(parsed) };
      // Instances do not share memory: if this one has not seen the real bridge, ask the shared database, but only for
      // a non-live push (the rare path), never for the real bridge's own pushes.
      const dbLiveFresh =
        verifiedSource !== 'live_hardware' && !isRelayLiveFresh(relayAuthority, nowMs, staleMs)
          ? await hasFreshLiveTelemetryRow(staleMs)
          : false;
      const relayDecision = decideRelayPush(relayAuthority, incoming, nowMs, staleMs, dbLiveFresh);
      if (!relayDecision.accept) {
        ignoredPushesSinceLog += 1;
        if (nowMs - lastIgnoredLogMs >= IGNORED_PUSH_LOG_INTERVAL_MS) {
          console.warn(
            `[!] [Relay] Ignored ${ignoredPushesSinceLog} non-live push(es) from bridge ${incoming.bridgeId ?? 'unknown'} ` +
              `(${verifiedSource}) while a live snapshot is fresh. A second bridge is pushing to this endpoint.`,
          );
          lastIgnoredLogMs = nowMs;
          ignoredPushesSinceLog = 0;
        }
        res.setHeader('X-Relay-Decision', 'ignored');
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'ignored', synced: false, reason: relayDecision.reason, provenance: latestSnapshot.source }));
        return;
      }
      if (relayDecision.competingLive) {
        console.warn(`[!] [Relay] Two live bridges are pushing to this endpoint (now ${incoming.bridgeId ?? 'unknown'}); the dashboard will alternate between their views.`);
      }
      relayAuthority = nextRelayAuthority(relayAuthority, incoming, relayDecision, nowMs);

      // Council Invariant 6 (Anti-Simulation Law): If transitioning from synthetic cloud_snapshot
      // to verified live_hardware, discard synthetic rolling points entirely so fake waves
      // never pollute live telemetry buffers.
      const isFirstLivePush = latestSnapshot.source === 'cloud_snapshot' && verifiedSource === 'live_hardware';

      const existingZodiacSeries = isFirstLivePush ? undefined : latestSnapshot.timeSeries;
      const existingJetsonSeries = isFirstLivePush ? undefined : latestSnapshot.jetson?.timeSeries;
      const existingCoralSeries = isFirstLivePush ? undefined : latestSnapshot.coral?.timeSeries;
      const existingWorkstationSeries = isFirstLivePush ? undefined : latestSnapshot.workstation?.timeSeries;
      const existingRpi5Series = isFirstLivePush ? undefined : latestSnapshot.rpi5?.timeSeries;

      const mergedZodiacSeries = mergeRollingSeries(
        existingZodiacSeries,
        parsed.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      ) ?? [];

      const mergedJetsonSeries = mergeRollingSeries(
        existingJetsonSeries,
        parsed.jetson?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      const mergedCoralSeries = mergeRollingSeries(
        existingCoralSeries,
        parsed.coral?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      const mergedWorkstationSeries = mergeRollingSeries(
        existingWorkstationSeries,
        parsed.workstation?.timeSeries,
        MAX_SERVERLESS_BUFFER_POINTS
      );

      const mergedRpi5Series = mergeRollingSeries(
        existingRpi5Series,
        parsed.rpi5?.timeSeries,
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
        ports: (parsed.ports && parsed.ports.length > 0) ? parsed.ports : latestSnapshot.ports,
        openflow: parsed.openflow ?? latestSnapshot.openflow,
        ...(parsed.jetson ? {
          jetson: {
            ...latestSnapshot.jetson,
            ...parsed.jetson,
            ...(mergedJetsonSeries ? { timeSeries: mergedJetsonSeries } : {}),
          }
        } : (latestSnapshot.jetson ? { jetson: latestSnapshot.jetson } : {})),
        ...(parsed.coral ? {
          coral: {
            ...latestSnapshot.coral,
            ...parsed.coral,
            ...(mergedCoralSeries ? { timeSeries: mergedCoralSeries } : {}),
          }
        } : (latestSnapshot.coral ? { coral: latestSnapshot.coral } : {})),
        ...(parsed.workstation ? {
          workstation: {
            ...latestSnapshot.workstation,
            ...parsed.workstation,
            ...(mergedWorkstationSeries ? { timeSeries: mergedWorkstationSeries } : {}),
          }
        } : (latestSnapshot.workstation ? { workstation: latestSnapshot.workstation } : {})),
        ...(parsed.rpi5 ? {
          rpi5: {
            ...latestSnapshot.rpi5,
            ...parsed.rpi5,
            ...(mergedRpi5Series ? { timeSeries: mergedRpi5Series } : {}),
          }
        } : (latestSnapshot.rpi5 ? { rpi5: latestSnapshot.rpi5 } : {})),
      };

      // Persist to Neon Postgres (10-second batched cadence, Ghemawat Backpressure Invariant)
      // In serverless, un-awaited promises are killed on res.end(), so await with a configurable Dean latency deadline.
      if (!isPersistingTelemetry()) {
        const timeoutMs = Number(process.env['TELEMETRY_PERSIST_TIMEOUT_MS'] ?? 5000);
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

    // Council Invariant 5 (Oriol Vinyals & Quoc Le - Adaptive Control & Hysteresis):
    // Hydrate latestSnapshot from Neon Postgres if local container memory has no live hardware
    // or if the local in-memory snapshot is older than the mathematically derived threshold.
    // Invariance under distribution shift: bounds are derived from CLOUD_RELAY_BOUNDS push cadence.
    const STALE_LOCAL_CACHE_THRESHOLD_MS = CLOUD_RELAY_BOUNDS.BRIDGE_PUSH_CADENCE_MS * CLOUD_RELAY_BOUNDS.MAX_MISSED_PUSH_CYCLES;
    const DB_HYDRATION_MAX_AGE_MS = CLOUD_RELAY_BOUNDS.DB_HYDRATION_SLA_MS;

    const latestPointTs = latestSnapshot.timeSeries?.at(-1)?.timestampMs ?? 0;
    const isLocalStale = latestSnapshot.source !== 'live_hardware' || (
      latestPointTs > 0 && Date.now() - latestPointTs > STALE_LOCAL_CACHE_THRESHOLD_MS
    );

    if (isLocalStale) {
      const dbSnapshot = await getLatestTelemetrySnapshotFromDb(DB_HYDRATION_MAX_AGE_MS);
      if (dbSnapshot) {
        // Overlay exactly what the bridge reported onto the current (disconnected) base; blocks the bridge did not send
        // stay as the base's honest "not detected" defaults. The row is only ever written from a live snapshot.
        latestSnapshot = { ...latestSnapshot, ...dbSnapshot, source: 'live_hardware' };
      }
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
      const config = RANGE_CONFIGS[range];
      const durationMs = RANGE_DURATION_MS[range];
      const cutoffMs = Date.now() - durationMs;
      // DB failure is non-fatal for the dashboard: fall through and serve the
      // current in-memory snapshot below rather than returning a 5xx.
      let multi: Awaited<ReturnType<typeof getHistoricalMultiDeviceTelemetry>> | null = null;
      try {
        multi = await getHistoricalMultiDeviceTelemetry(range);
      } catch (err: unknown) {
        console.warn('[!] [API] Historical DB query failed, serving in-memory snapshot:',
          err instanceof Error ? err.message : String(err));
      }
      if (!multi) {
        // DB unavailable — fall through to in-memory snapshot response below.
        res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
        res.statusCode = 200;
        res.end(serializeWithBigInt(latestSnapshot));
        return;
      }

      // Workstation: prefer DB-persisted history (covers 1h–30d);
      // fall back to in-memory for the current window if no DB rows yet.
      let workstationPoints: WorkstationTimeSeriesPoint[];
      if (multi.workstationTimeSeries.length > 0) {
        workstationPoints = downsampleWorkstationPoints(multi.workstationTimeSeries, config.maxPoints);
      } else {
        const wsSeries = latestSnapshot.workstation?.timeSeries ?? [];
        const windowedWorkstation = wsSeries.slice(findCutoffIndex(wsSeries, cutoffMs));
        workstationPoints = downsampleWorkstationPoints(windowedWorkstation, config.maxPoints);
      }

      if (multi.timeSeries.length > 0 || multi.jetsonTimeSeries.length > 0 || multi.coralTimeSeries.length > 0 || workstationPoints.length > 0) {
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
          ...(latestSnapshot.workstation ? {
            workstation: {
              ...latestSnapshot.workstation,
              timeSeries: workstationPoints,
            },
          } : {}),
          ...(latestSnapshot.rpi5 ? {
            rpi5: {
              ...latestSnapshot.rpi5,
              timeSeries: latestSnapshot.rpi5.timeSeries ? latestSnapshot.rpi5.timeSeries.slice(findCutoffIndex(latestSnapshot.rpi5.timeSeries, cutoffMs)) : [],
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
        ...(latestSnapshot.rpi5 ? {
          rpi5: { ...latestSnapshot.rpi5, timeSeries: trimSince(latestSnapshot.rpi5.timeSeries) },
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
