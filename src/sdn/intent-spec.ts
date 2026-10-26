/**
 * intent-spec.ts
 * Intent compliance (roadmap A11): does a rule set do what the stated intent asked?
 *
 * Properties A1 to A10 are generic safety checks. A rule set can pass all of them and still be
 * wrong for its intent (it also forwards NTP, or it forgets the return path). This module closes
 * that gap with an exact evaluation over packet classes.
 *
 * Method. Every rule match and every intent clause is a conjunction of field constraints. For each
 * field we collect the boundaries those constraints draw (IPv4 prefixes become integer intervals;
 * ports, EtherTypes and MACs become distinct values plus one "anything else" value). The cartesian
 * product of the per-field atoms is a partition of header space in which every packet of a class is
 * treated identically by every rule and every clause. Evaluating one representative per class is
 * therefore exhaustive over the modelled fields, not a sample.
 *
 * What this proves: over the modelled fields (in_port, eth_type, eth_src, eth_dst, ipv4_src,
 * ipv4_dst, arp_spa, arp_tpa), under OpenFlow 1.3 single-table priority semantics with a table-miss
 * DROP, the rule set forwards each packet class to a port set that the intent permits, and reaches
 * every port the intent requires.
 *
 * What it does NOT prove:
 *   - that the Zodiac FX firmware implements those semantics beyond what's been measured on hardware
 *     (track B conformance probe; ARP_SPA/TPA enforcement itself was confirmed on real hardware,
 *     docs/benchmarks/results/a10-arp-spa-feasibility/, but this module's exactness claim is about the
 *     model, not a re-verification of the firmware on every run);
 *   - anything about fields still not modelled (L4 ports, VLAN);
 *   - that the table-miss DROP is installed (roadmap A3, readback);
 *   - capacity (roadmap A8).
 *
 * Pure functions, no I/O. Bounded by a configurable class budget (Invariant 5); exceeding it throws
 * rather than returning a partial verdict (Invariant 3).
 */

import type { FlowModMatchOptions } from './openflow-types.js';
import type { IsolationRule } from './port1-isolation.js';

export const ETH_TYPE_IPV4_INTENT = 0x0800;
export const ETH_TYPE_ARP_INTENT = 0x0806;

/** Default ceiling on enumerated packet classes. A 128-rule table stays far below it. */
export const DEFAULT_MAX_PACKET_CLASSES = 250_000;
/** Hard upper bound so a caller cannot configure an unbounded enumeration. */
export const MAX_PACKET_CLASSES_CEILING = 5_000_000;

const IPV4_MAX = 0xffff_ffff;

/** One clause of an intent. Clauses are evaluated in order; the first clause that matches decides. */
export interface IntentClause {
  readonly id: string;
  /** Same predicate language as a flow match. `{}` matches every packet. */
  readonly match: FlowModMatchOptions;
  /** Ports every packet in this clause must be delivered to. Must be a subset of `mayReach`. */
  readonly mustReach: readonly number[];
  /** Ports a packet in this clause is permitted to reach. Anything else is a leak. */
  readonly mayReach: readonly number[];
}

export interface IntentSpec {
  readonly id: string;
  readonly description: string;
  /** Data-plane ports under flow-table control. Packets are enumerated arriving on each. */
  readonly ports: readonly number[];
  /** Ordered clauses. Packets matching no clause fall to an implicit default-deny. */
  readonly clauses: readonly IntentClause[];
}

/**
 * A representative packet. IPv4 fields exist only when `etherType` is IPv4, and ARP SPA/TPA fields
 * only when `etherType` is ARP (OF 1.3 prerequisites).
 */
export interface PacketClass {
  readonly inPort: number;
  readonly etherType: number;
  readonly srcMac: string;
  readonly dstMac: string;
  readonly srcIp?: string;
  readonly dstIp?: string;
  readonly arpSpa?: string;
  readonly arpTpa?: string;
}

export type IntentViolationKind = 'leak' | 'missing' | 'ambiguous' | 'invalid-rule';

export interface IntentViolation {
  readonly kind: IntentViolationKind;
  /** Representative packet of the offending class (absent for `invalid-rule`). */
  readonly packet?: PacketClass;
  /** Intent clause that governs the packet class. */
  readonly clauseId: string;
  /** Rules responsible. Empty when the packet fell to table-miss. */
  readonly ruleIds: readonly string[];
  /** Leak: ports reached but not permitted. Missing: ports required but not reached. */
  readonly ports: readonly number[];
  readonly detail: string;
}

