/**
 * test/invariants/isolation-watch.test.ts
 * The isolation watcher (docs/design/isolation-watch.md): a damped state machine that turns the bridge's isolation status into push messages for a person.
 * The bridge only reports a lost or changed table-miss DROP on a status endpoint, a dashboard badge and the journal; nothing pushes it. These tests pin the
 * damping (a transient must not page anyone), the escalation, the recovery, the dead-re-check and unreachable cases, the retry when a push fails, and the config bounds.
 */
import { describe, it, expect } from 'vitest';
import {
  IsolationWatcher, classify, parseObservation, parseWatchConfig, DEFAULT_WATCH_CONFIG,
  type Observation, type WatchMessage,
} from '../../src/sdn/isolation-watch.js';

const NS_PER_S = 1_000_000_000n;
const ok: Observation = { kind: 'status', state: 'verified', tableMiss: 'drops', checkedAgeMs: 10_000, mismatches: 0 };
const mismatch: Observation = { kind: 'status', state: 'mismatch', tableMiss: 'drops', checkedAgeMs: 10_000, mismatches: 2 };
const forwards: Observation = { kind: 'status', state: 'mismatch', tableMiss: 'forwards', checkedAgeMs: 10_000, mismatches: 1 };
const absent: Observation = { kind: 'status', state: 'mismatch', tableMiss: 'absent', checkedAgeMs: 10_000, mismatches: 1 };
const stale: Observation = { kind: 'status', state: 'verified', tableMiss: 'drops', checkedAgeMs: 20 * 60_000, mismatches: 0 };
const down: Observation = { kind: 'unreachable', reason: 'connect ECONNREFUSED' };

/** A watcher on a fake clock that advances one poll interval (60 s) per observation. */
function rig(cfg = DEFAULT_WATCH_CONFIG, drainStarted = true) {
  let t = 1_000n * NS_PER_S;
  const w = new IsolationWatcher(cfg, t);
  if (drainStarted) for (const m of w.outbox()) w.delivered(m.id); // the one-time 'started' message is not what these tests are about
  const sent: WatchMessage[] = [];
  const poll = (o: Observation, secs = 60): WatchMessage[] => {
    t += BigInt(secs) * NS_PER_S;
    w.observe(o, t);
    const out = w.outbox();
    for (const m of out) { sent.push(m); w.delivered(m.id); }
    return out;
  };
  return { w, poll, sent, now: () => t };
}
const kinds = (ms: WatchMessage[]): string[] => ms.map((m) => m.kind);

describe('classify', () => {
  it('a verified status with a dropping table-miss and a fresh check is ok', () => expect(classify(ok, DEFAULT_WATCH_CONFIG)).toBe('ok'));
  it('a mismatch is bad; a table-miss that is absent, forwards or is unrecognised is critical', () => {
    expect(classify(mismatch, DEFAULT_WATCH_CONFIG)).toBe('bad');
    for (const tm of ['absent', 'forwards', 'unrecognised']) expect(classify({ ...mismatch, tableMiss: tm }, DEFAULT_WATCH_CONFIG)).toBe('critical');
  });
  it('a verified status whose check is older than the limit is stale (the re-check has stopped; verified is then not evidence)', () => expect(classify(stale, DEFAULT_WATCH_CONFIG)).toBe('stale'));
  it('an unreachable bridge is unreachable; a verifier_rejected policy is critical; readback_failed and not_installed are bad', () => {
    expect(classify(down, DEFAULT_WATCH_CONFIG)).toBe('unreachable');
    expect(classify({ ...ok, state: 'verifier_rejected' }, DEFAULT_WATCH_CONFIG)).toBe('critical');
    for (const s of ['readback_failed', 'not_installed']) expect(classify({ ...ok, state: s }, DEFAULT_WATCH_CONFIG)).toBe('bad');
  });
  it('an unknown state is never ok (fail closed)', () => expect(classify({ ...ok, state: 'something-new' }, DEFAULT_WATCH_CONFIG)).toBe('bad'));
});

describe('damping: a transient must not page anyone', () => {
  it('a mismatch shorter than the threshold raises no alert and no recovery message', () => {
    const r = rig();
    const msgs = [mismatch, mismatch, mismatch, ok, ok, ok].flatMap((o) => r.poll(o));
    expect(msgs).toEqual([]);
  });
  it('a generic mismatch alerts once, on the poll that reaches the threshold (5 by default), as a high-priority message', () => {
    const r = rig();
    const out = [1, 2, 3, 4].flatMap(() => r.poll(mismatch));
    expect(out).toEqual([]);
    const fifth = r.poll(mismatch);
    expect(kinds(fifth)).toEqual(['alert']);
    expect(fifth[0]?.priority).toBe('high');
    expect(r.poll(mismatch)).toEqual([]); // not again on the next poll
  });
  it('a lost or forwarding table-miss alerts sooner (2 polls) and as urgent', () => {
    for (const bad of [absent, forwards]) {
      const r = rig();
      expect(r.poll(bad)).toEqual([]);
      const m = r.poll(bad);
      expect(kinds(m)).toEqual(['alert']);
      expect(m[0]?.priority).toBe('urgent');
      expect(m[0]?.body).toMatch(/table-miss/);
    }
  });
});

