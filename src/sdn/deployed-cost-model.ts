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
 * The table the hardware run measured: exactly the deployed isolation policy, in its order, followed by quarantine DROPs. Each DROP is an
 * add with no output, matching only eth_type IPv4 and an exact /32 source, at a priority above every policy rule.
 */
export function classifyDeployedShape(rules: readonly IsolationRule[]): DeployedShapeResult {
  const no = (reason: string): DeployedShapeResult => ({ modelled: false, reason });
  const policy = buildPort1IsolationPolicy();
  if (rules.length < policy.length) return no(`${rules.length} rules; the deployed table has the ${policy.length}-rule isolation policy first`);
  for (const [i, p] of policy.entries()) {
    const r = rules[i];
    if (r === undefined || canon(r) !== canon(p)) return no(`rule ${i + 1} is not the deployed policy's ${p.id}, in order; only the deployed policy followed by quarantine DROPs was measured`);
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
