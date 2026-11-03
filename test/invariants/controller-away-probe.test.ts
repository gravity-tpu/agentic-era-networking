/**
 * controller-away-probe.test.ts
 * The read-only controller-away probe (src/sdn/controller-away-probe.ts).
 *
 * IMPORTANT (Invariant 6): the "switch" below is a fake socket speaking OpenFlow framing, and every table is a FIXTURE built from the controller's own
 * flow-mod encoding. Nothing here is a capture from the Zodiac FX. These tests prove the probe's own behaviour (it never writes, it classifies, it is
 * bounded), not what the firmware does when its controller goes away.
 */

import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OFP_VERSION_1_3,
  OpenFlowType,
  FlowModCommand,
  buildOfpFlowMod,
  buildOfpHello,
  buildOfpEchoRequest,
  buildOfpTableMissFlowMod,
  decodeOfpHeader,
} from '../../src/sdn/openflow-types.js';
import { buildFlowStatsRequest } from '../../src/sdn/dataplane-benchmark.js';
import { OpenFlowServer } from '../../src/sdn/openflow-server.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import {
  EXIT_CODES,
  PROBE_LIMITS,
  MAX_RECORDED_SERVER_ERRORS,
  ReadOnlySwitchSession,
  assessTable,
  counterDeltas,
  parseProbeConfig,
  rawWriteViolation,
  readOnlyViolation,
  runAwayProbe,
  type ProbeConfig,
  type ProbeSummary,
} from '../../src/sdn/controller-away-probe.js';
import { closeAndExit } from '../../src/sdn/controller-away-probe-cli.js';
import { entryFrom, replyOf } from '../helpers/flow-stats-fixtures.js';

const policy = buildPort1IsolationPolicy();
const policyMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);

/** An entry buffer with a packet counter set. */
function counted(fm: Buffer, packets: bigint): Buffer {
  const e = entryFrom(fm);
  e.writeBigUInt64BE(packets, 32);
  return e;
}
const faithful = (packets = 0n): Buffer[] => [counted(tableMissMod, packets), ...policyMods.map((fm) => counted(fm, packets))];

const toBuffer = (chunk: string | Buffer): Buffer => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);

const fastConfig = (over: Partial<ProbeConfig> = {}): ProbeConfig => ({
  port: 0,
  host: '127.0.0.1',
  overallTimeoutMs: 5_000,
  reconnectWaitMs: 1_000,
  readbackTimeoutMs: 500,
  readbacks: 2,
  readbackIntervalMs: 60,
  ...over,
});

interface FakeSwitch {
  /** every OpenFlow message the probe wrote to the switch, in order */
  readonly received: Buffer[];
  readonly socket: net.Socket;
}

interface FakeSwitchOptions {
  /** entries to answer the Nth flow-stats request with; the last element repeats; undefined means never answer */
  readonly tables?: ReadonlyArray<readonly Buffer[]>;
  /** send an OFPT_PACKET_IN right after the handshake */
  readonly packetIn?: boolean;
}

function connectFakeSwitch(port: number, opts: FakeSwitchOptions): FakeSwitch {
  const received: Buffer[] = [];
  let rx = Buffer.alloc(0);
  let flowRequests = 0;
  const socket = net.connect({ port, host: '127.0.0.1' }, () => socket.write(buildOfpHello(1)));
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, toBuffer(chunk)]);
    while (rx.length >= 8) {
      const header = decodeOfpHeader(rx);
      if (rx.length < header.length) break;
      const msg = Buffer.from(rx.subarray(0, header.length));
      rx = rx.subarray(header.length);
      received.push(msg);
      if (header.type === OpenFlowType.OFPT_FEATURES_REQUEST) {
        const reply = Buffer.alloc(32);
        reply.writeUInt8(OFP_VERSION_1_3, 0);
        reply.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
        reply.writeUInt16BE(32, 2);
        reply.writeUInt32BE(header.xid, 4);
        reply.writeBigUInt64BE(0xabcdn, 8);
        reply.writeUInt32BE(128, 16);
        socket.write(reply);
        if (opts.packetIn === true) {
          const pi = Buffer.alloc(24 + 12 + 2 + 4);
          pi.writeUInt8(OFP_VERSION_1_3, 0);
          pi.writeUInt8(OpenFlowType.OFPT_PACKET_IN, 1);
          pi.writeUInt16BE(pi.length, 2);
          pi.writeUInt32BE(7, 4);
          pi.writeUInt32BE(0xffffffff, 8);
          pi.writeUInt16BE(4, 12);
          pi.writeUInt16BE(1, 24);
          pi.writeUInt16BE(8, 26);
          pi.writeUInt32BE(0x80000004, 28);
          pi.writeUInt32BE(1, 32);
          socket.write(pi);
        }
      } else if (header.type === OpenFlowType.OFPT_MULTIPART_REQUEST && opts.tables !== undefined && opts.tables.length > 0) {
        const table = opts.tables[Math.min(flowRequests, opts.tables.length - 1)] ?? [];
        flowRequests += 1;
        const reply = Buffer.from(replyOf(table));
        reply.writeUInt32BE(header.xid, 4);
        socket.write(reply);
      } else if (header.type === OpenFlowType.OFPT_ECHO_REQUEST) {
        const reply = Buffer.from(msg);
        reply.writeUInt8(OpenFlowType.OFPT_ECHO_REPLY, 1);
        socket.write(reply);
      }
    }
  });
  return { received, socket };
}

