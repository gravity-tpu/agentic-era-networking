/**
 * isolation-recheck.test.ts
 * Periodic re-verification of the isolation policy: eligibility, drift detection, damping, and the timer.
 *
 * IMPORTANT (Invariant 6): the switch replies are FIXTURES (test/helpers/flow-stats-fixtures.ts), and the clock is
 * fake. This proves the logic that watches a switch, not how a switch behaves.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply, type FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';
import { buildPort1IsolationPolicy, verifyIsolationReadback } from '../../src/sdn/port1-isolation.js';
import {
  DEFAULT_RECHECK_INTERVAL_MS,
  FlowReadLock,
  IsolationRechecker,
  RECHECK_CLEAN_READS_TO_RECOVER,
  RECHECK_FAILURES_BEFORE_UNKNOWN,
  RecheckConfigError,
  parseRecheckIntervalMs,
} from '../../src/sdn/isolation-recheck.js';
import {
  initialIsolationStatus,
  pendingReadbackStatus,
  statusFromReadback,
  verifierRejectedStatus,
  type IsolationStatus,
} from '../../src/sdn/isolation-status.js';
import { applyActions, entryFrom, outputAction, replyOf } from '../helpers/flow-stats-fixtures.js';

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);

const entriesOf = (bufs: readonly Buffer[]): FlowStatsEntry[] => parseFlowStatsReply(replyOf(bufs)).entries;
const faithful = (): FlowStatsEntry[] => entriesOf([entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))]);
const leaky = (): FlowStatsEntry[] => {
  const bufs = [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))];
  const idx = policy.findIndex((r) => r.id === 'p1-default-tap-only') + 1;
  bufs[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(2), outputAction(3)));
  return entriesOf(bufs);
};
const missingRule = (): FlowStatsEntry[] => faithful().filter((_, i) => i !== 2);

type Read = () => Promise<readonly FlowStatsEntry[]>;
const ok = (entries: () => FlowStatsEntry[]): Read => () => Promise.resolve(entries());
const fails = (msg = 'OFPMP_FLOW readback timed out after 10000 ms'): Read => () => Promise.reject(new Error(msg));

function verifiedStatus(): IsolationStatus {
  return statusFromReadback(pendingReadbackStatus(), verifyIsolationReadback(policy, faithful()), 1, 1n);
}

function make(initial: IsolationStatus = verifiedStatus(), intervalMs = 10_000) {
  let status = initial;
  let mono = 100n;
  let reads = 0;
  let read: Read = ok(faithful);
  const logs: Array<{ level: string; text: string }> = [];
  const lock = new FlowReadLock();
  const rc = new IsolationRechecker({
    policy,
    read: () => {
      reads += 1;
      return read();
    },
    getStatus: () => status,
    setStatus: (s) => {
      status = s;
    },
    lock,
    log: (level, text) => logs.push({ level, text }),
    nowMs: () => 1_700_000_000_000,
    nowMonoNs: () => (mono += 1000n),
    intervalMs,
  });
  return {
    rc,
    lock,
    logs,
    status: () => status,
    setStatus: (s: IsolationStatus) => {
      status = s;
    },
    reads: () => reads,
    useRead: (r: Read) => {
      read = r;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseRecheckIntervalMs', () => {
  it('defaults when unset, 0 disables, and a bounded integer is accepted', () => {
    expect(parseRecheckIntervalMs({})).toBe(DEFAULT_RECHECK_INTERVAL_MS);
    expect(parseRecheckIntervalMs({ ZODIAC_ISOLATION_RECHECK_INTERVAL_MS: '0' })).toBe(0);
    expect(parseRecheckIntervalMs({ ZODIAC_ISOLATION_RECHECK_INTERVAL_MS: '10000' })).toBe(10_000);
    expect(parseRecheckIntervalMs({ ZODIAC_ISOLATION_RECHECK_INTERVAL_MS: '3600000' })).toBe(3_600_000);
  });

  it('rejects anything else, so a typo cannot silently turn verification off', () => {
    for (const v of ['9999', '3600001', '-1', 'abc', '', ' 60000', '1e4', '00', '60000ms']) {
      expect(() => parseRecheckIntervalMs({ ZODIAC_ISOLATION_RECHECK_INTERVAL_MS: v }), JSON.stringify(v)).toThrow(RecheckConfigError);
    }
  });
});

describe('FlowReadLock', () => {
  it('admits one holder at a time and is reusable after release', () => {
    const lock = new FlowReadLock();
    expect(lock.isHeld).toBe(false);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isHeld).toBe(true);
    expect(lock.tryAcquire()).toBe(false); // a second reader is refused, not queued
    lock.release();
    expect(lock.isHeld).toBe(false);
    expect(lock.tryAcquire()).toBe(true);
  });
});

describe('eligibility', () => {
  it('does nothing before an install readback has produced a verdict (every such state)', async () => {
    const states = [initialIsolationStatus(), pendingReadbackStatus(), verifierRejectedStatus(['x'], 1, 2n)];
    expect(states.map((s) => s.state)).toEqual(['not_installed', 'pending_readback', 'verifier_rejected']);
    for (const s of states) {
      const t = make(s);
      expect(await t.rc.runOnce(), s.state).toBe('skipped');
      expect(t.reads(), s.state).toBe(0);
    }
  });

  it('skips while another flow-table read holds the lock, and does not release a lock it did not take', async () => {
    const t = make();
    expect(t.lock.tryAcquire()).toBe(true); // e.g. the on-demand probe
    expect(await t.rc.runOnce()).toBe('skipped');
    expect(t.reads()).toBe(0);
    expect(t.lock.isHeld).toBe(true);
  });

  it('releases the lock after a successful read and after a failed one', async () => {
    const t = make();
    await t.rc.runOnce();
    expect(t.lock.isHeld).toBe(false);
    t.useRead(fails());
    await t.rc.runOnce();
    expect(t.lock.isHeld).toBe(false);
  });

  it('judges against the latest status: if the install path moved it while reading, it records nothing', async () => {
    const t = make();
    t.useRead(() => {
      t.setStatus(pendingReadbackStatus()); // a new session began installing
      return Promise.resolve(faithful());
    });
    expect(await t.rc.runOnce()).toBe('skipped');
    expect(t.status().state).toBe('pending_readback');
  });
});

describe('steady state and drift', () => {
  it('a healthy switch stays verified, the age is refreshed, and nothing is logged', async () => {
    const t = make();
    const before = t.status().checkedAtMonoNs;
    expect(await t.rc.runOnce()).toBe('unchanged');
    expect(t.status().state).toBe('verified');
    expect(t.status().provenForwarding).toBe(true);
    expect((t.status().checkedAtMonoNs ?? 0n) > (before ?? 0n)).toBe(true);
    expect(t.logs).toEqual([]);
  });

  it('a leak that appears after install is recorded immediately, with an error log', async () => {
    const t = make();
    t.useRead(ok(leaky));
    expect(await t.rc.runOnce()).toBe('changed');
    expect(t.status().state).toBe('mismatch');
    expect(t.status().provenForwarding).toBe(false);
    expect(t.logs.some((l) => l.level === 'error' && l.text.includes('no longer matches the policy') && l.text.includes('p1-default-tap-only'))).toBe(true);
  });

  it('a rule that vanishes, or an emptied table (a switch that rebooted), is recorded immediately', async () => {
    for (const drift of [missingRule, () => [] as FlowStatsEntry[]]) {
      const t = make();
      t.useRead(ok(drift));
      expect(await t.rc.runOnce()).toBe('changed');
      expect(t.status().state).toBe('mismatch');
    }
  });
});

describe('damping: failed reads', () => {
  it('one failed read does not change a verified status; consecutive failures do', async () => {
    const t = make();
    t.useRead(fails());
    expect(await t.rc.runOnce()).toBe('unchanged');
    expect(t.status().state).toBe('verified');
    expect(t.logs.at(-1)?.level).toBe('warn');
    for (let i = 1; i < RECHECK_FAILURES_BEFORE_UNKNOWN; i++) await t.rc.runOnce();
    expect(t.status().state).toBe('readback_failed');
    expect(t.status().provenForwarding).toBe(false);
    expect(t.logs.at(-1)?.level).toBe('error');
  });

  it('a successful read between failures starts the count over', async () => {
    const t = make();
    t.useRead(fails());
    await t.rc.runOnce();
    t.useRead(ok(faithful));
    await t.rc.runOnce();
    t.useRead(fails());
    await t.rc.runOnce();
    expect(t.status().state).toBe('verified');
  });

  it('failed reads never replace a recorded mismatch', async () => {
    const t = make();
    t.useRead(ok(leaky));
    await t.rc.runOnce();
    const recorded = t.status().mismatches;
    expect(t.status().state).toBe('mismatch');
    t.useRead(fails());
    for (let i = 0; i < RECHECK_FAILURES_BEFORE_UNKNOWN + 2; i++) await t.rc.runOnce();
    expect(t.status().state).toBe('mismatch');
    expect(t.status().mismatches).toEqual(recorded);
    expect(t.status().actions?.status).toBe('mismatch');
  });

  it('reset() forgets the failures of a previous session', async () => {
    const t = make();
    t.useRead(fails());
    await t.rc.runOnce();
    t.rc.reset();
    await t.rc.runOnce();
    expect(t.status().state).toBe('verified'); // two failures, but not in a row after the reset
  });
});

describe('damping: recovery', () => {
  const broken = async () => {
    const t = make();
    t.useRead(ok(leaky));
    await t.rc.runOnce();
    expect(t.status().state).toBe('mismatch');
    return t;
  };

  it('a single clean readback does not clear a mismatch; a run of them does', async () => {
    const t = await broken();
    t.useRead(ok(faithful));
    for (let i = 1; i < RECHECK_CLEAN_READS_TO_RECOVER; i++) {
      expect(await t.rc.runOnce()).toBe('unchanged');
      expect(t.status().state).toBe('mismatch');
    }
    expect(await t.rc.runOnce()).toBe('changed');
    expect(t.status().state).toBe('verified');
    expect(t.status().provenForwarding).toBe(true);
    expect(t.logs.at(-1)?.text).toContain('back to Isolation readback VERIFIED');
  });

  it('a bad readback between clean ones breaks the streak', async () => {
    const t = await broken();
    t.useRead(ok(faithful));
    await t.rc.runOnce();
    t.useRead(ok(leaky));
    await t.rc.runOnce();
    t.useRead(ok(faithful));
    await t.rc.runOnce();
    expect(t.status().state).toBe('mismatch'); // only one clean read since the last bad one
  });

  it('readback_failed also needs a run of clean reads to recover', async () => {
    const t = make();
    t.useRead(fails());
    for (let i = 0; i < RECHECK_FAILURES_BEFORE_UNKNOWN; i++) await t.rc.runOnce();
    expect(t.status().state).toBe('readback_failed');
    t.useRead(ok(faithful));
    await t.rc.runOnce();
    expect(t.status().state).toBe('readback_failed');
    await t.rc.runOnce();
    expect(t.status().state).toBe('verified');
  });
});

describe('the timer', () => {
  it('reads once per interval, chained: the next check is scheduled after the last one finishes', async () => {
    vi.useFakeTimers();
    const t = make(verifiedStatus(), 10_000);
    t.rc.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(t.reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reads()).toBe(2);
    t.rc.stop();
  });

  it('a slow readback is never overlapped by the next tick', async () => {
    vi.useFakeTimers();
    const t = make(verifiedStatus(), 10_000);
    let release: () => void = () => undefined;
    t.useRead(() => new Promise<FlowStatsEntry[]>((resolve) => { release = () => resolve(faithful()); }));
    // The lock would also refuse an overlapping read, so count the ticks that START a check: while one is
    // outstanding, no further tick may even begin.
    const ticks = vi.spyOn(t.rc, 'runOnce');
    t.rc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reads()).toBe(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); // the read is still outstanding
    expect(t.reads()).toBe(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reads()).toBe(2);
    expect(ticks).toHaveBeenCalledTimes(2);
    t.rc.stop();
  });

  it('stop() ends it, start() is idempotent, and an interval of 0 never starts', async () => {
    vi.useFakeTimers();
    const t = make(verifiedStatus(), 10_000);
    t.rc.start();
    t.rc.start(); // a second start must not double the schedule
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reads()).toBe(1);
    t.rc.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(t.reads()).toBe(1);

    const off = make(verifiedStatus(), 0);
    off.rc.start();
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(off.reads()).toBe(0);
  });
});
