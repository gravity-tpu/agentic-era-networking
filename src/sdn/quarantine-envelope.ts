/**
 * Bounds on an automated quarantine (Invariants 3, 4 and 5).
 *
 * The detector may install a DROP without a person on each event, but only inside limits a person set in advance:
 *   - scope: a single source IPv4 inside the workload segment (never the lab LAN, the controller subnet or the world);
 *   - protected hosts that are never blocked (the segment's network and broadcast addresses, plus a configured list);
 *   - a cap on concurrent quarantines, well under the switch's 128-entry table, so a spoofed-source sweep cannot fill it;
 *   - a time limit after which the rule is removed.
 * Anything outside these bounds is refused. This is NOT a check that the source is actually malicious: the source IP
 * is forgeable on the untrusted segment, so these bounds limit the damage a wrong or steered decision can do; they do
 * not make the decision correct.
 *
 * Pure functions, no I/O.
 */

import { WORKLOAD_PREFIX_LEN, WORKLOAD_SUBNET } from './port1-isolation.js';

export const DEFAULT_QUARANTINE_TTL_MS = 300_000;
export const MIN_QUARANTINE_TTL_MS = 10_000;
export const MAX_QUARANTINE_TTL_MS = 3_600_000;
/** 8 of the Zodiac FX's 128 entries at most; the isolation policy itself uses 7. */
export const DEFAULT_QUARANTINE_MAX_ACTIVE = 8;
export const MIN_QUARANTINE_MAX_ACTIVE = 1;
export const MAX_QUARANTINE_MAX_ACTIVE = 32;

/**
 * What the bridge does with a request that is inside the envelope.
 *   propose (default): record it as a proposal for a person to approve; install nothing.
 *   enforce: install it, time-limited. Only the exact value `enforce` selects this: anything else is `propose`.
 * The bridge is the single place this is decided, so every detector that posts to it (the trt daemon, the GPU
 * sentinel, anything later) obeys it.
 */
export type QuarantineMode = 'propose' | 'enforce';

export interface QuarantineEnvelopeConfig {
  readonly mode: QuarantineMode;
  readonly ttlMs: number;
  readonly maxActive: number;
  readonly scopeSubnet: string;
  readonly scopePrefixLen: number;
  /** Exact IPv4 addresses that are never quarantined. */
  readonly protectedIps: readonly string[];
  /** True when the protected list could not be parsed: nothing is quarantined until it is fixed. */
  readonly protectedListInvalid: boolean;
}

export interface QuarantineEnvelopeConfigResult {
  readonly config: QuarantineEnvelopeConfig;
  readonly warnings: readonly string[];
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

function ipv4ToInt(ip: string): number | null {
  if (!IPV4.test(ip)) return null;
  const p = ip.split('.').map(Number);
  return (((p[0] ?? 0) * 256 + (p[1] ?? 0)) * 256 + (p[2] ?? 0)) * 256 + (p[3] ?? 0);
}

function readBounded(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  dflt: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push(`${name}=${JSON.stringify(raw)} is not an integer in ${min}..${max}; using the default ${dflt}.`);
  return dflt;
}

export function readQuarantineEnvelopeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): QuarantineEnvelopeConfigResult {
  const warnings: string[] = [];
  const ttlMs = readBounded(env, 'ZODIAC_QUARANTINE_TTL_MS', DEFAULT_QUARANTINE_TTL_MS, MIN_QUARANTINE_TTL_MS, MAX_QUARANTINE_TTL_MS, warnings);
  const maxActive = readBounded(env, 'ZODIAC_QUARANTINE_MAX_ACTIVE', DEFAULT_QUARANTINE_MAX_ACTIVE, MIN_QUARANTINE_MAX_ACTIVE, MAX_QUARANTINE_MAX_ACTIVE, warnings);

  const protectedIps: string[] = [];
  let protectedListInvalid = false;
  const rawList = env['ZODIAC_QUARANTINE_PROTECTED_IPS'];
  if (rawList !== undefined && rawList.trim() !== '') {
    for (const item of rawList.split(',').map((s) => s.trim())) {
      if (ipv4ToInt(item) === null) {
        protectedListInvalid = true;
        warnings.push(`ZODIAC_QUARANTINE_PROTECTED_IPS entry ${JSON.stringify(item)} is not an IPv4 address; refusing every quarantine until it is fixed.`);
      } else {
        protectedIps.push(item);
      }
    }
  }
  return {
    config: { mode: env['ZODIAC_QUARANTINE_MODE'] === 'enforce' ? 'enforce' : 'propose', ttlMs, maxActive, scopeSubnet: WORKLOAD_SUBNET, scopePrefixLen: WORKLOAD_PREFIX_LEN, protectedIps, protectedListInvalid },
    warnings,
  };
}

