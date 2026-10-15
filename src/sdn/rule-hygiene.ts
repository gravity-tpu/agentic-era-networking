/**
 * rule-hygiene.ts
 * Roadmap track A properties A5 (no shadowed rules) and A6 (no conflicting equal-priority overlaps),
 * independent of any intent.
 *
 * Method: the same exact packet-class partition that intent compliance (A11) uses. Every rule match draws
 * boundaries in header space; one representative per class is evaluated under OpenFlow 1.3 single-table
 * priority semantics. Because every rule treats all packets of a class identically, the result is exhaustive
 * over the modelled fields (in_port, eth_type, eth_src, eth_dst, ipv4_src, ipv4_dst), not a sample.
 * One extra "any other ingress port" class is added, because a rule that does not match in_port can be hit from
 * a port no rule names (for example a port outside flow-table control), and leaving it out would wrongly call
 * such a rule shadowed.
 *
 * A5 (shadowed): a rule matches at least one packet class but wins none of them, because a strictly
 * higher-priority rule takes every packet it matches. Several higher-priority rules can cover a lower one
 * together even when none does alone. Partial overlap, where the lower rule still wins some packets, is normal
 * layering and is not reported.
 *
 * A6 (conflict): two or more rules tie for the highest priority on some packet class and their output sets
 * differ. OpenFlow 1.3 leaves the winner undefined. Also reported: two rules with the same priority and the same
 * match, because the switch treats a second ADD with an identical match and priority as a replacement of the
 * first, so the table would hold fewer entries than were proposed.
 *
 * What this does NOT prove: that the firmware resolves ties the way a given test expects, anything about fields
 * not modelled (L4 ports, VLAN, ARP SPA/TPA), or that the rules do what an intent asks (that is A11).
 *
 * Pure functions, no I/O. Bounded by the packet-class budget (Invariant 5); exceeding it throws
 * IntentClassBudgetError rather than returning a partial verdict (Invariant 3).
 */

import {
  DEFAULT_MAX_PACKET_CLASSES,
  ETH_TYPE_IPV4_INTENT,
  enumeratePacketClasses,
  matchesPacket,
  type PacketClass,
} from './intent-spec.js';
import type { FlowModMatchOptions } from './openflow-types.js';
import type { IsolationRule } from './port1-isolation.js';
import { ZODIAC_PORT_TAP, ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD } from './port1-isolation.js';

/** Ports under flow-table control on the Zodiac FX (port 4 is the OpenFlow management port). */
export const DEFAULT_HYGIENE_PORTS: readonly number[] = [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP];

/**
 * `prerequisite` is not a roadmap property: it marks a rule the switch would refuse (IPv4 match without
 * eth_type=0x0800). It is reported here, as A11 also does, so hygiene cannot pass while ignoring a rule.
 */
export type HygieneProperty = 'A5' | 'A6' | 'prerequisite';
export type HygieneKind = 'shadowed' | 'conflict' | 'duplicate-key' | 'invalid-rule';

export interface HygieneViolation {
  readonly property: HygieneProperty;
  readonly kind: HygieneKind;
  /** Offending rules. For `shadowed`: the shadowed rule first, then the rules that cover it. */
  readonly ruleIds: readonly string[];
  /** A representative packet for `conflict`. */
  readonly packet?: PacketClass;
  readonly detail: string;
}

export interface HygieneVerdict {
  readonly satisfied: boolean;
  readonly classesEvaluated: number;
  readonly violations: readonly HygieneViolation[];
}

export interface HygieneOptions {
  /** Ports to enumerate arrivals on. Default DEFAULT_HYGIENE_PORTS. An "other port" class is always added. */
  readonly ports?: readonly number[];
  readonly maxPacketClasses?: number;
}

const sortedKey = (ports: readonly number[]): string => [...new Set(ports)].sort((a, b) => a - b).join(',');

/** Canonical form of a match, so equivalent spellings (omitted /32, MAC case) compare equal. */
function matchKey(m: FlowModMatchOptions | undefined): string {
  const x = m ?? {};
  return JSON.stringify([
    x.inPort ?? null,
    x.etherType ?? null,
    x.srcMac?.trim().toLowerCase() ?? null,
    x.dstMac?.trim().toLowerCase() ?? null,
    x.srcIp ?? null,
    x.srcIp === undefined ? null : (x.srcIpPrefixLen ?? 32),
    x.dstIp ?? null,
    x.dstIp === undefined ? null : (x.dstIpPrefixLen ?? 32),
  ]);
}

/** Smallest positive port number that no rule and no declared port uses: stands for "any other ingress port". */
function otherPort(used: ReadonlySet<number>): number {
  let p = 1;
  while (used.has(p)) p++;
  return p;
}

export class HygieneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HygieneInputError';
  }
}

