/**
 * scripts/merge-eval-shards.ts
 * Joins the per-shard result directories of scripts/agent-eval.ts --shard i/k into one canonical result directory
 * (trials.jsonl in seed order, summary.json with summed counts). Refuses unless the shards agree on provenance and
 * cover seeds 1..N exactly once (src/sdn/eval-shards.ts). Invariant 3/4: nothing is merged on a guess.
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/merge-eval-shards.ts --out <dir> <shardDir> [<shardDir> ...]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeShards, type ShardInput } from '../dist/sdn/eval-shards.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const dirs = argv.filter((_, i) => i !== outIdx && i !== outIdx + 1);
  if (out === undefined || dirs.length === 0) throw new Error('usage: merge-eval-shards.ts --out <dir> <shardDir> [<shardDir> ...]');
  const inputs: ShardInput[] = [];
  for (const dir of dirs) {
    inputs.push({
      summary: JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf8')) as Record<string, unknown>,
      trialsJsonl: await fs.readFile(path.join(dir, 'trials.jsonl'), 'utf8'),
    });
  }
  const merged = mergeShards(inputs);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'trials.jsonl'), merged.trialsJsonl);
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(merged.summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(merged.summary['counts']) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