const ALLOWED_TYPES: readonly number[] = [
  OpenFlowType.OFPT_HELLO,
  OpenFlowType.OFPT_FEATURES_REQUEST,
  OpenFlowType.OFPT_ECHO_REQUEST,
  OpenFlowType.OFPT_ECHO_REPLY,
  OpenFlowType.OFPT_MULTIPART_REQUEST,
];

const isClosed = (server: OpenFlowServer): boolean => (server['server'] as net.Server | null) === null;

/** Runs the probe against a fake switch that connects as soon as the port is open. */
async function runAgainstFakeSwitch(opts: FakeSwitchOptions, cfg: ProbeConfig, rules = policy): Promise<{ summary: ProbeSummary; fake: FakeSwitch }> {
  const server = new OpenFlowServer();
  const session = new ReadOnlySwitchSession(server);
  let fake: FakeSwitch | null = null;
  const summaryP = runAwayProbe(session, cfg, rules, () => undefined);
  // runAwayProbe binds first; poll for the ephemeral port, then connect the fake switch.
  for (let i = 0; i < 200 && fake === null; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const p = (server['server'] as net.Server | null)?.address();
    if (p !== null && p !== undefined && typeof p === 'object') fake = connectFakeSwitch(p.port, opts);
  }
  if (fake === null) throw new Error('the probe never started listening');
  const summary = await summaryP;
  const sw = fake;
  sw.socket.destroy();
  return { summary, fake: sw };
}

