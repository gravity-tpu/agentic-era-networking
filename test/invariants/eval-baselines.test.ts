/**
 * eval-baselines.test.ts
 * The committed baselines file must be exactly what the generator produces now (apart from the commit it was made at),
 * and its counts must agree with each other, so the file cannot drift from its generator or be edited by hand unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeBaselines } from '../../src/sdn/eval-baselines.js';

const FILE = resolve(__dirname, '../../docs/benchmarks/results/agent-evaluation/baselines/summary.json');
const committed = JSON.parse(readFileSync(FILE, 'utf-8')) as Record<string, unknown> & {
  mutants: { total: number; killed: number; survived: number; byOperator: Record<string, { total: number; killed: number; survived: number }>; killedByPrimaryCategory: Record<string, number> };
  survivedMutants: string[];
};

describe('committed baselines', () => {
  it('equal the regenerated result (gitCommit aside)', () => {
    const { gitCommit: _ignored, ...rest } = committed;
    expect(rest).toEqual(JSON.parse(JSON.stringify(computeBaselines())));
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
  it('can fail: the reference passes and a leaking policy would be rejected', () => {
    const r = computeBaselines();
    expect(r.reference.category).toBe('ADMISSIBLE');
    expect(r.mutants.killed).toBeGreaterThan(0);
  });
});
