/**
 * capacity-budget.ts
 * Roadmap track A properties A7 (rule budget) and A8 (capacity budget), over the same rule representation the
 * rest of the verifier uses (IsolationRule[]).
 *
 * A7 proves: the rules, the table-miss entry and a declared reserve of quarantine entries fit in the 128-entry
 * hardware table. It proves nothing about what the rules do.
 *
 * A8 proves: for a policy of exactly the shape the benchmark measured, the cost model's capacity at the worst
 * declared quarantine depth meets a declared packet-rate target, with the model's own tolerance taken off.
 * The measured shape is narrow (two in_port-only forwarding rules plus source-IP DROP rules; see
 * classifyForCostModel). For any other policy A8 returns `unverifiable`: it does NOT pass, and it does not fail
 * either, because applying the model to an unmeasured shape would be an extrapolation presented as a bound.
 * Today that includes the deployed Port 1 isolation policy (six rules, IPv4 confinement, ARP, tap).
 *
 * Invariant 2: integer arithmetic only. Invariant 3: unknown shapes are not accepted as passing.
 * Invariant 5: the quarantine reserve is a named, configurable, bounded input (default = the measured "typical
 * working window" depth).
 */

import { FLOW_TABLE_CAPACITY } from './dataplane-benchmark.js';
import { WORKDAY_PROFILES } from './dataplane-depth.js';
import {
  CostModelDomainError,
  MODEL_TOLERANCE_PPM,
  capacityPps,
  meetsCapacityTarget,
  type CostLayout,
} from './zodiac-cost-model.js';
import type { IsolationRule } from './port1-isolation.js';
import { ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD } from './port1-isolation.js';

/** The table-miss entry (priority 0) occupies one hardware entry and is installed separately from the rules. */
export const TABLE_MISS_ENTRIES = 1;

/**
 * Default headroom for quarantine rules added after the policy is installed: the depth of the measured "typical"
 * working window (rules ramp 0 to 24). Callers should pass their own value; this is only a measured default.
 */
export const DEFAULT_QUARANTINE_RESERVE = WORKDAY_PROFILES.typical;

export type BudgetProperty = 'A7' | 'A8';

export interface BudgetViolation {
  readonly property: BudgetProperty;
  /** Rules responsible; may be empty when the property concerns the table as a whole. */
  readonly ruleIds: readonly string[];
  readonly detail: string;
}

export class BudgetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetInputError';
  }
}

function checkedReserve(reserve: number | undefined, capacity: number): number {
  const r = reserve ?? DEFAULT_QUARANTINE_RESERVE;
  if (!Number.isInteger(r) || r < 0 || r > capacity) {
    throw new BudgetInputError(`quarantineReserve must be an integer in 0..${capacity}, got ${r}`);
  }
  return r;
}

function checkedCapacity(capacity: number | undefined): number {
  const c = capacity ?? FLOW_TABLE_CAPACITY;
  if (!Number.isInteger(c) || c < 1 || c > FLOW_TABLE_CAPACITY) {
    throw new BudgetInputError(`table capacity must be an integer in 1..${FLOW_TABLE_CAPACITY}, got ${c}`);
  }
  return c;
}

// ---------------------------------------------------------------------------
// A7: rule budget
// ---------------------------------------------------------------------------

export interface RuleBudgetOptions {
  /** Entries to keep free for quarantine rules added later. Default DEFAULT_QUARANTINE_RESERVE. */
  readonly quarantineReserve?: number;
  /** Hardware table size; default and maximum FLOW_TABLE_CAPACITY (128). */
  readonly capacity?: number;
}

export interface RuleBudgetVerdict {
  readonly property: 'A7';
  readonly satisfied: boolean;
  readonly policyRules: number;
  readonly tableMissEntries: number;
  readonly quarantineReserve: number;
  readonly capacity: number;
  /** Entries still free after the policy, table-miss and reserve (negative when over budget). */
  readonly headroom: number;
  readonly violations: readonly BudgetViolation[];
}

/**
 * A7. Passes when policy rules + table-miss + quarantine reserve <= table capacity. On failure, `ruleIds` names the
 * lowest-priority rules that do not fit (highest priority kept first; equal priorities keep their input order).
 */
