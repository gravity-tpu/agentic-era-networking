/**
 * scripts/eval-baselines.ts
 * The two deterministic baselines of the pre-registered evaluation (docs/research/evaluation-plan.md section 2): the
 * human-engineered reference policy, and the single-point mutations of it, both judged by the same triage the model
 * proposals go through. No model, no switch: pure and repeatable. Integer counts only (Invariant 2).
 *
 * The computation is src/sdn/eval-baselines.ts (regenerated and compared with the committed files by
 * test/invariants/eval-baselines.test.ts, which ignores gitCommit). INTENT-1 is written to <dir>/summary.json (the original
 * file); the others to <dir>/<intent id with / replaced by _>/summary.json.
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/eval-baselines.ts docs/benchmarks/results/agent-evaluation/baselines
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASELINE_TARGETS, computeBaselinesFor } from '../dist/sdn/eval-baselines.js';

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined || outDir === '') throw new Error('usage: eval-baselines.ts <output dir>');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf-8' }).trim();
  if (status !== '') throw new Error('working tree has uncommitted changes to tracked files; commit first (plan section 8)');
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  for (const [i, target] of BASELINE_TARGETS.entries()) {
    const summary = { ...computeBaselinesFor(target.intent, target.reference()), gitCommit };
    const dir = i === 0 ? outDir : path.join(outDir, target.intent.id.replace('/', '_'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    process.stdout.write(`${target.intent.id}: ${summary.mutants.killed} of ${summary.mutants.total} mutants rejected, reference ${summary.reference.category}\n`);
  }
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