describe('read-only gate', () => {
  const xid = 5;

  it('allows exactly the messages the probe sends', () => {
    expect(readOnlyViolation(buildOfpHello(xid))).toBeNull();
    expect(readOnlyViolation(buildFlowStatsRequest(xid))).toBeNull();
    expect(readOnlyViolation(buildOfpEchoRequest(xid))).toBeNull();
    const features = Buffer.alloc(8);
    features.writeUInt8(OFP_VERSION_1_3, 0);
    features.writeUInt8(OpenFlowType.OFPT_FEATURES_REQUEST, 1);
    features.writeUInt16BE(8, 2);
    expect(readOnlyViolation(features)).toBeNull();
  });

  it('refuses a flow-mod, a table-miss flow-mod and a delete', () => {
    const add = readOnlyViolation(policyMods[0] as Buffer);
    expect(add).toMatch(/message type 14/);
    expect(readOnlyViolation(buildOfpTableMissFlowMod(xid, 0, 'DROP'))).toMatch(/message type 14/);
    expect(readOnlyViolation(buildOfpFlowMod({ command: FlowModCommand.OFPFC_DELETE, priority: 0 }, xid))).toMatch(/message type 14/);
  });

  it('refuses every other message type by default, including ones this code does not know', () => {
    for (const type of [OpenFlowType.OFPT_GROUP_MOD, OpenFlowType.OFPT_PORT_MOD, OpenFlowType.OFPT_TABLE_MOD, OpenFlowType.OFPT_PACKET_OUT, OpenFlowType.OFPT_SET_CONFIG, OpenFlowType.OFPT_BARRIER_REQUEST, OpenFlowType.OFPT_EXPERIMENTER, 29]) {
      const b = Buffer.alloc(16);
      b.writeUInt8(OFP_VERSION_1_3, 0);
      b.writeUInt8(type, 1);
      b.writeUInt16BE(16, 2);
      expect(readOnlyViolation(b), `type ${type}`).not.toBeNull();
    }
  });

  it('refuses a multipart request that is not a flow-stats request (for example a meter or port-mod style type)', () => {
    const req = Buffer.from(buildFlowStatsRequest(xid));
    req.writeUInt16BE(9, 8); // OFPMP_METER_CONFIG-ish: any other multipart type
    expect(readOnlyViolation(req)).toMatch(/not a flow-stats request/);
  });

  it('refuses malformed frames: short, wrong version, wrong length', () => {
    expect(readOnlyViolation(Buffer.alloc(4))).toMatch(/shorter/);
    const wrongVersion = Buffer.from(buildFlowStatsRequest(xid));
    wrongVersion.writeUInt8(1, 0);
    expect(readOnlyViolation(wrongVersion)).toMatch(/not OpenFlow 1.3/);
    const wrongLength = Buffer.from(buildFlowStatsRequest(xid));
    wrongLength.writeUInt16BE(40, 2);
    expect(readOnlyViolation(wrongLength)).toMatch(/does not match/);
  });

  it('lets the readback send only a flow-stats request, not even a hello or an echo', () => {
    expect(rawWriteViolation(buildFlowStatsRequest(xid))).toBeNull();
    expect(rawWriteViolation(buildOfpHello(xid))).toMatch(/only a flow-stats request/);
    expect(rawWriteViolation(buildOfpEchoRequest(xid))).toMatch(/only a flow-stats request/);
    expect(rawWriteViolation(policyMods[0] as Buffer)).not.toBeNull();
  });
});

describe('ReadOnlySwitchSession exposes no way to write', () => {
  it('has only the read, listen, close and subscription members', () => {
    const names = Object.getOwnPropertyNames(ReadOnlySwitchSession.prototype).filter((n) => n !== 'constructor').sort();
    expect(names).toEqual(['close', 'listen', 'onDisconnected', 'onNotice', 'onReady', 'packetIns', 'readFlowStats', 'serverErrors', 'state']);
  });

  it('keeps the server out of reach: no enumerable own property on an instance holds it', () => {
    const session = new ReadOnlySwitchSession(new OpenFlowServer());
    expect(Object.keys(session)).toEqual([]);
    for (const name of ['sendFlowMod', 'deleteFlow', 'sendMirrorRule', 'sendForwardingRule', 'sendFlowModOptions', 'sendTableMissRule', 'sendRaw']) {
      expect(Reflect.get(session, name), name).toBeUndefined();
    }
  });
});

describe('source scan: neither source file names a write method', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
  const files = ['../../src/sdn/controller-away-probe.ts', '../../src/sdn/controller-away-probe-cli.ts'];
  const forbidden = ['sendFlowMod', 'deleteFlow', 'sendMirrorRule', 'sendForwardingRule', 'sendTableMissRule', 'buildOfpFlowMod', 'buildOfpTableMissFlowMod', 'pushRule', 'sendFlowModOptions'];

  it('names none of the server write methods or flow-mod builders', () => {
    for (const f of files) {
      const text = read(f);
      for (const word of forbidden) expect(text.includes(word), `${f} mentions ${word}`).toBe(false);
    }
  });

  it('calls the server sendRaw in exactly one place, behind the gate', () => {
    const text = read(files[0] as string);
    expect(text.match(/\.sendRaw\(/g)?.length).toBe(1);
    expect(text.indexOf('rawWriteViolation(packet)')).toBeLessThan(text.indexOf('server.sendRaw(packet)'));
  });
});

