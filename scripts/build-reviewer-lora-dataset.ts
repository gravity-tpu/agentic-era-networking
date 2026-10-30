/**
 * scripts/build-reviewer-lora-dataset.ts
 * Generates the format-verified SFT and DPO JSONL datasets for fine-tuning the local pre-push
 * code reviewer (`qwen3.8:27b` in `scripts/ai-reviewer.mjs`) across Invariants 1..6 and
 * `NET-001`..`NET-010`.
 *
 * Invariant 2: Integer counts and monotonic nanosecond duration (`process.hrtime.bigint()`).
 * Invariant 3 & 4: Every generated review is validated against `validateReviewFormat` (matching
 *   `scripts/ai-reviewer.mjs`'s strict-mode section and `EMPTY_STATE_REGEX` checks).
 * Invariant 6: Records git commit, SHA-256 digests of every emitted JSONL file, and explicit
 *   `source: 'synthetic_verifier_grounded'` provenance.
 *
 * Usage (after `npm run build:server` or `npx tsc`):
 *   node --experimental-strip-types scripts/build-reviewer-lora-dataset.ts --out /tmp/zodiac-reviewer-lora
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReviewerLoraDataset } from '../dist/sdn/reviewer-lora-dataset.js';

const DEFAULT_OUT_DIR = '/tmp/zodiac-reviewer-lora';

interface CliArgs {
  readonly outDir: string;
}

function parseCli(argv: readonly string[]): CliArgs {
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('--')) {
        throw new Error('--out requires a directory path');
      }
      outDir = next;
      i++;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}; usage: [--out <dir>]`);
    }
  }
  return { outDir };
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function currentGitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const t0 = process.hrtime.bigint();

  const dataset = buildReviewerLoraDataset();
  await fs.mkdir(args.outDir, { recursive: true });

  const sftBody = dataset.sftExamples.map((ex) => JSON.stringify(ex)).join('\n') + '\n';
  const dpoBody =
    dataset.dpoPairs
      .map((pair) =>
        JSON.stringify({
          id: pair.id,
          invariantId: pair.invariantId,
          council: pair.council,
          expectedVerdict: pair.expectedVerdict,
          prompt: pair.prompt,
          chosen: [{ role: 'assistant', content: pair.chosen }],
          rejected: [{ role: 'assistant', content: pair.rejected }],
        }),
      )
      .join('\n') + '\n';

  const sftFile = 'sft-reviewer.jsonl';
  const dpoFile = 'dpo-reviewer.jsonl';

  await fs.writeFile(path.join(args.outDir, sftFile), sftBody);
  await fs.writeFile(path.join(args.outDir, dpoFile), dpoBody);

  const wallNs = (process.hrtime.bigint() - t0).toString();
  const report = {
    ...dataset.summary,
    gitCommit: currentGitCommit(),
    wallNs,
    files: {
      [sftFile]: {
        rows: dataset.sftExamples.length,
        sha256: sha256Hex(sftBody),
      },
      [dpoFile]: {
        rows: dataset.dpoPairs.length,
        sha256: sha256Hex(dpoBody),
      },
    },
  };

  await fs.writeFile(path.join(args.outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

