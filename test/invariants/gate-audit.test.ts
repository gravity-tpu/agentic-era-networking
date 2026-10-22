/**
 * gate-audit.test.ts
 * The install gate's audit trail: one bounded JSON line per refusal, rotation, a per-minute limit that counts what it drops, and a write failure
 * that is reported and never changes or throws into the refusal. Time is injected: no sleeps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GateAuditLog, buildGateAuditRecord, resolveGateAuditFile, resolveCallerAuditFile, safeHeaderText, CALLER_MAX_EVENTS_PER_MINUTE, GATE_AUDIT_SCHEMA, MAX_VIOLATIONS, MAX_EVENTS_PER_MINUTE, type GateAuditInput } from '../../src/sdn/gate-audit.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

const rule = (id: string) => ({ id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 10, outputPorts: [2], match: { srcMac: 'aa:bb:cc:dd:ee:ff' } } });
const input = (over: Partial<GateAuditInput> = {}): GateAuditInput => ({
  event: 'refused', route: 'allow', peer: '10.0.0.119', what: 'allow rule x', proposed: [rule('allow-1')],
  violations: [{ property: 'A2', ruleIds: ['allow-1'], detail: 'allow-1 names no ingress port' }], notes: ['A8 unverifiable: x'], tableRules: 7, ...over,
});

describe('buildGateAuditRecord', () => {
  it('records who, what and which property failed on which rule', () => {
    const r = buildGateAuditRecord(input(), 1000, 0);
    expect(r.schema).toBe(GATE_AUDIT_SCHEMA);
    expect(r).toMatchObject({ atMs: 1000, event: 'refused', route: 'allow', peer: '10.0.0.119', tableRules: 7, suppressedBefore: 0 });
    expect(r.proposed[0]).toEqual({ id: 'allow-1', priority: 10, outputPorts: [2], match: { srcMac: 'aa:bb:cc:dd:ee:ff' } });
    expect(r.violations[0]).toEqual({ property: 'A2', ruleIds: ['allow-1'], detail: 'allow-1 names no ingress port' });
  });

  it('bounds everything it copies: long strings are clipped, violations are capped and the omitted count is kept', () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: MAX_VIOLATIONS + 7 }, (_, i) => ({ property: 'A11' as const, ruleIds: [long], detail: `${long}${i}` }));
    const r = buildGateAuditRecord(input({ peer: long, what: long, violations: many, notes: Array.from({ length: 30 }, () => long) }), 1, 0);
    expect(r.violations).toHaveLength(MAX_VIOLATIONS);
    expect(r.violationsOmitted).toBe(7);
    expect(r.notes.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(r).length).toBeLessThan(40_000);
    expect(r.what.length).toBeLessThanOrEqual(501);
    expect(r.peer === null ? 0 : r.peer.length).toBeLessThanOrEqual(501);
  });

  it('copies only primitive fields of a match, at most 16, so a hostile match cannot widen a line or break the copy', () => {
    const hostile: Record<string, unknown> = { srcMac: 'aa:bb:cc:dd:ee:ff', nested: { deep: { deeper: 1 } }, list: [1, 2, 3], fn: () => 1 };
    for (let i = 0; i < 40; i++) hostile[`f${i}`] = i;
    const cyc: Record<string, unknown> = { a: 1 }; cyc['self'] = cyc;
    const r = buildGateAuditRecord(input({ proposed: [{ id: 'h', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 1, outputPorts: [], match: hostile as never } }, { id: 'c', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 1, outputPorts: [], match: cyc as never } }] }), 1, 0);
    expect(Object.keys(r.proposed[0]!.match).length).toBeLessThanOrEqual(16);
    expect(r.proposed[0]!.match['srcMac']).toBe('aa:bb:cc:dd:ee:ff');
    expect(r.proposed[0]!.match['nested']).toBeUndefined();
    expect(r.proposed[1]!.match).toEqual({ a: 1 }); // a cyclic object is copied without its cycle
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('keeps a null peer (a call that did not come from a request, such as the startup self-check)', () => {
    expect(buildGateAuditRecord(input({ peer: null, route: 'startup' }), 1, 0).peer).toBeNull();
  });
});

describe('GateAuditLog', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-')); file = path.join(dir, 'sub', 'audit.jsonl'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lines = (f: string): Array<Record<string, unknown>> => fs.readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('appends one parseable line per event, creates the directory, and keeps the file private', () => {
    let t = 1000;
    const log = new GateAuditLog({ file, nowMs: () => t });
    expect(log.record(input())).toBeNull();
    t = 2000;
    expect(log.record(input({ event: 'advisory', route: 'quarantine' }))).toBeNull();
    const got = lines(file);
    expect(got.map((g) => [g['event'], g['route'], g['atMs']])).toEqual([['refused', 'allow', 1000], ['advisory', 'quarantine', 2000]]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rotates once at the size limit, keeping one previous file', () => {
    const log = new GateAuditLog({ file, nowMs: () => 1, maxFileBytes: 1500, maxEventsPerMinute: 1000 });
    for (let i = 0; i < 12; i++) log.record(input({ what: `event ${i}` }));
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1500);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1']);
  });

  it('counts events beyond the per-minute limit instead of writing them, and writes the count into the next allowed line', () => {
    let t = 0;
    const log = new GateAuditLog({ file, nowMs: () => t, maxEventsPerMinute: 3 });
    for (let i = 0; i < 8; i++) log.record(input({ what: `e${i}` }));
    expect(lines(file)).toHaveLength(3);
    expect(log.totalSuppressed).toBe(5);
    t = 61_000; // a new minute
    log.record(input({ what: 'after' }));
    const last = lines(file).at(-1)!;
    expect(last['what']).toBe('after');
    expect(last['suppressedBefore']).toBe(5); // the flood is visible in the trail, not hidden by the limit
    expect(MAX_EVENTS_PER_MINUTE).toBeGreaterThan(0);
  });

  it('returns an error string and counts it when the write fails; it never throws', () => {
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    const log = new GateAuditLog({ file: path.join(dir, 'blocker', 'audit.jsonl') });
    const err = log.record(input());
    expect(err).toMatch(/could not write the gate audit trail/);
    expect(log.failedWrites).toBe(1);
  });
});

describe('resolveGateAuditFile', () => {
  it('uses the explicit variable, else STATE_DIRECTORY, else /var/lib/zodiac', () => {
    expect(resolveGateAuditFile({ ZODIAC_GATE_AUDIT_FILE: ' /x/a.jsonl ' } as NodeJS.ProcessEnv)).toBe('/x/a.jsonl');
    expect(resolveGateAuditFile({ STATE_DIRECTORY: '/s' } as NodeJS.ProcessEnv)).toBe('/s/install-gate-audit.jsonl');
    expect(resolveGateAuditFile({} as NodeJS.ProcessEnv)).toBe('/var/lib/zodiac/install-gate-audit.jsonl');
  });
});

describe('caller-refusal helpers', () => {
  it('safeHeaderText joins repeated headers, replaces control characters, and bounds the length', () => {
    expect(safeHeaderText(['1.1.1.1', '2.2.2.2'])).toBe('1.1.1.1, 2.2.2.2');
    expect(safeHeaderText('a\nb\u0000c\u007fd')).toBe('a?b?c?d');
    expect(safeHeaderText('x'.repeat(1000)).length).toBeLessThanOrEqual(201);
    expect(safeHeaderText(undefined)).toBe('');
  });

  it('gives callers their own file and a smaller budget than gate refusals', () => {
    expect(resolveCallerAuditFile({ ZODIAC_CALLER_AUDIT_FILE: ' /x/c.jsonl ' } as NodeJS.ProcessEnv)).toBe('/x/c.jsonl');
    expect(resolveCallerAuditFile({ STATE_DIRECTORY: '/s' } as NodeJS.ProcessEnv)).toBe('/s/install-gate-callers.jsonl');
    expect(resolveCallerAuditFile({} as NodeJS.ProcessEnv)).toBe('/var/lib/zodiac/install-gate-callers.jsonl');
    expect(resolveCallerAuditFile({} as NodeJS.ProcessEnv)).not.toBe(resolveGateAuditFile({} as NodeJS.ProcessEnv));
    expect(CALLER_MAX_EVENTS_PER_MINUTE).toBeLessThan(MAX_EVENTS_PER_MINUTE);
  });
});
