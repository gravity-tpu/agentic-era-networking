/**
 * install-gate.ts
 * The pre-install admissibility gate for rules the bridge puts on the switch outside the fixed isolation policy.
 *
 * Before this module existed A5, A6, A7 and A11 were checks that only the experiment path and the evaluation triage called; the
 * `/api/sdn/allow` route and the quarantine path sent FlowMods with no check of the resulting table. `admitInstall` takes the table the
 * switch would hold AFTER the install (current rules plus the proposed ones) and refuses, naming the property and the rules, if any
 * of these fail:
 *   - A2 hairpin: a rule outputs to its own ingress port, including a rule with no in_port that wins a packet arriving on a port it outputs to
 *   - A5 shadowed, A6 conflicting or duplicate rules, OpenFlow prerequisites, unmodelled match fields (rule-hygiene.ts)
 *   - A7 table budget with a quarantine reserve (capacity-budget.ts)
 *   - A4 quarantine precedence (quarantine-precedence.ts)
 *   - A11 intent compliance of the whole table, when an intent is given (intent-spec.ts)
 * A8 (modelled packet cost) is reported as a note, never as a pass: the deployed layout is outside what the cost model measured.
 *
 * Invariant 3 (fail closed): a check that cannot run (class budget exceeded, duplicate ids, a malformed rule) refuses the install.
 * Pure functions, no I/O.
 */

import { DEFAULT_MAX_PACKET_CLASSES, checkIntent, enumeratePacketClasses, matchesPacket, type IntentSpec } from './intent-spec.js';
import { checkRuleHygiene } from './rule-hygiene.js';
import { checkRuleBudget, classifyForCostModel } from './capacity-budget.js';
import { checkQuarantinePrecedence, defaultIsQuarantine } from './quarantine-precedence.js';
import { ZODIAC_PORT_TAP, ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD, type IsolationRule } from './port1-isolation.js';

export type GateProperty = 'A2' | 'A4' | 'A5' | 'A6' | 'A7' | 'A11' | 'prerequisite' | 'unmodelled' | 'uncheckable';

export interface GateViolation {
  readonly property: GateProperty;
  readonly ruleIds: readonly string[];
  readonly detail: string;
}

export interface GateResult {
  readonly admitted: boolean;
  readonly violations: readonly GateViolation[];
  /** Things the gate could not conclude (for example A8) or that hold only vacuously. Never a pass. */
  readonly notes: readonly string[];
}

export interface GateInput {
  /** The rules the switch holds now and will keep: the isolation policy, forwarding rules already installed, active quarantine DROPs. */
  readonly current: readonly IsolationRule[];
  /** The rules about to be added. */
  readonly proposed: readonly IsolationRule[];
  /** When given, the whole table after the install must satisfy it (A11). */
  readonly intent?: IntentSpec;
  /** Entries kept free for quarantines that may be added later. Default 0 when the table already contains quarantines, else the budget module's default. */
  readonly quarantineReserve?: number;
  readonly maxPacketClasses?: number;
}

export function admitInstall(input: GateInput): GateResult {
  const rules: readonly IsolationRule[] = [...input.current, ...input.proposed];
  const violations: GateViolation[] = [];
  const notes: string[] = [];
  const classBudget = input.maxPacketClasses ?? DEFAULT_MAX_PACKET_CLASSES;
  const refuse = (property: GateProperty, ruleIds: readonly string[], detail: string): void => { violations.push({ property, ruleIds, detail }); };

  try {
    for (const r of rules) {
      const m = r.flowMod.match;
      if (m?.inPort !== undefined && (r.flowMod.outputPorts ?? []).includes(m.inPort)) refuse('A2', [r.id], `${r.id} outputs to its own ingress port ${m.inPort}`);
    }

    for (const v of checkRuleHygiene(rules, { maxPacketClasses: classBudget }).violations) {
      const property: GateProperty = v.property === 'A5' || v.property === 'A6' ? v.property : v.property === 'prerequisite' ? 'prerequisite' : 'unmodelled';
      refuse(property, v.ruleIds, v.detail);
    }

    // A2 for a rule that names no ingress port: it wins some packets, and it must not output to the port such a packet arrived on.
    const ports = [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP];
    const used = new Set<number>(ports);
    for (const r of rules) if (r.flowMod.match?.inPort !== undefined) used.add(r.flowMod.match.inPort);
    let other = 1;
    while (used.has(other)) other++;
    const classes = enumeratePacketClasses(rules.map((r) => r.flowMod.match ?? {}), [...used, other], classBudget);
    const wildcardHairpins = new Map<string, number>();
    for (const pkt of classes) {
      if (!ports.includes(pkt.inPort)) continue;
      const hits = rules.filter((r) => matchesPacket(r.flowMod.match ?? {}, pkt));
      if (hits.length === 0) continue;
      const top = Math.max(...hits.map((r) => r.flowMod.priority));
      for (const r of hits) {
        if (r.flowMod.priority === top && r.flowMod.match?.inPort === undefined && (r.flowMod.outputPorts ?? []).includes(pkt.inPort)) {
          wildcardHairpins.set(r.id, pkt.inPort);
        }
      }
    }
    for (const [id, port] of wildcardHairpins) refuse('A2', [id], `${id} names no ingress port and outputs to port ${port}, so a packet that arrives on port ${port} is sent straight back out of it`);

    // The reserve is what the caller says is still to come. A table that already holds quarantines counts them as rules, so it defaults to no extra reserve.
    const hasQuarantine = rules.some(defaultIsQuarantine);
    const reserve = input.quarantineReserve ?? (hasQuarantine ? 0 : undefined);
    const budget = checkRuleBudget(rules, reserve === undefined ? {} : { quarantineReserve: reserve });
    for (const v of budget.violations) refuse('A7', v.ruleIds, v.detail);

    const precedence = checkQuarantinePrecedence(rules, { maxPacketClasses: classBudget });
    for (const v of precedence.violations) refuse('A4', v.ruleIds, v.detail);
    if (precedence.quarantineRules === 0) notes.push('A4 holds vacuously: the table has no quarantine DROP rules');

    if (input.intent !== undefined) {
      const quarantineSet = new Set(rules.filter(defaultIsQuarantine).map((r) => r.id));
      const intentional = new Set<string>();
      for (const v of checkIntent(rules, input.intent, { maxPacketClasses: classBudget }).violations) {
        // A quarantine exists to stop deliveries the intent otherwise requires, so a "missing" caused only by quarantine DROPs is the intended effect.
        // A quarantine cannot create a leak (a DROP only removes deliveries), so leaks and ambiguity from any rule are still refused.
        if (v.kind === 'missing' && v.ruleIds.length > 0 && v.ruleIds.every((id) => quarantineSet.has(id))) { v.ruleIds.forEach((id) => intentional.add(id)); continue; }
        refuse('A11', v.ruleIds, `${v.kind} in ${v.clauseId}: ${v.detail}`);
      }
      if (intentional.size > 0) notes.push(`A11: deliveries the intent requires are withheld from quarantined sources by ${[...intentional].join(', ')} (intended)`);
    }

    const shape = classifyForCostModel(rules);
    notes.push(shape.modelled ? 'A8: the table is a shape the cost model measured; no throughput target was declared, so no verdict' : `A8 unverifiable: ${shape.reason}`);
  } catch (e) {
    refuse('uncheckable', [], `the gate could not evaluate the table: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { admitted: violations.length === 0, violations, notes };
}
