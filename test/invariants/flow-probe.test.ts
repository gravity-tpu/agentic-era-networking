/**
 * flow-probe.test.ts
 * Tests for the read-only flow-table probe: report building, the independent re-derivation from raw bytes, the
 * raw-capturing readback, the HTTP error mapping, and the bridge's rate limiting.
 *
 * IMPORTANT (Invariant 6): every switch reply below is a FIXTURE (see test/helpers/flow-stats-fixtures.ts). None is
 * a capture from the physical switch. The probe exists to take the first real capture; these tests prove the
 * machinery that will interpret it, not what firmware 0.86 actually reports.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import {
  analyzeFlowProbe,
  buildFlowProbeReport,
  FLOW_PROBE_ORIGIN,
  FLOW_PROBE_SCHEMA,
  FlowProbeError,
  FlowProbeRateLimitedError,
  probeErrorToHttp,
  splitFlowStatsEntries,
  type FlowProbeReport,
} from '../../src/sdn/flow-probe.js';
import { MAX_READBACK_RAW_BYTES, readFlowStats, readFlowStatsRaw } from '../../src/sdn/flow-readback.js';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { applyActions, entryFrom, otherAction, outputAction, replyOf } from '../helpers/flow-stats-fixtures.js';

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);

const faithful = (): Buffer[] => [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))];
const matchOnly = (): Buffer[] => [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm, Buffer.alloc(0)))];

const report = (replies: readonly Buffer[]): FlowProbeReport =>
  buildFlowProbeReport({
    policy,
    replies,
    capturedAtIso: '2026-10-15T00:00:00.000Z',
    capturedMonotonicNs: 123_456_789n,
    context: { note: 'fixture' },
  });

describe('probe findings', () => {
  it('a switch that reports the instructions it was sent: observable, and matches the policy', () => {
    const r = report([replyOf(faithful())]);
    expect(r.schema).toBe(FLOW_PROBE_SCHEMA);
    expect(r.origin).toBe(FLOW_PROBE_ORIGIN);
    expect(r.finding).toBe('reports-instructions');
    expect(r.entryCount).toBe(policy.length + 1);
    expect(r.readback.verified).toBe(true);
    expect(r.readback.actions.status).toBe('confirmed');
    expect(r.readback.provenForwarding).toBe(true);
    // the raw bytes of each entry are kept, exactly
    expect(r.entries[1]?.entryHex).toBe((flowMods[0] ? entryFrom(flowMods[0]) : Buffer.alloc(0)).toString('hex'));
  });

  it('a switch that omits instructions: no-instructions-reported, action level unobservable, not proven', () => {
    const r = report([replyOf(matchOnly())]);
    expect(r.finding).toBe('no-instructions-reported');
    expect(r.findingDetail).toContain('omits');
    expect(r.findingDetail).not.toMatch(/likel/i); // a mechanical statement, not an inference
    expect(r.findingDetail).toContain('must not be described as proving forwarding intent');
    expect(r.readback.verified).toBe(true);
    expect(r.readback.actions.status).toBe('unobservable');
    expect(r.readback.provenForwarding).toBe(false);
  });

  it('an empty flow table is its own finding (the policy was lost), not "no instructions"', () => {
    const r = report([replyOf([])]);
    expect(r.finding).toBe('no-entries');
    expect(r.entryCount).toBe(0);
    expect(r.readback.verified).toBe(false);
  });

  it('instruction bytes the parser cannot read are reported as unreadable, with the bytes to inspect', () => {
    const entries = faithful();
    const bad = applyActions(outputAction(2), outputAction(3));
    bad.writeUInt16BE(20, 2); // misaligned length
    entries[1] = entryFrom(flowMods[0] as Buffer, bad);
    const r = report([replyOf(entries)]);
    expect(r.finding).toBe('unreadable-instructions');
    expect(r.entries[1]?.actions.complete).toBe(false);
    expect(r.entries[1]?.entryHex.length).toBeGreaterThan(0);
  });

  it('a switch that reports instructions which differ from the policy is a mismatch, not a failed probe', () => {
    const entries = faithful();
    const idx = policy.findIndex((x) => x.id === 'p1-default-tap-only') + 1;
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(2), outputAction(3), otherAction(25)));
    const r = report([replyOf(entries)]);
    expect(r.finding).toBe('reports-instructions');
    expect(r.readback.actions.status).toBe('mismatch');
    expect(r.readback.provenForwarding).toBe(false);
  });

  it('keeps every segment of a multi-segment reply, in order, and hashes the raw bytes', () => {
    const all = faithful();
    const first = replyOf(all.slice(0, 3), true);
    const second = replyOf(all.slice(3));
    const r = report([first, second]);
    expect(r.entryCount).toBe(all.length);
    expect(r.rawRepliesHex).toEqual([first.toString('hex'), second.toString('hex')]);
    expect(r.rawRepliesSha256).toBe(createHash('sha256').update(Buffer.concat([first, second])).digest('hex'));
  });

  it('rejects a reply that is not a flow-stats reply, naming which one', () => {
    expect(() => report([replyOf(faithful()), Buffer.alloc(8)])).toThrow(FlowProbeError);
    expect(() => report([replyOf(faithful()), Buffer.alloc(8)])).toThrow(/reply 1/);
  });
});

describe('raw entry splitting', () => {
  it('returns one buffer per entry, byte for byte', () => {
    const entries = faithful();
    expect(splitFlowStatsEntries(replyOf(entries)).map((b) => b.toString('hex'))).toEqual(entries.map((b) => b.toString('hex')));
  });

  it('rejects a zero, undersized or overrunning length instead of looping or truncating', () => {
    const base = replyOf([entryFrom(tableMissMod)]);
    for (const len of [0, 8, 55, 0xffff]) {
      const bad = Buffer.from(base);
      bad.writeUInt16BE(len, 16);
      expect(() => splitFlowStatsEntries(bad), `len ${len}`).toThrow(FlowProbeError);
    }
    expect(() => splitFlowStatsEntries(Buffer.concat([base, Buffer.from([0])]))).toThrow(FlowProbeError); // 1 stray byte
  });

  it('a malformed reply never reaches the report: the report builder rejects it', () => {
    const bad = Buffer.from(replyOf([entryFrom(tableMissMod)]));
    bad.writeUInt16BE(0, 16);
    expect(() => report([bad])).toThrow(FlowProbeError);
  });
});

describe('independent re-derivation from the raw bytes', () => {
  it('a report survives a JSON round trip (no BigInt) and re-derives to the same summary', () => {
    const r = report([replyOf(faithful())]);
    const json = JSON.stringify(r); // throws on a BigInt
    const back = JSON.parse(json) as FlowProbeReport;
    expect(back).toEqual(r);
    expect(analyzeFlowProbe(back, policy).disagreements).toEqual([]);
  });

  it('flags an edited summary', () => {
    const r = JSON.parse(JSON.stringify(report([replyOf(matchOnly())]))) as FlowProbeReport;
    const edited = { ...r, finding: 'reports-instructions' as const };
    const d = analyzeFlowProbe(edited, policy).disagreements;
    expect(d.map((x) => x.field)).toContain('finding');
  });

  it('flags edited raw bytes: the summary no longer follows from them', () => {
    const r = JSON.parse(JSON.stringify(report([replyOf(faithful())]))) as FlowProbeReport;
    const hex = r.rawRepliesHex[0] ?? '';
    const tampered = (hex.slice(0, hex.length - 8) + 'ffffffff') as string; // overwrite the last 4 bytes
    const d = analyzeFlowProbe({ ...r, rawRepliesHex: [tampered] }, policy).disagreements.map((x) => x.field);
    expect(d).toContain('rawRepliesSha256');
  });

  it('refuses an unknown schema, a wrong origin, or non-hex bytes', () => {
    const r = report([replyOf(faithful())]);
    expect(() => analyzeFlowProbe({ ...r, schema: 'other/v9' as typeof r.schema }, policy)).toThrow(/schema/);
    expect(() => analyzeFlowProbe({ ...r, origin: 'simulated' as typeof r.origin }, policy)).toThrow(/origin/);
    expect(() => analyzeFlowProbe({ ...r, rawRepliesHex: ['zz'] }, policy)).toThrow(/hex/);
  });
});

describe('HTTP error mapping', () => {
  it('maps each failure to a distinct status without leaking internals', () => {
    expect(probeErrorToHttp(new FlowProbeRateLimitedError(1500, 'spaced')).status).toBe(429);
    expect(probeErrorToHttp(new FlowProbeRateLimitedError(1500, 'spaced')).body.retryAfterSeconds).toBe(2);
    expect(probeErrorToHttp(new FlowProbeRateLimitedError(1, 'spaced')).body.retryAfterSeconds).toBe(1);
    expect(probeErrorToHttp(new Error('Cannot send raw OpenFlow message: switch not in ESTABLISHED state (current: LISTENING)')).status).toBe(503);
    expect(probeErrorToHttp(new Error('OFPMP_FLOW readback timed out after 10000 ms')).status).toBe(504);
    expect(probeErrorToHttp(new FlowProbeError('reply 0 is not parseable')).status).toBe(502);
    expect(probeErrorToHttp(new Error('switch rejected OFPMP_FLOW (type 1, code 2)')).status).toBe(502);
    const unexpected = probeErrorToHttp(new Error('secret path /etc/zodiac/x failed'));
    expect(unexpected.status).toBe(500);
    expect(unexpected.body.error).not.toContain('/etc/zodiac');
  });
});

/** A fake switch session: emits the given replies for the request's xid when a request is written. */
class FakeSession extends EventEmitter {
  public sent = 0;
  constructor(private readonly replies: readonly Buffer[], private readonly xid = 42) {
    super();
  }
  public reserveXid(): number {
    return this.xid;
  }
  public sendRaw(_packet: Buffer): void {
    this.sent += 1;
    queueMicrotask(() => this.replies.forEach((r) => this.emit('multipartReply', this.xid, r)));
  }
}

