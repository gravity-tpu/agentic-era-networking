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

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB

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

          const remoteIp = req.socket.remoteAddress ?? '';
          const isLoopback =
            remoteIp === '127.0.0.1' ||
            remoteIp === '::1' ||
            remoteIp === '::ffff:127.0.0.1' ||
            req.headers.host?.startsWith('localhost') === true ||
            req.headers.host?.startsWith('127.0.0.1') === true;

          const bridgeSecret = typeof req.headers['x-zodiac-bridge-secret'] === 'string'
            ? req.headers['x-zodiac-bridge-secret']
            : undefined;

          const verifiedSource = resolveVerifiedProvenance(parsed.source, {
            isLoopback,
            bridgeSecret,
            expectedSecret: process.env['ZODIAC_BRIDGE_SECRET'],
          });

          latestSnapshot = {
            ...latestSnapshot,
            ...parsed,
            source: verifiedSource,
            system: {
              ...latestSnapshot.system,
              ...(parsed.system ?? {}),
              timestampNs: process.hrtime.bigint(),
            },
          };
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