export function checkRuleHygiene(rules: readonly IsolationRule[], options: HygieneOptions = {}): HygieneVerdict {
  const seenIds = new Set<string>();
  for (const r of rules) {
    // Results are keyed by rule id; two rules sharing an id would be silently merged.
    if (seenIds.has(r.id)) throw new HygieneInputError(`duplicate rule id ${r.id}`);
    seenIds.add(r.id);
  }
  const violations: HygieneViolation[] = [];

  const valid: IsolationRule[] = [];
  for (const r of rules) {
    const m = r.flowMod.match ?? {};
    if ((m.srcIp !== undefined || m.dstIp !== undefined) && m.etherType !== ETH_TYPE_IPV4_INTENT) {
      violations.push({
        property: 'prerequisite',
        kind: 'invalid-rule',
        ruleIds: [r.id],
        detail: `${r.id}: IPv4 match without eth_type=0x0800 violates OpenFlow 1.3 prerequisites; the switch would refuse it`,
      });
    } else {
      valid.push(r);
    }
  }

  // Same priority and same match: the switch replaces, not adds.
  const byKey = new Map<string, IsolationRule[]>();
  for (const r of valid) {
    const k = `${r.flowMod.priority}|${matchKey(r.flowMod.match)}`;
    const group = byKey.get(k);
    if (group === undefined) byKey.set(k, [r]);
    else group.push(r);
  }
  const duplicateGroups: IsolationRule[][] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    duplicateGroups.push(group);
    violations.push({
      property: 'A6',
      kind: 'duplicate-key',
      ruleIds: group.map((r) => r.id),
      detail:
        `${group.map((r) => r.id).join(', ')} share priority ${group[0]?.flowMod.priority} and an identical match; ` +
        'the switch would keep only the last one installed',
    });
  }
  const duplicateSets = new Set(duplicateGroups.map((g) => g.map((r) => r.id).sort().join('|')));

  const declared = options.ports ?? DEFAULT_HYGIENE_PORTS;
  const used = new Set<number>(declared);
  for (const r of valid) if (r.flowMod.match?.inPort !== undefined) used.add(r.flowMod.match.inPort);
  const ports = [...used, otherPort(used)];

  const classes = enumeratePacketClasses(
    valid.map((r) => r.flowMod.match ?? {}),
    ports,
    options.maxPacketClasses ?? DEFAULT_MAX_PACKET_CLASSES,
  );

  const matched = new Map<string, number>();
  const won = new Map<string, number>();
  const coveredBy = new Map<string, Set<string>>();
  const conflicts = new Map<string, { packet: PacketClass; ids: string[]; classes: number }>();

  for (const pkt of classes) {
    const hits = valid.filter((r) => matchesPacket(r.flowMod.match ?? {}, pkt));
    if (hits.length === 0) continue;
    const topPriority = Math.max(...hits.map((r) => r.flowMod.priority));
    const top = hits.filter((r) => r.flowMod.priority === topPriority);

    for (const r of hits) {
      matched.set(r.id, (matched.get(r.id) ?? 0) + 1);
      if (r.flowMod.priority === topPriority) {
        won.set(r.id, (won.get(r.id) ?? 0) + 1);
      } else {
        const set = coveredBy.get(r.id) ?? new Set<string>();
        for (const t of top) set.add(t.id);
        coveredBy.set(r.id, set);
      }
    }

    if (top.length > 1 && new Set(top.map((r) => sortedKey(r.flowMod.outputPorts ?? []))).size > 1) {
      const ids = top.map((r) => r.id);
      const key = [...ids].sort().join('|');
      const prev = conflicts.get(key);
      if (prev === undefined) conflicts.set(key, { packet: pkt, ids, classes: 1 });
      else prev.classes += 1;
    }
  }

  for (const r of valid) {
    if ((matched.get(r.id) ?? 0) > 0 && (won.get(r.id) ?? 0) === 0) {
      const covering = [...(coveredBy.get(r.id) ?? [])];
      violations.push({
        property: 'A5',
        kind: 'shadowed',
        ruleIds: [r.id, ...covering],
        detail: `${r.id} never wins: every packet it matches is taken by higher-priority ${covering.join(', ')}`,
      });
    }
  }

  for (const [key, c] of conflicts) {
    if (duplicateSets.has(key)) continue; // already reported as a duplicate key
    violations.push({
      property: 'A6',
      kind: 'conflict',
      ruleIds: c.ids,
      packet: c.packet,
      detail:
        `${c.ids.join(', ')} tie at priority ${valid.find((r) => r.id === c.ids[0])?.flowMod.priority} with different ` +
        `outputs on ${c.classes} packet class(es); OpenFlow 1.3 leaves the winner undefined`,
    });
  }

  return { satisfied: violations.length === 0, classesEvaluated: classes.length, violations };
}
