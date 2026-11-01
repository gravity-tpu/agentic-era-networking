/**
 * test/invariants/wire-report.test.ts
 * The report of an on-wire conformance run (plan section 16.6): per-session and per-kind counts, the lists of disagreements, intent violations and unsent
 * flows, a Wilson interval for the agreement rate, and the consistency of the repeat sessions. Pure functions over result data.
 */
import { describe, it, expect } from 'vitest';
import { wilson95, aggregate, repeatConsistency, type ReportSet } from '../../src/sdn/wire-report.js';

const flow = (flowId: string, predicted: number[], observed: number[], leaks: number[] = [], missing: number[] = []) => ({
  flowId, tag: 1, sent: true as const, predicted, observed,
  m1: { agrees: JSON.stringify(predicted) === JSON.stringify(observed), seenNotPredicted: observed.filter((p) => !predicted.includes(p)), predictedNotSeen: predicted.filter((p) => !observed.includes(p)) },
  expectation: { clauseId: 'c', mustReach: [], mayReach: [] },
  m2: { compliant: leaks.length === 0 && missing.length === 0, leaks, missing },
  evidence: {},
});
const unsent = (flowId: string, reason: string) => ({ flowId, tag: 2, sent: false as const, reason });
const set = (id: string, kind: string, flows: ReportSet['flows'], intent = 'i/v1'): ReportSet => ({ id, kind, intent, installed: true, restored: true, flows });

describe('wilson95', () => {
  it('matches the interval reported for the 2026-10-20 run: 290 of 290 is 98.7% to 100%', () => {
    const w = wilson95(290, 290);
    expect(w.lo).toBeGreaterThan(0.986);
    expect(w.lo).toBeLessThan(0.988);
    expect(w.hi).toBeCloseTo(1, 6);
  });
  it('is a proper interval for a middle value and rejects impossible input', () => {
    const w = wilson95(50, 100);
    expect(w.lo).toBeCloseTo(0.404, 2);
    expect(w.hi).toBeCloseTo(0.596, 2);
    expect(() => wilson95(5, 4)).toThrow(RangeError);
    expect(() => wilson95(-1, 4)).toThrow(RangeError);
    expect(() => wilson95(0, 0)).toThrow(RangeError);
  });
});

describe('aggregate', () => {
  const sessions = [
    { name: 's1', sets: [set('a', 'reference', [flow('f1', [2], [2]), flow('f2', [3], [])]), set('b', 'model-admissible', [flow('f1', [2], [2, 3], [3]), unsent('f9', 'no sender')])] },
    { name: 's2', sets: [set('c', 'surviving-mutant', [flow('f1', [], [])])] },
  ];
  const r = aggregate(sessions, (intent, id) => (id === 'b' ? 'L4' : 'reference'));
  it('counts flows, agreements and intent violations per session and overall', () => {
    expect(r.total).toMatchObject({ sets: 3, flowsSent: 4, flowsNotSent: 1, m1Agree: 2, m1Disagree: 2, m2Compliant: 3, m2NonCompliant: 1 });
    expect(r.sessions.map((s) => [s.name, s.flowsSent, s.m1Disagree])).toEqual([['s1', 3, 2], ['s2', 1, 0]]);
  });
  it('splits by kind and by the arm that produced the set', () => {
    expect(r.byKind['reference']).toMatchObject({ sets: 1, flowsSent: 2, m1Agree: 1 });
    expect(r.byArm['L4']).toMatchObject({ sets: 1, flowsSent: 1, m1Agree: 0 });
  });
  it('lists every disagreement, intent violation and unsent flow with where it happened, and never counts an unsent flow as agreement', () => {
    expect(r.disagreements.map((d) => `${d.set}/${d.flow}`).sort()).toEqual(['a/f2', 'b/f1']);
    expect(r.nonCompliant.map((d) => `${d.set}/${d.flow}`)).toEqual(['b/f1']);
    expect(r.unsent).toEqual([{ session: 's1', set: 'b', intent: 'i/v1', flow: 'f9', reason: 'no sender' }]);
    expect(r.total.m1Agree + r.total.m1Disagree).toBe(r.total.flowsSent);
  });
});

describe('repeatConsistency', () => {
  const a = [set('x', 'surviving-mutant', [flow('f1', [2], [2]), flow('f2', [3], [3])])];
  it('reports a set whose observations are identical across the sessions as stable', () => {
    const c = repeatConsistency([a, a, a]);
    expect(c).toMatchObject({ sets: 1, stable: 1, unstable: [] });
  });
  it('can fail: a flow observed differently in one session makes the set unstable and names the flow', () => {
    const b = [set('x', 'surviving-mutant', [flow('f1', [2], [2]), flow('f2', [3], [])])];
    const c = repeatConsistency([a, a, b]);
    expect(c.stable).toBe(0);
    expect(c.unstable).toEqual([{ intent: 'i/v1', set: 'x', flows: ['f2'] }]);
  });
  it('refuses fewer than two sessions (nothing to compare)', () => {
    expect(() => repeatConsistency([a])).toThrow(RangeError);
  });
});
