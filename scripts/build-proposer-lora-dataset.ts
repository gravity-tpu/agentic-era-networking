/**
 * scripts/build-proposer-lora-dataset.ts
 * Generates the verifier-grounded SFT and DPO JSONL datasets for fine-tuning a local OpenFlow
 * policy proposer (e.g. Qwen 3.8 27B via LoRA with HuggingFace TRL), strictly disjoint from the
 * four pre-registered benchmark intents in `src/sdn/intents.ts`.
 *
 * Invariant 2: Integer counts and monotonic nanosecond duration (`process.hrtime.bigint()`).
 * Invariant 3 & 4: Fails closed if any scenario overlaps the held-out benchmark intents or if any
 *   positive/negative example fails deterministic verification (`src/sdn/proposer-lora-dataset.ts`).
 * Invariant 6: Records git commit, SHA-256 digests of every emitted JSONL file, and explicit
 *   `source: 'synthetic_verifier_grounded'` provenance.
 *
 * Usage (after `npm run build:server` or `npx tsc`):
 *   node --experimental-strip-types scripts/build-proposer-lora-dataset.ts --out /tmp/zodiac-proposer-lora
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildProposerLoraDataset } from '../dist/sdn/proposer-lora-dataset.js';

const DEFAULT_OUT_DIR = '/tmp/zodiac-proposer-lora';

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

  const dataset = buildProposerLoraDataset();
  await fs.mkdir(args.outDir, { recursive: true });

  const sftZeroShotBody =
    dataset.sftZeroShot.map((ex) => JSON.stringify(ex)).join('\n') + '\n';
  const sftRepairBody =
    dataset.sftRepair.map((ex) => JSON.stringify(ex)).join('\n') + '\n';
  const sftCombinedBody = sftZeroShotBody + sftRepairBody;

  // TRL DPOTrainer conversational preference format: prompt, chosen, rejected as message arrays,
  // alongside metadata fields for inspection and filtering.
  const dpoPairsBody =
    dataset.dpoPairs
      .map((pair) =>
        JSON.stringify({
          id: pair.id,
          scenarioId: pair.scenarioId,
          failureCategory: pair.failureCategory,
          operator: pair.operator,
          prompt: pair.prompt,
          chosen: [{ role: 'assistant', content: pair.chosen }],
          rejected: [{ role: 'assistant', content: pair.rejected }],
          verifierDetails: pair.verifierDetails,
        }),
      )
      .join('\n') + '\n';

  const files = {
    sftZeroShot: 'sft-zero-shot.jsonl',
    sftRepair: 'sft-repair.jsonl',
    sftCombined: 'sft-combined.jsonl',
    dpoPairs: 'dpo-pairs.jsonl',
  } as const;

  await fs.writeFile(path.join(args.outDir, files.sftZeroShot), sftZeroShotBody);
  await fs.writeFile(path.join(args.outDir, files.sftRepair), sftRepairBody);
  await fs.writeFile(path.join(args.outDir, files.sftCombined), sftCombinedBody);
  await fs.writeFile(path.join(args.outDir, files.dpoPairs), dpoPairsBody);

  const wallNs = (process.hrtime.bigint() - t0).toString();
  const report = {
    ...dataset.summary,
    gitCommit: currentGitCommit(),
    wallNs,
    files: {
      [files.sftZeroShot]: {
        rows: dataset.sftZeroShot.length,
        sha256: sha256Hex(sftZeroShotBody),
      },
      [files.sftRepair]: {
        rows: dataset.sftRepair.length,
        sha256: sha256Hex(sftRepairBody),
      },
      [files.sftCombined]: {
        rows: dataset.sftZeroShot.length + dataset.sftRepair.length,
        sha256: sha256Hex(sftCombinedBody),
      },
      [files.dpoPairs]: {
        rows: dataset.dpoPairs.length,
        sha256: sha256Hex(dpoPairsBody),
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