describe('raw-capturing readback', () => {
  it('returns the entries and the raw reply bytes, and readFlowStats still returns the entries alone', async () => {
    const first = replyOf(faithful().slice(0, 2), true);
    const second = replyOf(faithful().slice(2));
    const raw = await readFlowStatsRaw(new FakeSession([first, second]), 1000);
    expect(raw.replies.map((b) => b.toString('hex'))).toEqual([first.toString('hex'), second.toString('hex')]);
    expect(raw.entries).toHaveLength(faithful().length);
    const entries = await readFlowStats(new FakeSession([first, second]), 1000);
    expect(entries).toHaveLength(faithful().length);
  });

  it('ignores replies for another xid', async () => {
    const s = new FakeSession([replyOf(faithful())]);
    const p = readFlowStatsRaw(s, 1000);
    s.emit('multipartReply', 999, replyOf([entryFrom(tableMissMod)]));
    expect((await p).entries).toHaveLength(faithful().length);
  });

  it('aborts when the raw bytes exceed the cap, even if no entries accumulate', async () => {
    const many = Array.from({ length: 4 }, () => replyOf([], true));
    await expect(readFlowStatsRaw(new FakeSession(many), 1000, 512, 40)).rejects.toThrow(/raw bytes/);
    expect(MAX_READBACK_RAW_BYTES).toBeGreaterThan(0);
  });

  it('times out when the switch never answers', async () => {
    await expect(readFlowStatsRaw(new FakeSession([]), 30)).rejects.toThrow(/timed out/);
  });
});

