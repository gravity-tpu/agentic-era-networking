/**
 * Seed sharding for scripts/agent-eval.ts: run seeds 1..N as k concurrent processes against one model server, then merge.
 * Pure: no I/O. A trial is identical whichever shard runs it (same seed, prompt and sampling); only the schedule changes.
 *
 * Invariant 3/4: mergeShards refuses (throws) unless the shards share one provenance, form exactly the set 1..k, and
 * between them hold every seed 1..N once. A merge that cannot reject a gap or a duplicate would not be verification.
 */

/** Upper bound on shards: more concurrent streams than this risks exhausting GPU memory for the KV caches. */
export const MAX_SHARDS = 16;

export interface ShardSpec {
  readonly index: number; // 1-based
  readonly count: number;
}

export interface ShardInput {
  readonly summary: Record<string, unknown>;
  readonly trialsJsonl: string;
}

export interface MergedShards {
  readonly summary: Record<string, unknown>;
  readonly trialsJsonl: string;
}

/** Summary fields that must be identical across shards: they identify the model, prompt, intent, settings and code. */
const PROVENANCE_KEYS = [
  'schema', 'protocol', 'intent', 'model', 'modelDigest', 'host', 'trials', 'temperature', 'topP', 'seeds',
  'numPredict', 'think', 'promptSha256', 'promptVersion', 'intentSha256', 'gitCommit',
] as const;

export function parseShardSpec(raw: string, trials: number): ShardSpec {
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (m === null) throw new Error(`--shard must look like i/k (for example 2/4), got ${JSON.stringify(raw)}`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || count > MAX_SHARDS) throw new Error(`--shard: k must be 1 to ${MAX_SHARDS}`);
  if (index < 1 || index > count) throw new Error(`--shard: i must be 1 to k (${count})`);
  if (count > trials) throw new Error(`--shard: ${count} shards exceeds ${trials} trials (more shards than trials)`);
  return { index, count };
}

/** Seeds this shard runs: strided so shards take equal shares even if later seeds think longer. */
export function shardSeeds(trials: number, shard: ShardSpec): number[] {
  const seeds: number[] = [];
  for (let seed = shard.index; seed <= trials; seed += shard.count) seeds.push(seed);
  return seeds;
}

function shardOf(summary: Record<string, unknown>): ShardSpec & { readonly seedsRun: readonly number[] } {
  const s = summary['shard'] as { index?: unknown; count?: unknown; seedsRun?: unknown } | undefined;
  if (s === undefined || !Number.isInteger(s.index) || !Number.isInteger(s.count) || !Array.isArray(s.seedsRun)) {
    throw new Error('ERR_SHARD_SET: a summary has no valid shard record (was it run without --shard?)');
  }
  return { index: s.index as number, count: s.count as number, seedsRun: s.seedsRun as number[] };
}

export function mergeShards(inputs: readonly ShardInput[]): MergedShards {
  if (inputs.length === 0) throw new Error('ERR_SHARD_SET: no shards to merge');
  const shards = inputs.map((i) => shardOf(i.summary));
  const count = shards[0]!.count;
  const indexes = shards.map((s) => s.index).sort((a, b) => a - b);
  const expected = Array.from({ length: count }, (_, i) => i + 1);
  if (shards.some((s) => s.count !== count) || inputs.length !== count || indexes.some((v, i) => v !== expected[i])) {
    throw new Error(`ERR_SHARD_SET: need exactly shards 1..${count}, got ${JSON.stringify(indexes)}`);
  }

  const first = inputs[0]!.summary;
  for (const input of inputs) {
    for (const key of PROVENANCE_KEYS) {
      if (JSON.stringify(input.summary[key]) !== JSON.stringify(first[key])) {
        throw new Error(`ERR_SHARD_MISMATCH: shards disagree on ${key}`);
      }
    }
  }
  const trials = first['trials'] as number;

  const records: Array<{ seed: number; line: string }> = [];
  inputs.forEach((input, idx) => {
    const spec = shards[idx]!;
    const want = shardSeeds(trials, { index: spec.index, count: spec.count });
    const lines = input.trialsJsonl.split('\n').filter((l) => l.trim() !== '');
    const got = lines.map((l) => (JSON.parse(l) as { seed: number }).seed);
    if (JSON.stringify(got) !== JSON.stringify(want) || JSON.stringify(spec.seedsRun) !== JSON.stringify(want)) {
      throw new Error(`ERR_SHARD_SEEDS: shard ${spec.index}/${count} should hold seeds ${JSON.stringify(want)} but holds ${JSON.stringify(got)}`);
    }
    lines.forEach((line, i) => records.push({ seed: got[i]!, line }));
  });
  records.sort((a, b) => a.seed - b.seed);
  if (records.length !== trials || records.some((r, i) => r.seed !== i + 1)) {
    throw new Error(`ERR_SHARD_SEEDS: merged trials are not exactly seeds 1..${trials}`);
  }

  const counts: Record<string, number> = {};
  for (const input of inputs) {
    for (const [k, v] of Object.entries(input.summary['counts'] as Record<string, number>)) counts[k] = (counts[k] ?? 0) + v;
  }
  const summary: Record<string, unknown> = { ...first };
  delete summary['shard'];
  summary['trialsRun'] = records.length;
  summary['counts'] = counts;
  summary['startedAt'] = inputs.map((i) => String(i.summary['startedAt'])).sort()[0];
  summary['mergedFromShards'] = count;
  return { summary, trialsJsonl: records.map((r) => r.line).join('\n') + '\n' };
}
