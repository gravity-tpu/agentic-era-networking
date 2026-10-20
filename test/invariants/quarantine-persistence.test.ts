/**
 * quarantine-persistence.test.ts
 * Active quarantines must survive a bridge restart and a switch reconnect, because the firmware flushes its table when the
 * controller session drops (measured 2026-10-20). These tests drive the bridge's real persistence and re-send logic against a
 * recording controller. They show the bridge's logic; they do not show what the firmware does with the re-sent rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { parseQuarantineState, loadQuarantineState, saveQuarantineState, resolveQuarantineStateFile } from '../../src/sdn/quarantine-persistence.js';
import { readQuarantineEnvelopeConfig, MAX_QUARANTINE_TTL_MS } from '../../src/sdn/quarantine-envelope.js';

const env = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_PROTECTED_IPS: '10.0.2.119' } as NodeJS.ProcessEnv).config;
const NOW = 1_700_000_000_000;
const file = (records: unknown[], version = 1): string => JSON.stringify({ version, active: records });
const rec = (ip: string, expiresAtMs: number, extra: Record<string, unknown> = {}) => ({ ip, reason: 'rate', priority: 65535, expiresAtMs, ...extra });

describe('parseQuarantineState', () => {
  it('keeps a live record with its remaining time and drops an expired one', () => {
    const r = parseQuarantineState(file([rec('10.0.2.50', NOW + 60_000), rec('10.0.2.51', NOW - 1)]), NOW, env);
    expect(r.records.map((x) => x.ip)).toEqual(['10.0.2.50']);
    expect(r.records[0]?.expiresAtMs).toBe(NOW + 60_000); // never extended
    expect(r.notes.join()).toMatch(/10\.0\.2\.51.*already passed/);
  });

  it('caps the remaining time at the envelope maximum, even if the file was edited to a far future', () => {
    const r = parseQuarantineState(file([rec('10.0.2.50', NOW + 10 * MAX_QUARANTINE_TTL_MS)]), NOW, env);
    expect(r.records[0]?.expiresAtMs).toBe(NOW + MAX_QUARANTINE_TTL_MS);
  });

  it('re-checks the CURRENT envelope: out of scope, protected, and over the cap are dropped, not installed', () => {
    const small = { ...env, maxActive: 1 };
    const r = parseQuarantineState(file([rec('10.0.0.5', NOW + 5000), rec('10.0.2.119', NOW + 5000), rec('10.0.2.60', NOW + 5000), rec('10.0.2.61', NOW + 5000)]), NOW, small);
    expect(r.records.map((x) => x.ip)).toEqual(['10.0.2.60']);
    expect(r.notes.join()).toMatch(/out_of_scope/);
    expect(r.notes.join()).toMatch(/protected/);
    expect(r.notes.join()).toMatch(/cap_reached/);
  });

  it('drops duplicates, malformed records, and bad priorities fall back to 65535', () => {
    const r = parseQuarantineState(file([rec('10.0.2.50', NOW + 5000), rec('10.0.2.50', NOW + 5000), { ip: 5 }, null, rec('10.0.2.52', NOW + 5000, { priority: 0 })]), NOW, env);
    expect(r.records.map((x) => [x.ip, x.priority])).toEqual([['10.0.2.50', 65535], ['10.0.2.52', 65535]]);
  });

  it('ignores a corrupt file, a wrong version, and a wrong shape entirely, with a note, never partially', () => {
    expect(parseQuarantineState('{not json', NOW, env).records).toEqual([]);
    expect(parseQuarantineState('{not json', NOW, env).notes[0]).toMatch(/not valid JSON/);
    expect(parseQuarantineState(file([rec('10.0.2.50', NOW + 5000)], 2), NOW, env).records).toEqual([]);
    expect(parseQuarantineState('[]', NOW, env).records).toEqual([]);
  });
});

describe('save and load', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips, writes atomically (no temp file left) and privately', () => {
    const f = path.join(dir, 'sub', 'q.json');
    expect(saveQuarantineState(f, [{ ip: '10.0.2.50', reason: 'r', priority: 65535, expiresAtMs: NOW + 5000 }])).toBeNull();
    expect(fs.readdirSync(path.dirname(f))).toEqual(['q.json']);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(loadQuarantineState(f, NOW, env).records.map((x) => x.ip)).toEqual(['10.0.2.50']);
  });

  it('a missing file is empty with no note; an unwritable path returns an error instead of throwing', () => {
    expect(loadQuarantineState(path.join(dir, 'none.json'), NOW, env)).toEqual({ records: [], notes: [] });
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    expect(saveQuarantineState(path.join(dir, 'blocker', 'q.json'), [])).toMatch(/could not write/);
  });

  it('resolves the path from the explicit variable, else STATE_DIRECTORY, else /var/lib/zodiac', () => {
    expect(resolveQuarantineStateFile({ ZODIAC_QUARANTINE_STATE_FILE: ' /x/q.json ' } as NodeJS.ProcessEnv)).toBe('/x/q.json');
    expect(resolveQuarantineStateFile({ STATE_DIRECTORY: '/s' } as NodeJS.ProcessEnv)).toBe('/s/quarantine-state.json');
    expect(resolveQuarantineStateFile({} as NodeJS.ProcessEnv)).toBe('/var/lib/zodiac/quarantine-state.json');
  });
});

describe('the bridge restores quarantines after a restart and a reconnect', () => {
  let dir: string;
  let stateFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-'));
    stateFile = path.join(dir, 'q.json');
    vi.stubEnv('ZODIAC_QUARANTINE_STATE_FILE', stateFile);
    vi.stubEnv('ZODIAC_QUARANTINE_MODE', 'enforce');
    vi.stubEnv('ZODIAC_QUARANTINE_PROTECTED_IPS', '10.0.2.119');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

  const bridgeWithRecorder = () => {
    const controller = new ZodiacController();
    const pushed: Array<{ ip: string; priority: number; hardTimeoutS: number | undefined }> = [];
    vi.spyOn(controller, 'pushRule').mockImplementation((rule, _out, hard) => { pushed.push({ ip: rule.srcCidr, priority: rule.priority, hardTimeoutS: hard }); });
    return { bridge: new ZodiacBridgeServer(controller), pushed, controller };
  };

  it('a quarantine installed by one bridge process is re-sent, with its remaining time, by the next', () => {
    const a = bridgeWithRecorder();
    expect(a.bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' }).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).active).toHaveLength(1);
    // "Restart": a new bridge, same state file, no switch session yet.
    const b = bridgeWithRecorder();
    expect(b.pushed).toEqual([]); // nothing is sent until a session is ready
    expect(b.bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'again' }).status).toBe(409); // restored, so it counts as already quarantined
    expect(b.bridge.reinstallQuarantines()).toBe(1);
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]?.ip).toBe('10.0.2.50/32');
    expect(b.pushed[0]?.priority).toBe(65535);
    expect(b.pushed[0]?.hardTimeoutS).toBeGreaterThan(0);
    expect(b.pushed[0]?.hardTimeoutS).toBeLessThanOrEqual(300); // the remaining time, never a fresh full limit beyond the original
  });

  it('a switch reconnect (table flushed) re-sends the same quarantines again, and a release is not resurrected', () => {
    const a = bridgeWithRecorder();
    a.bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    a.bridge.requestQuarantine({ targetIp: '10.0.2.51', reason: 'rate' });
    a.pushed.length = 0;
    expect(a.bridge.reinstallQuarantines()).toBe(2); // the "ready" handler calls this on every new session
    expect(a.pushed.map((p) => p.ip).sort()).toEqual(['10.0.2.50/32', '10.0.2.51/32']);
    // (liftQuarantine needs an ESTABLISHED session, which a unit test does not have; the lift itself is not what is under test here.)
    vi.spyOn(a.controller, 'liftQuarantine').mockReturnValue({ success: true, timestampNs: 0n });
    expect(a.bridge.releaseQuarantineRule({ targetIp: '10.0.2.50', reason: 'triage' }).releasedCount).toBe(1);
    a.pushed.length = 0;
    expect(a.bridge.reinstallQuarantines()).toBe(1);
    expect(a.pushed.map((p) => p.ip)).toEqual(['10.0.2.51/32']);
    // and a restart after the release does not bring it back
    const b = bridgeWithRecorder();
    expect(b.bridge.reinstallQuarantines()).toBe(1);
    expect(b.pushed.map((p) => p.ip)).toEqual(['10.0.2.51/32']);
  });

  it('an expired quarantine is lifted by the sweep, leaves the file, and is not restored', () => {
    const a = bridgeWithRecorder();
    a.bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    expect(a.bridge.sweepExpiredQuarantines(process.hrtime.bigint() + 400n * 1_000_000_000n)).toBe(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).active).toEqual([]);
    const b = bridgeWithRecorder();
    expect(b.bridge.reinstallQuarantines()).toBe(0);
  });

  it('a record whose wall-clock end has passed while the bridge was down is not restored', () => {
    fs.writeFileSync(stateFile, file([rec('10.0.2.50', Date.now() - 1000)]));
    const b = bridgeWithRecorder();
    expect(b.bridge.reinstallQuarantines()).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).active).toEqual([]); // and the file is cleaned
  });

  it('a record for a host that is protected now is not restored', () => {
    fs.writeFileSync(stateFile, file([rec('10.0.2.119', Date.now() + 60_000)]));
    const b = bridgeWithRecorder();
    expect(b.bridge.reinstallQuarantines()).toBe(0);
  });

  it('a push that throws is reported, not counted, and the next call retries it', () => {
    const controller = new ZodiacController();
    const bridge = new ZodiacBridgeServer(controller);
    bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    const spy = vi.spyOn(controller, 'pushRule').mockImplementationOnce(() => { throw new Error('socket closed'); });
    expect(bridge.reinstallQuarantines()).toBe(0);
    spy.mockImplementation(() => undefined);
    expect(bridge.reinstallQuarantines()).toBe(1);
  });

  it('the switch-ready handler re-sends quarantines right after the table-miss and BEFORE any isolation allow-rule', async () => {
    const a = bridgeWithRecorder();
    a.bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    const controller = new ZodiacController();
    const order: string[] = [];
    vi.spyOn(controller.openFlow, 'sendTableMissRule').mockImplementation(() => { order.push('table-miss'); });
    vi.spyOn(controller.openFlow, 'sendFlowModOptions').mockImplementation(() => { order.push('isolation-rule'); return 1; });
    vi.spyOn(controller, 'pushRule').mockImplementation((rule) => { order.push(`quarantine ${rule.srcCidr}`); });
    const bridge = new ZodiacBridgeServer(controller);
    controller.openFlow.emit('ready', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(order[0]).toBe('table-miss');
    expect(order[1]).toBe('quarantine 10.0.2.50/32');
    expect(order.slice(2).every((x) => x === 'isolation-rule')).toBe(true);
    expect(order.length).toBeGreaterThan(2);
    expect(bridge).toBeDefined();
  });
});
