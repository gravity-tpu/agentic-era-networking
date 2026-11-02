/**
 * deployed-cost-model.ts
 * Pure, integer-only cost model of the DEPLOYED table on the Zodiac FX: the six-rule isolation policy with k quarantine DROPs above it
 * (roadmap track A, property A8; the measured counterpart of zodiac-cost-model.ts, which was fitted on a different shape).
 *
 *   t_packet = 80.0 us + 5.42 us x k          capacity = 1 / t_packet          (572-byte payload, k = 0..8)
 *
 * Source: the 2026-10-20 hardware run docs/benchmarks/results/layout-capacity/run-2026-10-20 (pre-registered; report in the README beside it):
 * two rounds at each of k = 0, 2, 4 and 8, quarantines installed through the bridge AFTER the policy (so DROPs outrank the forwarding
 * rules in priority but are installed last), traffic matched by the tap-only rule. test/invariants/deployed-cost-model.test.ts re-reads
 * that artifact and fails if the model drifts from any clean saturated step.
 *
 * What this is NOT: a model of any other table, payload, match path or install order. The table must be the deployed policy followed by
 * quarantine DROPs; the payload must be 572 B; k must be 0 to 8; anything else is outside the domain and the caller gets "unverifiable".
 * The path measured is a frame matched by the tap-only rule (the fifth of six policy rules by priority); frames matched by other rules
 * were not measured. One switch, firmware 0.86. It says nothing about session loss (the switch lost its OpenFlow session at roughly 1.3
 * to 2.3 times capacity), so a load near the modelled capacity is not safe merely because it is below it.
 *
 * Install order matters on this firmware: the earlier ladder found different slopes for DROPs installed first (4.24 us) and last (4.83 us on
 * two forwarding rules); the deployed table, with DROPs installed last, measured 5.42 us. A table whose DROPs come FIRST in install order
 * (what the bridge does when it re-sends quarantines at session start) is a different layout and is not modelled here.
 *
 * Invariant 2: all arithmetic is BigInt in picoseconds.
 */

import { FlowModCommand, type FlowModOptions } from './openflow-types.js';
import { buildPort1IsolationPolicy, type IsolationRule } from './port1-isolation.js';

export const PS_PER_SECOND = 1_000_000_000_000n;
export const DEPLOYED_PAYLOAD_BYTES = 572n;
export const DEPLOYED_MAX_QUARANTINES = 8n;
const FIXED_PS = 80_000_000n;
const PER_QUARANTINE_PS = 5_420_000n;
/** Same claimed accuracy as zodiac-cost-model.ts. The worst clean saturated step in the stored artifact is about 13,000 ppm off. */
export const DEPLOYED_TOLERANCE_PPM = 20_000n;

/**
 * The uplink ARP peer list of the policy the hardware measured: none, which is the live bridge's setting (`ZODIAC_UPLINK_ARP_PEERS=none`, six rules). The builder's
 * default (peers unset, an open uplink ARP rule, seven rules) is a different table that no run measured, so it is not modelled. The 2026-10-20 run measured the same
 * match path behind the same number of rules (the older six-rule policy), and the 2026-10-31 run re-measured the live table itself and confirmed the coefficients below
 * within 1.5% at every k (docs/benchmarks/results/layout-capacity/README-live-policy-2026-10-31.md).
 */
export const MEASURED_UPLINK_ARP_PEERS: readonly string[] = [];

export class DeployedCostDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployedCostDomainError';
  }
}

/** Why the model cannot be applied here, or null when it can. */
export function explainDeployedDomain(payloadBytes: bigint, quarantines: bigint): string | null {
  if (payloadBytes !== DEPLOYED_PAYLOAD_BYTES) return `payload ${payloadBytes} B is outside the measured domain (only ${DEPLOYED_PAYLOAD_BYTES} B was measured for the deployed table)`;
  if (quarantines < 0n || quarantines > DEPLOYED_MAX_QUARANTINES) return `${quarantines} quarantines is outside the measured 0 to ${DEPLOYED_MAX_QUARANTINES}`;
  return null;
}

export function deployedPacketTimePs(payloadBytes: bigint, quarantines: bigint): bigint {
  const problem = explainDeployedDomain(payloadBytes, quarantines);
  if (problem !== null) throw new DeployedCostDomainError(problem);
  return FIXED_PS + PER_QUARANTINE_PS * quarantines;
}

