/**
 * experiment-install.test.ts
 * Invariant tests for the bounded experiment install path (src/sdn/experiment-install.ts).
 *
 * IMPORTANT (Invariant 6): these tests drive a FAKE switch that models wipe, table-miss and add. They show the installer's
 * logic (bounds, ordering, readback judgement, restore on failure and on the time limit). They say nothing about how the
 * Zodiac FX firmware treats a wildcard delete or hard timeouts: that is measured on the live switch, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  parseExperimentRequest, parseExperimentSettleMs, ExperimentInstaller, EXPERIMENT_MAX_RULES, EXPERIMENT_SETTLE_MS, EXPERIMENT_TTL_DEFAULT_SECONDS, EXPERIMENT_SWITCH_EXPIRY_MARGIN_SECONDS,
  type InstallerDeps, type ExperimentRequest,
} from '../../src/sdn/experiment-install.js';
import { FlowModCommand, type FlowModOptions } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import type { FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';

const rule = (id: string, priority: number, outputPorts: number[], match: Record<string, unknown> = {}) => ({ id, priority, outputPorts, match });
const valid = () => ({
  label: 'fixture',
  rules: [
    rule('arp', 100, [2], { inPort: 1, etherType: 2054 }),
    rule('ip', 100, [2], { inPort: 1, etherType: 2048, srcIp: '10.0.2.0', srcIpPrefixLen: 24, dstIp: '10.0.2.0', dstIpPrefixLen: 24 }),
  ],
});
const errorsOf = (raw: unknown): string[] => {
  const r = parseExperimentRequest(raw);
  if (r.ok) throw new Error('expected a refusal');
  return [...r.errors];
};

describe('parseExperimentRequest', () => {
  it('accepts a small valid set and gives every rule a switch-side hard timeout of ttl + margin', () => {
    const r = parseExperimentRequest(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.rules).toHaveLength(2);
    expect(r.request.ttlSeconds).toBe(EXPERIMENT_TTL_DEFAULT_SECONDS);
    for (const x of r.request.rules) {
      expect(x.flowMod.command).toBe(FlowModCommand.OFPFC_ADD);
      expect(x.flowMod.hardTimeout).toBe(EXPERIMENT_TTL_DEFAULT_SECONDS + EXPERIMENT_SWITCH_EXPIRY_MARGIN_SECONDS);
    }
  });

  it('refuses a body that is not an object, and an empty or oversized rule list', () => {
    expect(errorsOf('x')[0]).toMatch(/JSON object/);
    expect(errorsOf({ rules: [] })[0]).toMatch(/1 to 100/);
    const many = Array.from({ length: EXPERIMENT_MAX_RULES + 1 }, (_, i) => rule(`r${i}`, 10 + i, [2], { inPort: 1, etherType: 2048, srcIp: `10.0.${i % 200}.1` }));
    expect(errorsOf({ rules: many })[0]).toMatch(/1 to 100/);
  });

  it('refuses a bad time limit', () => {
    expect(errorsOf({ ...valid(), ttlSeconds: 5 }).join()).toMatch(/ttlSeconds/);
    expect(errorsOf({ ...valid(), ttlSeconds: 301 }).join()).toMatch(/ttlSeconds/);
    expect(errorsOf({ ...valid(), ttlSeconds: 'x' }).join()).toMatch(/ttlSeconds/);
  });

  it('refuses bad ids, duplicate ids, and priorities that collide with the table-miss or quarantine', () => {
    expect(errorsOf({ rules: [rule('has space', 10, [2])] }).join()).toMatch(/id must be/);
    expect(errorsOf({ rules: [rule('a', 10, [2], { inPort: 1 }), rule('a', 11, [2], { inPort: 2 })] }).join()).toMatch(/duplicate id/);
    expect(errorsOf({ rules: [rule('a', 0, [2])] }).join()).toMatch(/priority/);
    expect(errorsOf({ rules: [rule('a', 65535, [2])] }).join()).toMatch(/priority/);
  });

  it('refuses outputs to port 4 (the controller link), non-distinct ports, and non-integers', () => {
    expect(errorsOf({ rules: [rule('a', 10, [4], { inPort: 1 })] }).join()).toMatch(/outputPorts/);
    expect(errorsOf({ rules: [rule('a', 10, [2, 2], { inPort: 1 })] }).join()).toMatch(/outputPorts/);
    expect(errorsOf({ rules: [rule('a', 10, [2.5], { inPort: 1 })] }).join()).toMatch(/outputPorts/);
  });

  it('refuses unknown match fields, an IP without eth_type 2048, a prefix without its address, and bad addresses', () => {
    expect(errorsOf({ rules: [rule('a', 10, [2], { vlan: 5 })] }).join()).toMatch(/unknown match/);
    expect(errorsOf({ rules: [rule('a', 10, [2], { srcIp: '10.0.2.1' })] }).join()).toMatch(/etherType 2048/);
    expect(errorsOf({ rules: [rule('a', 10, [2], { etherType: 2048, srcIpPrefixLen: 24 })] }).join()).toMatch(/without srcIp/);
    expect(errorsOf({ rules: [rule('a', 10, [2], { etherType: 2048, srcIp: '10.0.2.300' })] }).join()).toMatch(/dotted IPv4/);
    expect(errorsOf({ rules: [rule('a', 10, [2], { etherType: 2048, srcIp: '10.0.2.1', srcIpPrefixLen: 33 })] }).join()).toMatch(/srcIpPrefixLen/);
  });

  it('refuses a hairpin (output to the ingress port)', () => {
    expect(errorsOf({ rules: [rule('h', 10, [1, 2], { inPort: 1 })] }).join()).toMatch(/hairpin/);
  });

  it('refuses a shadowed rule (A5) and an equal-priority conflict (A6)', () => {
    const shadow = [rule('wide', 100, [2], { inPort: 1 }), rule('narrow', 50, [3], { inPort: 1, etherType: 2054 })];
    expect(errorsOf({ rules: shadow }).join()).toMatch(/A5/);
    const conflict = [rule('x', 100, [2], { inPort: 1, etherType: 2054 }), rule('y', 100, [3], { inPort: 1, etherType: 2054, srcMac: 'aa:bb:cc:dd:ee:ff' })];
    // Same priority, overlapping matches, different outputs.
    expect(errorsOf({ rules: conflict }).join()).toMatch(/A6|A5/);
  });
});

// ─── A fake switch ───────────────────────────────────────────────────────────

interface FakeOptions {
  /** indices (counting every ADD the fake receives, installs and restores alike) the switch silently ignores, to model a lost FlowMod */
  dropAdds?: ReadonlySet<number>;
  established?: boolean;
  gateBusy?: boolean;
  /** if true the wildcard delete does nothing (models firmware that ignores it) */
  ignoreWipe?: boolean;
  /** the first N flow-table reads throw (models a readback that fails after the FlowMods were written) */
  failReads?: number;
  settleMs?: number;
}