describe('bridge probeFlowTable', () => {
  const make = () => {
    const controller = new ZodiacController();
    const server = new ZodiacBridgeServer(controller);
    return { controller, server };
  };

  it('fails closed with no established switch session (sends nothing)', async () => {
    const { server } = make();
    await expect(server.probeFlowTable()).rejects.toThrow(/Cannot send raw OpenFlow message/);
  });

  it('returns a probe report from the switch session, and sends exactly one request', async () => {
    const { controller, server } = make();
    const session = new FakeSession([replyOf(faithful())]);
    const of = controller.openFlow;
    of.reserveXid = () => session.reserveXid();
    of.sendRaw = (p: Buffer) => {
      session.sendRaw(p);
      queueMicrotask(() => of.emit('multipartReply', 42, replyOf(faithful())));
    };
    const r = await server.probeFlowTable();
    expect(r.origin).toBe(FLOW_PROBE_ORIGIN);
    expect(r.finding).toBe('reports-instructions');
    expect(r.context['isolationState']).toBe('not_installed');
    expect(session.sent).toBe(1);
  });

  it('refuses a second probe straight after the first, with how long to wait', async () => {
    const { controller, server } = make();
    const of = controller.openFlow;
    of.reserveXid = () => 42;
    of.sendRaw = () => queueMicrotask(() => of.emit('multipartReply', 42, replyOf(faithful())));
    await server.probeFlowTable();
    const err = await server.probeFlowTable().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowProbeRateLimitedError);
    expect((err as FlowProbeRateLimitedError).retryAfterMs).toBeGreaterThan(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spaces probes from the END of the previous one, and allows the next once the window has passed', async () => {
    const { controller, server } = make();
    const of = controller.openFlow;
    of.reserveXid = () => 42;
    // A controllable monotonic clock: it only moves when the test moves it, so the test does not depend on how many
    // times the code reads it.
    let now = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
    of.sendRaw = () => {
      now += 10_000_000_000n; // this probe takes 10 s (up to the readback timeout)
      queueMicrotask(() => of.emit('multipartReply', 42, replyOf(faithful())));
    };
    await server.probeFlowTable();
    // 10.001 s after it STARTED, 1 ms after it ENDED: start-to-start spacing would allow this, end-to-start must not.
    now += 1_000_000n;
    await expect(server.probeFlowTable()).rejects.toBeInstanceOf(FlowProbeRateLimitedError);
    // Once the default 5 s window since the end has passed, the next probe is allowed.
    now += 6_000_000_000n;
    await expect(server.probeFlowTable()).resolves.toMatchObject({ origin: FLOW_PROBE_ORIGIN });
  });

  it('refuses a concurrent probe while one is in flight', async () => {
    const { controller, server } = make();
    const of = controller.openFlow;
    of.reserveXid = () => 42;
    let release: () => void = () => undefined;
    of.sendRaw = () => {
      release = () => of.emit('multipartReply', 42, replyOf(faithful()));
    };
    const first = server.probeFlowTable();
    await Promise.resolve();
    // The in-flight guard, not the spacing limit, must be what refuses it (the spacing limit would also trip here).
    const second = await server.probeFlowTable().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(FlowProbeRateLimitedError);
    expect((second as FlowProbeRateLimitedError).message).toContain('already running');
    release();
    await first;
  });
});
