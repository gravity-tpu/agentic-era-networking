/**
 * test/invariants/isolation-repair.test.ts
 * The repair governor (docs/design/isolation-repair.md): when the bridge may re-install the person-approved isolation policy by itself after the switch's
 * table-miss DROP is found missing or wrong (property A3). Detector-driven action is allowed only inside an envelope a person approved in advance (Invariant 4):
 * opt-in, scoped to the table-miss, damped, rate-limited, bounded per window, never during an experiment, audited, and it stops and asks for a person when exhausted.
 */
import { describe, it, expect } from 'vitest';
import { RepairGovernor, parseRepairConfig, DEFAULT_REPAIR_CONFIG, type RepairConfig } from '../../src/sdn/isolation-repair.js';

const NS_PER_MS = 1_000_000n;
const ON: RepairConfig = { ...DEFAULT_REPAIR_CONFIG, enabled: true };
const ctx = { sessionUp: true, experimentIdle: true, busy: false };
const bad = (tableMiss: string) => ({ state: 'mismatch', tableMiss });
const clean = { state: 'verified', tableMiss: 'drops' };

function rig(cfg: RepairConfig = ON) {
  let t = 10_000n * NS_PER_MS;
  const g = new RepairGovernor(cfg);
  const read = (r: { state: string; tableMiss: string | null }, ms = 60_000, c = ctx) => { t += BigInt(ms) * NS_PER_MS; return g.observe({ ...r, monoNs: t }, c); };
  const repaired = (trigger = 'forwards') => g.repaired(t, 1_000, trigger);
  return { g, read, repaired, now: () => t };
}

describe('scope and damping', () => {
  it('is off unless explicitly enabled: it never repairs, however long the table-miss is wrong', () => {
    const r = rig({ ...ON, enabled: false });
    for (let i = 0; i < 20; i++) expect(r.read(bad('absent')).action).toBe('none');
    expect(r.g.status().enabled).toBe(false);
  });
  it('repairs after the configured number of consecutive bad readings (3), not before', () => {
    const r = rig();
    expect(r.read(bad('forwards')).action).toBe('none');
    expect(r.read(bad('forwards')).action).toBe('none');
    expect(r.read(bad('forwards'))).toEqual({ action: 'repair', trigger: 'forwards', readings: 3 });
  });
  it('treats absent, forwards and unrecognised alike, and nothing else', () => {
    for (const tm of ['absent', 'forwards', 'unrecognised']) {
      const r = rig();
      r.read(bad(tm)); r.read(bad(tm));
      expect(r.read(bad(tm)).action, tm).toBe('repair');
    }
    // a generic mismatch with a dropping table-miss is out of scope: it may be a quarantine or an experiment table, and a re-install could wipe state a person set
    const r = rig();
    for (let i = 0; i < 10; i++) expect(r.read({ state: 'mismatch', tableMiss: 'drops' }).action).toBe('none');
  });
  it('a clean reading resets the streak; a failed or unobservable readback is not a bad reading', () => {
    const r = rig();
    r.read(bad('absent')); r.read(bad('absent'));
    r.read(clean);
    expect(r.read(bad('absent')).action).toBe('none');
    const q = rig();
    q.read(bad('absent')); q.read(bad('absent'));
    expect(q.read({ state: 'readback_failed', tableMiss: null }).action).toBe('none');
    expect(q.read({ state: 'mismatch', tableMiss: 'unobservable' }).action).toBe('none');
  });
});

describe('gates: when it must not act', () => {
  it('does nothing while an experiment is running or the switch session is down, and says why', () => {
    const r = rig();
    r.read(bad('absent')); r.read(bad('absent'));
    expect(r.read(bad('absent'), 60_000, { ...ctx, experimentIdle: false })).toEqual({ action: 'blocked', reason: 'an experiment is running' });
    expect(r.read(bad('absent'), 60_000, { ...ctx, sessionUp: false })).toEqual({ action: 'blocked', reason: 'no OpenFlow session' });
    expect(r.read(bad('absent'), 60_000, { ...ctx, busy: true })).toEqual({ action: 'blocked', reason: 'an install or repair is in progress' });
    expect(r.read(bad('absent')).action).toBe('repair'); // the streak was kept, the gates lifted
  });
});

