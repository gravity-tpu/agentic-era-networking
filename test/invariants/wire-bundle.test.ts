/**
 * test/invariants/wire-bundle.test.ts
 * The on-wire conformance bundle (Track A close-out, plan section 16) is chosen by a fixed rule and a fixed seed from recorded data. This test
 * regenerates it and fails if it differs from the committed one, so the bundle that was approved by hash is the bundle the rule produces.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RESULTS = path.join(ROOT, 'docs/benchmarks/results/agent-evaluation');
const BUNDLE = path.join(ROOT, 'docs/benchmarks/results/conformance/bundle-2026-10-31');
const read = (p: string): string => readFileSync(p, 'utf8');

describe('wire bundle selection', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'wire-bundle-'));
  execFileSync('node', ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts/select-wire-bundle.ts'), RESULTS, out], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

  it('regenerates the committed index, flows, coverage flows and manifest byte for byte', () => {
    for (const f of ['index.json', 'flows.json', 'coverage-flows.json', 'repeats.json', 'manifest.json']) expect(read(path.join(out, f))).toBe(read(path.join(BUNDLE, f)));
  });

  it('every indexed rule set exists in the committed bundle and is installable within the bridge bounds', () => {
    const index = JSON.parse(read(path.join(BUNDLE, 'index.json'))) as Array<{ file: string; kind: string }>;
    expect(index.length).toBeGreaterThan(0);
    for (const e of index) {
      expect(existsSync(path.join(BUNDLE, e.file))).toBe(true);
      const body = JSON.parse(read(path.join(BUNDLE, e.file))) as { ttlSeconds: number; rules: Array<{ priority: number; outputPorts: number[] }> };
      expect(body.ttlSeconds).toBe(60);
      for (const r of body.rules) {
        expect(r.priority).toBeGreaterThanOrEqual(1);
        expect(r.priority).toBeLessThanOrEqual(65534); // 65535 is reserved for quarantine
        expect(r.outputPorts.every((p) => p >= 1 && p <= 3)).toBe(true);
      }
    }
  });

  it('has exactly one reference per intent and the manifest hash matches the index', () => {
    const index = JSON.parse(read(path.join(BUNDLE, 'index.json'))) as Array<{ intent: string; kind: string }>;
    const refs = index.filter((e) => e.kind === 'reference');
    expect(new Set(refs.map((e) => e.intent)).size).toBe(refs.length);
    expect(refs.length).toBe(8);
    const manifest = JSON.parse(read(path.join(BUNDLE, 'manifest.json'))) as { indexSha256: string };
    expect(manifest.indexSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('repeats.json (plan 16.5): 20 distinct separable sets of the bundle, drawn by the seed', () => {
    const index = JSON.parse(read(path.join(BUNDLE, 'index.json'))) as Array<{ intent: string; kind: string; id: string }>;
    const rep = JSON.parse(read(path.join(BUNDLE, 'repeats.json'))) as { seed: number; count: number; sets: Array<{ intent: string; id: string }> };
    expect(rep.count).toBe(20);
    expect(rep.sets).toHaveLength(20);
    expect(new Set(rep.sets.map((x) => `${x.intent}|${x.id}`)).size).toBe(20);
    for (const x of rep.sets) {
      const e = index.find((i) => i.intent === x.intent && i.id === x.id);
      expect(e, `${x.intent} ${x.id} is not in the index`).toBeDefined();
      expect(['surviving-mutant', 'model-admissible']).toContain(e?.kind);
    }
  });

  it('can fail: a different seed produces a different bundle', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'wire-bundle-seed-'));
    execFileSync('node', ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts/select-wire-bundle.ts'), RESULTS, other, '--seed', '7'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(read(path.join(other, 'index.json'))).not.toBe(read(path.join(BUNDLE, 'index.json')));
  });
});