export function checkRuleBudget(rules: readonly IsolationRule[], options: RuleBudgetOptions = {}): RuleBudgetVerdict {
  const capacity = checkedCapacity(options.capacity);
  const reserve = checkedReserve(options.quarantineReserve, capacity);
  const available = capacity - TABLE_MISS_ENTRIES - reserve;
  const headroom = available - rules.length;
  const violations: BudgetViolation[] = [];
  if (headroom < 0) {
    const byPriorityDesc = rules
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.flowMod.priority - a.r.flowMod.priority || a.i - b.i);
    const overflow = byPriorityDesc.slice(Math.max(available, 0)).map(({ r }) => r.id);
    violations.push({
      property: 'A7',
      ruleIds: overflow,
      detail:
        `${rules.length} rules + ${TABLE_MISS_ENTRIES} table-miss + ${reserve} quarantine reserve = ` +
        `${rules.length + TABLE_MISS_ENTRIES + reserve} entries, over the ${capacity}-entry table by ${-headroom}`,
    });
  }
  return {
    property: 'A7',
    satisfied: violations.length === 0,
    policyRules: rules.length,
    tableMissEntries: TABLE_MISS_ENTRIES,
    quarantineReserve: reserve,
    capacity,
    headroom,
    violations,
  };
}

// ---------------------------------------------------------------------------
// A8: capacity budget
// ---------------------------------------------------------------------------

export interface CostModelShape {
  readonly layout: CostLayout;
  /** Source-IP DROP rules present in the policy (the model's "rules" term before any reserve). */
  readonly quarantineRuleIds: readonly string[];
}

export type ShapeResult =
  | { readonly modelled: true; readonly shape: CostModelShape }
  | { readonly modelled: false; readonly reason: string };

function onlyKeys(m: object | undefined, allowed: readonly string[]): boolean {
  return Object.entries(m ?? {}).every(([k, v]) => v === undefined || allowed.includes(k));
}

/**
 * The only policy shape the benchmark measured (src/sdn/dataplane-depth.ts, host32 and net16 conditions):
 *   - exactly two forwarding rules at one priority: in_port P1 -> [P2] and in_port P2 -> [P1], matching nothing else;
 *   - any number of DROP rules (empty output) matching only an exact source host (/32). The /16 condition was
 *     measured at 4.39 us per rule, 2 to 3% off the model at some depths, so it is outside the claimed tolerance;
 *   - layout `base` when every DROP outranks the forwarding rules AND is listed before them, or `forward_first`
 *     when the forwarding rules outrank every DROP AND are listed first (array order is the install order).
 *     Forwarding above only, or installed first only, was measured too (`fwdabove`, `fwdinstall`) with different
 *     fits, and is not modelled, so it is not accepted.
 * Anything else returns modelled: false with the first reason found.
 */
export function classifyForCostModel(rules: readonly IsolationRule[]): ShapeResult {
  const no = (reason: string): ShapeResult => ({ modelled: false, reason });
  const forwards: { rule: IsolationRule; index: number }[] = [];
  const drops: { rule: IsolationRule; index: number }[] = [];

  for (const [index, rule] of rules.entries()) {
    const m = rule.flowMod.match;
    const out = rule.flowMod.outputPorts ?? [];
    if (out.length === 0) {
      const prefix = m?.srcIpPrefixLen;
      if (m?.srcIp === undefined || !onlyKeys(m, ['srcIp', 'srcIpPrefixLen']) || (prefix !== undefined && prefix !== 32)) {
        return no(`${rule.id}: DROP rule is not an exact source-host (/32) match, the only DROP shape inside the model's tolerance`);
      }
      drops.push({ rule, index });
    } else {
      if (m?.inPort === undefined || !onlyKeys(m, ['inPort'])) {
        return no(`${rule.id}: forwarding rule matches more than in_port; only in_port-only forwarding rules were measured`);
      }
      forwards.push({ rule, index });
    }
  }

  if (forwards.length !== 2) {
    return no(`${forwards.length} forwarding rules; the benchmark measured exactly 2 (P1 -> P2 and P2 -> P1)`);
  }
  const [a, b] = forwards;
  if (a === undefined || b === undefined) return no('forwarding rules missing');
  const p1 = [a, b].find((f) => f.rule.flowMod.match?.inPort === ZODIAC_PORT_WORKLOAD);
  const p2 = [a, b].find((f) => f.rule.flowMod.match?.inPort === ZODIAC_PORT_UPLINK);
  const only = (f: typeof a | undefined, port: number): boolean => {
    const out = f?.rule.flowMod.outputPorts ?? [];
    return out.length === 1 && out[0] === port;
  };
  if (p1 === undefined || p2 === undefined || !only(p1, ZODIAC_PORT_UPLINK) || !only(p2, ZODIAC_PORT_WORKLOAD)) {
    return no('forwarding rules are not exactly in_port 1 -> [2] and in_port 2 -> [1]');
  }
  const fwdPriority = p1.rule.flowMod.priority;
  if (p2.rule.flowMod.priority !== fwdPriority) return no('the two forwarding rules have different priorities');

  const quarantineRuleIds = drops.map((d) => d.rule.id);
  if (drops.length === 0) {
    // With no DROP rules the layout is undistinguished; the zero-depth point is measured under the base layout.
    return { modelled: true, shape: { layout: 'base', quarantineRuleIds } };
  }
  const dropsAllAbove = drops.every((d) => d.rule.flowMod.priority > fwdPriority);
  const dropsAllBelow = drops.every((d) => d.rule.flowMod.priority < fwdPriority);
  const lastFwd = Math.max(p1.index, p2.index);
  const firstFwd = Math.min(p1.index, p2.index);
  const dropsListedFirst = Math.max(...drops.map((d) => d.index)) < firstFwd;
  const fwdListedFirst = lastFwd < Math.min(...drops.map((d) => d.index));
  if (dropsAllAbove && dropsListedFirst) return { modelled: true, shape: { layout: 'base', quarantineRuleIds } };
  if (dropsAllBelow && fwdListedFirst) return { modelled: true, shape: { layout: 'forward_first', quarantineRuleIds } };
  return no(
    'layout is not one of the two modelled: DROP rules must all outrank forwarding and be installed first (base), ' +
      'or forwarding must outrank every DROP and be installed first (forward_first)',
  );
}