function maskFor(len: number | undefined): string | undefined {
  if (len === undefined || len === 32) return undefined;
  const m = (0xffffffff << (32 - len)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
}

function makeFake(opts: FakeOptions = {}) {
  let table: FlowStatsEntry[] = [];
  const sent: FlowModOptions[] = [];
  const phasesAtSend: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let addIndex = 0;
  let restores = 0;
  let readsLeftToFail = opts.failReads ?? 0;
  let gateHeld = opts.gateBusy === true;
  let phaseProbe: () => string = () => 'unknown';
  const missEntry: FlowStatsEntry = { tableId: 0, priority: 0, packetCount: 0n, byteCount: 0n };
  // Mirrors how the switch reports a match back (see parseFlowStatsReply in dataplane-benchmark.ts, the source of truth for the entry fields).
  const entryOf = (o: FlowModOptions): FlowStatsEntry => {
    const m = o.match ?? {};
    return {
      tableId: 0, priority: o.priority, packetCount: 0n, byteCount: 0n,
      ...(m.inPort !== undefined ? { inPort: m.inPort } : {}),
      ...(m.etherType !== undefined ? { ethType: m.etherType } : {}),
      ...(m.srcIp !== undefined ? { srcIp: m.srcIp, ...(maskFor(m.srcIpPrefixLen) ? { srcMask: maskFor(m.srcIpPrefixLen) as string } : {}) } : {}),
      ...(m.dstIp !== undefined ? { dstIp: m.dstIp, ...(maskFor(m.dstIpPrefixLen) ? { dstMask: maskFor(m.dstIpPrefixLen) as string } : {}) } : {}),
    };
  };
  const deps: InstallerDeps = {
    sendFlowMod(o) {
      sent.push(o);
      phasesAtSend.push(phaseProbe());
      if (o.command === FlowModCommand.OFPFC_DELETE) { if (opts.ignoreWipe !== true) table = []; return sent.length; }
      const idx = addIndex++;
      if (opts.dropAdds?.has(idx)) return sent.length;
      table.push(entryOf(o));
      return sent.length;
    },
    sendTableMissDrop() { sent.push({ command: FlowModCommand.OFPFC_ADD, priority: 0, outputPorts: [], match: {} }); phasesAtSend.push(phaseProbe()); table.push(missEntry); },
    async readFlowStats() {
      if (readsLeftToFail > 0) { readsLeftToFail--; throw new Error('flow-stats read failed'); }
      return [...table];
    },
    isSessionEstablished: () => opts.established !== false,
    gate: { tryAcquire: () => { if (gateHeld) return false; gateHeld = true; return true; }, release: () => { gateHeld = opts.gateBusy === true; }, get isHeld() { return gateHeld; } },
    isolationPolicy: () => buildPort1IsolationPolicy(),
    nowMs: () => 1_000_000,
    sleep: async (ms) => { sleeps.push(ms); },
    ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    setTimer(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer(h) { (h as { live: boolean }).live = false; },
    onRestored() { restores++; },
    log: (l) => { logs.push(l); },
  };
  return {
    deps, sent, timers, sleeps, logs, phasesAtSend,
    attach(inst: ExperimentInstaller) { phaseProbe = () => inst.state().phase; },
    get table() { return table; },
    get restores() { return restores; },
    isolationOnly() { return table.filter((e) => e.priority !== 0).length === buildPort1IsolationPolicy().length; },
  };
}

function request(): ExperimentRequest {
  const r = parseExperimentRequest(valid());
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.request;
}

function installer(f: ReturnType<typeof makeFake>): ExperimentInstaller {
  const inst = new ExperimentInstaller(f.deps);
  f.attach(inst);
  return inst;
}

describe('ExperimentInstaller', () => {
  it('wipes, re-installs the table-miss drop, adds the rules in order, and reports a verified install', async () => {
    const f = makeFake();
    const inst = installer(f);
    const report = await inst.install(request());
    expect(report.ok).toBe(true);
    expect(report.confirmed).toEqual(['arp', 'ip']);
    expect(report.extraEntries).toBe(0);
    expect(report.tableMissEntries).toBe(1);
    expect(report.ran).toBe(true);
    expect(f.sent[0]!.command).toBe(FlowModCommand.OFPFC_DELETE);
    expect(f.sent[0]!.match).toEqual({});
    expect(f.sent[1]!.priority).toBe(0); // the table-miss, straight after the wipe
    expect(f.sent.slice(2).map((s) => s.priority)).toEqual([100, 100]);
    expect(inst.state().phase).toBe('active');
    expect(inst.state().activeRuleIds).toEqual(['arp', 'ip']);
    expect(inst.state().attention).toBeNull();
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0]!.ms).toBe(EXPERIMENT_TTL_DEFAULT_SECONDS * 1000);
  });

  it('waits the configured settle time before reading back, and the default when none is set', async () => {
    const f = makeFake({ settleMs: 321 });
    await installer(f).install(request());
    expect(f.sleeps).toContain(321);
    const g = makeFake();
    await installer(g).install(request());
    expect(g.sleeps).toContain(EXPERIMENT_SETTLE_MS);
  });

  it('puts the isolation policy back when the time limit expires', async () => {
    const f = makeFake();
    const inst = installer(f);
    await inst.install(request());
    f.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.state().phase).toBe('idle');
    expect(f.restores).toBe(1);
    expect(f.isolationOnly()).toBe(true);
    expect(inst.state().last?.action).toBe('restore');
    expect(inst.state().last?.ok).toBe(true);
    expect(inst.state().attention).toBeNull();
  });

  it('raises an alert (attention) when the automatic restore at the time limit does not verify', async () => {
    const f = makeFake({ dropAdds: new Set([2, 3, 4, 5, 6, 7]) }); // the install (adds 0 and 1) lands; the restore's six adds are lost
    const inst = installer(f);
    await inst.install(request());
    f.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.state().phase).toBe('idle');
    expect(inst.state().last?.ok).toBe(false);
    expect(inst.state().attention).toMatch(/NOT verified/);
    expect(f.logs.join('\n')).toMatch(/ALERT restore NOT VERIFIED/);
  });

  it('restores at once when a rule is missing from the readback, and reports that the restore verified', async () => {
    const f = makeFake({ dropAdds: new Set([1]) }); // the second experimental ADD is lost
    const inst = installer(f);
    const report = await inst.install(request());
    expect(report.ok).toBe(false);
    expect(report.action).toBe('install');
    expect(report.confirmed).toEqual(['arp']);
    expect(report.restoreAfterFailure?.ok).toBe(true);
    expect(inst.state().phase).toBe('idle');
    expect(f.isolationOnly()).toBe(true);
    expect(f.restores).toBe(1);
  });

  it('never passes through idle between a failed install and its restore', async () => {
    const f = makeFake({ dropAdds: new Set([1]) });
    const inst = installer(f);
    await inst.install(request());
    expect(f.phasesAtSend.length).toBeGreaterThan(0);
    expect(f.phasesAtSend.every((p) => p === 'installing' || p === 'restoring')).toBe(true);
  });

  it('says so when the install failed AND the restore after it did not verify', async () => {
    const f = makeFake({ dropAdds: new Set([1, 2, 3, 4, 5, 6, 7]) }); // one experimental add lost, then all six restore adds lost
    const inst = installer(f);
    const report = await inst.install(request());
    expect(report.ok).toBe(false);
    expect(report.restoreAfterFailure?.ok).toBe(false);
    expect(inst.state().attention).toMatch(/NOT verified/);
    expect(inst.state().phase).toBe('idle');
  });

  it('treats leftover entries the wipe did not remove as a failed install, and counts the extra table-miss', async () => {
    const f = makeFake({ ignoreWipe: true });
    const inst = installer(f);
    await inst.restore(); // the table now holds the isolation policy and cannot be wiped
    const report = await inst.install(request());
    expect(report.ok).toBe(false);
    expect(report.extraEntries).toBeGreaterThan(0);
    expect(report.tableMissEntries).toBeGreaterThan(1);
  });

  it('refuses to start without a session, and leaves nothing stuck', async () => {
    const f = makeFake({ established: false });
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/no OpenFlow session/);
    expect(inst.state().phase).toBe('idle');
    expect(f.sent).toHaveLength(0);
  });

  it('when the readback throws after the FlowMods were written, restores and surfaces the original error', async () => {
    const f = makeFake({ failReads: 1 }); // the install's read fails; the restore's read works
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/flow-stats read failed/);
    expect(inst.state().phase).toBe('idle');
    expect(f.isolationOnly()).toBe(true);
    expect(inst.state().attention).toBeNull();
    expect(f.phasesAtSend.every((p) => p === 'installing' || p === 'restoring')).toBe(true);
  });

  it('when the readback throws and the restore cannot verify either, the thrown error says so and attention is set', async () => {
    const f = makeFake({ failReads: 2 }); // both the install read and the restore read fail
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/restore did not verify/);
    expect(inst.state().attention).toMatch(/could not run/);
    expect(inst.state().phase).toBe('idle');
    expect(inst.state().last?.ran).toBe(false);
  });

  it('an explicit restore that cannot run is an error (ran: false), one that ran but did not verify is a failing report', async () => {
    const down = makeFake({ established: false });
    await expect(installer(down).restore()).rejects.toThrow(/restore could not run/);
    const lossy = makeFake({ dropAdds: new Set([0, 1, 2, 3, 4, 5]) }); // every isolation add is lost, but the read works
    const report = await installer(lossy).restore();
    expect(report.ok).toBe(false);
    expect(report.ran).toBe(true);
  });

  it('refuses a second install while one is active, and allows it after a restore', async () => {
    const f = makeFake();
    const inst = installer(f);
    await inst.install(request());
    await expect(inst.install(request())).rejects.toThrow(/already active/);
    const back = await inst.restore();
    expect(back.ok).toBe(true);
    expect(f.timers[0]!.live).toBe(false); // the time-limit timer was cancelled by the restore
    const again = await inst.install(request());
    expect(again.ok).toBe(true);
  });

  it('clears a stale attention when the session handler re-verifies isolation, but never during an experiment', async () => {
    const f = makeFake({ dropAdds: new Set([2, 3, 4, 5, 6, 7]) }); // the restore at the time limit fails to verify, as in the frozen-bridge case
    const inst = installer(f);
    await inst.install(request());
    f.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.state().attention).toMatch(/NOT verified/);
    inst.isolationReestablished();
    expect(inst.state().attention).toBeNull();
    expect(f.logs.join('\n')).toMatch(/clearing the alarm/);
    // a second install succeeds (its adds are not the dropped ones) while a NEW alarm is raised by hand-built state: set it by repeating the failure first
    const f2 = makeFake({ dropAdds: new Set([2, 3, 4, 5, 6, 7]) });
    const inst2 = installer(f2);
    await inst2.install(request());
    f2.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(inst2.state().attention).not.toBeNull();
    const second = await inst2.install(request()); // adds 8 and 9 are kept, so this install verifies and the experiment is active again
    expect(second.ok).toBe(true);
    expect(inst2.state().phase).toBe('active');
    expect(inst2.state().attention).not.toBeNull(); // an install does not clear the alarm
    inst2.isolationReestablished(); // must not clear it while an experiment is running
    expect(inst2.state().attention).not.toBeNull();
    expect(inst2.state().phase).toBe('active');
  });

  it('forgets an active experiment and cancels its timer when the switch session is re-established, and logs it', async () => {
    const f = makeFake();
    const inst = installer(f);
    await inst.install(request());
    inst.sessionReset();
    expect(inst.state().phase).toBe('idle');
    expect(inst.state().activeRuleIds).toEqual([]);
    expect(f.timers[0]!.live).toBe(false);
    expect(f.logs.join('\n')).toMatch(/session reset while active/);
  });

  it('fails closed when the table lock never frees: nothing is sent and no verdict is invented', async () => {
    const f = makeFake({ gateBusy: true });
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/table lock/);
    expect(f.sent).toHaveLength(0); // the lock is taken BEFORE the wipe, so a busy lock leaves the switch untouched
    expect(inst.state().phase).toBe('idle');
  });

  it('holds the flow-table lock from the wipe through the readback, so the periodic re-check cannot read a half-written table', async () => {
    const f = makeFake();
    const inst = installer(f);
    // The periodic isolation re-check does exactly this at a random moment: tryAcquire, and skip the tick if it fails.
    const breaches: string[] = [];
    const probe = (where: string): void => {
      if (f.deps.gate.tryAcquire()) { breaches.push(where); f.deps.gate.release(); }
    };
    const send = f.deps.sendFlowMod, miss = f.deps.sendTableMissDrop, sleep = f.deps.sleep, read = f.deps.readFlowStats;
    f.deps.sendFlowMod = (o) => { probe('flowmod'); return send(o); };
    f.deps.sendTableMissDrop = () => { probe('table-miss'); miss(); };
    f.deps.sleep = async (ms) => { probe('settle'); await sleep(ms); };
    f.deps.readFlowStats = async () => { probe('readback'); return read(); };
    const report = await inst.install(request());
    expect(report.ok).toBe(true);
    expect(breaches).toEqual([]);
    expect(f.deps.gate.isHeld).toBe(false); // and it is released afterwards
    // The same holds for a restore.
    breaches.length = 0;
    await inst.restore();
    expect(breaches).toEqual([]);
    expect(f.deps.gate.isHeld).toBe(false);
  });

  it('releases the lock when the readback throws', async () => {
    const f = makeFake({ failReads: 1 });
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/flow-stats read failed/);
    expect(f.deps.gate.isHeld).toBe(false);
  });

  it('refuses an install while quarantine DROPs are active, and sends nothing (an install wipes the table)', async () => {
    const f = makeFake();
    f.deps.activeQuarantines = () => 2;
    const inst = installer(f);
    await expect(inst.install(request())).rejects.toThrow(/2 quarantine DROP/);
    expect(f.sent).toHaveLength(0);
    expect(inst.state().phase).toBe('idle');
  });

  it('calls afterRestore after every restore that ran, including the restore that follows a failed install', async () => {
    let calls = 0;
    const f = makeFake({ dropAdds: new Set([0]) }); // the first ADD is lost: the install does not verify and is rolled back
    f.deps.afterRestore = () => { calls++; };
    const inst = installer(f);
    const report = await inst.install(request());
    expect(report.ok).toBe(false);
    expect(calls).toBe(1);
    const g = makeFake();
    g.deps.afterRestore = () => { calls++; };
    const inst2 = installer(g);
    await inst2.install(request());
    await inst2.restore();
    expect(calls).toBe(2);
  });
});

describe('parseExperimentSettleMs', () => {
  it('uses the default when unset or empty, accepts a value in bounds, and refuses one outside them', () => {
    expect(parseExperimentSettleMs(undefined)).toBe(EXPERIMENT_SETTLE_MS);
    expect(parseExperimentSettleMs('')).toBe(EXPERIMENT_SETTLE_MS);
    expect(parseExperimentSettleMs('2500')).toBe(2500);
    expect(parseExperimentSettleMs('250')).toBe(250);
    expect(parseExperimentSettleMs('10000')).toBe(10000);
    expect(() => parseExperimentSettleMs('249')).toThrow(/250 to 10000/);
    expect(() => parseExperimentSettleMs('10001')).toThrow(/250 to 10000/);
    expect(() => parseExperimentSettleMs('10')).toThrow(/250 to 10000/);
    expect(() => parseExperimentSettleMs('99999')).toThrow(/250 to 10000/);
    expect(() => parseExperimentSettleMs('abc')).toThrow(/250 to 10000/);
  });
});
