/**
 * zodiac-cost-model.ts
 * Pure, integer-only cost model of the Zodiac FX software lookup path (roadmap track B; feeds A8).
 *
 *   t_packet = FIXED(layout) + PER_BYTE x (payloadBytes - 64) + PER_RULE(layout) x rules      (base layout)
 *   t_packet = FIXED(layout) + PER_RULE(layout) x rules                                        (forward_first, 572 B only)
 *   capacity = 1 / t_packet
 *
 * Source: the saturated points of the rate ladders in docs/benchmarks/results/ (analysis in
 * docs/benchmarks/zodiac-fx-depth-analysis-2026-10-04.md, section 3), firmware 0.86, one switch, one round for
 * most layouts. test/invariants/zodiac-cost-model.test.ts re-reads those artifacts and fails if the model drifts
 * more than MODEL_TOLERANCE_PPM from any saturated measurement.
 *
 * What this is NOT: a prediction outside the measured domain. Anything outside it throws (Invariant 3/4),
 * because a capacity figure extrapolated past the data would be an unverified claim presented as a bound.
 * Each layout has its own measured payload range: forward_first was only measured at 572 B, so it is only
 * modelled at 572 B. The base layout's per-byte slope is not borrowed for it.
 * It also says nothing about session loss: the switch dropped its OpenFlow session at roughly 1.3 to 2.3 times
 * capacity, so a load near the modelled capacity is not safe merely because it is below it.
 *
 * Invariant 2: all arithmetic is BigInt in picoseconds (34.8 ns per byte is not an integer in ns).
 */

import { FLOW_TABLE_CAPACITY } from './dataplane-benchmark.js';

export type CostLayout = 'base' | 'forward_first';

export const PS_PER_SECOND = 1_000_000_000_000n;

/** Payload at which the base layout's FIXED is quoted; also the smallest payload measured. */
export const REFERENCE_PAYLOAD_BYTES = 64n;
/** Largest UDP payload measured for the base layout (single-round ladder at 1470 B; the 64 B and 572 B points carry the fit). */
export const MAX_MEASURED_PAYLOAD_BYTES = 1470n;
export const MAX_MODELLED_RULES = BigInt(FLOW_TABLE_CAPACITY);

/** Per-byte cost over the reference payload: 34.8 ns, from the 64 B versus 572 B fixed intercepts (38.5 and 56.2 us). Base layout only. */
export const PER_BYTE_PS = 34_800n;

/** Fixed per-packet cost of the base layout at the reference payload: 38.5 us. */
const BASE_FIXED_PS = 38_500_000n;
/** Per-rule cost of the base layout: 4.24 us (the 64 B and 572 B ladders fitted 4.28 and 4.19). */
const BASE_PER_RULE_PS = 4_240_000n;

/** forward_first was fitted at 572 B only: 58.0 us fixed, 1.30 us per rule. No payload term is modelled for it. */
export const FWDFIRST_PAYLOAD_BYTES = 572n;
const FWDFIRST_FIXED_PS = 58_000_000n;
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
  /** Fixed cost at minPayload. */
  readonly fixedPs: bigint;
  readonly perRulePs: bigint;
  /** Per-byte cost above minPayload; 0 where no payload dependence was measured. */
  readonly perBytePs: bigint;
  /** Measured payload range for this layout, inclusive. */
  readonly minPayload: bigint;
  readonly maxPayload: bigint;
}

const LAYOUTS: Readonly<Record<CostLayout, LayoutParams>> = {
  base: {
    fixedPs: BASE_FIXED_PS,
    perRulePs: BASE_PER_RULE_PS,
    perBytePs: PER_BYTE_PS,
    minPayload: REFERENCE_PAYLOAD_BYTES,
    maxPayload: MAX_MEASURED_PAYLOAD_BYTES,
  },
  forward_first: {
    fixedPs: FWDFIRST_FIXED_PS,
    perRulePs: FWDFIRST_PER_RULE_PS,
    perBytePs: 0n,
    minPayload: FWDFIRST_PAYLOAD_BYTES,
    maxPayload: FWDFIRST_PAYLOAD_BYTES,
  },
};

function paramsFor(layout: string): LayoutParams {
  if (layout === 'base' || layout === 'forward_first') return LAYOUTS[layout];
  throw new CostModelDomainError(`unknown layout ${JSON.stringify(layout)}: no measured cost model for it`);
}

function domainProblem(layout: string, p: LayoutParams, payloadBytes: bigint, rules: bigint): string | null {
  if (payloadBytes < p.minPayload || payloadBytes > p.maxPayload) {
    return `payload ${payloadBytes} B is outside the measured range ${p.minPayload} to ${p.maxPayload} B for layout ${layout}`;
  }
  if (rules < 0n || rules > MAX_MODELLED_RULES) {
    return `${rules} rules is outside 0 to ${MAX_MODELLED_RULES} (the table capacity)`;
  }
  return null;
}

/**
 * Why the model cannot be applied here, or null when it can. Lets callers ask without catching exceptions, so a
 * broad catch never has to stand between a real bug and an "unverifiable" verdict.
 */
export function explainDomain(layout: CostLayout, payloadBytes: bigint, rules: bigint): string | null {
  return domainProblem(layout, paramsFor(layout), payloadBytes, rules);
}

function checkDomain(layout: string, p: LayoutParams, payloadBytes: bigint, rules: bigint): void {
  const problem = domainProblem(layout, p, payloadBytes, rules);
  if (problem !== null) throw new CostModelDomainError(problem);
}

/** Modelled per-packet service time in picoseconds. Throws CostModelDomainError outside the measured domain. */
export function packetTimePs(layout: CostLayout, payloadBytes: bigint, rules: bigint): bigint {
  const p = paramsFor(layout);
  checkDomain(layout, p, payloadBytes, rules);
  return p.fixedPs + p.perBytePs * (payloadBytes - p.minPayload) + p.perRulePs * rules;
}

/**
 * Modelled forwarding capacity in packets per second. The floor division rounds down, and meetsCapacityTarget
 * discounts again by the tolerance: both roundings deliberately favour rejection (fail closed). Do not change
 * the floor to a round. Throws CostModelDomainError outside the domain.
 */
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