describe('episodes: escalation, reminders and recovery', () => {
  it('escalates from bad to critical with a new alert', () => {
    const r = rig();
    [1, 2, 3, 4, 5].forEach(() => r.poll(mismatch));
    expect(r.sent.map((m) => m.priority)).toEqual(['high']);
    r.poll(forwards);
    const m = r.poll(forwards);
    expect(kinds(m)).toEqual(['alert']);
    expect(m[0]?.priority).toBe('urgent');
  });
  it('reminds while the problem lasts, every 30 minutes by default, and stops after the bounded number of reminders', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.poll(forwards, 60);
    const before = r.sent.length;
    r.poll(forwards, 25 * 60);
    expect(r.sent.length).toBe(before); // 28 minutes since the alert: not yet
    r.poll(forwards, 3 * 60);
    expect(kinds(r.sent.slice(before))).toEqual(['reminder']); // 31 minutes since the alert
    for (let i = 0; i < 20; i++) r.poll(forwards, 31 * 60);
    expect(r.sent.filter((m) => m.kind === 'reminder').length).toBe(DEFAULT_WATCH_CONFIG.maxReminders);
  });
  it('sends one recovered message after the clean-polls threshold, and a bad poll in between resets the streak', () => {
    const r = rig();
    for (let i = 0; i < 2; i++) r.poll(forwards);
    expect(r.sent.map((m) => m.kind)).toEqual(['alert']);
    r.poll(ok);
    r.poll(forwards); // resets the clean streak
    expect(r.sent.map((m) => m.kind)).toEqual(['alert']);
    r.poll(ok);
    expect(kinds(r.poll(ok))).toEqual(['recovered']);
    expect(r.poll(ok)).toEqual([]);
  });
});

describe('a silent or dead check is a problem too', () => {
  it('alerts when the bridge is unreachable for the threshold (3 polls), and recovers', () => {
    const r = rig();
    r.poll(down); r.poll(down);
    const m = r.poll(down);
    expect(kinds(m)).toEqual(['alert']);
    expect(m[0]?.body).toMatch(/unreachable|cannot be reached/i);
    r.poll(ok);
    expect(kinds(r.poll(ok))).toEqual(['recovered']);
  });
  it('alerts when the isolation re-check has stopped (a frozen verified status), after the same threshold', () => {
    const r = rig();
    r.poll(stale); r.poll(stale);
    const m = r.poll(stale);
    expect(kinds(m)).toEqual(['alert']);
    expect(m[0]?.body).toMatch(/re-check/i);
  });
});

describe('delivery', () => {
  it('keeps a message pending until it is delivered, so a failed push is retried and never duplicated', () => {
    let t = 1_000n * NS_PER_S;
    const w = new IsolationWatcher(DEFAULT_WATCH_CONFIG, t);
    for (const m of w.outbox()) w.delivered(m.id); // drain 'started'
    for (let i = 0; i < 2; i++) { t += 60n * NS_PER_S; w.observe(forwards, t); }
    const first = w.outbox();
    expect(kinds(first)).toEqual(['alert']);
    t += 60n * NS_PER_S; w.observe(forwards, t);
    expect(w.outbox().map((m) => m.id)).toEqual(first.map((m) => m.id)); // still the same single pending alert
    w.delivered(first[0]!.id);
    expect(w.outbox()).toEqual([]);
  });
  it('sends a started message and a heartbeat every 24 hours, so silence means the watcher is not running', () => {
    const r = rig(DEFAULT_WATCH_CONFIG, false);
    expect(kinds(r.w.outbox())).toEqual(['started']);
    r.w.delivered(r.w.outbox()[0]!.id);
    for (let i = 0; i < 100; i++) r.poll(ok, 60);
    expect(r.sent.filter((m) => m.kind === 'heartbeat')).toEqual([]);
    const beat = r.poll(ok, 24 * 3600);
    expect(kinds(beat)).toEqual(['heartbeat']);
  });
});