describe('assessTable (pure)', () => {
  const entriesOf = (bufs: readonly Buffer[]) => parseFlowStatsReply(replyOf([...bufs])).entries;

  it('zero entries is empty', () => {
    expect(assessTable([], policy).klass).toBe('empty');
  });

  it('a table holding only a table-miss entry is not empty: it differs', () => {
    const a = assessTable(entriesOf([tableMissMod].map((m) => entryFrom(m))), policy);
    expect(a.klass).toBe('differs');
    expect(a.entryCount).toBe(1);
  });

  it('the policy plus one table-miss entry equals the policy', () => {
    const a = assessTable(entriesOf(faithful()), policy);
    expect(a.klass).toBe('equals_policy');
    expect(a.confirmed).toBe(policy.length);
    expect(a.extraEntries).toBe(0);
  });

  it('a missing rule, an extra entry and a duplicate each differ', () => {
    expect(assessTable(entriesOf(faithful().slice(1)), policy).klass).toBe('differs'); // table-miss gone
    expect(assessTable(entriesOf(faithful().slice(0, -1)), policy).klass).toBe('differs'); // last rule gone
    const extra = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 400, match: { etherType: 0x0800, srcIp: '10.0.2.101', srcIpPrefixLen: 32 } }, 77);
    const withExtra = assessTable(entriesOf([...faithful(), entryFrom(extra)]), policy);
    expect(withExtra.klass).toBe('differs');
    expect(withExtra.extraEntries).toBe(1);
    expect(assessTable(entriesOf([...faithful(), entryFrom(policyMods[0] as Buffer)]), policy).klass).toBe('differs');
  });

  it('counterDeltas reports per-entry change and entries that appeared or vanished', () => {
    const first = entriesOf(faithful(10n));
    const later = entriesOf(faithful(25n).slice(0, -1));
    const c = counterDeltas(first, later);
    expect(c.deltas.every((d) => d.packets === '15')).toBe(true);
    expect(c.vanished).toHaveLength(1);
    expect(c.appeared).toHaveLength(0);
  });
});

