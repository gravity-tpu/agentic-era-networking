/**
 * dataplane-depth.ts
 * Pure logic for the Zodiac FX depth / working-window benchmarks (no I/O, no clocks).
 *
 * Extends dataplane-benchmark.ts, which measured three rule depths (0 / 32 / 126). This module
 * plans finer depth sweeps and the rule-layout variants that test *why* depth costs throughput:
 *   - match kind        : exact /32 hosts vs /16 prefixes (does a prefix rule cost less per entry?)
 *   - priority order    : quarantine above forwarding (production worst case) vs forwarding above
 *   - install order     : which rules the firmware sees first
 *   - drop-hit position : traffic that matches a DROP rule at the first / middle / last position
 *
 * Council Invariant 2: every counter, rate and duration here is a BigInt / integer.
 */

import {
  FLOW_TABLE_CAPACITY,
  PORT_UPLINK,
  PORT_WORKLOAD,
  UDP_WIRE_OVERHEAD_BYTES,
} from './dataplane-benchmark.js';
import type { FlowStatsEntry } from './dataplane-benchmark.js';

// ---------------------------------------------------------------------------
// Rule layout
// ---------------------------------------------------------------------------

export type MatchKind = 'host32' | 'net16';
export type PriorityOrder = 'quarantine_above' | 'forward_above';
export type InstallOrder = 'quarantine_first' | 'forward_first';
export type HitPosition = 'first' | 'middle' | 'last';

export interface DepthCondition {
  readonly id: string;
  /** Total quarantine DROP entries, including the hit rule when `hit` is set. */
  readonly depth: number;
  readonly match: MatchKind;
  readonly priorityOrder: PriorityOrder;
  readonly installOrder: InstallOrder;
  /** Give each quarantine rule its own priority (descending in install order). Implied by `hit`. */
  readonly distinctPriorities: boolean;
  /** When set, one quarantine rule matches the workload's own source IP, so benchmark traffic is dropped. */
  readonly hit: HitPosition | null;
}

export interface DepthFlow {
  readonly kind: 'forward' | 'quarantine' | 'hit';
  readonly priority: number;
  readonly inPort?: number;
  readonly srcIp?: string;
  /** 32 for an exact host match, 16 for a /16 prefix. */
  readonly srcPrefixLen?: number;
  /** Empty = DROP. */
  readonly outputPorts: readonly number[];
}

export interface DepthPlan {
  readonly condition: DepthCondition;
  /** Flows in the order they are sent to the switch. */
  readonly flows: readonly DepthFlow[];
  readonly forwardingRuleCount: number;
  /** Priority of the rule that matches workload traffic, when `condition.hit` is set. */
  readonly hitPriority: number | null;
}

export const FORWARD_PRIORITY_LOW = 100;
export const FORWARD_PRIORITY_HIGH = 65535;
export const QUARANTINE_PRIORITY_HIGH = 65535;
/** Quarantine base priority when forwarding sits above it; leaves room for 126 distinct values. */
export const QUARANTINE_PRIORITY_LOW_BASE = 1000;
/** Max quarantine entries: the table holds 128, two are mandatory Port1<->Port2 forwarding. */
export const MAX_QUARANTINE_DEPTH = FLOW_TABLE_CAPACITY - 2;

function quarantineAddress(match: MatchKind, i: number): { srcIp: string; srcPrefixLen: number } {
  if (match === 'host32') {
    // RFC 5737 TEST-NET-2: never present on the benchmark wire (same pool as the original benchmark).
    if (i >= 253) throw new Error('planDepthCondition: host32 address pool (198.51.100.1-253) exhausted');
    return { srcIp: `198.51.100.${i + 1}`, srcPrefixLen: 32 };
  }
  // 240.0.0.0/4 is reserved (class E) and never routable, so these /16s cannot match lab traffic.
  if (i >= 254) throw new Error('planDepthCondition: net16 prefix pool (240.1-254.0.0/16) exhausted');
  return { srcIp: `240.${i + 1}.0.0`, srcPrefixLen: 16 };
}

