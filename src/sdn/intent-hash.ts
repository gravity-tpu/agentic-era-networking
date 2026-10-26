/**
 * intent-hash.ts
 * A hash of an intent specification, so a result can say which version of the question it answered. The A10 policy work changed
 * INTENT-1, 3 and 4 in place after results had been recorded against them, and nothing in the result files could show it. Every
 * agent-eval summary now carries this hash and a test pins it for the four evaluated intents.
 *
 * Canonical JSON (object keys sorted at every level, arrays kept in order: clause order is part of the specification, because the
 * first matching clause wins). Pure apart from node:crypto.
 */

import crypto from 'node:crypto';
import type { IntentSpec } from './intent-spec.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function intentSha256(spec: IntentSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(spec))).digest('hex');
}
