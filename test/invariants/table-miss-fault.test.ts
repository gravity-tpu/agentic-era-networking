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
  parseTableMissFault,
} from '../../src/sdn/table-miss-fault.js';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply, type FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import { readFlowStats } from '../../src/sdn/flow-readback.js';
import { entryFrom, replyOf } from '../helpers/flow-stats-fixtures.js';

vi.mock('../../src/sdn/flow-readback.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/sdn/flow-readback.js')>()), readFlowStats: vi.fn() }));

const ON = { ZODIAC_FAULT_TABLE_MISS: 'forward-to-tap', ZODIAC_FAULT_TABLE_MISS_ACK: TABLE_MISS_FAULT_ACK };

describe('parseTableMissFault', () => {
  it('is off, and silent, when nothing is set', () => {
    expect(parseTableMissFault({})).toEqual({ enabled: false, durationMs: 0, warnings: [] });
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
    expect(parseTableMissFault(ON)).toMatchObject({ enabled: true, durationMs: TABLE_MISS_FAULT_DEFAULT_SECONDS * 1000, warnings: [] });
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
  vi.spyOn(controller.openFlow, 'sendFlowModOptions').mockImplementation((fm) => { order.push(`flow-mod:p${fm.priority}:[${(fm.outputPorts ?? []).join(',')}]`); return 1; });
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