export interface IntentVerdict {
  readonly intentId: string;
  readonly satisfied: boolean;
  readonly classesEvaluated: number;
  readonly violations: readonly IntentViolation[];
}

export interface IntentCheckOptions {
  readonly maxPacketClasses?: number;
}

export class IntentClassBudgetError extends Error {
  constructor(public readonly classes: number, public readonly budget: number) {
    super(`intent check would enumerate ${classes} packet classes, over the budget of ${budget}`);
    this.name = 'IntentClassBudgetError';
  }
}

export class IntentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentSpecError';
  }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

export function ipv4ToUint(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new IntentSpecError(`malformed IPv4 address: ${ip}`);
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new IntentSpecError(`malformed IPv4 address: ${ip}`);
    const octet = Number(p);
    if (octet > 255) throw new IntentSpecError(`malformed IPv4 address: ${ip}`);
    n = n * 256 + octet;
  }
  return n;
}

export function uintToIpv4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/** CIDR to inclusive integer interval. Omitted prefix length means an exact host (/32). */
function prefixInterval(ip: string, prefixLen: number | undefined): Interval {
  const len = prefixLen ?? 32;
  if (!Number.isInteger(len) || len < 0 || len > 32) {
    throw new IntentSpecError(`prefix length out of range for ${ip}: ${String(prefixLen)}`);
  }
  const addr = ipv4ToUint(ip);
  const size = 2 ** (32 - len);
  const lo = addr - (addr % size);
  return { lo, hi: lo + size - 1 };
}

function normMac(mac: string): string {
  const m = mac.trim().toLowerCase();
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) throw new IntentSpecError(`malformed MAC address: ${mac}`);
  return m;
}

/** First EtherType at or above 0x88B5 (IEEE local experimental) that no predicate uses. */
function unusedEtherType(used: ReadonlySet<number>): number {
  for (let v = 0x88b5; v <= 0xffff; v++) if (!used.has(v)) return v;
  throw new IntentSpecError('no unused EtherType available for the "other" class');
}