export function hitIndex(depth: number, hit: HitPosition): number {
  if (hit === 'first') return 0;
  if (hit === 'last') return depth - 1;
  return (depth - 1) >> 1;
}

/**
 * Builds the rule layout for one condition. Throws rather than clamping: a sweep that silently
 * installs fewer rules than requested would mislabel its own results.
 */
export function planDepthCondition(cond: DepthCondition, hitSrcIp = '10.0.2.50'): DepthPlan {
  if (!Number.isInteger(cond.depth) || cond.depth < 0) throw new Error('planDepthCondition: depth must be a non-negative integer');
  if (cond.depth > MAX_QUARANTINE_DEPTH) {
    throw new Error(`planDepthCondition: depth ${cond.depth} exceeds table room ${MAX_QUARANTINE_DEPTH}`);
  }
  if (cond.hit !== null && cond.depth < 1) throw new Error('planDepthCondition: a hit rule needs depth >= 1');
  if (cond.hit !== null && cond.match !== 'host32') throw new Error('planDepthCondition: hit rules are exact host matches');

  const distinct = cond.distinctPriorities || cond.hit !== null;
  const fwdPriority = cond.priorityOrder === 'quarantine_above' ? FORWARD_PRIORITY_LOW : FORWARD_PRIORITY_HIGH;
  const qBase = cond.priorityOrder === 'quarantine_above' ? QUARANTINE_PRIORITY_HIGH : QUARANTINE_PRIORITY_LOW_BASE;
  const hitAt = cond.hit === null ? -1 : hitIndex(cond.depth, cond.hit);

  const forwards: DepthFlow[] = [
    { kind: 'forward', priority: fwdPriority, inPort: PORT_WORKLOAD, outputPorts: [PORT_UPLINK] },
    { kind: 'forward', priority: fwdPriority, inPort: PORT_UPLINK, outputPorts: [PORT_WORKLOAD] },
  ];
  const quarantine: DepthFlow[] = [];
  let hitPriority: number | null = null;
  let benign = 0;
  for (let i = 0; i < cond.depth; i++) {
    const priority = distinct ? qBase - i : qBase;
    if (i === hitAt) {
      hitPriority = priority;
      quarantine.push({ kind: 'hit', priority, srcIp: hitSrcIp, srcPrefixLen: 32, outputPorts: [] });
    } else {
      const a = quarantineAddress(cond.match, benign++);
      quarantine.push({ kind: 'quarantine', priority, srcIp: a.srcIp, srcPrefixLen: a.srcPrefixLen, outputPorts: [] });
    }
  }
  return {
    condition: cond,
    flows: cond.installOrder === 'quarantine_first' ? [...quarantine, ...forwards] : [...forwards, ...quarantine],
    forwardingRuleCount: forwards.length,
    hitPriority,
  };
}

// ---------------------------------------------------------------------------
// Readback verification (match-aware)
// ---------------------------------------------------------------------------

export interface DepthReadbackVerdict {
  readonly verified: boolean;
  readonly totalEntries: bigint;
  readonly mismatches: readonly string[];
  /** Packets matched by benign quarantine rules; must be 0 (they are unroutable test addresses). */
  readonly benignQuarantineHits: bigint;
  /** Packets matched by the intentional hit rule; null when the plan has none. */
  readonly hitRulePackets: bigint | null;
  /** true when each entry's match (source IP / mask / in_port) was compared, not just counts. */
  readonly matchContentChecked: boolean;
}

function maskToPrefixLen(mask: string): number | null {
  const parts = mask.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  const v = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  let n = 0;
  let seenZero = false;
  for (let b = 31; b >= 0; b--) {
    if (((v >>> b) & 1) === 1) {
      if (seenZero) return null; // non-contiguous mask
      n++;
    } else seenZero = true;
  }
  return n;
}