export interface CapacityBudgetSpec {
  /** UDP payload size the target applies to. Must be inside the model's measured range for the layout. */
  readonly payloadBytes: bigint;
  /** Declared packet-rate target, packets per second. */
  readonly targetPps: bigint;
  /** Quarantine rules that may be added later; capacity is evaluated at the full depth. Default DEFAULT_QUARANTINE_RESERVE. */
  readonly quarantineReserve?: number;
  readonly capacity?: number;
}

export type CapacityVerdict =
  | {
      readonly property: 'A8';
      readonly status: 'pass' | 'fail';
      readonly layout: CostLayout;
      /** Quarantine depth the model was evaluated at: DROP rules present plus the reserve. */
      readonly quarantineDepth: number;
      readonly modelledPps: bigint;
      readonly targetPps: bigint;
      readonly tolerancePpm: bigint;
      readonly violations: readonly BudgetViolation[];
    }
  | { readonly property: 'A8'; readonly status: 'unverifiable'; readonly reason: string };

/**
 * A8. `pass` and `fail` are both claims about the cost model at the worst declared depth; `unverifiable` means the
 * policy or the spec lies outside what was measured, and the caller must not treat it as a pass.
 */
export function checkCapacityBudget(rules: readonly IsolationRule[], spec: CapacityBudgetSpec): CapacityVerdict {
  const capacity = checkedCapacity(spec.capacity);
  const reserve = checkedReserve(spec.quarantineReserve, capacity);
  if (spec.targetPps < 0n) throw new BudgetInputError(`negative target ${spec.targetPps}`);

  const shape = classifyForCostModel(rules);
  if (!shape.modelled) return { property: 'A8', status: 'unverifiable', reason: shape.reason };

  const depth = shape.shape.quarantineRuleIds.length + reserve;
  try {
    const modelledPps = capacityPps(shape.shape.layout, spec.payloadBytes, BigInt(depth));
    const ok = meetsCapacityTarget(shape.shape.layout, spec.payloadBytes, BigInt(depth), spec.targetPps);
    return {
      property: 'A8',
      status: ok ? 'pass' : 'fail',
      layout: shape.shape.layout,
      quarantineDepth: depth,
      modelledPps,
      targetPps: spec.targetPps,
      tolerancePpm: MODEL_TOLERANCE_PPM,
      violations: ok
        ? []
        : [
            {
              property: 'A8',
              ruleIds: shape.shape.quarantineRuleIds,
              detail:
                `modelled capacity ${modelledPps} pps (${spec.payloadBytes} B, ${shape.shape.layout}, ${depth} quarantine rules ` +
                `including ${reserve} reserved) does not meet the ${spec.targetPps} pps target after the ` +
                `${MODEL_TOLERANCE_PPM} ppm model tolerance`,
            },
          ],
    };
  } catch (e) {
    if (e instanceof CostModelDomainError) return { property: 'A8', status: 'unverifiable', reason: e.message };
    throw e;
  }
}