describe('parseProbeConfig', () => {
  it('defaults are inside their own bounds and the overall limit covers the wait plus a readback', () => {
    const c = parseProbeConfig([]);
    expect(c.port).toBe(6633);
    expect(c.overallTimeoutMs).toBe(120_000);
    for (const l of Object.values(PROBE_LIMITS)) expect(l.dflt >= l.min && l.dflt <= l.max).toBe(true);
    expect(c.overallTimeoutMs).toBeGreaterThanOrEqual(c.reconnectWaitMs + c.readbackTimeoutMs);
  });

  it('accepts values inside the bounds', () => {
    const c = parseProbeConfig(['--overall-ms', '65000', '--reconnect-wait-ms', '35000', '--readback-timeout-ms', '8000', '--readbacks', '2', '--interval-ms', '20000', '--host', '10.0.0.5']);
    expect(c).toMatchObject({ overallTimeoutMs: 65_000, reconnectWaitMs: 35_000, readbackTimeoutMs: 8_000, readbacks: 2, readbackIntervalMs: 20_000, host: '10.0.0.5' });
  });

  it('refuses values outside the bounds, junk, unknown flags and an overall limit that cannot cover the wait', () => {
    expect(() => parseProbeConfig(['--overall-ms', '150001'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--overall-ms', '9999'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--readbacks', '7'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--readbacks', '0'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--interval-ms', '1000'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--port', '0'])).toThrow(/between/);
    expect(() => parseProbeConfig(['--readbacks', 'three'])).toThrow(/integer/);
    expect(() => parseProbeConfig(['--readbacks'])).toThrow(/integer/);
    expect(() => parseProbeConfig(['--write'])).toThrow(/unknown argument/);
    expect(() => parseProbeConfig(['--overall-ms', '20000', '--reconnect-wait-ms', '60000'])).toThrow(/must cover/);
  });
});

describe('runAwayProbe against a fake switch socket', () => {
  it('table equals the policy: exit 0, two readbacks, and only hello / features / echo / flow-stats request bytes ever leave the probe', async () => {
    const { summary, fake } = await runAgainstFakeSwitch({ tables: [faithful(100n), faithful(160n)] }, fastConfig());
    expect(summary.outcome).toBe('equals_policy');
    expect(summary.exitCode).toBe(EXIT_CODES.equals_policy);
    expect(summary.reads).toHaveLength(2);
    expect(summary.reads[0]?.entries).toHaveLength(policy.length + 1);
    expect(summary.tableChangedDuringSession).toBe(false);
    expect(summary.counterDeltas.every((d) => d.packets === '60')).toBe(true);

    expect(fake.received.length).toBeGreaterThan(0);
    for (const m of fake.received) {
      expect(ALLOWED_TYPES, `type ${m.readUInt8(1)} left the probe`).toContain(m.readUInt8(1));
      expect(readOnlyViolation(m)).toBeNull();
    }
    const types = fake.received.map((m) => m.readUInt8(1));
    expect(types).not.toContain(OpenFlowType.OFPT_FLOW_MOD);
    expect(types).not.toContain(OpenFlowType.OFPT_PACKET_OUT);
    expect(types.filter((t) => t === OpenFlowType.OFPT_MULTIPART_REQUEST)).toHaveLength(2);
    for (const m of fake.received.filter((x) => x.readUInt8(1) === OpenFlowType.OFPT_MULTIPART_REQUEST)) expect(m.readUInt16BE(8)).toBe(1);
  });

  it('an empty table: exit 3', async () => {
    const { summary, fake } = await runAgainstFakeSwitch({ tables: [[]] }, fastConfig({ readbacks: 1 }));
    expect(summary.outcome).toBe('empty');
    expect(summary.exitCode).toBe(3);
    expect(summary.reads[0]?.assessment?.entryCount).toBe(0);
    for (const m of fake.received) expect(readOnlyViolation(m)).toBeNull();
  });

  it('a table that is not the policy: exit 2, with the entries listed', async () => {
    const { summary } = await runAgainstFakeSwitch({ tables: [faithful().slice(0, 3)] }, fastConfig({ readbacks: 1 }));
    expect(summary.outcome).toBe('differs');
    expect(summary.exitCode).toBe(2);
    expect(summary.reads[0]?.entries).toHaveLength(3);
    expect(summary.reads[0]?.assessment?.mismatches.length).toBeGreaterThan(0);
  });

  it('the first readback decides the outcome, and a table that changes during the session is flagged', async () => {
    const { summary } = await runAgainstFakeSwitch({ tables: [faithful(), []] }, fastConfig());
    expect(summary.outcome).toBe('equals_policy');
    expect(summary.tableChangedDuringSession).toBe(true);
    expect(summary.notes.some((n) => n.includes('vanished'))).toBe(true);
    expect(summary.reads[1]?.assessment?.klass).toBe('empty');
  });

  it('a switch that never answers the flow-stats request: readback_failed, exit 5, bounded by the readback timeout', async () => {
    const t0 = process.hrtime.bigint();
    const { summary } = await runAgainstFakeSwitch({}, fastConfig({ readbacks: 1, readbackTimeoutMs: 150 }));
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    expect(summary.outcome).toBe('readback_failed');
    expect(summary.exitCode).toBe(5);
    expect(summary.reads[0]?.error).toMatch(/timed out/);
    expect(ms).toBeLessThan(2_000);
  });

  it('counts a packet-in from the switch and never answers it', async () => {
    const { summary, fake } = await runAgainstFakeSwitch({ tables: [[]], packetIn: true }, fastConfig({ readbacks: 1 }));
    expect(summary.packetIns).toBe('1');
    expect(fake.received.map((m) => m.readUInt8(1))).not.toContain(OpenFlowType.OFPT_PACKET_OUT);
  });

  it('no switch connects: never_reconnected, exit 4, within the bounded wait, and the port is released', async () => {
    const server = new OpenFlowServer();
    const t0 = process.hrtime.bigint();
    const summary = await runAwayProbe(new ReadOnlySwitchSession(server), fastConfig({ reconnectWaitMs: 150 }), policy, () => undefined);
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    expect(summary.outcome).toBe('never_reconnected');
    expect(summary.exitCode).toBe(4);
    expect(summary.reads).toHaveLength(0);
    expect(ms).toBeLessThan(1_500);
    expect(isClosed(server)).toBe(true); // the listener was released
  });

  it('the port is already taken (the bridge is up): bind_failed, exit 7, nothing sent', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as net.AddressInfo).port;
    try {
      const summary = await runAwayProbe(new ReadOnlySwitchSession(new OpenFlowServer()), fastConfig({ port: taken }), policy, () => undefined);
      expect(summary.outcome).toBe('bind_failed');
      expect(summary.exitCode).toBe(7);
      expect(summary.notes.join(' ')).toMatch(/EADDRINUSE|in use/);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('the overall limit stops later readbacks from being attempted', async () => {
    const { summary } = await runAgainstFakeSwitch({ tables: [faithful()] }, fastConfig({ overallTimeoutMs: 1_500, reconnectWaitMs: 500, readbackTimeoutMs: 500, readbacks: 3, readbackIntervalMs: 5_000 }));
    expect(summary.outcome).toBe('equals_policy');
    expect(summary.reads).toHaveLength(1);
    expect(summary.notes.some((n) => n.includes('not attempted'))).toBe(true);
  });
});

describe('server errors are recorded, never swallowed (Invariant 1)', () => {
  it('delivers an error emitted before onNotice attaches, and counts it', () => {
    const server = new OpenFlowServer();
    const session = new ReadOnlySwitchSession(server);
    server.emit('error', new Error('early failure'));
    server.emit('clientError', new Error('early socket'), '10.0.0.9:1234');
    const seen: string[] = [];
    session.onNotice((t) => seen.push(t));
    expect(seen).toEqual(['server error: early failure', 'socket error from 10.0.0.9:1234: early socket']);
    server.emit('error', new Error('late failure'));
    expect(seen).toContain('server error: late failure'); // live after attach, not duplicated
    expect(seen.filter((t) => t.includes('late failure'))).toHaveLength(1);
    expect(session.serverErrors().count).toBe(3n);
  });

  it('keeps only the most recent errors but counts all of them', () => {
    const server = new OpenFlowServer();
    const session = new ReadOnlySwitchSession(server);
    const total = MAX_RECORDED_SERVER_ERRORS + 7;
    for (let i = 0; i < total; i++) server.emit('error', new Error(`e${i}`));
    const { count, recent } = session.serverErrors();
    expect(count).toBe(BigInt(total));
    expect(recent).toHaveLength(MAX_RECORDED_SERVER_ERRORS);
    expect(recent[recent.length - 1]).toBe(`server error: e${total - 1}`);
    expect(recent[0]).toBe('server error: e7');
  });

  it('reports the count and the recent errors in the result', async () => {
    const server = new OpenFlowServer();
    const session = new ReadOnlySwitchSession(server);
    server.emit('error', new Error('before the run'));
    const summary = await runAwayProbe(session, fastConfig({ reconnectWaitMs: 100 }), policy, () => undefined);
    expect(summary.serverErrorCount).toBe('1');
    expect(summary.recentServerErrors).toEqual(['server error: before the run']);
  });
});

describe('closeAndExit (CLI stop path)', () => {
  it('exits with the intended code after a clean close', async () => {
    const exits: number[] = [];
    await closeAndExit({ close: () => Promise.resolve() }, 143, (c) => exits.push(c), () => undefined);
    expect(exits).toEqual([143]);
  });

  it('logs a rejected close and still exits with the intended code', async () => {
    const exits: number[] = [];
    const errors: string[] = [];
    await closeAndExit({ close: () => Promise.reject(new Error('close blew up')) }, 6, (c) => exits.push(c), (m) => errors.push(m));
    expect(exits).toEqual([6]);
    expect(errors.join(' ')).toMatch(/close blew up/);
  });
});

describe('orchestrator judging helpers (offline)', () => {
  it('passes its own selftest: integer permille ratios, the zero/partial/resumed thresholds, and a line far inside the dropped part of the buffer still seen', () => {
    const script = fileURLToPath(new URL('../../scripts/controller-away-run.py', import.meta.url));
    const out = execFileSync('python3', ['-I', script, '--selftest'], { encoding: 'utf-8', timeout: 20_000 });
    expect(out).toContain('selftest ok');
  });

  it('has no float division on packet counters and no float seconds for waits', () => {
    const text = readFileSync(fileURLToPath(new URL('../../scripts/controller-away-run.py', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/total \/ r\['sent'\]/);
    expect(text).not.toMatch(/time\.monotonic\(\)/);
  });
});

describe('the orchestrator does not match its own ssh shell when it looks for a probe', () => {
  it('uses a bracketed pattern for pgrep and pkill, so an idle Jetson reads as no probe running', () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/controller-away-run.py'), 'utf-8');
    expect(src).not.toMatch(/pgrep -f controller-away-probe-cli/);
    expect(src).not.toMatch(/pkill -f controller-away-probe-cli/);
    expect(src).toContain('[c]ontroller-away-probe-cli');
  });
});
