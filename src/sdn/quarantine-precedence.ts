/**
 * quarantine-precedence.ts
 * Roadmap track A property A4: every quarantine DROP outranks every forwarding rule that can match the same packet.
 *
 * Method: the same exact packet-class partition that A5, A6 and A11 use (intent-spec.ts). For each class, if a quarantine DROP and a
 * forwarding rule both match, the highest-priority quarantine rule must be STRICTLY above the highest-priority forwarding rule. A tie is a
 * violation: OpenFlow 1.3 leaves the winner undefined, and a quarantined source that is still forwarded is the failure this property
 * exists to prevent.
 *
 * Which rules are quarantine DROPs: those named by `isQuarantine` (default: id starts with `quarantine-`, the id the bridge gives every
 * automated quarantine) that have an empty output set. An ordinary DROP below an allow (for example a catch-all drop under a DNS allow)
 * is a legitimate layering and is NOT an A4 concern; A4 is about quarantine.
 *
 * A4 versus A9 (layout): the measured cheap layout puts forwarding rules above DROP rules, which would violate this property. The decision
 * (docs/ROADMAP.md, track A) is that A4 is a hard check and the cost model charges the quarantine block on top; see `QUARANTINE_BLOCK_NOTE`.
 *
 * Pure functions, no I/O. Bounded by the packet-class budget (throws IntentClassBudgetError rather than returning a partial verdict).
 */

import { DEFAULT_MAX_PACKET_CLASSES, enumeratePacketClasses, matchesPacket } from './intent-spec.js';
import type { IsolationRule } from './port1-isolation.js';
import { ZODIAC_PORT_TAP, ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD } from './port1-isolation.js';

export interface PrecedenceViolation {
  readonly property: 'A4';
  /** The quarantine rule first, then the forwarding rule(s) that outrank or tie it. */
  readonly ruleIds: readonly string[];
  readonly detail: string;
}

export interface PrecedenceVerdict {
  readonly property: 'A4';
  readonly satisfied: boolean;
  /** Quarantine DROP rules found in the input. When 0 the property holds vacuously, and callers should say so. */
  readonly quarantineRules: number;
  readonly violations: readonly PrecedenceViolation[];
}

export interface PrecedenceOptions {
  readonly isQuarantine?: (rule: IsolationRule) => boolean;
  readonly ports?: readonly number[];
  readonly maxPacketClasses?: number;
}

export const QUARANTINE_ID_PREFIX = 'quarantine-';
/** The priority every automated quarantine DROP is installed at. Forwarding rules installed by the bridge must stay strictly below it (A4). */
export const QUARANTINE_PRIORITY = 65535;
/** Highest priority the bridge accepts for a forwarding rule it installs: one below the quarantine band. */
export const MAX_FORWARDING_PRIORITY = QUARANTINE_PRIORITY - 1;

export const defaultIsQuarantine = (r: IsolationRule): boolean => r.id.startsWith(QUARANTINE_ID_PREFIX) && (r.flowMod.outputPorts ?? []).length === 0;

export function checkQuarantinePrecedence(rules: readonly IsolationRule[], options: PrecedenceOptions = {}): PrecedenceVerdict {
  const isQ = options.isQuarantine ?? defaultIsQuarantine;
  const quarantine = rules.filter(isQ);
  const forwarding = rules.filter((r) => !isQ(r) && (r.flowMod.outputPorts ?? []).length > 0 && r.flowMod.priority > 0);
  if (quarantine.length === 0 || forwarding.length === 0) return { property: 'A4', satisfied: true, quarantineRules: quarantine.length, violations: [] };

  const used = new Set<number>(options.ports ?? [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]);
  for (const r of rules) if (r.flowMod.match?.inPort !== undefined) used.add(r.flowMod.match.inPort);
  let other = 1;
  while (used.has(other)) other++;
  const classes = enumeratePacketClasses(
    rules.map((r) => r.flowMod.match ?? {}),
    [...used, other],
    options.maxPacketClasses ?? DEFAULT_MAX_PACKET_CLASSES,
  );

  const found = new Map<string, { q: IsolationRule; outranking: Set<string> }>();
  for (const pkt of classes) {
    const q = quarantine.filter((r) => matchesPacket(r.flowMod.match ?? {}, pkt));
    if (q.length === 0) continue;
    const f = forwarding.filter((r) => matchesPacket(r.flowMod.match ?? {}, pkt));
    if (f.length === 0) continue;
    const topQ = q.reduce((a, b) => (b.flowMod.priority > a.flowMod.priority ? b : a));
    const topF = Math.max(...f.map((r) => r.flowMod.priority));
    if (topQ.flowMod.priority > topF) continue;
    const entry = found.get(topQ.id) ?? { q: topQ, outranking: new Set<string>() };
    for (const r of f) if (r.flowMod.priority >= topQ.flowMod.priority) entry.outranking.add(r.id);
    found.set(topQ.id, entry);
  }

  const violations: PrecedenceViolation[] = [...found.values()].map(({ q, outranking }) => ({
    property: 'A4',
    ruleIds: [q.id, ...outranking],
    detail: `${q.id} (priority ${q.flowMod.priority}) does not outrank ${[...outranking].join(', ')}, so a packet matching both is forwarded instead of dropped`,
  }));
  return { property: 'A4', satisfied: violations.length === 0, quarantineRules: quarantine.length, violations };
}

/**
 * A4 versus A9, the recorded decision: quarantine DROPs sit in a block ABOVE all forwarding rules, and the block is bounded by the
 * envelope's cap (src/sdn/quarantine-envelope.ts, default 8, at most 32). The cost model therefore charges every active quarantine
 * at the per-DROP-rule cost on top of the forwarding cost. The cheap forwarding-first layout is not used while any quarantine can be active.
 */
export const QUARANTINE_BLOCK_NOTE =
  'quarantine DROPs are placed above all forwarding rules (A4 is a hard check); the cost model charges each active quarantine at the measured per-DROP-rule cost';
