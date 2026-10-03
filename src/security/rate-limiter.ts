/**
 * src/security/rate-limiter.ts
 * Phase 0.6B — Token-bucket edge rate limiter (in-memory, per-IP, sliding window).
 *
 * Council Invariants:
 * - Ghemawat: Zero external dependencies — pure Node.js built-ins.
 * - Dean: process.hrtime.bigint() for monotonic timing on the hot path.
 * - Hassabis: Fail-open on internal error — never block legitimate traffic due to
 *   limiter failure. Rate limiting is a defence layer, not a correctness gate.
 *
 * Limitations: state is per-instance. On Vercel, each warm instance has its own
 * bucket map; cold starts reset all counters. This provides defence-in-depth
 * within a warm instance. The replay-protection layer (0.6C) provides an
 * independent, stateless defence against bulk replay attacks across instances.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

interface Bucket {
  tokens: number;   // current token count (float — fractional tokens accumulate between requests)
  lastNs: bigint;   // monotonic timestamp of last refill (process.hrtime.bigint())
}

const _buckets = new Map<string, Bucket>();

// Cleanup cadence: evict buckets idle for >2 minutes every 2 minutes.
const _BUCKET_TTL_NS = 120_000_000_000n;       // 2 minutes in ns
const _CLEANUP_INTERVAL_NS = 120_000_000_000n;
let _lastCleanupNs = process.hrtime.bigint();

function _cleanup(): void {
  const nowNs = process.hrtime.bigint();
  if (nowNs - _lastCleanupNs < _CLEANUP_INTERVAL_NS) return;
  _lastCleanupNs = nowNs;
  for (const [key, b] of _buckets) {
    if (nowNs - b.lastNs > _BUCKET_TTL_NS) _buckets.delete(key);
  }
}

/**
 * Token-bucket rate check. Returns allowed=true and consumes one token, or
 * allowed=false with seconds until the next token is available.
 *
 * elapsed nanoseconds (Number cast from BigInt) is safe for our 2-minute eviction
 * window: max value is 1.2×10^11 ns, well below Number.MAX_SAFE_INTEGER (~9×10^15).
 */
export function checkRateLimit(
  ip: string,
  limitPerMin: number,
): { allowed: boolean; retryAfterSecs: number } {
  try {
    _cleanup();

    const nowNs = process.hrtime.bigint();
    // ns per token: 60 billion ns / limit — kept as a plain Number (exact for integer limits ≤ 2^53)
    const nsPerToken = 60_000_000_000 / limitPerMin;

    const b = _buckets.get(ip);
    if (b === undefined) {
      _buckets.set(ip, { tokens: limitPerMin - 1, lastNs: nowNs });
      return { allowed: true, retryAfterSecs: 0 };
    }

    const elapsedNs = Number(nowNs - b.lastNs);
    b.tokens = Math.min(limitPerMin, b.tokens + elapsedNs / nsPerToken);
    b.lastNs = nowNs;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSecs: 0 };
    }

    const retryAfterSecs = Math.ceil((1 - b.tokens) * nsPerToken / 1_000_000_000);
    return { allowed: false, retryAfterSecs };
  } catch (err: unknown) {
    // Fail-open: limiter errors must never block legitimate requests.
    console.warn('[!] [RateLimit] Internal error — failing open:', err instanceof Error ? err.message : String(err));
    return { allowed: true, retryAfterSecs: 0 };
  }
}

/** Extract the originating client IP, preferring Vercel's x-forwarded-for edge header. */
export function getClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Write a 429 response with deterministic Retry-After header. */
export function rejectRateLimited(res: ServerResponse, retryAfterSecs: number): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', String(retryAfterSecs));
  res.statusCode = 429;
  res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: retryAfterSecs }));
}
