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
 * The quarantine reserve means the same thing in both: how many MORE quarantine rules may be added after the policy
 * is installed. A7 counts it on top of every rule already present; A8 counts it on top of the DROP rules already
 * present. So for a modelled policy, A7's total entries = A8's quarantine depth + 2 forwarding rules + 1 table-miss.
 *
 * Invariant 2: integer arithmetic only. Invariant 3: unknown shapes are not accepted as passing.
 * Invariant 5: the quarantine reserve is a named, configurable, bounded input (default = the measured "typical
 * working window" depth, `WORKDAY_PROFILES.typical`).
 */

import { FLOW_TABLE_CAPACITY } from './dataplane-benchmark.js';
import { WORKDAY_PROFILES } from './dataplane-depth.js';
import {
  MODEL_TOLERANCE_PPM,
  capacityPps,
  explainDomain,
  meetsCapacityTarget,
  type CostLayout,
} from './zodiac-cost-model.js';
import {
  DEPLOYED_TOLERANCE_PPM,
  ALLOW_FLOOR_DEPTH,
  ALLOW_FLOOR_PPS,
  ALLOW_FORM_MAX_RULES,
  classifyDeployedAllowShape,
  classifyDeployedShape,
  DEPLOYED_PAYLOAD_BYTES,
  deployedCapacityPps,
  explainDeployedDomain,
  meetsAllowFloorTarget,
  meetsDeployedCapacityTarget,
} from './deployed-cost-model.js';
import type { IsolationRule } from './port1-isolation.js';
import { ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD } from './port1-isolation.js';

/** The table-miss entry (priority 0) occupies one hardware entry and is installed separately from the rules. */
export const TABLE_MISS_ENTRIES = 1;

/**
 * Default headroom for quarantine rules added after the policy is installed: the depth of the measured "typical"
 * working window (`WORKDAY_PROFILES.typical`). Callers should pass their own value; this is only a measured
 * default. A test pins both the literal and the tie to the profile, so a change cannot shift it silently.
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
 * rules that would be dropped if the policy were trimmed by priority (highest priority kept first; equal priorities
 * keep their input order). That is a diagnostic ordering, not the install order: the switch fills its table in
 * the order rules are sent, so the caller decides what actually gets cut.
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
  /** null when the policy holds no DROP rules, so the layout is not yet determined. */
  readonly layout: CostLayout | null;
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
    // With no DROP rules the layout the reserve will later be installed in is undeclared. layout: null tells
    // checkCapacityBudget to evaluate every modelled layout and require the target at the lowest capacity.
    return { modelled: true, shape: { layout: null, quarantineRuleIds } };
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
      /**
       * The layout whose modelled capacity the verdict rests on. For a policy with DROP rules this is the policy's
       * layout. For a policy with none, the layout is undetermined and this is the lowest-capacity modelled layout:
       * a bound, not a statement about what is installed.
       */
      readonly decidingLayout: CostLayout | 'deployed' | 'deployed_allow';
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
  if (!shape.modelled) {
    // Not the two-rule shape of the 2026-10-04 benchmark. The deployed table (policy plus quarantine DROPs) has its own measured model.
    const deployed = classifyDeployedShape(rules);
    if (deployed.modelled) return checkDeployedCapacity(deployed.quarantineRuleIds, reserve, spec);
    const withAllow = classifyDeployedAllowShape(rules);
    if (withAllow.modelled) return checkDeployedAllowCapacity(withAllow.allowRuleIds, withAllow.quarantineRuleIds, reserve, spec);
    return { property: 'A8', status: 'unverifiable', reason: `${shape.reason}; and not the deployed table either (${deployed.reason}); nor the deployed table with allow rules (${withAllow.reason})` };
  }

  const depth = shape.shape.quarantineRuleIds.length + reserve;
  const depthBig = BigInt(depth);
  const candidates: readonly CostLayout[] = shape.shape.layout === null ? ['base', 'forward_first'] : [shape.shape.layout];

  // Every candidate layout must be modelled at this payload and depth. When the layout is undetermined (no DROP
  // rules yet) a pass has to hold in whichever layout the reserve is later installed in, so a layout the model
  // does not cover cannot be skipped: that would be a pass for a case that was never evaluated.
  const evaluated: { layout: CostLayout; pps: bigint }[] = [];
  const problems: string[] = [];
  for (const layout of candidates) {
    const problem = explainDomain(layout, spec.payloadBytes, depthBig);
    if (problem === null) evaluated.push({ layout, pps: capacityPps(layout, spec.payloadBytes, depthBig) });
    else problems.push(problem);
  }
  if (problems.length > 0) return { property: 'A8', status: 'unverifiable', reason: problems.join('; ') };
  const [first, ...rest] = evaluated;
  if (first === undefined) return { property: 'A8', status: 'unverifiable', reason: 'no layout to evaluate' };
  const worst = rest.reduce((a, b) => (b.pps < a.pps ? b : a), first);
  const ok = meetsCapacityTarget(worst.layout, spec.payloadBytes, depthBig, spec.targetPps);
  return {
    property: 'A8',
    status: ok ? 'pass' : 'fail',
    decidingLayout: worst.layout,
    quarantineDepth: depth,
    modelledPps: worst.pps,
    targetPps: spec.targetPps,
    tolerancePpm: MODEL_TOLERANCE_PPM,
    violations: ok
      ? []
      : [
          {
            property: 'A8',
            ruleIds: shape.shape.quarantineRuleIds,
            detail:
              `modelled capacity ${worst.pps} pps (${spec.payloadBytes} B, ${worst.layout}, ${depth} quarantine rules ` +
              `including ${reserve} reserved) does not meet the ${spec.targetPps} pps target after the ` +
              `${MODEL_TOLERANCE_PPM} ppm model tolerance`,
          },
        ],
  };
}

