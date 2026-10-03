/**
 * src/security/request-attestation.ts
 * Phase 0.6C — HMAC-SHA256 replay-protection for the bridge→cloud telemetry relay.
 *
 * Signature scheme:
 *   message   = `${timestampNs}:${sha256_hex(body)}`
 *   signature = HMAC-SHA256(ZODIAC_BRIDGE_SECRET, message) as lowercase hex
 *
 * Wire headers:
 *   X-Timestamp-Ns:    wall-clock nanoseconds (BigInt(Date.now()) * 1_000_000n)
 *   X-Zodiac-Signature: lowercase hex HMAC
 *
 * Replay window: ±60 seconds (wall-clock comparison — both sides use Date.now()).
 * The bridge cannot use process.hrtime.bigint() because it is monotonic since
 * system boot and cannot be compared cross-process against the server's clock.
 *
 * Council Invariants:
 * - Hassabis: timingSafeEqual for all HMAC comparisons (prevent timing oracle attacks).
 * - Ghemawat: Zero dependencies — node:crypto only.
 * - Anti-Shortcut: malformed or stale payloads are rejected, never silently passed.
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_NS = 60_000_000_000n; // 60 seconds in nanoseconds

export interface AttestationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Sign a bridge relay payload.
 * Returns the X-Timestamp-Ns and X-Zodiac-Signature header values.
 */
export function signBridgePayload(
  body: string,
  secret: string,
): { timestampNs: string; signature: string } {
  const timestampNs = (BigInt(Date.now()) * 1_000_000n).toString();
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const message = `${timestampNs}:${bodyHash}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { timestampNs, signature };
}

/**
 * Verify the attestation headers on an incoming bridge relay request.
 * Rejects if headers are missing, timestamp is stale, or HMAC does not match.
 */
export function verifyBridgeAttestation(
  timestampNsHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  body: Buffer,
  secret: string,
): AttestationResult {
  if (typeof timestampNsHeader !== 'string' || typeof signatureHeader !== 'string') {
    return { valid: false, reason: 'missing X-Timestamp-Ns or X-Zodiac-Signature header' };
  }

  let remoteNs: bigint;
  try {
    remoteNs = BigInt(timestampNsHeader);
  } catch {
    return { valid: false, reason: 'malformed X-Timestamp-Ns: not a valid integer' };
  }

  // Replay check: compare remote wall-clock ns against server wall-clock ns.
  const serverNs = BigInt(Date.now()) * 1_000_000n;
  const delta = remoteNs > serverNs ? remoteNs - serverNs : serverNs - remoteNs;
  if (delta > REPLAY_WINDOW_NS) {
    return { valid: false, reason: `timestamp outside ±60s replay window (delta: ${delta / 1_000_000n}ms)` };
  }

  // Recompute expected signature over the body as received.
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${timestampNsHeader}:${bodyHash}`;
  const expectedHex = createHmac('sha256', secret).update(message).digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  // Strip optional "sha256=" prefix for interoperability with webhook-style senders.
  const actualHex = signatureHeader.toLowerCase().replace(/^sha256=/, '');
  const actualBuf = Buffer.from(actualHex, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'signature length mismatch' };
  }

  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}
