/**
 * test/invariants/wire-session.test.ts
 * The session runner of the on-wire conformance run (plan section 16), exercised against a fake rig. These tests are the offline proof that the
 * safety behaviour holds before the runner ever touches the switch: restore in every path, stop when a restore or readback does not verify,
 * refuse a bridge that is not idle, never count an unsendable flow as agreement.
 */
import { describe, it, expect } from 'vitest';
import { runSession, UDP_TAG_BASE, MAX_UDP_TAGS, type Rig, type SessionSet, type RigFlowResult } from '../../src/sdn/wire-session.js';
import { predictOutcome, type WireFlow, type WireRule } from '../../src/sdn/wire-flows.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';

const refRules: WireRule[] = [
  { id: 'intra', priority: 200, outputPorts: [2, 3], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.0', srcIpPrefixLen: 24, dstIp: '10.0.2.0', dstIpPrefixLen: 24 } },
  { id: 'catch', priority: 100, outputPorts: [3], match: { inPort: 1 } },
];
const set = (id: string, rules: WireRule[], kind = 'reference'): SessionSet => ({ id, kind, intent: PORT1_ISOLATION_INTENT, rules, body: { label: id, ttlSeconds: 60, rules } });
const flowA: WireFlow = { id: 'p1-ip-a', mode: 0, observable: [2, 3], packet: { inPort: 1, etherType: 0x0800, srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.2.50', dstIp: '10.0.2.52' } };
const flowB: WireFlow = { id: 'p1-ip-b', mode: 0, observable: [2, 3], packet: { inPort: 1, etherType: 0x0800, srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.2.50', dstIp: '8.8.8.8' } };

interface Log { calls: string[] }
/** A switch that does exactly what the model predicts, unless `override` says otherwise. */
function fakeRig(log: Log, opts: { idle?: boolean; attention?: string | null; installOk?: boolean; restoreOk?: boolean; throwOnFlow?: string; unsendable?: string; override?: (setId: string, flow: WireFlow) => number[] | undefined; stateAfterRestore?: { phase: string; attention: string | null } } = {}): Rig {
  let installed: SessionSet | null = null;
  let restored = false;
  return {
    async bridgeState() {
      log.calls.push('state');
      if (restored && opts.stateAfterRestore !== undefined) return opts.stateAfterRestore;
      return { phase: opts.idle === false ? 'running' : 'idle', attention: opts.attention ?? null };
    },
    async install(s) { log.calls.push(`install:${s.id}`); installed = s; restored = false; return { ok: opts.installOk !== false, httpStatus: opts.installOk === false ? 409 : 200, report: {} }; },
    async restore() { log.calls.push('restore'); restored = true; return { ok: opts.restoreOk !== false, report: {} }; },
    async runFlow(flow: WireFlow, tag: number): Promise<RigFlowResult> {
      log.calls.push(`flow:${flow.id}:${tag}`);
      if (opts.throwOnFlow === flow.id) throw new Error('capture failed');
      if (opts.unsendable === flow.id) return { sent: false, reason: 'no sender', observedPorts: [], evidence: {} };
      const o = installed === null ? undefined : opts.override?.(installed.id, flow);
      return { sent: true, observedPorts: o ?? (installed === null ? [] : predictOutcome(installed.rules, flow)), evidence: { O3: 'frames' } };
    },
  };
}
const flows = { [PORT1_ISOLATION_INTENT.id]: [flowA, flowB] };

describe('runSession', () => {
  it('records agreement for a switch that does what the model says', async () => {
    const log: Log = { calls: [] };
    const out = await runSession(fakeRig(log), [set('ref', refRules)], flows, {});
    expect(out.stoppedBecause).toBeNull();
    const r = out.results[0]!;
    expect(r.installed && r.restored).toBe(true);
    expect(r.flows.map((f) => f.m1.agrees)).toEqual([true, true]);
  });

  it('can fail: a disagreement is recorded as data and the session continues', async () => {
    const log: Log = { calls: [] };
    const rig = fakeRig(log, { override: (id, f) => (id === 'ref' && f.id === 'p1-ip-a' ? [2, 3, 1] : undefined) });
    const out = await runSession(rig, [set('ref', refRules), set('ref2', refRules)], flows, {});
    expect(out.results[0]!.flows[0]!.m1).toMatchObject({ agrees: false });
    expect(out.results).toHaveLength(2);
    expect(out.stoppedBecause).toBeNull();
  });

  it('reports M2 against the intent separately from M1', async () => {
    const leakyRules: WireRule[] = [{ id: 'all', priority: 1, outputPorts: [1, 2, 3], match: {} }];
    const out = await runSession(fakeRig({ calls: [] }), [set('leaky', leakyRules, 'model-admissible')], flows, {});
    const f = out.results[0]!.flows[1]!; // 10.0.2.50 -> 8.8.8.8: the intent allows only the tap
    expect(f.m1.agrees).toBe(true);
    expect(f.m2.compliant).toBe(false);
    expect(f.m2.leaks).toContain(2);
  });

  it('refuses to start when the bridge is not idle or reports attention', async () => {
    await expect(runSession(fakeRig({ calls: [] }, { idle: false }), [set('ref', refRules)], flows, {})).rejects.toThrow(/not idle/);
    await expect(runSession(fakeRig({ calls: [] }, { attention: 'policy missing' }), [set('ref', refRules)], flows, {})).rejects.toThrow(/attention/);
  });

  it('restores after every set, including when a flow throws, and then stops (fail closed)', async () => {
    const log: Log = { calls: [] };
    const out = await runSession(fakeRig(log, { throwOnFlow: 'p1-ip-b' }), [set('a', refRules), set('b', refRules)], flows, {});
    expect(log.calls.filter((c) => c === 'restore').length).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.stoppedBecause).toMatch(/flow error/);
    expect(out.results[0]!.restored).toBe(true);
    expect(log.calls.some((c) => c === 'install:b')).toBe(false);
  });

  it('stops when a restore does not verify', async () => {
    const out = await runSession(fakeRig({ calls: [] }, { restoreOk: false }), [set('a', refRules), set('b', refRules)], flows, {});
    expect(out.stoppedBecause).toMatch(/restore/);
    expect(out.results).toHaveLength(1);
  });

  it('stops when the bridge is not idle again after the restore', async () => {
    const out = await runSession(fakeRig({ calls: [] }, { stateAfterRestore: { phase: 'idle', attention: 'readback mismatch' } }), [set('a', refRules), set('b', refRules)], flows, {});
    expect(out.stoppedBecause).toMatch(/attention/);
    expect(out.results).toHaveLength(1);
  });

  it('when the install does not verify, no flow is sent and the set is skipped', async () => {
    const log: Log = { calls: [] };
    const out = await runSession(fakeRig(log, { installOk: false }), [set('a', refRules)], flows, {});
    expect(out.results[0]!.installed).toBe(false);
    expect(out.results[0]!.flows).toEqual([]);
    expect(log.calls.some((c) => c.startsWith('flow:'))).toBe(false);
  });

  it('never counts an unsendable flow as agreement', async () => {
    const out = await runSession(fakeRig({ calls: [] }, { unsendable: 'p1-ip-a' }), [set('a', refRules)], flows, {});
    const f = out.results[0]!.flows[0]!;
    expect(f.sent).toBe(false);
    expect(f.reason).toBe('no sender');
    expect(f).not.toHaveProperty('m1');
  });

  it('refuses a rule set that matches MAC addresses (the flow MACs are placeholders, so its prediction would be unreliable)', async () => {
    const macRules: WireRule[] = [{ id: 'mac', priority: 5, outputPorts: [2], match: { inPort: 1, srcMac: '02:00:00:00:00:01' } }];
    const log: Log = { calls: [] };
    const out = await runSession(fakeRig(log), [set('mac', macRules)], flows, {});
    expect(out.results[0]!.skipped).toMatch(/MAC/);
    expect(log.calls.some((c) => c.startsWith('install:'))).toBe(false);
  });

  it('uses a unique UDP tag for every flow of the run', async () => {
    const log: Log = { calls: [] };
    await runSession(fakeRig(log), [set('a', refRules), set('b', refRules)], flows, {});
    const tags = log.calls.filter((c) => c.startsWith('flow:')).map((c) => Number(c.split(':')[2]));
    expect(new Set(tags).size).toBe(tags.length);
    expect(Math.min(...tags)).toBe(UDP_TAG_BASE);
  });

  it('stops between sets when asked to (the owner calls it)', async () => {
    let n = 0;
    const out = await runSession(fakeRig({ calls: [] }), [set('a', refRules), set('b', refRules), set('c', refRules)], flows, { shouldStop: () => n++ >= 1 });
    expect(out.results).toHaveLength(1);
    expect(out.stoppedBecause).toMatch(/requested/);
  });

  it('refuses a run that would run out of unique tags', async () => {
    const many = Array.from({ length: Math.ceil(MAX_UDP_TAGS / 2) + 1 }, (_, i) => set(`s${i}`, refRules));
    await expect(runSession(fakeRig({ calls: [] }), many, flows, {})).rejects.toThrow(/tags/);
  });
});