export type QuarantineRefusal =
  | 'config_invalid'
  | 'no_ip'
  | 'bad_ip'
  | 'out_of_scope'
  | 'protected'
  | 'already_active'
  | 'cap_reached';

export type QuarantineDecision =
  | { readonly allow: true; readonly ttlMs: number }
  | { readonly allow: false; readonly code: QuarantineRefusal; readonly reason: string };

const refuse = (code: QuarantineRefusal, reason: string): QuarantineDecision => ({ allow: false, code, reason });

export function decideQuarantine(
  request: { readonly targetIp?: string | undefined; readonly targetMac?: string | undefined },
  activeIps: readonly string[],
  config: QuarantineEnvelopeConfig,
): QuarantineDecision {
  if (config.protectedListInvalid) return refuse('config_invalid', 'the protected-host list is malformed, so protection cannot be verified');
  if (request.targetIp === undefined) return refuse('no_ip', 'an automated quarantine needs a source IPv4; a MAC alone cannot be checked against the allowed scope');
  const ip = ipv4ToInt(request.targetIp);
  if (ip === null) return refuse('bad_ip', `${JSON.stringify(request.targetIp)} is not a valid IPv4 address`);

  const net = ipv4ToInt(config.scopeSubnet);
  if (net === null) return refuse('config_invalid', 'the scope subnet is not a valid IPv4 network');
  const size = 2 ** (32 - config.scopePrefixLen);
  const base = net - (net % size);
  if (ip < base || ip >= base + size) return refuse('out_of_scope', `${request.targetIp} is outside the workload segment ${config.scopeSubnet}/${config.scopePrefixLen}`);
  if (ip === base || ip === base + size - 1) return refuse('protected', `${request.targetIp} is the segment's network or broadcast address`);
  if (config.protectedIps.includes(request.targetIp)) return refuse('protected', `${request.targetIp} is on the protected-host list`);
  if (activeIps.includes(request.targetIp)) return refuse('already_active', `${request.targetIp} is already quarantined`);
  if (activeIps.length >= config.maxActive) return refuse('cap_reached', `${activeIps.length} quarantines are already active (limit ${config.maxActive})`);
  return { allow: true, ttlMs: config.ttlMs };
}

/** Largest number of samples kept per evidence list. */
export const MAX_EVIDENCE_SAMPLES = 32;
const MAX_EVIDENCE_KEYS = 12;

export type EvidenceValue = number | readonly number[];

function isShortNumberList(v: unknown): v is number[] {
  return Array.isArray(v) && v.length <= MAX_EVIDENCE_SAMPLES && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x));
}

/**
 * A detector may attach the numbers behind its decision. Only integers (counters, nanoseconds, packets per second:
 * Invariant 2) and short lists of integers under short plain keys are kept; everything else is dropped, so a request cannot store arbitrary data or grow the record.
 */
export function sanitizeEvidence(raw: unknown): Readonly<Record<string, EvidenceValue>> {
  const out: Record<string, EvidenceValue> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_EVIDENCE_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) continue;
    const value: unknown = entry;
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      out[key] = value;
    } else if (isShortNumberList(value)) {
      out[key] = value;
    }
  }
  return out;
}

/** True for the machine's own addresses: the only callers allowed to approve a quarantine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via'] as const;

/**
 * Whether a request may approve a quarantine: it must come from the machine itself AND carry none of the headers a
 * reverse proxy normally adds. This only defends against a cooperative proxy that sets one of those headers: a proxy
 * on this machine that strips them, or any local process that forwards requests, still looks local. It does not make
 * the approval route authenticated.
 */
export function mayApproveQuarantine(
  remoteAddress: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  if (!isLoopbackAddress(remoteAddress)) return false;
  return PROXY_HEADERS.every((h) => headers[h] === undefined);
}