function expectedKey(f: DepthFlow): string {
  return f.kind === 'forward'
    ? `fwd|${f.priority}|in${f.inPort}`
    : `q|${f.priority}|${f.srcIp}/${f.srcPrefixLen}`;
}

function actualKey(e: FlowStatsEntry): string | null {
  if (e.inPort !== undefined && e.srcIp === undefined) return `fwd|${e.priority}|in${e.inPort}`;
  if (e.srcIp !== undefined) {
    const len = e.srcMask === undefined ? 32 : maskToPrefixLen(e.srcMask);
    if (len === null) return null;
    return `q|${e.priority}|${e.srcIp}/${len}`;
  }
  return null;
}

/**
 * Compares the switch's reported table with the plan. Counts per priority class and the total are
 * always required to match. Match *content* is compared for every entry when the plan relies on it
 * (prefix rules, hit rules); if the firmware reports no usable match then, that is a mismatch
 * (fail-closed) because an unverifiable mask could mean a silently widened DROP rule.
 */
export function verifyDepthReadback(plan: DepthPlan, entries: readonly FlowStatsEntry[]): DepthReadbackVerdict {
  const mismatches: string[] = [];
  const expectedCounts = new Map<number, bigint>();
  for (const f of plan.flows) expectedCounts.set(f.priority, (expectedCounts.get(f.priority) ?? 0n) + 1n);
  const gotCounts = new Map<number, bigint>();
  for (const e of entries) gotCounts.set(e.priority, (gotCounts.get(e.priority) ?? 0n) + 1n);
  for (const [prio, n] of expectedCounts) {
    const got = gotCounts.get(prio) ?? 0n;
    if (got !== n) mismatches.push(`priority ${prio}: expected ${n} entries, switch reports ${got}`);
  }
  for (const [prio, n] of gotCounts) {
    if (!expectedCounts.has(prio)) mismatches.push(`priority ${prio}: ${n} unexpected entries on switch`);
  }
  if (BigInt(entries.length) !== BigInt(plan.flows.length)) {
    mismatches.push(`total entries: expected ${plan.flows.length}, switch reports ${entries.length}`);
  }

  const needsMatch = plan.condition.match === 'net16' || plan.condition.hit !== null;
  if (needsMatch) {
    const want = new Map<string, number>();
    for (const f of plan.flows) want.set(expectedKey(f), (want.get(expectedKey(f)) ?? 0) + 1);
    const got = new Map<string, number>();
    let unparsed = 0;
    for (const e of entries) {
      const k = actualKey(e);
      if (k === null) unparsed++;
      else got.set(k, (got.get(k) ?? 0) + 1);
    }
    if (unparsed > 0) mismatches.push(`${unparsed} entries carry no verifiable match (firmware match report unusable)`);
    else {
      for (const [k, n] of want) if ((got.get(k) ?? 0) !== n) mismatches.push(`match ${k}: expected ${n}, switch reports ${got.get(k) ?? 0}`);
      for (const k of got.keys()) if (!want.has(k)) mismatches.push(`unexpected match on switch: ${k}`);
    }
  }

  let benign = 0n;
  let hitPackets: bigint | null = null;
  for (const e of entries) {
    const isHit = plan.hitPriority !== null && e.priority === plan.hitPriority;
    const isQuarantineEntry = plan.flows.some((f) => f.kind !== 'forward' && f.priority === e.priority);
    if (isHit) hitPackets = (hitPackets ?? 0n) + e.packetCount;
    else if (isQuarantineEntry) benign += e.packetCount;
  }
  return {
    verified: mismatches.length === 0,
    totalEntries: BigInt(entries.length),
    mismatches,
    benignQuarantineHits: benign,
    hitRulePackets: plan.hitPriority === null ? null : (hitPackets ?? 0n),
    matchContentChecked: needsMatch,
  };
}

// ---------------------------------------------------------------------------
// Line-rate arithmetic (the "20,800 pps" theory, made explicit)
// ---------------------------------------------------------------------------

