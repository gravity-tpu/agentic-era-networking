/**
 * scripts/eval-baselines.ts
 * The two deterministic baselines of the pre-registered evaluation (docs/research/evaluation-plan.md section 2): the
 * human-engineered reference policy, and the single-point mutations of it, both judged by the same triage the model
 * proposals go through. No model, no switch: pure and repeatable. Integer counts only (Invariant 2).
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/eval-baselines.ts docs/benchmarks/results/agent-evaluation/baselines
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPort1IsolationPolicy, ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../dist/sdn/port1-isolation.js';
import { generateMutants, scoreMutants, MUTATION_OPERATORS } from '../dist/sdn/rule-mutations.js';
import { PORT1_ISOLATION_INTENT } from '../dist/sdn/intents.js';
import { triageProposal } from '../dist/sdn/proposal-triage.js';

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined || outDir === '') throw new Error('usage: eval-baselines.ts <output dir>');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf-8' }).trim();
  if (status !== '') throw new Error('working tree has uncommitted changes to tracked files; commit first (plan section 8)');
  const reference = buildPort1IsolationPolicy();
  const refVerdict = triageProposal(reference, PORT1_ISOLATION_INTENT);
  if (refVerdict.category !== 'ADMISSIBLE') throw new Error(`the reference policy is not admissible under its own intent: ${refVerdict.details.join('; ')}`);

  const mutants = generateMutants(reference, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]);
  const verdicts = new Map(mutants.map((m) => [m.id, triageProposal(m.rules, PORT1_ISOLATION_INTENT)]));
  const score = scoreMutants(mutants, (rules) => triageProposal(rules, PORT1_ISOLATION_INTENT).category !== 'ADMISSIBLE');

  const byOperator = Object.fromEntries(MUTATION_OPERATORS.map((op) => {
    const of = mutants.filter((m) => m.operator === op);
    const killed = of.filter((m) => score.killed.includes(m)).length;
    return [op, { total: of.length, killed, survived: of.length - killed }];
  }));
  const killedBy: Record<string, number> = {};
  for (const m of score.killed) { const c = verdicts.get(m.id)!.category; killedBy[c] = (killedBy[c] ?? 0) + 1; }

  const summary = {
    schema: 'eval-baselines/v1', intent: PORT1_ISOLATION_INTENT.id, gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    reference: { rules: reference.length, category: refVerdict.category },
    mutants: { total: score.total, killed: score.killed.length, survived: score.survived.length, byOperator, killedByPrimaryCategory: killedBy },
    survivedMutants: score.survived.map((m) => m.id),
    note: 'a survived mutant is either an equivalent mutant (same behaviour under the intent) or a gap in the checks; this file does not say which',
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
