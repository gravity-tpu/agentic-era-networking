/**
 * install-gate.ts
 * The pre-install admissibility gate for rules the bridge puts on the switch outside the fixed isolation policy.
 *
 * Before this module existed A5, A6, A7 and A11 were checks that only the experiment path and the evaluation triage called; the
 * `/api/sdn/allow` route and the quarantine path sent FlowMods with no check of the resulting table. `admitInstall` takes the table the
 * switch would hold AFTER the install (current rules plus the proposed ones) and refuses, naming the property and the rules, if any
 * of these fail:
 *   - A3 default drop: no rule uses priority 0, the table-miss DROP's priority, and every priority is a whole number from 0 to 65535. The table-miss entry itself is installed
 *     and read back by the bridge (action-readback.ts), not part of this table, so this keeps a proposal from replacing it with a default allow; it does not prove the entry is there
 *   - A2 hairpin: a rule outputs to its own ingress port, including a rule with no in_port that wins a packet arriving on a port it outputs to
 *   - A5 shadowed, A6 conflicting or duplicate rules, OpenFlow prerequisites, unmodelled match fields (rule-hygiene.ts)
 *   - A7 table budget with a quarantine reserve (capacity-budget.ts)
 *   - A4 quarantine precedence (quarantine-precedence.ts)
 *   - A11 intent compliance of the whole table, when an intent is given (intent-spec.ts)
 *   - A8 capacity, when a target is declared: the table must meet it under the measured cost model (the deployed table has its own, deployed-cost-model.ts;
 *     the two-rule shape of the 2026-10-04 benchmark has the older one). `unverifiable` (a table or payload no model covers) refuses: it is not a pass.
 *     With no target declared A8 is a note. A caller may mark the target advisory (containment must not be refused for throughput): the verdict is then a note.
 *
 * Invariant 3 (fail closed): a check that cannot run (class budget exceeded, duplicate ids, a malformed rule) refuses the install.
 * Pure functions, no I/O.
 */

import { DEFAULT_MAX_PACKET_CLASSES, checkIntent, enumeratePacketClasses, matchesPacket, type IntentSpec } from './intent-spec.js';
import { checkRuleHygiene } from './rule-hygiene.js';
import { checkCapacityBudget, checkRuleBudget, classifyForCostModel } from './capacity-budget.js';
import { classifyDeployedShape } from './deployed-cost-model.js';
import { checkQuarantinePrecedence, defaultIsQuarantine } from './quarantine-precedence.js';
import { ZODIAC_PORT_TAP, ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD, type IsolationRule } from './port1-isolation.js';

export type GateProperty = 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A11' | 'prerequisite' | 'unmodelled' | 'uncheckable';