/** Floor division rounds down and meetsDeployedCapacityTarget discounts again by the tolerance: both favour rejection. Do not change the floor to a round. */
export function deployedCapacityPps(payloadBytes: bigint, quarantines: bigint): bigint {
  return PS_PER_SECOND / deployedPacketTimePs(payloadBytes, quarantines);
}

export function meetsDeployedCapacityTarget(payloadBytes: bigint, quarantines: bigint, targetPps: bigint): boolean {
  if (targetPps < 0n) throw new DeployedCostDomainError(`negative target ${targetPps}`);
  const discounted = (deployedCapacityPps(payloadBytes, quarantines) * (1_000_000n - DEPLOYED_TOLERANCE_PPM)) / 1_000_000n;
  return discounted >= targetPps;
}

export type DeployedShapeResult =
  | { readonly modelled: true; readonly quarantineRuleIds: readonly string[] }
  | { readonly modelled: false; readonly reason: string };

/** Canonical projection of a rule, so equality does not depend on key order or undefined fields. */
function canon(r: { id: string; flowMod: FlowModOptions }): string {
  const m = r.flowMod.match ?? {};
  const keys = Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined).sort();
  return JSON.stringify([r.id, r.flowMod.command, r.flowMod.priority, [...(r.flowMod.outputPorts ?? [])], keys.map((k) => [k, (m as Record<string, unknown>)[k]])]);
}

/**
 * The table the hardware runs measured: exactly the live isolation policy (uplink ARP peers none), in its order, followed by quarantine DROPs. Each DROP is an
 * add with no output, matching only eth_type IPv4 and an exact /32 source, at a priority above every policy rule.
 */
export function classifyDeployedShape(rules: readonly IsolationRule[]): DeployedShapeResult {
  const no = (reason: string): DeployedShapeResult => ({ modelled: false, reason });
  const policy = buildPort1IsolationPolicy(undefined, undefined, undefined, MEASURED_UPLINK_ARP_PEERS);
  if (rules.length < policy.length) return no(`${rules.length} rules; the measured table has the ${policy.length}-rule live isolation policy first (uplink ARP peers none)`);
  for (const [i, p] of policy.entries()) {
    const r = rules[i];
    if (r === undefined || canon(r) !== canon(p)) return no(`rule ${i + 1} is not the measured live policy's ${p.id}, in order; only the live policy (uplink ARP peers none) followed by quarantine DROPs was measured`);
  }
  const maxPolicyPriority = Math.max(...policy.map((p) => p.flowMod.priority));
  const quarantineRuleIds: string[] = [];
  for (const r of rules.slice(policy.length)) {
    const m = r.flowMod.match ?? {};
    const keys = Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined).sort();
    const shapeOk = (r.flowMod.outputPorts ?? []).length === 0 && r.flowMod.command === FlowModCommand.OFPFC_ADD && m.etherType === 0x0800 && m.srcIp !== undefined
      && (m.srcIpPrefixLen === undefined || m.srcIpPrefixLen === 32) && keys.every((k) => ['etherType', 'srcIp', 'srcIpPrefixLen'].includes(k));
    if (!shapeOk) return no(`${r.id}: after the policy only quarantine DROPs (eth_type IPv4, exact /32 source, no output) were measured`);
    if (r.flowMod.priority <= maxPolicyPriority) return no(`${r.id}: a DROP at priority ${r.flowMod.priority} does not outrank the policy; only DROPs above it were measured`);
    quarantineRuleIds.push(r.id);
  }
  return { modelled: true, quarantineRuleIds };
}

/**
 * The allow-rule form that was measured (2026-11-01, docs/benchmarks/results/layout-capacity/run-2026-11-01-allow-sweep/README.md): the live policy, then 1 to 8
 * allow rules, then quarantine DROPs. Each allow rule matches `in_port 3` and a source MAC, outputs to P1 and sits at priority 120 (between p3-tap-return, 100, and the
 * rule the measured frames match, 150). This is a FLOOR over measurements, not a per-rule cost: the runs could not resolve a per-count step above their run-to-run
 * spread (the same table measured 6% apart in two runs), so the claim is only that, in every measurement of this form with 8 quarantine DROPs, capacity was at least
 * ALLOW_FLOOR_PPS. A test re-reads the stored runs and fails if the constant is not the lowest of them.
 *
 * What it does not say: counts above 8, another priority, output, match form or command, an allow rule installed after a quarantine, a quarantine depth other than 8,
 * another payload, or traffic that matches an allow rule (the rules measured matched none, and the cost of a frame that takes an allow rule was not measured).
 * The gate can check that a rule has this form; it cannot check that the rule matches no traffic.
 */
