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
  type ZodiacFullTelemetrySnapshot,
} from '../dist/sdn/zodiac-telemetry.js';
import { requireOperatorAuth, isLocalDev } from '../dist/auth/google-auth.js';
import {
  persistTelemetrySnapshot,
  getHistoricalTelemetry,
  getHistoricalMultiDeviceTelemetry,
  isValidRange,
  isPersistingTelemetry,
} from '../dist/db/telemetry-db.js';

const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB (ample headroom for 120-point live history ~91KB)

// In-memory cache for cloud serverless execution
let latestSnapshot: ZodiacFullTelemetrySnapshot = createDefaultZodiacSnapshot();

function serializeWithBigInt(obj: unknown): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

function isValidTelemetryPayload(val: unknown): val is Partial<ZodiacFullTelemetrySnapshot> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    return false;
  }
  const obj = val as Record<string, unknown>;
  if ('system' in obj && (typeof obj['system'] !== 'object' || obj['system'] === null || Array.isArray(obj['system']))) {
    return false;
  }
  if ('ports' in obj && !Array.isArray(obj['ports'])) {
    return false;
  }
  if ('openflow' in obj && (typeof obj['openflow'] !== 'object' || obj['openflow'] === null || Array.isArray(obj['openflow']))) {
    return false;
  }
  if ('timeSeries' in obj && !Array.isArray(obj['timeSeries'])) {
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
    // Await stream processing inside a Promise to prevent premature serverless context freeze
    return new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;

      req.on('error', (err: Error) => {
        aborted = true;
        req.destroy();
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: `Request stream failure: ${err.message}` }));
        }
        resolve();
      });

      req.on('data', (chunk: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_PAYLOAD_BYTES) {
          aborted = true;
          req.destroy();
          res.statusCode = 413;
          res.end(JSON.stringify({ error: 'Payload Too Large: Maximum telemetry push size is 256KB' }));
          resolve();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted || res.headersSent) {
          resolve();
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const parsed: unknown = JSON.parse(body);

          if (!isValidTelemetryPayload(parsed)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid payload: telemetry snapshot must be a JSON object' }));
            resolve();
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

          const jetsonTimeSeries = Array.isArray(parsed.jetson?.timeSeries)
            ? parsed.jetson.timeSeries.slice(-120)
            : latestSnapshot.jetson?.timeSeries;

          const coralTimeSeries = Array.isArray(parsed.coral?.timeSeries)
            ? parsed.coral.timeSeries.slice(-120)
            : latestSnapshot.coral?.timeSeries;

          latestSnapshot = {
            ...latestSnapshot,
            ...parsed,
            timeSeries: Array.isArray(parsed.timeSeries)
              ? parsed.timeSeries.slice(-120)
              : latestSnapshot.timeSeries,
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
                ...(jetsonTimeSeries ? { timeSeries: jetsonTimeSeries } : {}),
              }
            } : {}),
            ...(parsed.coral ? {
              coral: {
                ...latestSnapshot.coral,
                ...parsed.coral,
                ...(coralTimeSeries ? { timeSeries: coralTimeSeries } : {}),
              }
            } : {}),
          };

          // Asynchronously persist to Neon Postgres (10-second batched cadence, Ghemawat Backpressure Invariant)
          if (!isPersistingTelemetry()) {
            persistTelemetrySnapshot(latestSnapshot).catch((err: unknown) => {
              console.error('[!] [DB] Telemetry persist to Neon failed:', err instanceof Error ? err.message : String(err));
            });
          }

          res.setHeader('X-Telemetry-Provenance', latestSnapshot.source);
          res.statusCode = 200;
          res.end(JSON.stringify({ status: 'ok', synced: true, provenance: latestSnapshot.source }));
        } catch (err: unknown) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }));
        } finally {
          resolve();
        }
      });
    });
  }

  if (req.method === 'GET') {
    // Council Invariant 3: Fail-Closed Isolation & Operator Authentication Guard
    const user = requireOperatorAuth(req, res);
    if (!user) {
      return; // 401 response already handled by requireOperatorAuth
    }

    // Historical Range Query from Neon Postgres (up to 30 days)
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
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