/** UDP payload bytes for an IPv4 packet of `ipBytes` (20 IP + 8 UDP headers). */
export function udpPayloadForIpPacket(ipBytes: number): number {
  if (!Number.isInteger(ipBytes) || ipBytes <= 28) throw new Error('udpPayloadForIpPacket: ipBytes must be an integer > 28');
  return ipBytes - 28;
}

/** The roadmap's figure: bandwidth / (bytes * 8), ignoring all framing. floor. */
export function naiveLineRatePps(linkBps: bigint, packetBytes: bigint): bigint {
  if (packetBytes <= 0n) throw new Error('naiveLineRatePps: packet size must be positive');
  return linkBps / (packetBytes * 8n);
}

/** Packets/s a link carries at a given UDP payload size once Ethernet framing is counted. floor. */
export function framedLineRatePps(linkBps: bigint, udpPayloadBytes: bigint): bigint {
  if (udpPayloadBytes <= 0n) throw new Error('framedLineRatePps: payload must be positive');
  return linkBps / ((udpPayloadBytes + UDP_WIRE_OVERHEAD_BYTES) * 8n);
}

// ---------------------------------------------------------------------------
// Working-window rule ramp
// ---------------------------------------------------------------------------

/** Quarantine rules a 5-minute window accumulates before the table is flushed. */
export const WORKDAY_PROFILES = { low: 8, typical: 24, worst: 126 } as const;
export type WorkdayProfile = keyof typeof WORKDAY_PROFILES;

/**
 * Millisecond offsets (from window start) at which rule 1..target are added. Evenly spaced and
 * strictly inside the window, so the table ramps 0 -> target without landing on the flush edge.
 */
export function rampAddOffsetsMs(targetRules: number, windowMs: number): number[] {
  if (!Number.isInteger(targetRules) || targetRules < 0) throw new Error('rampAddOffsetsMs: targetRules must be >= 0');
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('rampAddOffsetsMs: windowMs must be > 0');
  const out: number[] = [];
  for (let k = 1; k <= targetRules; k++) out.push(Math.floor((k * windowMs) / (targetRules + 1)));
  return out;
}

export function rulesAtOffset(offsetsMs: readonly number[], tMs: number): number {
  let n = 0;
  for (const o of offsetsMs) if (o <= tMs) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Blackout analysis (ping -D output from the workload node)
// ---------------------------------------------------------------------------

export interface PingGapReport {
  readonly sent: number | null;
  readonly received: number;
  /** Longest interval with no echo reply, in microseconds. null when fewer than two replies. */
  readonly maxGapUs: bigint | null;
  /** Gaps longer than `thresholdUs`, as [startUs, durationUs] using the sender's epoch clock. */
  readonly gaps: ReadonlyArray<{ readonly startUs: bigint; readonly durationUs: bigint }>;
}

/** "[1759540000.123456]" -> microseconds since epoch, with no floating point. */
function epochUs(stamp: string): bigint {
  const m = /^(\d+)\.(\d{1,6})$/.exec(stamp);
  if (!m) throw new Error(`analyzePingGaps: unparseable timestamp ${stamp}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!.padEnd(6, '0'));
}

export function analyzePingGaps(output: string, thresholdUs: bigint): PingGapReport {
  const times: bigint[] = [];
  for (const line of output.split('\n')) {
    const m = /^\[(\d+\.\d+)\].*\bicmp_seq=\d+\b/.exec(line);
    if (m) times.push(epochUs(m[1]!));
  }
  const sentMatch = /(\d+) packets transmitted/.exec(output);
  const gaps: Array<{ startUs: bigint; durationUs: bigint }> = [];
  let max: bigint | null = null;
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!;
    if (max === null || d > max) max = d;
    if (d > thresholdUs) gaps.push({ startUs: times[i - 1]!, durationUs: d });
  }
  return { sent: sentMatch ? Number(sentMatch[1]) : null, received: times.length, maxGapUs: max, gaps };
}