describe('rate limits and exhaustion', () => {
  it('after a repair it needs a fresh streak, and respects the minimum interval between repairs (10 minutes)', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.read(bad('forwards'));
    r.repaired();
    expect(r.read(bad('forwards')).action).toBe('none'); // streak restarted
    r.read(bad('forwards'));
    const early = r.read(bad('forwards'), 60_000);
    expect(early.action).toBe('blocked');
    expect((early as { reason: string }).reason).toMatch(/minimum interval/);
    const later = r.read(bad('forwards'), 8 * 60_000);
    expect(later.action).toBe('repair');
  });
  /** One repair cycle: 3 bad readings (the first after a gap that clears the minimum interval), then the caller sends the repair. */
  const cycle = (r: ReturnType<typeof rig>, gapMs: number): void => { r.read(bad('forwards'), gapMs); r.read(bad('forwards')); r.read(bad('forwards')); r.repaired(); };
  it('stops after the maximum repairs in the window (3 per hour) and asks for a person: exhausted, with no further repair', () => {
    const r = rig();
    cycle(r, 60_000); cycle(r, 11 * 60_000); cycle(r, 11 * 60_000);
    expect(r.g.status().repairsInWindow).toBe(3);
    r.read(bad('forwards'), 11 * 60_000); r.read(bad('forwards'));
    expect(r.read(bad('forwards'))).toEqual({ action: 'exhausted' });
    expect(r.g.status().exhausted).toBe(true);
    for (let i = 0; i < 6; i++) expect(r.read(bad('forwards'), 60_000).action).toBe('none'); // announced once, then silent (the watcher keeps reminding a person)
    expect(r.g.status().totalRepairs).toBe(3);
  });
  it('clears the exhausted flag only after a clean streak: the condition really resolved', () => {
    const r = rig();
    cycle(r, 60_000); cycle(r, 11 * 60_000); cycle(r, 11 * 60_000);
    r.read(bad('forwards'), 11 * 60_000); r.read(bad('forwards')); r.read(bad('forwards'));
    expect(r.g.status().exhausted).toBe(true);
    r.read(clean); r.read(clean);
    expect(r.g.status().exhausted).toBe(true);
    r.read(clean);
    expect(r.g.status().exhausted).toBe(false);
  });
  it('old repairs leave the window after an hour', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.read(bad('forwards'));
    r.repaired();
    expect(r.g.status().repairsInWindow).toBe(1);
    r.read(clean, 61 * 60_000);
    expect(r.g.status().repairsInWindow).toBe(0);
    expect(r.g.status().totalRepairs).toBe(1);
  });
});

describe('status and config', () => {
  it('reports what a person and the watcher need: totals, the last repair and its trigger', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.read(bad('absent'));
    r.g.repaired(r.now(), 1_700_000_000_000, 'absent');
    expect(r.g.status()).toMatchObject({ enabled: true, totalRepairs: 1, lastTrigger: 'absent', lastRepairAtMs: 1_700_000_000_000, exhausted: false });
  });
  it('parses its settings from the environment with bounds, off by default', () => {
    expect(parseRepairConfig({})).toEqual(DEFAULT_REPAIR_CONFIG);
    expect(DEFAULT_REPAIR_CONFIG.enabled).toBe(false);
    expect(parseRepairConfig({ ZODIAC_ISOLATION_REPAIR: '1' }).enabled).toBe(true);
    for (const bad2 of [{ ZODIAC_ISOLATION_REPAIR: 'yes' }, { ZODIAC_ISOLATION_REPAIR_READINGS: '0' }, { ZODIAC_ISOLATION_REPAIR_READINGS: '99' }, { ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS: '1000' }, { ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW: '0' }, { ZODIAC_ISOLATION_REPAIR_WINDOW_MS: '100' }]) expect(() => parseRepairConfig(bad2)).toThrow(RangeError);
  });
});
