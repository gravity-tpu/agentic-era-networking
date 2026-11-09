/**
 * eval-shards.test.ts
 * Seed sharding for scripts/agent-eval.ts (docs/research/evaluation-plan.md section 11): a sharded run must
 * merge into exactly the record an unsharded run would have produced, and any gap, duplicate or provenance
 * mismatch must refuse the merge (Invariant 3/4: a check that cannot reject is not verification).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mergeShards, shardSeeds, parseShardSpec, parseSeedStart, trialSeeds, MAX_SEED_START, type ShardInput } from '../../src/sdn/eval-shards.js';

const BASE = {
  schema: 'agent-eval/v2', protocol: 'A (zero-shot)', intent: 'quarantine-precedence/v1', model: 'zodiac-L3',
  modelDigest: 'abc', host: 'http://127.0.0.1:11434', trials: 6, temperature: 0.2, topP: 0.95, seeds: '1..6',
  numPredict: 32768, think: true, promptSha256: 'p', promptVersion: 'v3', intentSha256: 'i', gitCommit: 'deadbeef',
};

function shard(index: number, count: number, n: number, over: Record<string, unknown> = {}, cats: Record<number, string> = {}): ShardInput {
  const seeds = shardSeeds(n, { index, count });
  const lines = seeds.map((s) => JSON.stringify({ seed: s, ok: true, category: cats[s] ?? 'ADMISSIBLE', wallNs: '1' }));
  const counts: Record<string, number> = { ADMISSIBLE: 0, ERR_INTENT_LEAK: 0, TRANSPORT_FAILURE: 0 };
  for (const s of seeds) counts[cats[s] ?? 'ADMISSIBLE'] = (counts[cats[s] ?? 'ADMISSIBLE'] ?? 0) + 1;
  return {
    summary: { ...BASE, trials: n, seeds: `1..${n}`, trialsRun: seeds.length, startedAt: `2026-10-30T05:0${index}:00Z`, counts, shard: { index, count, seedsRun: seeds }, ...over },
    trialsJsonl: lines.join('\n') + '\n',
  };
}

describe('shardSeeds / parseShardSpec', () => {
  it('strides seeds so every seed belongs to exactly one shard', () => {
    expect(shardSeeds(6, { index: 1, count: 4 })).toEqual([1, 5]);
    expect(shardSeeds(6, { index: 2, count: 4 })).toEqual([2, 6]);
    expect(shardSeeds(6, { index: 3, count: 4 })).toEqual([3]);
    expect(shardSeeds(6, { index: 4, count: 4 })).toEqual([4]);
    const all = [1, 2, 3, 4].flatMap((i) => shardSeeds(50, { index: i, count: 4 })).sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
  it('parses i/k and rejects anything else', () => {
    expect(parseShardSpec('2/4', 50)).toEqual({ index: 2, count: 4 });
    for (const bad of ['0/4', '5/4', '1/0', '1/17', 'a/b', '2', '1/4/2', '-1/4', '1.5/4']) {
      expect(() => parseShardSpec(bad, 50)).toThrow();
    }
    expect(() => parseShardSpec('1/8', 4)).toThrow(/shards than trials|exceeds/i);
  });
});

describe('mergeShards', () => {
  it('merges complete shards into seed order with summed counts and no shard field', () => {
    const merged = mergeShards([shard(2, 3, 6, {}, { 2: 'ERR_INTENT_LEAK' }), shard(1, 3, 6), shard(3, 3, 6)]);
    const seeds = merged.trialsJsonl.trim().split('\n').map((l) => (JSON.parse(l) as { seed: number }).seed);
    expect(seeds).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged.summary['trialsRun']).toBe(6);
    expect(merged.summary['counts']).toMatchObject({ ADMISSIBLE: 5, ERR_INTENT_LEAK: 1 });
    expect(merged.summary['shard']).toBeUndefined();
    expect(merged.summary['mergedFromShards']).toBe(3);
    expect(merged.summary['startedAt']).toBe('2026-10-30T05:01:00Z');
  });
  it('refuses a missing shard', () => {
    expect(() => mergeShards([shard(1, 3, 6), shard(2, 3, 6)])).toThrow(/ERR_SHARD_SET/);
  });
  it('refuses a duplicated shard index', () => {
    expect(() => mergeShards([shard(1, 2, 6), shard(1, 2, 6)])).toThrow(/ERR_SHARD_SET/);
  });
  it('refuses shards whose provenance differs (model, prompt, commit, intent, settings)', () => {
    for (const over of [{ modelDigest: 'x' }, { promptSha256: 'x' }, { gitCommit: 'x' }, { intentSha256: 'x' }, { temperature: 0.5 }, { numPredict: 1 }]) {
      expect(() => mergeShards([shard(1, 2, 6), shard(2, 2, 6, over)])).toThrow(/ERR_SHARD_MISMATCH/);
    }
  });
  it('refuses a shard that did not run all of its seeds', () => {
    const full = shard(2, 2, 6);
    const short = { ...full, trialsJsonl: full.trialsJsonl.split('\n').slice(0, 1).join('\n') + '\n' };
    expect(() => mergeShards([shard(1, 2, 6), short])).toThrow(/ERR_SHARD_SEEDS/);
  });
  it('refuses a trial whose seed belongs to another shard (duplicate across shards)', () => {
    const other = shard(2, 2, 6);
    const bad = { ...other, trialsJsonl: JSON.stringify({ seed: 1, ok: true, category: 'ADMISSIBLE' }) + '\n' + other.trialsJsonl.split('\n').slice(1).join('\n') };
    expect(() => mergeShards([shard(1, 2, 6), bad])).toThrow(/ERR_SHARD_SEEDS/);
  });
  it('refuses an unsharded summary', () => {
    const plain = shard(1, 1, 6);
    delete (plain.summary as Record<string, unknown>)['shard'];
    expect(() => mergeShards([plain])).toThrow(/ERR_SHARD_SET/);
  });
});

describe('scripts/agent-eval.ts --shard validation (before any network or git check)', () => {
  function run(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync('node', ['--experimental-strip-types', '--no-warnings', 'scripts/agent-eval.ts', ...args], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? '' };
    }
  }
  const common = ['--intent', 'dns-confinement/v1', '--host', 'http://127.0.0.1:1', '--out', '/tmp/agent-eval-shard-test'];
  it('rejects a malformed shard spec', () => {
    const r = run([...common, '--model', 'm', '--n', '10', '--shard', '5/4']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--shard');
  });
  it('rejects --shard together with --batch', () => {
    const r = run(['--provider', 'anthropic', '--batch', '--intent', 'dns-confinement/v1', '--model', 'm', '--n', '10', '--shard', '1/2', '--out', '/tmp/agent-eval-shard-test',
      '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--shard cannot be combined with --batch');
  });
  it('accepts a valid shard spec (fails later, not on --shard)', () => {
    const r = run([...common, '--model', 'm', '--n', '10', '--shard', '2/4']);
    expect(r.stderr).not.toContain('--shard');
  });
});

describe('seed start (fresh seed ranges for repeat runs, plan section 17)', () => {
  it('defaults to seeds 1..N and offsets the whole range when a start is given', () => {
    expect(trialSeeds(4)).toEqual([1, 2, 3, 4]);
    expect(trialSeeds(4, 51)).toEqual([51, 52, 53, 54]);
    expect(shardSeeds(6, { index: 1, count: 4 }, 51)).toEqual([51, 55]);
    expect(shardSeeds(6, { index: 4, count: 4 }, 51)).toEqual([54]);
    const all = [1, 2, 3, 4].flatMap((i) => shardSeeds(50, { index: i, count: 4 }, 101)).sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => 101 + i));
  });
  it('leaves the unoffset behaviour unchanged', () => {
    expect(shardSeeds(6, { index: 2, count: 4 })).toEqual([2, 6]);
    expect(shardSeeds(6, { index: 2, count: 4 }, 1)).toEqual([2, 6]);
  });
  it('parses --seed-start and rejects anything that is not a positive integer within the bound', () => {
    expect(parseSeedStart(undefined)).toBe(1);
    expect(parseSeedStart('51')).toBe(51);
    expect(parseSeedStart(String(MAX_SEED_START))).toBe(MAX_SEED_START);
    for (const bad of ['0', '-1', '1.5', 'abc', '', ' 5', '1e3', String(MAX_SEED_START + 1)]) {
      expect(() => parseSeedStart(bad)).toThrow(/--seed-start/);
    }
  });
  function offsetShard(index: number, count: number, n: number, start: number, over: Record<string, unknown> = {}): ShardInput {
    const seeds = shardSeeds(n, { index, count }, start);
    const lines = seeds.map((s) => JSON.stringify({ seed: s, ok: true, category: 'ADMISSIBLE', wallNs: '1' }));
    return {
      summary: { ...BASE, trials: n, seeds: `${start}..${start + n - 1}`, seedStart: start, trialsRun: seeds.length, startedAt: `2026-11-09T05:0${index}:00Z`,
        counts: { ADMISSIBLE: seeds.length, ERR_INTENT_LEAK: 0, TRANSPORT_FAILURE: 0 }, shard: { index, count, seedsRun: seeds }, ...over },
      trialsJsonl: lines.join('\n') + '\n',
    };
  }
  it('merges shards of an offset run into exactly seeds start..start+N-1', () => {
    const merged = mergeShards([1, 2, 3].map((i) => offsetShard(i, 3, 7, 51)));
    const seeds = merged.trialsJsonl.trim().split('\n').map((l) => (JSON.parse(l) as { seed: number }).seed);
    expect(seeds).toEqual([51, 52, 53, 54, 55, 56, 57]);
    expect(merged.summary['seedStart']).toBe(51);
    expect(merged.summary['trialsRun']).toBe(7);
  });
  it('refuses shards that disagree on the seed start', () => {
    const a = offsetShard(1, 2, 6, 51);
    const b = offsetShard(2, 2, 6, 101);
    expect(() => mergeShards([a, b])).toThrow(/ERR_SHARD_MISMATCH/);
  });
  it('refuses a shard whose seeds are not the offset range it claims', () => {
    const good = offsetShard(1, 2, 6, 51);
    const bad = offsetShard(2, 2, 6, 51, {});
    const wrong = { ...bad, trialsJsonl: shardSeeds(6, { index: 2, count: 2 }).map((s) => JSON.stringify({ seed: s, ok: true, category: 'ADMISSIBLE' })).join('\n') + '\n' };
    expect(() => mergeShards([good, wrong])).toThrow(/ERR_SHARD_SEEDS/);
  });
  it('still merges an old summary with no seedStart as seeds 1..N', () => {
    const merged = mergeShards([shard(1, 2, 4), shard(2, 2, 4)]);
    expect(merged.trialsJsonl.trim().split('\n').map((l) => (JSON.parse(l) as { seed: number }).seed)).toEqual([1, 2, 3, 4]);
  });
});

describe('scripts/agent-eval.ts --seed-start validation (before any network or git check)', () => {
  function run(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync('node', ['--experimental-strip-types', '--no-warnings', 'scripts/agent-eval.ts', ...args], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? '' };
    }
  }
  const common = ['--host', 'http://127.0.0.1:1', '--intent', 'dns-confinement/v1', '--model', 'm', '--n', '10', '--out', '/tmp/agent-eval-seed-start-test'];
  it('rejects a non-positive or non-integer start', () => {
    for (const bad of ['0', '-3', 'x', '2.5']) {
      const r = run([...common, '--seed-start', bad]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--seed-start');
    }
  });
  it('rejects --seed-start together with --batch', () => {
    const r = run(['--provider', 'anthropic', '--batch', '--intent', 'dns-confinement/v1', '--model', 'm', '--n', '10', '--seed-start', '51', '--out', '/tmp/agent-eval-seed-start-test',
      '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--seed-start cannot be combined with --batch');
  });
  it('accepts a valid start (fails later, not on --seed-start)', () => {
    const r = run([...common, '--seed-start', '51']);
    expect(r.stderr).not.toContain('--seed-start');
  });
});