/** Priority of the table-miss DROP. Reserved: the bridge installs it, and no rule of a proposal or of the current table may use it. */
export const TABLE_MISS_PRIORITY = 0;
const MAX_OPENFLOW_PRIORITY = 65535;

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
  /** A declared throughput target (A8). Absent: A8 is a note. */
  readonly capacityTarget?: { readonly payloadBytes: bigint; readonly targetPps: bigint; readonly advisory?: boolean };
  /** Quarantines that may still be added, for the A8 depth. Default 0. */
  readonly capacityReserve?: number;
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
      const prio = r.flowMod.priority;
      if (!Number.isInteger(prio) || prio < TABLE_MISS_PRIORITY || prio > MAX_OPENFLOW_PRIORITY) refuse('A3', [r.id], `${r.id} has priority ${String(prio)}, not a whole number from ${TABLE_MISS_PRIORITY} to ${MAX_OPENFLOW_PRIORITY}`);
      else if (prio === TABLE_MISS_PRIORITY) refuse('A3', [r.id], `${r.id} is at priority ${TABLE_MISS_PRIORITY}, which belongs to the table-miss DROP: a rule there could replace the default drop with a default allow, and how the firmware breaks a tie at that priority is unmeasured`);
    }
    notes.push(`A3: the table-miss DROP (priority ${TABLE_MISS_PRIORITY}) is not part of this table; the bridge installs it and reads it back, and no rule here uses that priority`);

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

    if (input.capacityTarget !== undefined) {
      const t = input.capacityTarget;
      const verdict = checkCapacityBudget(rules, { payloadBytes: t.payloadBytes, targetPps: t.targetPps, quarantineReserve: input.capacityReserve ?? 0 });
      const label = `A8 (${t.targetPps} pps at ${t.payloadBytes} B)`;
      if (verdict.status === 'unverifiable') {
        if (t.advisory === true) notes.push(`${label}: unverifiable (advisory, not refused): ${verdict.reason}`);
        else refuse('A8', [], `a throughput target is declared but cannot be shown to be met: ${verdict.reason}`);
      } else if (verdict.status === 'pass') {
        notes.push(`${label}: met, modelled ${verdict.modelledPps} pps at ${verdict.quarantineDepth} quarantine rules (${verdict.decidingLayout} model, ${verdict.tolerancePpm} ppm tolerance)`);
      } else if (t.advisory === true) {
        notes.push(`${label}: NOT met (advisory, not refused): ${verdict.violations.map((v) => v.detail).join('; ')}`);
      } else {
        for (const v of verdict.violations) refuse('A8', v.ruleIds, v.detail);
      }
    } else {
      const deployed = classifyDeployedShape(rules);
      const shape = classifyForCostModel(rules);
      notes.push(deployed.modelled || shape.modelled
        ? 'A8: the table is a shape a cost model measured; no throughput target was declared, so no verdict'
        : `A8 unverifiable: ${shape.reason}`);
    }
  } catch (e) {
    // Every throw refuses (fail closed); the error's name tells a class-budget refusal apart from an unexpected defect.
    refuse('uncheckable', [], `the gate could not evaluate the table (${e instanceof Error ? e.name : 'non-Error throw'}): ${e instanceof Error ? e.message : String(e)}`);
  }

  return { admitted: violations.length === 0, violations, notes };
}

export interface CapacityTargetConfig {
  readonly target: { readonly payloadBytes: bigint; readonly targetPps: bigint } | null;
  readonly warnings: readonly string[];
}

const MAX_TARGET_PPS = 1_000_000n;

/**
 * Reads the declared throughput target: ZODIAC_CAPACITY_TARGET_PPS (whole number, 1 to 1,000,000) and ZODIAC_CAPACITY_PAYLOAD_BYTES (default 572,
 * the only payload the deployed table was measured at). Unset means no target. A malformed value means NO target plus a warning, and says so loudly:
 * the gate then reports A8 as a note, so a typo cannot silently turn enforcement into a pass that looks enforced. Pure.
 */
export function parseCapacityTarget(env: Readonly<Record<string, string | undefined>>): CapacityTargetConfig {
  const raw = env['ZODIAC_CAPACITY_TARGET_PPS'];
  if (raw === undefined || raw.trim() === '') return { target: null, warnings: [] };
  const payloadRaw = env['ZODIAC_CAPACITY_PAYLOAD_BYTES'];
  const warnings: string[] = [];
  if (!/^[0-9]{1,7}$/.test(raw.trim()) || BigInt(raw.trim()) < 1n || BigInt(raw.trim()) > MAX_TARGET_PPS) {
    return { target: null, warnings: [`ZODIAC_CAPACITY_TARGET_PPS=${JSON.stringify(raw)} is not a whole number from 1 to ${MAX_TARGET_PPS}; NO throughput target is enforced`] };
  }
  let payload = 572n;
  if (payloadRaw !== undefined && payloadRaw.trim() !== '') {
    if (!/^[0-9]{1,5}$/.test(payloadRaw.trim()) || BigInt(payloadRaw.trim()) < 1n) {
      return { target: null, warnings: [`ZODIAC_CAPACITY_PAYLOAD_BYTES=${JSON.stringify(payloadRaw)} is not a positive whole number; NO throughput target is enforced`] };
    }
    payload = BigInt(payloadRaw.trim());
  }
  // Only 572 B was measured for the deployed table, so a target at any other payload cannot be shown to be met. Say so at configuration time
  // instead of letting the first allow-route install be refused with a domain message.
  if (payload !== 572n) warnings.push(`ZODIAC_CAPACITY_PAYLOAD_BYTES=${payload} is not 572, the only payload the deployed table was measured at; allow-route installs will be refused as unverifiable until the model covers it`);
  return { target: { payloadBytes: payload, targetPps: BigInt(raw.trim()) }, warnings };
}