function unusedMac(used: ReadonlySet<string>): string {
  for (let i = 0; i < 256; i++) {
    const candidate = `02:00:00:00:00:${i.toString(16).padStart(2, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new IntentSpecError('no unused MAC available for the "other" class');
}

function ipAtoms(intervals: readonly Interval[]): number[] {
  const bounds = new Set<number>([0]);
  for (const { lo, hi } of intervals) {
    bounds.add(lo);
    if (hi < IPV4_MAX) bounds.add(hi + 1);
  }
  return [...bounds].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Partition header space by the boundaries drawn by `predicates` and return one representative per
 * class. Throws IntentClassBudgetError before allocating if the product exceeds `maxClasses`.
 */
export function enumeratePacketClasses(
  predicates: readonly FlowModMatchOptions[],
  ports: readonly number[],
  maxClasses: number = DEFAULT_MAX_PACKET_CLASSES,
): PacketClass[] {
  if (!Number.isInteger(maxClasses) || maxClasses < 1 || maxClasses > MAX_PACKET_CLASSES_CEILING) {
    throw new IntentSpecError(`maxPacketClasses must be an integer in 1..${MAX_PACKET_CLASSES_CEILING}`);
  }

  const inPorts = new Set<number>(ports);
  const etherTypes = new Set<number>([ETH_TYPE_IPV4_INTENT, ETH_TYPE_ARP_INTENT]);
  const srcMacs = new Set<string>();
  const dstMacs = new Set<string>();
  const srcIntervals: Interval[] = [];
  const dstIntervals: Interval[] = [];
  const arpSpaIntervals: Interval[] = [];
  const arpTpaIntervals: Interval[] = [];

  for (const p of predicates) {
    if (p.inPort !== undefined) inPorts.add(p.inPort);
    if (p.etherType !== undefined) etherTypes.add(p.etherType);
    if (p.srcMac !== undefined) srcMacs.add(normMac(p.srcMac));
    if (p.dstMac !== undefined) dstMacs.add(normMac(p.dstMac));
    if (p.srcIp !== undefined) srcIntervals.push(prefixInterval(p.srcIp, p.srcIpPrefixLen));
    if (p.dstIp !== undefined) dstIntervals.push(prefixInterval(p.dstIp, p.dstIpPrefixLen));
    if (p.arpSpa !== undefined) arpSpaIntervals.push(prefixInterval(p.arpSpa, p.arpSpaPrefixLen));
    if (p.arpTpa !== undefined) arpTpaIntervals.push(prefixInterval(p.arpTpa, p.arpTpaPrefixLen));
  }
  etherTypes.add(unusedEtherType(etherTypes));
  srcMacs.add(unusedMac(srcMacs));
  dstMacs.add(unusedMac(dstMacs));

  const srcAtoms = ipAtoms(srcIntervals);
  const dstAtoms = ipAtoms(dstIntervals);
  const arpSpaAtoms = ipAtoms(arpSpaIntervals);
  const arpTpaAtoms = ipAtoms(arpTpaIntervals);
  const nonIpTypes = [...etherTypes].filter((t) => t !== ETH_TYPE_IPV4_INTENT && t !== ETH_TYPE_ARP_INTENT);

  const perL2 = inPorts.size * srcMacs.size * dstMacs.size;
  const total = perL2 * (nonIpTypes.length + srcAtoms.length * dstAtoms.length + arpSpaAtoms.length * arpTpaAtoms.length);
  if (total > maxClasses) throw new IntentClassBudgetError(total, maxClasses);

  const out: PacketClass[] = [];
  const sortedPorts = [...inPorts].sort((a, b) => a - b);
  for (const inPort of sortedPorts) {
    for (const srcMac of srcMacs) {
      for (const dstMac of dstMacs) {
        for (const etherType of nonIpTypes) out.push({ inPort, etherType, srcMac, dstMac });
        for (const s of srcAtoms) {
          for (const d of dstAtoms) {
            out.push({ inPort, etherType: ETH_TYPE_IPV4_INTENT, srcMac, dstMac, srcIp: uintToIpv4(s), dstIp: uintToIpv4(d) });
          }
        }
        for (const s of arpSpaAtoms) {
          for (const d of arpTpaAtoms) {
            out.push({ inPort, etherType: ETH_TYPE_ARP_INTENT, srcMac, dstMac, arpSpa: uintToIpv4(s), arpTpa: uintToIpv4(d) });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching and evaluation
// ---------------------------------------------------------------------------

function inPrefix(ip: string | undefined, prefix: string, len: number | undefined): boolean {
  if (ip === undefined) return false;
  const { lo, hi } = prefixInterval(prefix, len);
  const v = ipv4ToUint(ip);
  return v >= lo && v <= hi;
}

/** OpenFlow 1.3 match semantics over the modelled fields. Unset fields are wildcards. */
export function matchesPacket(m: FlowModMatchOptions, pkt: PacketClass): boolean {
  if (m.inPort !== undefined && m.inPort !== pkt.inPort) return false;
  if (m.etherType !== undefined && m.etherType !== pkt.etherType) return false;
  if (m.srcMac !== undefined && normMac(m.srcMac) !== pkt.srcMac) return false;
  if (m.dstMac !== undefined && normMac(m.dstMac) !== pkt.dstMac) return false;
  if (m.srcIp !== undefined && !inPrefix(pkt.srcIp, m.srcIp, m.srcIpPrefixLen)) return false;
  if (m.dstIp !== undefined && !inPrefix(pkt.dstIp, m.dstIp, m.dstIpPrefixLen)) return false;
  if (m.arpSpa !== undefined && !inPrefix(pkt.arpSpa, m.arpSpa, m.arpSpaPrefixLen)) return false;
  if (m.arpTpa !== undefined && !inPrefix(pkt.arpTpa, m.arpTpa, m.arpTpaPrefixLen)) return false;
  return true;
}

const DEFAULT_DENY: IntentClause = { id: 'default-deny', match: {}, mustReach: [], mayReach: [] };

function validateSpec(spec: IntentSpec): void {
  const ids = new Set<string>();
  for (const c of spec.clauses) {
    if (ids.has(c.id)) throw new IntentSpecError(`${spec.id}: duplicate clause id ${c.id}`);
    ids.add(c.id);
    const may = new Set(c.mayReach);
    const stray = c.mustReach.filter((p) => !may.has(p));
    if (stray.length > 0) {
      throw new IntentSpecError(`${spec.id}/${c.id}: mustReach [${stray.join(', ')}] not in mayReach`);
    }
  }
  if (spec.ports.length === 0) throw new IntentSpecError(`${spec.id}: no ports declared`);
}

const sortedKey = (ports: readonly number[]): string => [...new Set(ports)].sort((a, b) => a - b).join(',');

/**
 * Check `rules` against `spec` over every packet class. Returns every violation found; an empty list
 * means the rule set satisfies the intent over the modelled fields (see the module header for scope).
 */
export function checkIntent(
  rules: readonly IsolationRule[],
  spec: IntentSpec,
  options: IntentCheckOptions = {},
): IntentVerdict {
  validateSpec(spec);
  const violations: IntentViolation[] = [];

  // OpenFlow 1.3 rejects IPv4 matches without eth_type=IPv4 (OFPBMC_BAD_PREREQ). An LLM that omits
  // the prerequisite has proposed a rule the switch will refuse, so report it rather than model it.
  const valid: IsolationRule[] = [];
  for (const r of rules) {
    const m = r.flowMod.match ?? {};
    if ((m.srcIp !== undefined || m.dstIp !== undefined) && m.etherType !== ETH_TYPE_IPV4_INTENT) {
      violations.push({
        kind: 'invalid-rule',
        clauseId: '',
        ruleIds: [r.id],
        ports: [],
        detail: `${r.id}: IPv4 match without eth_type=0x0800 violates OpenFlow 1.3 prerequisites`,
      });
    } else if ((m.arpSpa !== undefined || m.arpTpa !== undefined) && m.etherType !== ETH_TYPE_ARP_INTENT) {
      violations.push({
        kind: 'invalid-rule',
        clauseId: '',
        ruleIds: [r.id],
        ports: [],
        detail: `${r.id}: ARP_SPA/ARP_TPA match without eth_type=0x0806 violates OpenFlow 1.3 prerequisites`,
      });
    } else {
      valid.push(r);
    }
  }

  const predicates = [...valid.map((r) => r.flowMod.match ?? {}), ...spec.clauses.map((c) => c.match)];
  const classes = enumeratePacketClasses(predicates, spec.ports, options.maxPacketClasses ?? DEFAULT_MAX_PACKET_CLASSES);

  for (const pkt of classes) {
    const clause = spec.clauses.find((c) => matchesPacket(c.match, pkt)) ?? DEFAULT_DENY;

    let top: IsolationRule[] = [];
    let topPriority = -1;
    for (const r of valid) {
      if (!matchesPacket(r.flowMod.match ?? {}, pkt)) continue;
      if (r.flowMod.priority > topPriority) {
        topPriority = r.flowMod.priority;
        top = [r];
      } else if (r.flowMod.priority === topPriority) {
        top.push(r);
      }
    }

    if (top.length > 1 && new Set(top.map((r) => sortedKey(r.flowMod.outputPorts ?? []))).size > 1) {
      violations.push({
        kind: 'ambiguous',
        packet: pkt,
        clauseId: clause.id,
        ruleIds: top.map((r) => r.id),
        ports: [],
        detail: `equal-priority (${topPriority}) rules overlap with different outputs; OpenFlow 1.3 leaves the winner undefined`,
      });
      continue;
    }

    const winner = top[0];
    const outputs = new Set(winner?.flowMod.outputPorts ?? []); // no winner: table-miss DROP
    const ruleIds = winner ? [winner.id] : [];
    const may = new Set(clause.mayReach);

    const leaked = [...outputs].filter((p) => !may.has(p)).sort((a, b) => a - b);
    if (leaked.length > 0) {
      violations.push({
        kind: 'leak',
        packet: pkt,
        clauseId: clause.id,
        ruleIds,
        ports: leaked,
        detail: `reaches [${leaked.join(', ')}], which clause ${clause.id} does not permit`,
      });
    }
    const missed = clause.mustReach.filter((p) => !outputs.has(p));
    if (missed.length > 0) {
      violations.push({
        kind: 'missing',
        packet: pkt,
        clauseId: clause.id,
        ruleIds,
        ports: missed,
        detail: `does not reach [${missed.join(', ')}], which clause ${clause.id} requires${winner ? '' : ' (fell to table-miss)'}`,
      });
    }
  }

  return { intentId: spec.id, satisfied: violations.length === 0, classesEvaluated: classes.length, violations };
}
