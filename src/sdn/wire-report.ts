/**
 * wire-report.ts
 * The report of an on-wire conformance run (docs/research/evaluation-plan.md section 16.6): counts per session, per kind of rule set and per model
 * that produced it; the lists of disagreements with the model (M1), violations of the intent (M2) and flows that could not be sent; a Wilson interval
 * for the agreement rate; and the consistency of repeat sessions. Pure functions over result data; an unsent flow is never counted as agreement.
 */

import type { SetResult } from './wire-session.js';

export type ReportSet = SetResult;

const Z95 = 1.96;

/** 95% Wilson score interval for k successes in n trials (reporting only: the run's accounting is in integers). */
export function wilson95(k: number, n: number): { lo: number; hi: number } {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) throw new RangeError(`need integers with 0 <= k <= n and n >= 1, got k=${k}, n=${n}`);
  const p = k / n;
  const denom = 1 + (Z95 * Z95) / n;
  const centre = (p + (Z95 * Z95) / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface Counts { sets: number; flowsSent: number; flowsNotSent: number; m1Agree: number; m1Disagree: number; m2Compliant: number; m2NonCompliant: number }
const zero = (): Counts => ({ sets: 0, flowsSent: 0, flowsNotSent: 0, m1Agree: 0, m1Disagree: 0, m2Compliant: 0, m2NonCompliant: 0 });

export interface Disagreement { session: string; set: string; intent: string; kind: string; flow: string; predicted: number[]; observed: number[]; seenNotPredicted: number[]; predictedNotSeen: number[] }
export interface NonCompliance { session: string; set: string; intent: string; kind: string; flow: string; clause: string; leaks: number[]; missing: number[] }
export interface Unsent { session: string; set: string; intent: string; flow: string; reason: string }

export interface Report {
  readonly total: Counts;
  readonly sessions: Array<Counts & { name: string }>;
  readonly byKind: Record<string, Counts>;
  readonly byArm: Record<string, Counts>;
  readonly disagreements: Disagreement[];
  readonly nonCompliant: NonCompliance[];
  readonly unsent: Unsent[];
  readonly skipped: Array<{ session: string; set: string; reason: string }>;
}

function add(c: Counts, s: ReportSet): void {
  c.sets++;
  for (const f of s.flows) {
    if (!f.sent) { c.flowsNotSent++; continue; }
    c.flowsSent++;
    if (f.m1.agrees) c.m1Agree++; else c.m1Disagree++;
    if (f.m2.compliant) c.m2Compliant++; else c.m2NonCompliant++;
  }
}

export function aggregate(sessions: ReadonlyArray<{ name: string; sets: readonly ReportSet[] }>, armOf: (intent: string, id: string) => string): Report {
  const total = zero();
  const byKind: Record<string, Counts> = {};
  const byArm: Record<string, Counts> = {};
  const out: Report = { total, sessions: [], byKind, byArm, disagreements: [], nonCompliant: [], unsent: [], skipped: [] };
  for (const sess of sessions) {
    const sc = zero();
    for (const s of sess.sets) {
      add(total, s);
      add(sc, s);
      add((byKind[s.kind] ??= zero()), s);
      add((byArm[armOf(s.intent, s.id)] ??= zero()), s);
      if (s.skipped !== undefined) out.skipped.push({ session: sess.name, set: s.id, reason: s.skipped });
      for (const f of s.flows) {
        if (!f.sent) { out.unsent.push({ session: sess.name, set: s.id, intent: s.intent, flow: f.flowId, reason: f.reason }); continue; }
        if (!f.m1.agrees) out.disagreements.push({ session: sess.name, set: s.id, intent: s.intent, kind: s.kind, flow: f.flowId, predicted: f.predicted, observed: f.observed, seenNotPredicted: f.m1.seenNotPredicted, predictedNotSeen: f.m1.predictedNotSeen });
        if (!f.m2.compliant) out.nonCompliant.push({ session: sess.name, set: s.id, intent: s.intent, kind: s.kind, flow: f.flowId, clause: f.expectation.clauseId, leaks: f.m2.leaks, missing: f.m2.missing });
      }
    }
    out.sessions.push({ name: sess.name, ...sc });
  }
  return out;
}

export interface Consistency { sets: number; stable: number; unstable: Array<{ intent: string; set: string; flows: string[] }> }

/** For repeat sessions of the same sets: a set is stable when every flow was observed on the same ports (and sent or not sent alike) in every session. */
export function repeatConsistency(sessions: ReadonlyArray<readonly ReportSet[]>): Consistency {
  if (sessions.length < 2) throw new RangeError('need at least two sessions to compare');
  const key = (s: ReportSet): string => `${s.intent}|${s.id}`;
  const first = sessions[0] as readonly ReportSet[];
  const unstable: Consistency['unstable'] = [];
  for (const s of first) {
    const others = sessions.slice(1).map((sess) => sess.find((x) => key(x) === key(s)));
    const differing = new Set<string>();
    if (others.some((o) => o === undefined)) differing.add('(set missing from a session)');
    const flowIds = new Set<string>(s.flows.map((f) => f.flowId));
    for (const o of others) for (const f of o?.flows ?? []) flowIds.add(f.flowId);
    for (const id of flowIds) {
      const sig = [s, ...others].map((x) => {
        const f = x?.flows.find((g) => g.flowId === id);
        return f === undefined ? 'absent' : f.sent ? `sent:${JSON.stringify(f.observed)}` : 'unsent';
      });
      if (new Set(sig).size > 1) differing.add(id);
    }
    if (differing.size > 0) unstable.push({ intent: s.intent, set: s.id, flows: [...differing].sort() });
  }
  return { sets: first.length, stable: first.length - unstable.length, unstable };
}
