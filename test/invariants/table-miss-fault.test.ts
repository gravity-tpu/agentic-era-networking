/**
 * table-miss-fault.test.ts
 * A bounded, acknowledged fault that replaces the table-miss DROP with a forward to the tap port, so the isolation watcher and the repair governor can be
 * exercised against a real switch (docs/design/isolation-watch.md). The default is off; any doubt about the configuration leaves the DROP alone (Invariant 3).
 * The switch is a spy here: these tests show the guard, the ordering, the time limit and the audit, not what the firmware does with the flow-mod.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TABLE_MISS_FAULT_ACK,
  TABLE_MISS_FAULT_DEFAULT_SECONDS,
  TABLE_MISS_FAULT_MAX_SECONDS,
  TABLE_MISS_FAULT_MIN_SECONDS,
  TABLE_MISS_FAULT_MODES,
  TABLE_MISS_FAULT_REASSERT_MS,
  UNRECOGNISED_MODE_VARIANTS,
  parseTableMissFault,
} from '../../src/sdn/table-miss-fault.js';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import {
  UNRECOGNISED_TABLE_MISS_VARIANTS,
  assertNoForwardingInstructions,
  buildOfpFlowMod,
  buildOfpTableMissClearActions,
  buildOfpTableMissVariant,
  FlowModCommand,
  InstructionType,
  OpenFlowType,
  type UnrecognisedTableMissVariant,
} from '../../src/sdn/openflow-types.js';
import { RepairGovernor, parseRepairConfig } from '../../src/sdn/isolation-repair.js';
import { parseFlowStatsReply, type FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';
import { buildPort1IsolationPolicy, verifyIsolationReadback } from '../../src/sdn/port1-isolation.js';
import { readFlowStats } from '../../src/sdn/flow-readback.js';
import { pendingReadbackStatus, statusFromReadback } from '../../src/sdn/isolation-status.js';
import { entryFrom, replyOf } from '../helpers/flow-stats-fixtures.js';

vi.mock('../../src/sdn/flow-readback.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/sdn/flow-readback.js')>()), readFlowStats: vi.fn() }));

const ON = { ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap', ZODIAC_FAULT_TABLE_MISS_ACK: TABLE_MISS_FAULT_ACK };

describe('parseTableMissFault', () => {
  it('is off, and silent, when nothing is set', () => {
    expect(parseTableMissFault({})).toEqual({ enabled: false, mode: null, durationMs: 0, reassertMs: 0, warnings: [] });
  });

  it('stays off, and says why, without the acknowledgement or with a wrong one', () => {
    for (const env of [{ ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap' }, { ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap', ZODIAC_FAULT_TABLE_MISS_ACK: 'yes' }]) {
      const c = parseTableMissFault(env);
      expect(c.enabled).toBe(false);
      expect(c.warnings.join(' ')).toContain('ZODIAC_FAULT_TABLE_MISS_ACK');
    }
  });

  it('stays off for a mode it does not know, rather than guessing', () => {
    for (const mode of ['controller', 'FORWARD-TO-TAP', 'drop', '1', 'true']) {
      const c = parseTableMissFault({ ZODIAC_FAULT_TABLE_MISS: mode, ZODIAC_FAULT_TABLE_MISS_ACK: TABLE_MISS_FAULT_ACK });
      expect(c.enabled, mode).toBe(false);
      expect(c.warnings.length, mode).toBeGreaterThan(0);
    }
  });

  it('is on with the default time limit when both are set', () => {
    expect(parseTableMissFault(ON)).toMatchObject({ enabled: true, mode: 'forward-to-tap', durationMs: TABLE_MISS_FAULT_DEFAULT_SECONDS * 1000, reassertMs: 0, warnings: [] });
  });

  it('knows exactly seven modes, each needing the same acknowledgement: forward once, forward and keep re-asserting, remove the entry, and four entries that cannot forward but that the parser does not recognise as the DROP', () => {
    expect([...TABLE_MISS_FAULT_MODES]).toEqual(['forward-to-tap', 'forward-to-tap-sticky', 'delete-table-miss', 'unrecognised-table-miss', 'unrecognised-write-empty', 'unrecognised-apply-pop-vlan', 'unrecognised-write-metadata']);
    expect(parseTableMissFault({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap-sticky' })).toMatchObject({ enabled: true, mode: 'forward-to-tap-sticky', reassertMs: TABLE_MISS_FAULT_REASSERT_MS });
    expect(parseTableMissFault({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'delete-table-miss' })).toMatchObject({ enabled: true, mode: 'delete-table-miss', reassertMs: 0 });
    expect(parseTableMissFault({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'unrecognised-table-miss' })).toMatchObject({ enabled: true, mode: 'unrecognised-table-miss', reassertMs: 0 });
    for (const mode of TABLE_MISS_FAULT_MODES) {
      const c = parseTableMissFault({ ZODIAC_FAULT_TABLE_MISS: mode });
      expect(c.enabled, mode).toBe(false);
      expect(c.warnings.join(' '), mode).toContain('ZODIAC_FAULT_TABLE_MISS_ACK');
    }
  });

  it('bounds the time limit: the minimum and maximum pass, anything outside or malformed turns the fault off', () => {
    const at = (v: string) => parseTableMissFault({ ...ON, ZODIAC_FAULT_TABLE_MISS_SECONDS: v });
    expect(at(String(TABLE_MISS_FAULT_MIN_SECONDS))).toMatchObject({ enabled: true, durationMs: TABLE_MISS_FAULT_MIN_SECONDS * 1000 });
    expect(at(String(TABLE_MISS_FAULT_MAX_SECONDS))).toMatchObject({ enabled: true, durationMs: TABLE_MISS_FAULT_MAX_SECONDS * 1000 });
    for (const bad of [String(TABLE_MISS_FAULT_MIN_SECONDS - 1), String(TABLE_MISS_FAULT_MAX_SECONDS + 1), '0', '-5', '4.5', '1e3', 'abc', '', ' 240', '99999']) {
      const c = at(bad);
      expect(c.enabled, JSON.stringify(bad)).toBe(false);
      expect(c.warnings.join(' '), JSON.stringify(bad)).toContain('ZODIAC_FAULT_TABLE_MISS_SECONDS');
    }
  });
});

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);
const verifiedEntries = (): FlowStatsEntry[] => [...parseFlowStatsReply(replyOf([entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))])).entries];

let auditFile = '';
let controller: ZodiacController;
let order: string[];

function makeBridge(env: Record<string, string>): ZodiacBridgeServer {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('ZODIAC_GATE_AUDIT_FILE', auditFile);
  controller = new ZodiacController();
  order = [];
  vi.spyOn(controller.openFlow, 'sendTableMissRule').mockImplementation((_p, action) => { order.push(`table-miss:${action}`); });
  vi.spyOn(controller.openFlow, 'sendFlowModOptions').mockImplementation((fm) => { order.push(fm.command === FlowModCommand.OFPFC_DELETE_STRICT ? `delete-strict:p${fm.priority}` : `flow-mod:p${fm.priority}:[${(fm.outputPorts ?? []).join(',')}]`); return 1; });
  return new ZodiacBridgeServer(controller);
}
const audit = (): Array<Record<string, unknown>> => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(50); };

beforeEach(() => {
  auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fault-audit-')), 'gate.jsonl');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(readFlowStats).mockReset();
  vi.mocked(readFlowStats).mockResolvedValue(verifiedEntries());
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the fault in the bridge', () => {
  it('does nothing by default: the table-miss stays the DROP, with no flow-mod to the tap at priority 0', async () => {
    const b = makeBridge({});
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP']);
    expect(audit()).toEqual([]);
    expect(b).toBeDefined();
  });

  it('does nothing without the acknowledgement', async () => {
    makeBridge({ ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap' });
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]);
  });

  it('replaces the DROP with a priority-0 forward to the tap only AFTER the isolation readback verified, announces it, audits it, and puts the DROP back at the time limit', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS_SECONDS: '60' });
    controller.openFlow.emit('ready', {});
    await settle();
    const iDrop = order.indexOf('table-miss:DROP');
    const iFault = order.indexOf('flow-mod:p0:[3]');
    expect(iDrop).toBeGreaterThanOrEqual(0);
    expect(iFault).toBeGreaterThan(iDrop);
    expect(iFault).toBeGreaterThan(order.lastIndexOf(order.find((x) => x.startsWith('flow-mod:p200')) ?? ''));
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected']);
    // Not yet at the limit: the DROP has not been re-sent.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP', 'table-miss:DROP']);
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected', 'fault_reverted']);
  });

  it('does not inject when the readback did not verify the baseline (fail closed): the table is left as it is', async () => {
    makeBridge(ON);
    vi.mocked(readFlowStats).mockRejectedValue(new Error('readback timed out'));
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]);
    expect(audit()).toEqual([]);
  });

  it('injects once per process: a reconnect gets the DROP only, and cancels a fault still pending', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS_SECONDS: '120' });
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toHaveLength(1);
    order.length = 0;
    controller.openFlow.emit('ready', {}); // the session came back: the table is rewritten from the policy
    await settle();
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP']);
    await vi.advanceTimersByTimeAsync(130_000); // the cancelled timer must not fire a second DROP
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP']);
  });
});

describe('the sticky and delete modes in the bridge', () => {
  const sticky = { ...ON, ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap-sticky', ZODIAC_FAULT_TABLE_MISS_SECONDS: '60' };

  it('sticky: forwards once, then re-asserts the forward every few seconds (so a repair that re-sends the DROP does not take), and stops at the time limit with one DROP', async () => {
    makeBridge(sticky);
    controller.openFlow.emit('ready', {});
    await settle();
    const forwards = (): number => order.filter((x) => x === 'flow-mod:p0:[3]').length;
    expect(forwards()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forwards()).toBeGreaterThanOrEqual(1 + Math.floor(10_000 / TABLE_MISS_FAULT_REASSERT_MS) - 1);
    expect(forwards()).toBeLessThanOrEqual(1 + Math.ceil(10_000 / TABLE_MISS_FAULT_REASSERT_MS));
    const before = order.filter((x) => x.startsWith('table-miss')).length;
    await vi.advanceTimersByTimeAsync(60_000); // past the 60 s limit
    expect(order.filter((x) => x.startsWith('table-miss')).length).toBe(before + 1); // exactly one DROP at the limit
    const afterLimit = forwards();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forwards()).toBe(afterLimit); // no more re-assertion once it ended
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected', 'fault_reverted']);
  });

  it('sticky: a new switch session cancels the re-assertion as well as the revert', async () => {
    makeBridge(sticky);
    controller.openFlow.emit('ready', {});
    await settle();
    controller.openFlow.emit('ready', {});
    await settle();
    order.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual([]);
  });

  it('sticky: stops re-asserting, loudly, if a re-assertion cannot be sent (the session is gone)', async () => {
    makeBridge(sticky);
    controller.openFlow.emit('ready', {});
    await settle();
    vi.mocked(controller.openFlow.sendFlowModOptions).mockImplementation(() => { throw new Error('switch not in ESTABLISHED state'); });
    await vi.advanceTimersByTimeAsync(TABLE_MISS_FAULT_REASSERT_MS * 3);
    vi.mocked(controller.openFlow.sendFlowModOptions).mockClear();
    await vi.advanceTimersByTimeAsync(TABLE_MISS_FAULT_REASSERT_MS * 5);
    expect(vi.mocked(controller.openFlow.sendFlowModOptions)).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Fault\].*re-assert/);
  });

  it('delete: removes the priority-0 entry with a strict delete after the verified readback, and puts the DROP back at the limit', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'delete-table-miss', ZODIAC_FAULT_TABLE_MISS_SECONDS: '60' });
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'delete-strict:p0')).toHaveLength(1);
    expect(order.filter((x) => x === 'flow-mod:p0:[3]')).toEqual([]); // no forward in this mode
    expect(order.indexOf('delete-strict:p0')).toBeGreaterThan(order.indexOf('table-miss:DROP'));
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected']);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP', 'table-miss:DROP']);
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected', 'fault_reverted']);
  });

  it('delete: does nothing when the readback did not verify the baseline', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'delete-table-miss' });
    vi.mocked(readFlowStats).mockRejectedValue(new Error('readback timed out'));
    controller.openFlow.emit('ready', {});
    await settle();
    expect(order.filter((x) => x === 'delete-strict:p0')).toEqual([]);
  });
});

describe('a repair that does not take, against the governor with a sticky fault', () => {
  it('after the budget is spent the governor stops repairing and reports exhausted, instead of fighting the fault forever', () => {
    // The governor's own behaviour under a condition that never clears (the sticky fault re-applies the forward after each repair): pure, no clock.
    const gov = new RepairGovernor({ ...parseRepairConfig({ ZODIAC_ISOLATION_REPAIR: '1', ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW: '1', ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS: '60000' }) });
    const ctx = { sessionUp: true, experimentIdle: true, busy: false };
    let t = 0n;
    const NS = 1_000_000_000n;
    const decisions: string[] = [];
    for (let i = 0; i < 9; i++) {
      const monoNs = (t += 60n * NS);
      const d = gov.observe({ state: 'mismatch', tableMiss: 'forwards', monoNs }, ctx);
      decisions.push(d.action);
      if (d.action === 'repair') gov.repaired(monoNs, Number(t / 1_000_000n), d.trigger); // the sticky fault overwrites it, so the next reading is bad again
    }
    expect(decisions.filter((a) => a === 'repair')).toHaveLength(1);
    expect(decisions).toContain('exhausted');
    expect(decisions.filter((a) => a === 'exhausted')).toHaveLength(1); // announced once, then silent until it clears
    expect(decisions.indexOf('exhausted')).toBeGreaterThan(decisions.indexOf('repair'));
  });
});

describe('the unrecognised mode', () => {
  it('builds a priority-0 wildcard whose only instruction is CLEAR_ACTIONS, which executes as a drop (no output) but is not a drop the parser recognises', () => {
    const fm = buildOfpTableMissClearActions(7);
    expect(fm.readUInt8(0)).toBe(4); // OpenFlow 1.3
    expect(fm.readUInt8(1)).toBe(OpenFlowType.OFPT_FLOW_MOD);
    expect(fm.readUInt16BE(2)).toBe(fm.length);
    expect(fm.readUInt32BE(4)).toBe(7);
    expect(fm.readUInt8(25)).toBe(FlowModCommand.OFPFC_ADD);
    expect(fm.readUInt16BE(30)).toBe(0); // priority 0
    expect(fm.readUInt16BE(50)).toBe(4); // an empty match
    expect(fm.readUInt16BE(56)).toBe(InstructionType.OFPIT_CLEAR_ACTIONS);
    expect(fm.readUInt16BE(58)).toBe(8);
    expect(fm.length).toBe(64); // nothing after the one instruction: no apply-actions, so no output
  });

  it('is read back as an unrecognised table-miss, not as a drop', () => {
    const entries = [...parseFlowStatsReply(replyOf([entryFrom(buildOfpTableMissClearActions(99)), ...flowMods.map((fm) => entryFrom(fm))])).entries];
    const v = verifyIsolationReadback(policy, entries);
    expect(v.actions.tableMiss).toBe('unrecognised');
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches.join(' ')).toContain('could not be recognised as a drop');
    // And the isolation status built from it is not `verified`, so the recheck, the watcher and the repair governor all see it.
    expect(statusFromReadback(pendingReadbackStatus(), v, 1, 1n).state).not.toBe('verified');
  });

  it('is sent as raw bytes after the verified readback, once, with the DROP put back at the time limit; nothing else touches the table', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'unrecognised-table-miss', ZODIAC_FAULT_TABLE_MISS_SECONDS: '60' });
    const raw: Buffer[] = [];
    vi.spyOn(controller.openFlow, 'sendRaw').mockImplementation((p: Buffer) => { raw.push(Buffer.from(p)); });
    controller.openFlow.emit('ready', {});
    await settle();
    const clear = raw.filter((p) => p.length === 64 && p.readUInt8(1) === OpenFlowType.OFPT_FLOW_MOD && p.readUInt16BE(56) === InstructionType.OFPIT_CLEAR_ACTIONS);
    expect(clear).toHaveLength(1);
    expect(order.filter((x) => x === 'flow-mod:p0:[3]' || x === 'delete-strict:p0')).toEqual([]);
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected']);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP', 'table-miss:DROP']);
    expect(audit().map((r) => r['event'])).toEqual(['fault_injected', 'fault_reverted']);
  });

  it('does nothing when the readback did not verify the baseline', async () => {
    makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: 'unrecognised-table-miss' });
    const raw: Buffer[] = [];
    vi.spyOn(controller.openFlow, 'sendRaw').mockImplementation((p: Buffer) => { raw.push(Buffer.from(p)); });
    vi.mocked(readFlowStats).mockRejectedValue(new Error('readback timed out'));
    controller.openFlow.emit('ready', {});
    await settle();
    expect(raw.filter((p) => p.length === 64)).toEqual([]);
  });
});


/** The exact flow-mod bytes of each unrecognised variant (xid 7), written out by hand from OpenFlow 1.3 section 7.3.4.1: a 48-byte flow-mod header, an 8-byte empty OXM match, then the instruction. */
const HEAD = '040e' + '{LEN}' + '00000007' + '0000000000000000' + '0000000000000000' + '00' + '00' + '0000' + '0000' + '0000' + 'ffffffff' + 'ffffffff' + 'ffffffff' + '0000' + '0000' + '0001000400000000';
const VARIANT_HEX: Readonly<Record<UnrecognisedTableMissVariant, { instruction: string; otherInstructions: number[]; otherActions: number[] }>> = {
  'clear-actions': { instruction: '0005000800000000', otherInstructions: [5], otherActions: [] },
  'write-empty': { instruction: '0003000800000000', otherInstructions: [3], otherActions: [] },
  'apply-pop-vlan': { instruction: '0004001000000000' + '0012000800000000', otherInstructions: [], otherActions: [18] },
  'write-metadata': { instruction: '0002001800000000' + '0000000000000000' + '0000000000000000', otherInstructions: [2], otherActions: [] },
};
const expectedHex = (v: UnrecognisedTableMissVariant): string => {
  const instr = VARIANT_HEX[v].instruction;
  const len = (56 + instr.length / 2).toString(16).padStart(4, '0');
  return HEAD.replace('{LEN}', len) + instr;
};

