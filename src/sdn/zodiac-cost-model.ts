/**
 * zodiac-cost-model.ts
 * Pure, integer-only cost model of the Zodiac FX software lookup path (roadmap track B; feeds A8).
 *
 *   t_packet = FIXED(layout) + PER_BYTE x (payloadBytes - 64) + PER_RULE(layout) x rules
 *   capacity = 1 / t_packet
 *
 * Source: the saturated points of the rate ladders in docs/benchmarks/results/ (analysis in
 * docs/benchmarks/zodiac-fx-depth-analysis-2026-10-04.md, section 3), firmware 0.86, one switch, one round for
 * most layouts. test/invariants/zodiac-cost-model.test.ts re-reads those artifacts and fails if the model drifts
 * more than MODEL_TOLERANCE_PPM from any saturated measurement.
 *
 * What this is NOT: a prediction outside the measured domain. Anything outside it throws (Invariant 3/4),
 * because a capacity figure extrapolated past the data would be an unverified claim presented as a bound.
 * It also says nothing about session loss: the switch dropped its OpenFlow session at roughly 1.3 to 2.3 times
 * capacity, so a load near the modelled capacity is not safe merely because it is below it.
 *
 * Invariant 2: all arithmetic is BigInt in picoseconds (34.8 ns per byte is not an integer in ns).
 */

import { FLOW_TABLE_CAPACITY } from './dataplane-benchmark.js';

export type CostLayout = 'base' | 'forward_first';

export const PS_PER_SECOND = 1_000_000_000_000n;

/** Payload at which FIXED is quoted; also the smallest payload measured. */
export const REFERENCE_PAYLOAD_BYTES = 64n;
/** Largest UDP payload measured (single-round ladder at 1470 B; the 64 B and 572 B points carry the fit). */
export const MAX_MEASURED_PAYLOAD_BYTES = 1470n;
export const MAX_MODELLED_RULES = BigInt(FLOW_TABLE_CAPACITY);

/** Per-byte cost over the reference payload: 34.8 ns, from the 64 B versus 572 B fixed intercepts (38.5 and 56.2 us). */
export const PER_BYTE_PS = 34_800n;

/** Fixed per-packet cost of the base layout at the reference payload: 38.5 us. */
const BASE_FIXED_PS = 38_500_000n;
/** Per-rule cost of the base layout: 4.24 us (the 64 B and 572 B ladders fitted 4.28 and 4.19). */
const BASE_PER_RULE_PS = 4_240_000n;

/** forward_first was fitted at 572 B only: 58.0 us fixed, 1.30 us per rule. Fixed is re-expressed at 64 B. */
const FWDFIRST_FIT_PAYLOAD_BYTES = 572n;
const FWDFIRST_FIT_FIXED_PS = 58_000_000n;
const FWDFIRST_FIXED_PS = FWDFIRST_FIT_FIXED_PS - PER_BYTE_PS * (FWDFIRST_FIT_PAYLOAD_BYTES - REFERENCE_PAYLOAD_BYTES);
const FWDFIRST_PER_RULE_PS = 1_300_000n;

/**
 * The accuracy this model claims, in parts per million of the measured capacity: every saturated ladder point
 * in the stored artifacts must be within it. The observed worst case over the 12 saturated points is about 1.2%;
 * the margin above that is deliberate headroom, not a fitted number.
 */
export const MODEL_TOLERANCE_PPM = 20_000n;

export class CostModelDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostModelDomainError';
  }
}

interface LayoutParams {
  readonly fixedPs: bigint;
  readonly perRulePs: bigint;
}

const LAYOUTS: Readonly<Record<CostLayout, LayoutParams>> = {
  base: { fixedPs: BASE_FIXED_PS, perRulePs: BASE_PER_RULE_PS },
  forward_first: { fixedPs: FWDFIRST_FIXED_PS, perRulePs: FWDFIRST_PER_RULE_PS },
};

function paramsFor(layout: string): LayoutParams {
  if (layout === 'base' || layout === 'forward_first') return LAYOUTS[layout];
  throw new CostModelDomainError(`unknown layout ${JSON.stringify(layout)}: no measured cost model for it`);
}

function checkDomain(payloadBytes: bigint, rules: bigint): void {
  if (payloadBytes < REFERENCE_PAYLOAD_BYTES || payloadBytes > MAX_MEASURED_PAYLOAD_BYTES) {
    throw new CostModelDomainError(
      `payload ${payloadBytes} B is outside the measured range ${REFERENCE_PAYLOAD_BYTES} to ${MAX_MEASURED_PAYLOAD_BYTES} B`,
    );
  }
  if (rules < 0n || rules > MAX_MODELLED_RULES) {
    throw new CostModelDomainError(`${rules} rules is outside 0 to ${MAX_MODELLED_RULES} (the table capacity)`);
  }
}

/** Modelled per-packet service time in picoseconds. Throws CostModelDomainError outside the measured domain. */
export function packetTimePs(layout: CostLayout, payloadBytes: bigint, rules: bigint): bigint {
  const p = paramsFor(layout);
  checkDomain(payloadBytes, rules);
  return p.fixedPs + PER_BYTE_PS * (payloadBytes - REFERENCE_PAYLOAD_BYTES) + p.perRulePs * rules;
}

/** Modelled forwarding capacity in packets per second (floor). Throws CostModelDomainError outside the domain. */
export function capacityPps(layout: CostLayout, payloadBytes: bigint, rules: bigint): bigint {
  return PS_PER_SECOND / packetTimePs(layout, payloadBytes, rules);
}

/**
 * True when the modelled capacity at this rule count and payload meets the declared target. The model is
 * approximate (MODEL_TOLERANCE_PPM), so a target within that tolerance of capacity is rejected rather than
 * accepted: the check fails closed on the margin it cannot resolve.
 */
export function meetsCapacityTarget(
  layout: CostLayout,
  payloadBytes: bigint,
  rules: bigint,
  targetPps: bigint,
): boolean {
  if (targetPps < 0n) throw new CostModelDomainError(`negative target ${targetPps}`);
  const capacity = capacityPps(layout, payloadBytes, rules);
  const discounted = (capacity * (1_000_000n - MODEL_TOLERANCE_PPM)) / 1_000_000n;
  return discounted >= targetPps;
}