/** A8 for the deployed table, from the 2026-10-20 hardware model (deployed-cost-model.ts). Same fail-closed margins as the base model. */
function checkDeployedCapacity(quarantineRuleIds: readonly string[], reserve: number, spec: CapacityBudgetSpec): CapacityVerdict {
  const depth = quarantineRuleIds.length + reserve;
  const problem = explainDeployedDomain(spec.payloadBytes, BigInt(depth));
  if (problem !== null) return { property: 'A8', status: 'unverifiable', reason: problem };
  const depthBig = BigInt(depth);
  const modelled = deployedCapacityPps(spec.payloadBytes, depthBig);
  const ok = meetsDeployedCapacityTarget(spec.payloadBytes, depthBig, spec.targetPps);
  return {
    property: 'A8',
    status: ok ? 'pass' : 'fail',
    decidingLayout: 'deployed',
    quarantineDepth: depth,
    modelledPps: modelled,
    targetPps: spec.targetPps,
    tolerancePpm: DEPLOYED_TOLERANCE_PPM,
    violations: ok
      ? []
      : [
          {
            property: 'A8',
            ruleIds: quarantineRuleIds,
            detail:
              `modelled capacity ${modelled} pps (${spec.payloadBytes} B, deployed table, ${depth} quarantine rules including ${reserve} reserved) ` +
              `does not meet the ${spec.targetPps} pps target after the ${DEPLOYED_TOLERANCE_PPM} ppm model tolerance`,
          },
        ],
  };
}

/**
 * A8 for the deployed table with allow rules: a floor over measurements (deployed-cost-model.ts), valid only at the depth that was measured (8 quarantine rules,
 * present plus reserved) and at the measured payload. Any other depth or payload is unverifiable, never a pass.
 */
function checkDeployedAllowCapacity(allowRuleIds: readonly string[], quarantineRuleIds: readonly string[], reserve: number, spec: CapacityBudgetSpec): CapacityVerdict {
  const depth = quarantineRuleIds.length + reserve;
  if (allowRuleIds.length < 1 || BigInt(allowRuleIds.length) > ALLOW_FORM_MAX_RULES) {
    return { property: 'A8', status: 'unverifiable', reason: `${allowRuleIds.length} allow rules is outside the measured 1 to ${ALLOW_FORM_MAX_RULES}` }; // the classifier already refuses this; kept so the check does not rely on its caller
  }
  if (spec.payloadBytes !== DEPLOYED_PAYLOAD_BYTES) {
    return { property: 'A8', status: 'unverifiable', reason: `payload ${spec.payloadBytes} B is outside the measured domain (the allow-rule floor was measured at ${DEPLOYED_PAYLOAD_BYTES} B only)` };
  }
  if (BigInt(depth) !== ALLOW_FLOOR_DEPTH) {
    return { property: 'A8', status: 'unverifiable', reason: `${depth} quarantine rules (present plus reserved) is not the measured depth of ${ALLOW_FLOOR_DEPTH} for a table with allow rules` };
  }
  const ok = meetsAllowFloorTarget(spec.targetPps);
  return {
    property: 'A8',
    status: ok ? 'pass' : 'fail',
    decidingLayout: 'deployed_allow',
    quarantineDepth: depth,
    modelledPps: ALLOW_FLOOR_PPS,
    targetPps: spec.targetPps,
    tolerancePpm: DEPLOYED_TOLERANCE_PPM,
    violations: ok
      ? []
      : [
          {
            property: 'A8',
            ruleIds: allowRuleIds,
            detail:
              `the lowest capacity measured for this table with allow rules was ${ALLOW_FLOOR_PPS} pps (${spec.payloadBytes} B, ${allowRuleIds.length} allow rules, ${depth} quarantine rules ` +
              `including ${reserve} reserved), which does not meet the ${spec.targetPps} pps target after the ${DEPLOYED_TOLERANCE_PPM} ppm tolerance`,
          },
        ],
  };
}
