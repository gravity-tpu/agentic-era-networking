/**
 * eval-baselines.test.ts
 * Each committed baselines file must be exactly what the generator produces now (apart from the commit it was made at),
 * and its counts must agree with each other, so a file cannot drift from its generator or be edited by hand unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASELINE_TARGETS, computeBaselinesFor } from '../../src/sdn/eval-baselines.js';

const DIR = resolve(__dirname, '../../docs/benchmarks/results/agent-evaluation/baselines');

interface Committed {
  gitCommit: string;
  intent: string;
  mutants: { total: number; killed: number; survived: number; byOperator: Record<string, { total: number; killed: number; survived: number }>; killedByPrimaryCategory: Record<string, number> };
  survivedMutants: string[];
}

describe.each(BASELINE_TARGETS.map((t, i) => ({ t, i })))('committed baselines for $t.intent.id', ({ t, i }) => {
  const file = i === 0 ? join(DIR, 'summary.json') : join(DIR, t.intent.id.replace('/', '_'), 'summary.json');
  const committed = JSON.parse(readFileSync(file, 'utf-8')) as Committed;

  it('equal the regenerated result (gitCommit aside)', () => {
    const { gitCommit: _ignored, ...rest } = committed;
    expect(rest).toEqual(JSON.parse(JSON.stringify(computeBaselinesFor(t.intent, t.reference()))));
  });
  it('are internally consistent', () => {
    const m = committed.mutants;
    const ops = Object.values(m.byOperator);
    expect(m.killed + m.survived).toBe(m.total);
    expect(ops.reduce((n, o) => n + o.total, 0)).toBe(m.total);
    expect(ops.reduce((n, o) => n + o.killed, 0)).toBe(m.killed);
    expect(ops.reduce((n, o) => n + o.survived, 0)).toBe(m.survived);
    expect(Object.values(m.killedByPrimaryCategory).reduce((n, v) => n + v, 0)).toBe(m.killed);
    expect(committed.survivedMutants.length).toBe(m.survived);
  });
  it('can fail: the reference passes and some mutant is rejected', () => {
    const r = computeBaselinesFor(t.intent, t.reference());
    expect(r.reference.category).toBe('ADMISSIBLE');
    expect(r.mutants.killed).toBeGreaterThan(0);
  });
});
