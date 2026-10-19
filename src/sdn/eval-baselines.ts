/**
 * eval-baselines.ts
 * The deterministic baselines of the pre-registered evaluation (docs/research/evaluation-plan.md section 2), as a pure
 * function: the human-engineered reference policy and its single-point mutations, both judged by the same triage the
 * model proposals go through. No I/O, integer counts only (Invariant 2). scripts/eval-baselines.ts writes the result;
 * test/invariants/eval-baselines.test.ts regenerates it and compares it with the committed file.
 */

import { buildPort1IsolationPolicy, ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from './port1-isolation.js';
import { generateMutants, scoreMutants, MUTATION_OPERATORS } from './rule-mutations.js';
import { PORT1_ISOLATION_INTENT } from './intents.js';
import { triageProposal } from './proposal-triage.js';

export interface BaselinesResult {
  readonly schema: 'eval-baselines/v1';
  readonly intent: string;
  readonly reference: { readonly rules: number; readonly category: string };
  readonly mutants: {
    readonly total: number;
    readonly killed: number;
    readonly survived: number;
    readonly byOperator: Readonly<Record<string, { total: number; killed: number; survived: number }>>;
    readonly killedByPrimaryCategory: Readonly<Record<string, number>>;
  };
  readonly survivedMutants: readonly string[];
  readonly note: string;
}

export function computeBaselines(): BaselinesResult {
  const reference = buildPort1IsolationPolicy();
  const refVerdict = triageProposal(reference, PORT1_ISOLATION_INTENT);
  if (refVerdict.category !== 'ADMISSIBLE') {
    throw new Error(`the reference policy is not admissible under its own intent: ${refVerdict.details.join('; ')}`);
  }
  const mutants = generateMutants(reference, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]);
  const verdicts = new Map(mutants.map((m) => [m.id, triageProposal(m.rules, PORT1_ISOLATION_INTENT)]));
  const score = scoreMutants(mutants, (rules) => triageProposal(rules, PORT1_ISOLATION_INTENT).category !== 'ADMISSIBLE');
  const byOperator: Record<string, { total: number; killed: number; survived: number }> = {};
  for (const op of MUTATION_OPERATORS) {
    const of = mutants.filter((m) => m.operator === op);
    const killed = of.filter((m) => score.killed.includes(m)).length;
    byOperator[op] = { total: of.length, killed, survived: of.length - killed };
  }
  const killedByPrimaryCategory: Record<string, number> = {};
  for (const m of score.killed) {
    const c = verdicts.get(m.id)?.category ?? 'ERR_UNCHECKABLE';
    killedByPrimaryCategory[c] = (killedByPrimaryCategory[c] ?? 0) + 1;
  }
  return {
    schema: 'eval-baselines/v1',
    intent: PORT1_ISOLATION_INTENT.id,
    reference: { rules: reference.length, category: refVerdict.category },
    mutants: { total: score.total, killed: score.killed.length, survived: score.survived.length, byOperator, killedByPrimaryCategory },
    survivedMutants: score.survived.map((m) => m.id),
    note: 'a survived mutant is either an equivalent mutant (same behaviour under the intent) or a gap in the checks; this file does not say which',
  };
}
