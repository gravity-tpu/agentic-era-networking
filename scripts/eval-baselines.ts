/**
 * scripts/eval-baselines.ts
 * The two deterministic baselines of the pre-registered evaluation (docs/research/evaluation-plan.md section 2): the
 * human-engineered reference policy, and the single-point mutations of it, both judged by the same triage the model
 * proposals go through. No model, no switch: pure and repeatable. Integer counts only (Invariant 2).
 *
 * The computation is src/sdn/eval-baselines.ts (regenerated and compared with the committed file by
 * test/invariants/eval-baselines.test.ts, which ignores gitCommit).
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/eval-baselines.ts docs/benchmarks/results/agent-evaluation/baselines
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeBaselines } from '../dist/sdn/eval-baselines.js';

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined || outDir === '') throw new Error('usage: eval-baselines.ts <output dir>');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf-8' }).trim();
  if (status !== '') throw new Error('working tree has uncommitted changes to tracked files; commit first (plan section 8)');
  const summary = {
    ...computeBaselines(),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