describe('parseObservation', () => {
  it('reads the bridge payload', () => {
    const o = parseObservation({ port1Isolation: { state: 'verified', checkedAgeMs: 5000, mismatches: [], actions: { tableMiss: 'drops' } } });
    expect(o).toEqual({ kind: 'status', state: 'verified', tableMiss: 'drops', checkedAgeMs: 5000, mismatches: 0, repair: null }); // a bridge without auto-repair reports none
  });
  it('treats a payload it cannot read as unreachable, never as ok', () => {
    for (const bad of [null, {}, { port1Isolation: null }, { port1Isolation: { state: 5 } }, 'x']) expect(parseObservation(bad).kind).toBe('unreachable');
  });
});

describe('parseWatchConfig', () => {
  it('uses the defaults', () => expect(parseWatchConfig({})).toEqual(DEFAULT_WATCH_CONFIG));
  it('rejects a value outside its bounds or not a whole number (no silent clamp)', () => {
    expect(() => parseWatchConfig({ ISOLATION_WATCH_BAD_POLLS: '0' })).toThrow(RangeError);
    expect(() => parseWatchConfig({ ISOLATION_WATCH_BAD_POLLS: '1000' })).toThrow(RangeError);
    expect(() => parseWatchConfig({ ISOLATION_WATCH_CRITICAL_POLLS: '1.5' })).toThrow(RangeError);
    expect(() => parseWatchConfig({ ISOLATION_WATCH_REALERT_MS: '1000' })).toThrow(RangeError);
    expect(parseWatchConfig({ ISOLATION_WATCH_BAD_POLLS: '7' }).badPollsToAlert).toBe(7);
  });
  it('requires the critical threshold not to exceed the generic one (a lost table-miss must never be slower than a generic mismatch)', () => {
    expect(() => parseWatchConfig({ ISOLATION_WATCH_BAD_POLLS: '2', ISOLATION_WATCH_CRITICAL_POLLS: '3' })).toThrow(RangeError);
  });
});

describe('auto-repair events (the bridge re-sends the default DROP by itself; a person must hear about it)', () => {
  const withRepair = (totalRepairs: number, extra: Partial<{ exhausted: boolean; lastTrigger: string | null; enabled: boolean }> = {}): Observation => ({
    ...ok, repair: { enabled: true, totalRepairs, exhausted: false, lastTrigger: totalRepairs > 0 ? 'forwards' : null, ...extra },
  });
  it('sends one high-priority message when the repair count goes up, and none for the first observation or an unchanged count', () => {
    const r = rig();
    expect(r.poll(withRepair(0))).toEqual([]);
    expect(r.poll(withRepair(0))).toEqual([]);
    const m = r.poll(withRepair(1));
    expect(kinds(m)).toEqual(['repair']);
    expect(m[0]?.priority).toBe('high');
    expect(m[0]?.body).toMatch(/default DROP/);
    expect(m[0]?.body).toMatch(/forwards/);
    expect(r.poll(withRepair(1))).toEqual([]);
    expect(kinds(r.poll(withRepair(2)))).toEqual(['repair']);
  });
  it('does not announce a repair that happened before the watcher started (the first observation is the baseline), nor a counter reset by a bridge restart', () => {
    const r = rig();
    expect(r.poll(withRepair(5))).toEqual([]);
    expect(r.poll(withRepair(0))).toEqual([]); // the bridge restarted: counters are new
    expect(kinds(r.poll(withRepair(1)))).toEqual(['repair']);
  });
  it('an exhausted repair budget is critical: urgent after 2 polls, saying a person is needed', () => {
    const r = rig();
    r.poll(withRepair(3, { exhausted: true }));
    const m = r.poll(withRepair(3, { exhausted: true }));
    expect(kinds(m)).toEqual(['alert']);
    expect(m[0]?.priority).toBe('urgent');
    expect(m[0]?.body).toMatch(/person/);
    expect(classify(withRepair(3, { exhausted: true }), DEFAULT_WATCH_CONFIG)).toBe('critical');
  });
  it('an older bridge without repair information produces no repair messages and no error', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) expect(r.poll(ok)).toEqual([]);
  });
  it('parseObservation reads the repair block, and ignores a malformed one', () => {
    const base = { state: 'verified', checkedAgeMs: 5000, mismatches: [], actions: { tableMiss: 'drops' } };
    const good = parseObservation({ port1Isolation: { ...base, repair: { enabled: true, totalRepairs: 2, exhausted: false, lastTrigger: 'absent', repairsInWindow: 1 } } });
    expect(good).toMatchObject({ kind: 'status', repair: { enabled: true, totalRepairs: 2, exhausted: false, lastTrigger: 'absent' } });
    const bad = parseObservation({ port1Isolation: { ...base, repair: { totalRepairs: 'many' } } });
    expect(bad).toMatchObject({ kind: 'status', repair: null });
  });
});
