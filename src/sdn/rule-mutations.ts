/**
 * rule-mutations.ts
 * Mutation baseline for the agent-proposal evaluation (docs/research/evaluation-plan.md).
 *
 * Two uses:
 *   1. Baseline. LLM rejection rates mean little alone; single-point mutants of a known-correct rule
 *      set give a reference distribution of "plausible mistakes" to compare against.
 *   2. Checker validation (Invariant 4). The mutation score shows how many plausible mistakes a check
 *      catches. A check that kills nothing is not verification.
 *
 * Survivors are reported, never dropped. A survivor is either an equivalent mutant (the intent permits
 * the change) or a blind spot; telling them apart is a manual step recorded in the evaluation report.
 *
 * Pure and deterministic: the same input yields the same mutants in the same order.
 */

import type { FlowModMatchOptions } from './openflow-types.js';
import type { IsolationRule } from './port1-isolation.js';

export const MUTATION_OPERATORS = [
  'drop-rule',
  'widen-prefix',
  'remove-match-field',
  'add-output',
  'remove-output',
  'raise-priority',
] as const;

export type MutationOperator = (typeof MUTATION_OPERATORS)[number];

export interface Mutant {
  /** Stable id: `<operator>:<ruleId>[:<detail>]`. */
  readonly id: string;
  readonly operator: MutationOperator;
  readonly targetRuleId: string;
  readonly rules: readonly IsolationRule[];
}

export interface MutationScore {
  readonly total: number;
  readonly killed: readonly Mutant[];
  readonly survived: readonly Mutant[];
}

/** Bits removed from a prefix by `widen-prefix`. One octet is the commonest human and LLM slip. */
export const WIDEN_PREFIX_BITS = 8;
export const MAX_OPENFLOW_PRIORITY = 65535;

type MatchField = 'inPort' | 'etherType' | 'srcMac' | 'dstMac' | 'srcIp' | 'dstIp';
const MATCH_FIELDS: readonly MatchField[] = ['inPort', 'etherType', 'srcMac', 'dstMac', 'srcIp', 'dstIp'];

function withoutField(m: FlowModMatchOptions, field: MatchField): FlowModMatchOptions {
  const { inPort, etherType, srcMac, dstMac, srcIp, srcIpPrefixLen, dstIp, dstIpPrefixLen } = m;
  const out: { -readonly [K in keyof FlowModMatchOptions]: FlowModMatchOptions[K] } = {};
  if (field !== 'inPort' && inPort !== undefined) out.inPort = inPort;
  if (field !== 'etherType' && etherType !== undefined) out.etherType = etherType;
  if (field !== 'srcMac' && srcMac !== undefined) out.srcMac = srcMac;
  if (field !== 'dstMac' && dstMac !== undefined) out.dstMac = dstMac;
  if (field !== 'srcIp' && srcIp !== undefined) {
    out.srcIp = srcIp;
    if (srcIpPrefixLen !== undefined) out.srcIpPrefixLen = srcIpPrefixLen;
  }
  if (field !== 'dstIp' && dstIp !== undefined) {
    out.dstIp = dstIp;
    if (dstIpPrefixLen !== undefined) out.dstIpPrefixLen = dstIpPrefixLen;
  }
  return out;
}

function replaceAt(rules: readonly IsolationRule[], i: number, next: IsolationRule): IsolationRule[] {
  return rules.map((r, j) => (j === i ? next : r));
}

/**
 * All single-point mutants of `rules`. `ports` are the data-plane ports `add-output` may add.
 */
export function generateMutants(rules: readonly IsolationRule[], ports: readonly number[]): Mutant[] {
  const out: Mutant[] = [];
  const push = (operator: MutationOperator, rule: IsolationRule, detail: string | null, next: readonly IsolationRule[]): void => {
    out.push({ id: `${operator}:${rule.id}${detail === null ? '' : `:${detail}`}`, operator, targetRuleId: rule.id, rules: next });
  };
  const sortedPorts = [...new Set(ports)].sort((a, b) => a - b);

  rules.forEach((r, i) => {
    const fm = r.flowMod;
    const m = fm.match ?? {};
    const outputs = fm.outputPorts ?? [];
    const withMatch = (match: FlowModMatchOptions): IsolationRule => ({ id: r.id, flowMod: { ...fm, match } });

    push('drop-rule', r, null, rules.filter((_, j) => j !== i));

    for (const side of ['src', 'dst'] as const) {
      const ip = side === 'src' ? m.srcIp : m.dstIp;
      const len = (side === 'src' ? m.srcIpPrefixLen : m.dstIpPrefixLen) ?? 32;
      const wider = Math.max(0, len - WIDEN_PREFIX_BITS);
      if (ip === undefined || wider === len) continue;
      const match: FlowModMatchOptions = side === 'src' ? { ...m, srcIpPrefixLen: wider } : { ...m, dstIpPrefixLen: wider };
      push('widen-prefix', r, side, replaceAt(rules, i, withMatch(match)));
    }

    for (const field of MATCH_FIELDS) {
      if (m[field] === undefined) continue;
      push('remove-match-field', r, field, replaceAt(rules, i, withMatch(withoutField(m, field))));
    }

    for (const p of sortedPorts) {
      if (outputs.includes(p) || p === m.inPort) continue;
      push('add-output', r, String(p), replaceAt(rules, i, { id: r.id, flowMod: { ...fm, outputPorts: [...outputs, p] } }));
    }

    for (const p of outputs) {
      push('remove-output', r, String(p), replaceAt(rules, i, { id: r.id, flowMod: { ...fm, outputPorts: outputs.filter((q) => q !== p) } }));
    }

    if (fm.priority !== MAX_OPENFLOW_PRIORITY) {
      push('raise-priority', r, null, replaceAt(rules, i, { id: r.id, flowMod: { ...fm, priority: MAX_OPENFLOW_PRIORITY } }));
    }
  });

  return out;
}

/** Score mutants against a checker. `kills(rules)` returns true when the checker rejects the rule set. */
export function scoreMutants(mutants: readonly Mutant[], kills: (rules: readonly IsolationRule[]) => boolean): MutationScore {
  const killed: Mutant[] = [];
  const survived: Mutant[] = [];
  for (const m of mutants) (kills(m.rules) ? killed : survived).push(m);
  return { total: mutants.length, killed, survived };
}