describe('the further unrecognised variants (every one safe by construction: never an output)', () => {
  it('has exactly the four variants, each mapped from one mode, and the original mode keeps its meaning', () => {
    expect([...UNRECOGNISED_TABLE_MISS_VARIANTS]).toEqual(['clear-actions', 'write-empty', 'apply-pop-vlan', 'write-metadata']);
    expect(UNRECOGNISED_MODE_VARIANTS).toEqual({ 'unrecognised-table-miss': 'clear-actions', 'unrecognised-write-empty': 'write-empty', 'unrecognised-apply-pop-vlan': 'apply-pop-vlan', 'unrecognised-write-metadata': 'write-metadata' });
    expect(buildOfpTableMissClearActions(7).equals(buildOfpTableMissVariant('clear-actions', 7))).toBe(true);
  });

  for (const v of UNRECOGNISED_TABLE_MISS_VARIANTS) {
    it(`${v}: has exactly the bytes written out by hand, and its instruction block passes the no-forwarding guard`, () => {
      const fm = buildOfpTableMissVariant(v, 7);
      expect(fm.toString('hex')).toBe(expectedHex(v));
      expect(fm.readUInt16BE(2)).toBe(fm.length);
      expect(() => assertNoForwardingInstructions(fm.subarray(56))).not.toThrow();
    });

    it(`${v}: is read back as an unrecognised table-miss (not drops, not forwards), with the other types the parser records`, () => {
      const fm = buildOfpTableMissVariant(v, 99);
      const entries = [...parseFlowStatsReply(replyOf([entryFrom(fm), ...flowMods.map((m) => entryFrom(m))])).entries];
      const miss = entries.find((e) => e.priority === 0);
      expect(miss?.actions).toMatchObject({ outputPorts: [], complete: true, hasInstructions: true, otherInstructionTypes: VARIANT_HEX[v].otherInstructions, otherActionTypes: VARIANT_HEX[v].otherActions });
      const verdict = verifyIsolationReadback(policy, entries);
      expect(verdict.actions.tableMiss).toBe('unrecognised');
      expect(verdict.actions.status).toBe('mismatch');
      expect(statusFromReadback(pendingReadbackStatus(), verdict, 1, 1n).state).not.toBe('verified');
    });
  }

  it('the guard can reject: an output, a group, an experimenter action, a goto-table, a meter and a malformed block are all refused', () => {
    const out = Buffer.from('0004001800000000' + '0000001000000001' + '0000000000000000', 'hex'); // APPLY_ACTIONS [OUTPUT port 1]
    const group = Buffer.from('0004001000000000' + '0016000800000001', 'hex');
    const exp = Buffer.from('0004001000000000' + 'ffff000800000000', 'hex');
    const writeOut = Buffer.from('0003001800000000' + '0000001000000001' + '0000000000000000', 'hex');
    const gotoTable = Buffer.from('0001000800000000', 'hex');
    const meter = Buffer.from('0006000800000001', 'hex');
    for (const bad of [out, group, exp, writeOut, gotoTable, meter]) expect(() => assertNoForwardingInstructions(bad)).toThrow(/not allowed/);
    expect(() => assertNoForwardingInstructions(Buffer.from('00050010', 'hex'))).toThrow(/truncated|bad/); // length says 16, 4 bytes present
    expect(() => assertNoForwardingInstructions(Buffer.from('0005000400000000', 'hex'))).toThrow(/bad instruction length/);
    expect(() => assertNoForwardingInstructions(Buffer.from('0004001000000000' + '0012000400000000', 'hex'))).toThrow(/bad action length/);
  });

  for (const mode of ['unrecognised-write-empty', 'unrecognised-apply-pop-vlan', 'unrecognised-write-metadata'] as const) {
    const variant = UNRECOGNISED_MODE_VARIANTS[mode];
    it(`${mode}: is sent as raw bytes after the verified readback, once, with one DROP put back at the limit, audited with its own id; no other flow-mod`, async () => {
      makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: mode, ZODIAC_FAULT_TABLE_MISS_SECONDS: '60' });
      const raw: Buffer[] = [];
      vi.spyOn(controller.openFlow, 'sendRaw').mockImplementation((p: Buffer) => { raw.push(Buffer.from(p)); });
      controller.openFlow.emit('ready', {});
      await settle();
      expect(variant).toBeDefined();
      const sent = raw.filter((p) => p.readUInt8(1) === OpenFlowType.OFPT_FLOW_MOD && p.readUInt16BE(30) === 0);
      expect(sent).toHaveLength(1);
      const onWire = Buffer.from(sent[0] ?? Buffer.alloc(0));
      onWire.writeUInt32BE(7, 4); // the xid is the bridge's to choose; everything else is the variant's bytes
      expect(onWire.toString('hex')).toBe(expectedHex(variant ?? 'clear-actions'));
      expect(order.filter((x) => x === 'flow-mod:p0:[3]' || x === 'delete-strict:p0')).toEqual([]);
      expect(audit().map((r) => r['event'])).toEqual(['fault_injected']);
      expect(JSON.stringify(audit()[0])).toContain(`fault-table-miss-${mode}`);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(order.filter((x) => x.startsWith('table-miss'))).toEqual(['table-miss:DROP', 'table-miss:DROP']);
      expect(audit().map((r) => r['event'])).toEqual(['fault_injected', 'fault_reverted']);
    });

    it(`${mode}: does nothing when the readback did not verify the baseline`, async () => {
      makeBridge({ ...ON, ZODIAC_FAULT_TABLE_MISS: mode });
      const raw: Buffer[] = [];
      vi.spyOn(controller.openFlow, 'sendRaw').mockImplementation((p: Buffer) => { raw.push(Buffer.from(p)); });
      vi.mocked(readFlowStats).mockRejectedValue(new Error('readback timed out'));
      controller.openFlow.emit('ready', {});
      await settle();
      expect(raw.filter((p) => p.readUInt8(1) === OpenFlowType.OFPT_FLOW_MOD && p.readUInt16BE(30) === 0)).toEqual([]);
    });
  }
});
