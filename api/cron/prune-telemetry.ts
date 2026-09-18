/**
 * api/cron/prune-telemetry.ts
 * Vercel Serverless Function — Scheduled 30-Day Telemetry Pruning Engine
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Bounded database table footprint. Enforces 30-day retention SLA.
 * - Hassabis & Ghemawat: Fail-Closed Isolation. Unauthenticated invocations rejected with 401.
 * - Anti-Shortcut Law: Guaranteed execution lifecycle, deterministic status responses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { pruneOldTelemetry } from '../../src/db/telemetry-db.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Content-Type', 'application/json');

  // Fail-Closed: Default Drop on unsupported methods
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.statusCode = 405;
    res.end(JSON.stringify({
      error: `Method Not Allowed: ${req.method ?? 'UNKNOWN'}. Invariant: Fail-Closed Default Drop.`,
    }));
    return;
  }

  // Authentication Verification (Vercel Cron Secret - Fail-Closed Zero-Trust)
  const cronSecret = process.env['CRON_SECRET'];
  const authHeader = req.headers['authorization'];

  // Fail-Closed Default (Demis Hassabis): All cron endpoints require explicit Bearer authentication.
  // If CRON_SECRET is not configured or token does not match, reject immediately.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({
      error: 'Unauthorized: Missing or invalid Bearer CRON_SECRET token. Invariant: Fail-Closed Default Drop.',
    }));
    return;
  }

  try {
    const retentionDays = 30;
    const prunedCount = await pruneOldTelemetry(retentionDays);

    res.statusCode = 200;
    res.end(JSON.stringify({
      status: 'ok',
      prunedCount,
      retentionDays,
      executedAt: new Date().toISOString(),
    }));
  } catch (err: unknown) {
    res.statusCode = 500;
    res.end(JSON.stringify({
      error: `Telemetry pruning failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }
}
