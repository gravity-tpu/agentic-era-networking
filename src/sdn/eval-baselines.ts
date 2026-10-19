/**
 * eval-baselines.ts
 * The deterministic baselines of the pre-registered evaluation (docs/research/evaluation-plan.md section 2), as a pure
 * function: the human-engineered reference policy and its single-point mutations, both judged by the same triage the
 * model proposals go through. No I/O, integer counts only (Invariant 2). scripts/eval-baselines.ts writes the result;
 * test/invariants/eval-baselines.test.ts regenerates it and compares it with the committed file.
 */

import { buildPort1IsolationPolicy, ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from './port1-isolation.js';
import { generateMutants, MUTATION_OPERATORS } from './rule-mutations.js';
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
  if (new Set(mutants.map((m) => m.id)).size !== mutants.length) throw new Error('mutant ids are not unique; the per-mutant verdicts would collide');
  // One triage per mutant, one source of truth for killed, survived, the per-operator counts and the category counts.
  const judged = mutants.map((m) => ({ m, category: triageProposal(m.rules, PORT1_ISOLATION_INTENT).category }));
  const killed = judged.filter((j) => j.category !== 'ADMISSIBLE');
  const survived = judged.filter((j) => j.category === 'ADMISSIBLE');
  const byOperator: Record<string, { total: number; killed: number; survived: number }> = {};
  for (const op of MUTATION_OPERATORS) {
    const of = judged.filter((j) => j.m.operator === op);
    const k = of.filter((j) => j.category !== 'ADMISSIBLE').length;
    byOperator[op] = { total: of.length, killed: k, survived: of.length - k };
  }
  const killedByPrimaryCategory: Record<string, number> = {};
  for (const j of killed) killedByPrimaryCategory[j.category] = (killedByPrimaryCategory[j.category] ?? 0) + 1;
  return {
    schema: 'eval-baselines/v1',
    intent: PORT1_ISOLATION_INTENT.id,
    reference: { rules: reference.length, category: refVerdict.category },
    mutants: { total: judged.length, killed: killed.length, survived: survived.length, byOperator, killedByPrimaryCategory },
    survivedMutants: survived.map((j) => j.m.id),
    note: 'a survived mutant is either an equivalent mutant (same behaviour under the intent) or a gap in the checks; this file does not say which',
  };
}