export const ALLOW_FORM_PRIORITY = 120;
export const ALLOW_FORM_MAX_RULES = 8n;
export const ALLOW_FLOOR_DEPTH = DEPLOYED_MAX_QUARANTINES;
export const ALLOW_FLOOR_PPS = 7_765n;

/** The same fail-closed margin as the quarantine model: the floor is discounted by the tolerance, rounded down, before it is compared with a target. */
export function meetsAllowFloorTarget(targetPps: bigint): boolean {
  if (targetPps < 0n) throw new DeployedCostDomainError(`negative target ${targetPps}`);
  return (ALLOW_FLOOR_PPS * (1_000_000n - DEPLOYED_TOLERANCE_PPM)) / 1_000_000n >= targetPps;
}

export type DeployedAllowShapeResult =
  | { readonly modelled: true; readonly allowRuleIds: readonly string[]; readonly quarantineRuleIds: readonly string[] }
  | { readonly modelled: false; readonly reason: string };

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** Exactly the measured allow rule: an add at the form's priority, one output (P1), matching only in_port 3 and a source MAC. */
function allowFormProblem(r: IsolationRule): string | null {
  const m = r.flowMod.match ?? {};
  const keys = Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined).sort();
  const out = r.flowMod.outputPorts ?? [];
  if (r.flowMod.command !== FlowModCommand.OFPFC_ADD) return `${r.id}: only adds were measured`;
  if (r.flowMod.priority !== ALLOW_FORM_PRIORITY) return `${r.id}: only priority ${ALLOW_FORM_PRIORITY} was measured, not ${r.flowMod.priority}`;
  if (out.length !== 1 || out[0] !== 1) return `${r.id}: only a single output to P1 was measured`;
  if (keys.length !== 2 || keys[0] !== 'inPort' || keys[1] !== 'srcMac' || m.inPort !== 3 || typeof m.srcMac !== 'string' || !MAC_RE.test(m.srcMac.toLowerCase())) {
    return `${r.id}: only a match on in_port 3 and a source MAC was measured`;
  }
  return null;
}

/**
 * The table the allow-rule runs measured: the live policy in order, then 1 to ALLOW_FORM_MAX_RULES allow rules of the measured form (distinct ids and distinct source
 * MACs, so none is shadowed by another), then quarantine DROPs of the shape classifyDeployedShape accepts. An allow rule after a DROP is a different install order
 * and is not modelled.
 */
export function classifyDeployedAllowShape(rules: readonly IsolationRule[]): DeployedAllowShapeResult {
  const no = (reason: string): DeployedAllowShapeResult => ({ modelled: false, reason });
  const policy = buildPort1IsolationPolicy(undefined, undefined, undefined, MEASURED_UPLINK_ARP_PEERS);
  if (rules.length <= policy.length) return no(`no allow rule after the ${policy.length}-rule live isolation policy`);
  for (const [i, p] of policy.entries()) {
    const r = rules[i];
    if (r === undefined || canon(r) !== canon(p)) return no(`rule ${i + 1} is not the measured live policy's ${p.id}, in order`);
  }
  const rest = rules.slice(policy.length);
  // The allow rules are the leading run of rules of the measured form. Whatever follows the run must be quarantine DROPs and nothing else (checked through
  // classifyDeployedShape below), so a rule of another form in the middle of the run is refused there, never skipped over and never counted.
  const firstOther = rest.findIndex((r) => allowFormProblem(r) !== null);
  const allowRules = firstOther === -1 ? rest : rest.slice(0, firstOther);
  if (allowRules.length === 0) return no(allowFormProblem(rest[0]!) ?? 'no allow rule of the measured form');
  if (BigInt(allowRules.length) > ALLOW_FORM_MAX_RULES) return no(`${allowRules.length} allow rules; only 1 to ${ALLOW_FORM_MAX_RULES} were measured`);
  const ids = new Set(allowRules.map((r) => r.id));
  const macs = new Set(allowRules.map((r) => String(r.flowMod.match?.srcMac).toLowerCase()));
  if (ids.size !== allowRules.length) return no('two allow rules share an id');
  if (macs.size !== allowRules.length) return no('two allow rules match the same source MAC; the second would never win and was not measured');
  const tail = classifyDeployedShape([...policy, ...rest.slice(allowRules.length)]);
  if (!tail.modelled) return no(`after the allow rules: ${tail.reason}`);
  return { modelled: true, allowRuleIds: allowRules.map((r) => r.id), quarantineRuleIds: tail.quarantineRuleIds };
}
