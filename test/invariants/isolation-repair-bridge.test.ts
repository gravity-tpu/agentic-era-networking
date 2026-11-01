/**
 * test/invariants/isolation-repair-bridge.test.ts
 * The repair governor wired into the real bridge (docs/design/isolation-repair.md). The switch is a spy: these show the wiring, the gates and the audit, not what
 * the firmware does with the FlowMod. The repair is the smallest action that fixes A3: it re-sends the person-approved table-miss DROP and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import type { ControllerMetrics } from '../../src/sdn/openflow-server.js';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply, type FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';
import { buildPort1IsolationPolicy, verifyIsolationReadback } from '../../src/sdn/port1-isolation.js';
import { pendingReadbackStatus, statusFromReadback, type IsolationStatus } from '../../src/sdn/isolation-status.js';
import { applyActions, entryFrom, outputAction, replyOf } from '../helpers/flow-stats-fixtures.js';

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);
const entriesOf = (bufs: readonly Buffer[]): FlowStatsEntry[] => parseFlowStatsReply(replyOf(bufs)).entries;
const readingOf = (entries: FlowStatsEntry[]): IsolationStatus => statusFromReadback(pendingReadbackStatus(), verifyIsolationReadback(policy, entries), 1, 1n);
const clean = (): IsolationStatus => readingOf(entriesOf([entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))]));
const forwards = (): IsolationStatus => readingOf(entriesOf([entryFrom(tableMissMod, applyActions(outputAction(2))), ...flowMods.map((fm) => entryFrom(fm))]));
const absent = (): IsolationStatus => readingOf(entriesOf(flowMods.map((fm) => entryFrom(fm))));

let auditFile = '';
let controller: ZodiacController;
let tableMissSpy: ReturnType<typeof vi.spyOn>;
let flowModSpy: ReturnType<typeof vi.spyOn>;
let sessionState: ControllerMetrics['state'] = 'ESTABLISHED';

function makeBridge(env: Record<string, string> = { ZODIAC_ISOLATION_REPAIR: '1' }): ZodiacBridgeServer {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('ZODIAC_GATE_AUDIT_FILE', auditFile);
  controller = new ZodiacController();
  tableMissSpy = vi.spyOn(controller.openFlow, 'sendTableMissRule').mockImplementation(() => 1);
  flowModSpy = vi.spyOn(controller.openFlow, 'sendFlowModOptions').mockImplementation(() => 1);
  sessionState = 'ESTABLISHED';
  const realMetrics = controller.openFlow.metrics; // `metrics` is a getter returning a fresh object, so the getter itself is what is replaced
  vi.spyOn(controller.openFlow, 'metrics', 'get').mockImplementation(() => ({ ...realMetrics, state: sessionState }));
  return new ZodiacBridgeServer(controller);
}
const consider = (b: ZodiacBridgeServer, s: IsolationStatus): void => { b['considerRepair'](s); };
const auditLines = (): Array<Record<string, unknown>> => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

beforeEach(() => {
  auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-audit-')), 'gate.jsonl');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('repair, when enabled', () => {
  it('re-sends the default DROP after 3 consecutive readings with a forwarding table-miss, and sends nothing else', () => {
    const b = makeBridge();
    consider(b, forwards()); consider(b, forwards());
    expect(tableMissSpy).not.toHaveBeenCalled();
    consider(b, forwards());
    expect(tableMissSpy).toHaveBeenCalledTimes(1);
    expect(tableMissSpy).toHaveBeenCalledWith(0, 'DROP');
    expect(flowModSpy).not.toHaveBeenCalled(); // no policy rule, quarantine or allow rule is touched
  });
  it('also repairs an absent table-miss', () => {
    const b = makeBridge();
    for (let i = 0; i < 3; i++) consider(b, absent());
    expect(tableMissSpy).toHaveBeenCalledTimes(1);
  });
  it('writes an audit record for the repair and reports it in the status payload', () => {
    const b = makeBridge();
    for (let i = 0; i < 3; i++) consider(b, forwards());
    const rec = auditLines().find((l) => l['event'] === 'repair');
    expect(rec).toBeDefined();
    expect(rec?.['route']).toBe('repair');
    expect(String(rec?.['what'])).toMatch(/forwards/);
    const status = b['isolationJson']();
    expect(status.repair).toMatchObject({ enabled: true, totalRepairs: 1, lastTrigger: 'forwards', exhausted: false });
  });
  it('asks the re-checker for a verifying read soon after, so the result is not left to the next timer tick', async () => {
    vi.useFakeTimers();
    const b = makeBridge();
    const runOnce = vi.spyOn(b['isolationRechecker'], 'runOnce').mockResolvedValue('unchanged');
    for (let i = 0; i < 3; i++) consider(b, forwards());
    expect(runOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});

describe('repair, when it must not act', () => {
  it('is off by default', () => {
    const b = makeBridge({});
    for (let i = 0; i < 10; i++) consider(b, forwards());
    expect(tableMissSpy).not.toHaveBeenCalled();
    expect(b['isolationJson']().repair).toMatchObject({ enabled: false, totalRepairs: 0 });
  });
  it('does nothing for a generic mismatch whose table-miss drops, or for clean readings', () => {
    const b = makeBridge();
    const missingRule = readingOf(entriesOf([entryFrom(tableMissMod), ...flowMods.filter((_, i) => i !== 2).map((fm) => entryFrom(fm))]));
    expect(missingRule.state).toBe('mismatch');
    for (let i = 0; i < 10; i++) { consider(b, missingRule); consider(b, clean()); }
    expect(tableMissSpy).not.toHaveBeenCalled();
  });
  it('does nothing while an experiment is running', () => {
    const b = makeBridge();
    Object.defineProperty(b, 'experiment', { value: { state: () => ({ phase: 'active', attention: null }), sessionReset: () => undefined }, configurable: true });
    for (let i = 0; i < 5; i++) consider(b, forwards());
    expect(tableMissSpy).not.toHaveBeenCalled();
  });
  it('does nothing without an OpenFlow session', () => {
    const b = makeBridge();
    sessionState = 'DISCONNECTED';
    for (let i = 0; i < 5; i++) consider(b, forwards());
    expect(tableMissSpy).not.toHaveBeenCalled();
  });
  it('a malformed setting stops the bridge from starting instead of being guessed at', () => {
    expect(() => makeBridge({ ZODIAC_ISOLATION_REPAIR: 'yes' })).toThrow(RangeError);
    expect(() => makeBridge({ ZODIAC_ISOLATION_REPAIR: '1', ZODIAC_ISOLATION_REPAIR_READINGS: '0' })).toThrow(RangeError);
  });
});

describe('repair, bounded', () => {
  it('stops after the per-window budget, records that a person is needed, and sends no further repair', async () => {
    vi.useFakeTimers();
    const b = makeBridge({ ZODIAC_ISOLATION_REPAIR: '1', ZODIAC_ISOLATION_REPAIR_READINGS: '1', ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS: '60000', ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW: '2' });
    vi.spyOn(b['isolationRechecker'], 'runOnce').mockResolvedValue('unchanged');
    const nsTick = (ms: number): void => { const real = process.hrtime.bigint; let t = real(); t += BigInt(ms) * 1_000_000n; vi.spyOn(process.hrtime, 'bigint').mockReturnValue(t); };
    for (let k = 0; k < 4; k++) { nsTick(61_000 * (k + 1)); consider(b, forwards()); await vi.advanceTimersByTimeAsync(6_000); }
    expect(tableMissSpy).toHaveBeenCalledTimes(2);
    expect(b['isolationJson']().repair).toMatchObject({ exhausted: true, totalRepairs: 2 });
    expect(auditLines().some((l) => l['event'] === 'repair_exhausted')).toBe(true);
  });
});
