/**
 * controller-away-probe.ts
 * A READ-ONLY OpenFlow controller for one question: what is in the Zodiac FX's flow table when the real controller (the bridge) has been away?
 *
 * Why it exists: on 2026-11-02 the tap path delivered 0 of 48,000 frames while the bridge was stopped (docs/benchmarks/results/controller-outage-2026-11-01).
 * Either the switch cleared its table when the session ended, or it kept the table and stopped forwarding without a controller. The bridge cannot say which:
 * it cannot read the table while it is down, and on return it rewrites the table before reading it back. This probe listens on the bridge's port while the
 * bridge is stopped, lets the switch reconnect, completes the handshake, reads the table (OFPMP_FLOW) a bounded number of times and exits.
 *
 * What read-only means here, and how it is enforced (Invariant 4 says a check must be able to fail, so each layer below has a test that makes it fail):
 *   1. ReadOnlySwitchSession wraps the OpenFlowServer in a hard-private field and exposes only listen, close, read-flow-stats and event subscriptions. None of
 *      the server's write methods is reachable through it.
 *   2. The one raw-write path the readback needs (sendRaw) goes through readOnlyViolation, which accepts a flow-stats request and nothing else.
 *   3. The test drives the real server against a fake switch socket and asserts every byte that leaves the probe is a hello, features request, echo or
 *      flow-stats request, and a source scan asserts this file and its CLI do not name any write method.
 * What this does NOT prove: that the switch itself is unchanged by a controller connecting to it. A controller session is a state change on the switch's side
 * (it may start punting packets, restart a timer, or begin forwarding). The probe observes; the pre-registration says what each observation would mean.
 *
 * Pure parts (config parsing, table assessment, formatting, outcome) are separate from the I/O in runAwayProbe and ReadOnlySwitchSession.
 * Invariant 2: counters are BigInt; durations use process.hrtime.bigint(). Invariant 5: every limit is named, configurable and bounded.
 */

import { OpenFlowServer } from './openflow-server.js';
import type { SwitchState } from './openflow-server.js';
import { OFP_VERSION_1_3, OpenFlowType } from './openflow-types.js';
import { readFlowStats } from './flow-readback.js';
import type { FlowStatsSource } from './flow-readback.js';
import type { FlowStatsEntry } from './dataplane-benchmark.js';
import { portLabel } from './flow-actions.js';
import { verifyIsolationReadback } from './port1-isolation.js';
import type { IsolationReadbackVerdict, IsolationRule } from './port1-isolation.js';

// ---------------------------------------------------------------------------------------------------------------------
// Limits (Invariant 5). Each has a default, a minimum and a maximum; a value outside is refused, not clamped.
// ---------------------------------------------------------------------------------------------------------------------

export interface Limit {
  readonly flag: string;
  readonly min: number;
  readonly max: number;
  readonly dflt: number;
}

export const PROBE_LIMITS = {
  /** Hard bound on the whole run. The maximum keeps the bridge outage under the isolation watcher's 3 polls of 60 s. */
  overallTimeoutMs: { flag: '--overall-ms', min: 10_000, max: 150_000, dflt: 120_000 },
  /** How long to wait for the switch to connect and complete the handshake after the port is bound. */
  reconnectWaitMs: { flag: '--reconnect-wait-ms', min: 5_000, max: 100_000, dflt: 60_000 },
  /** Deadline for one OFPMP_FLOW readback (the bridge uses 10 s). */
  readbackTimeoutMs: { flag: '--readback-timeout-ms', min: 1_000, max: 30_000, dflt: 10_000 },
  /** Number of readbacks, failed ones included. */
  readbacks: { flag: '--readbacks', min: 1, max: 6, dflt: 3 },
  /** Spacing from the start of one readback to the start of the next (the bridge's on-demand probe is limited to 5 s). */
  readbackIntervalMs: { flag: '--interval-ms', min: 5_000, max: 60_000, dflt: 10_000 },
  port: { flag: '--port', min: 1, max: 65_535, dflt: 6633 },
} as const satisfies Record<string, Limit>;

/** How many of the most recent server and socket errors are kept (and replayed to a late subscriber). Older ones are counted, not kept. */
export const MAX_RECORDED_SERVER_ERRORS = 20;

export const DEFAULT_PROBE_HOST = '0.0.0.0';

export interface ProbeConfig {
  readonly port: number;
  readonly host: string;
  readonly overallTimeoutMs: number;
  readonly reconnectWaitMs: number;
  readonly readbackTimeoutMs: number;
  readonly readbacks: number;
  readonly readbackIntervalMs: number;
}

const defaultConfig = (): ProbeConfig => ({
  port: PROBE_LIMITS.port.dflt,
  host: DEFAULT_PROBE_HOST,
  overallTimeoutMs: PROBE_LIMITS.overallTimeoutMs.dflt,
  reconnectWaitMs: PROBE_LIMITS.reconnectWaitMs.dflt,
  readbackTimeoutMs: PROBE_LIMITS.readbackTimeoutMs.dflt,
  readbacks: PROBE_LIMITS.readbacks.dflt,
  readbackIntervalMs: PROBE_LIMITS.readbackIntervalMs.dflt,
});

function boundedInt(limit: Limit, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${limit.flag} needs a non-negative integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < limit.min || n > limit.max) {
    throw new Error(`${limit.flag} must be between ${limit.min} and ${limit.max}, got ${raw}`);
  }
  return n;
}

/** Parses the CLI flags. Unknown flags, missing values and out-of-bound values throw (fail closed); nothing is guessed. */
export function parseProbeConfig(argv: readonly string[]): ProbeConfig {
  let cfg = defaultConfig();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--port': cfg = { ...cfg, port: boundedInt(PROBE_LIMITS.port, value) }; break;
      case '--host':
        if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--host needs an address');
        cfg = { ...cfg, host: value };
        break;
      case '--overall-ms': cfg = { ...cfg, overallTimeoutMs: boundedInt(PROBE_LIMITS.overallTimeoutMs, value) }; break;
      case '--reconnect-wait-ms': cfg = { ...cfg, reconnectWaitMs: boundedInt(PROBE_LIMITS.reconnectWaitMs, value) }; break;
      case '--readback-timeout-ms': cfg = { ...cfg, readbackTimeoutMs: boundedInt(PROBE_LIMITS.readbackTimeoutMs, value) }; break;
      case '--readbacks': cfg = { ...cfg, readbacks: boundedInt(PROBE_LIMITS.readbacks, value) }; break;
      case '--interval-ms': cfg = { ...cfg, readbackIntervalMs: boundedInt(PROBE_LIMITS.readbackIntervalMs, value) }; break;
      default: throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (cfg.overallTimeoutMs < cfg.reconnectWaitMs + cfg.readbackTimeoutMs) {
    throw new Error(`--overall-ms (${cfg.overallTimeoutMs}) must cover the reconnect wait plus one readback (${cfg.reconnectWaitMs} + ${cfg.readbackTimeoutMs})`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------------------
// The read-only gate
// ---------------------------------------------------------------------------------------------------------------------

const OFPMP_FLOW = 1;
const OFP_HEADER_LEN = 8;
const MULTIPART_HEADER_LEN = 16;

/**
 * Returns why a message may not leave the probe, or null when it may. The allowlist is the whole set of messages this probe sends: hello, features
 * request, echo request and reply, and a flow-stats multipart request. Everything else (flow-mod, group-mod, meter, table-mod, port-mod, packet-out,
 * set-config, barrier, any other multipart type) is refused by default, so a message type added to the protocol later is refused too.
 */
export function readOnlyViolation(packet: Buffer): string | null {
  if (packet.length < OFP_HEADER_LEN) return `${packet.length} bytes is shorter than an OpenFlow header`;
  if (packet.readUInt8(0) !== OFP_VERSION_1_3) return `version 0x${packet.readUInt8(0).toString(16)} is not OpenFlow 1.3`;
  if (packet.readUInt16BE(2) !== packet.length) return `header length ${packet.readUInt16BE(2)} does not match the ${packet.length} bytes given`;
  const type = packet.readUInt8(1);
  switch (type) {
    case OpenFlowType.OFPT_HELLO:
    case OpenFlowType.OFPT_FEATURES_REQUEST:
    case OpenFlowType.OFPT_ECHO_REQUEST:
    case OpenFlowType.OFPT_ECHO_REPLY:
      return null;
    case OpenFlowType.OFPT_MULTIPART_REQUEST:
      if (packet.length < MULTIPART_HEADER_LEN) return 'multipart request is shorter than its header';
      return packet.readUInt16BE(8) === OFPMP_FLOW ? null : `multipart type ${packet.readUInt16BE(8)} is not a flow-stats request`;
    default:
      return `message type ${type} can change the switch and is not on the read-only list`;
  }
}

/** The raw-write gate: of the read-only list, only a flow-stats request may be handed to the readback's sendRaw. */
export function rawWriteViolation(packet: Buffer): string | null {
  const v = readOnlyViolation(packet);
  if (v !== null) return v;
  return packet.readUInt8(1) === OpenFlowType.OFPT_MULTIPART_REQUEST ? null : 'the readback may send only a flow-stats request';
}

// ---------------------------------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------------------------------

/** What runAwayProbe needs from a switch session. */
export interface ProbeSession {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  onReady(cb: () => void): void;
  onDisconnected(cb: () => void): void;
  onNotice(cb: (text: string) => void): void;
  readFlowStats(timeoutMs: number): Promise<FlowStatsEntry[]>;
  /** OFPT_PACKET_IN messages the switch has sent this process (all of them, including any the server's own rate limit dropped). The probe never answers one. */
  packetIns(): bigint;
  /** Server and socket errors seen so far: the total, and the most recent ones (at most MAX_RECORDED_SERVER_ERRORS). */
  serverErrors(): { readonly count: bigint; readonly recent: readonly string[] };
}

/** Read-only view of an OpenFlowServer. See the file comment for what is and is not enforced. */
export class ReadOnlySwitchSession implements ProbeSession {
  readonly #server: OpenFlowServer;
  readonly #source: FlowStatsSource;

  constructor(server: OpenFlowServer = new OpenFlowServer()) {
    this.#server = server;
    // An EventEmitter with no 'error' listener throws on emit. These listeners record every error (bounded buffer, total counted), replay the buffer to
    // a subscriber that attaches later, and deliver live ones to it; the result reports the count. Nothing is dropped silently.
    server.on('error', (e: Error) => this.#recordError(`server error: ${e.message}`));
    server.on('clientError', (e: Error, addr: string) => this.#recordError(`socket error from ${addr}: ${e.message}`));
    // Handed only to readFlowStats, below. sendRaw is the one write path the readback uses, and it is gated.
    this.#source = {
      reserveXid: () => server.reserveXid(),
      sendRaw: (packet: Buffer): void => {
        const why = rawWriteViolation(packet);
        if (why !== null) throw new Error(`read-only probe refused to send: ${why}`);
        server.sendRaw(packet);
      },
      on: (event, listener) => server.on(event, listener),
      off: (event, listener) => server.off(event, listener),
    };
  }

  #errors: string[] = [];
  #errorCount = 0n;
  readonly #noticeCallbacks: Array<(text: string) => void> = [];

  #recordError(text: string): void {
    this.#errorCount += 1n;
    this.#errors.push(text);
    if (this.#errors.length > MAX_RECORDED_SERVER_ERRORS) this.#errors = this.#errors.slice(-MAX_RECORDED_SERVER_ERRORS);
    for (const cb of this.#noticeCallbacks) cb(text);
  }

  serverErrors(): { readonly count: bigint; readonly recent: readonly string[] } { return { count: this.#errorCount, recent: [...this.#errors] }; }

  listen(port: number, host: string): Promise<void> { return this.#server.listen(port, host); }
  close(): Promise<void> { return this.#server.close(); }
  state(): SwitchState { return this.#server.metrics.state; }
  packetIns(): bigint { return this.#server.totalPacketIns; }
  onReady(cb: () => void): void { this.#server.on('ready', () => cb()); }
  onDisconnected(cb: () => void): void { this.#server.on('disconnected', () => cb()); }
  readFlowStats(timeoutMs: number): Promise<FlowStatsEntry[]> { return readFlowStats(this.#source, timeoutMs); }

  onNotice(cb: (text: string) => void): void {
    const s = this.#server;
    s.on('connected', (addr: string) => cb(`switch TCP connection from ${addr}`));
    s.on('ready', (f) => cb(`handshake complete, datapath ${f.datapathId.toString(16)}`));
    s.on('disconnected', (addr: string) => cb(`switch session ended (${addr})`));
    s.on('handshakeTimeout', (addr: string) => cb(`handshake timed out (${addr})`));
    s.on('deadPeerTimeout', (addr: string) => cb(`switch stopped answering (${addr})`));
    s.on('connectionRejected', (addr: string, why: string) => cb(`connection from ${addr} rejected: ${why}`));
    for (const text of this.#errors) cb(text); // errors that happened before this subscriber attached
    this.#noticeCallbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure: describing and assessing the table
// ---------------------------------------------------------------------------------------------------------------------

export interface EntryView {
  readonly priority: number;
  readonly match: string;
  /** Output ports the entry reports, as labels; empty for none. */
  readonly outputs: readonly string[];
  readonly instructions: string;
  readonly packets: string;
  readonly bytes: string;
}

const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;
const withMask = (v: string | undefined, mask: string | undefined): string | null => (v === undefined ? null : mask === undefined ? v : `${v}/${mask}`);

export function describeMatch(e: FlowStatsEntry): string {
  const parts: string[] = [];
  if (e.inPort !== undefined) parts.push(`in_port=${e.inPort}`);
  if (e.ethType !== undefined) parts.push(`eth_type=${hex(e.ethType)}`);
  const pairs: ReadonlyArray<readonly [string, string | null]> = [
    ['ipv4_src', withMask(e.srcIp, e.srcMask)],
    ['ipv4_dst', withMask(e.dstIp, e.dstMask)],
    ['arp_spa', withMask(e.arpSpa, e.arpSpaMask)],
    ['arp_tpa', withMask(e.arpTpa, e.arpTpaMask)],
  ];
  for (const [k, v] of pairs) if (v !== null) parts.push(`${k}=${v}`);
  return parts.length === 0 ? 'any' : parts.join(' ');
}

export function describeInstructions(e: FlowStatsEntry): string {
  const a = e.actions;
  if (a === undefined) return 'not reported';
  if (!a.complete) return 'unparsed (instruction block incomplete)';
  if (!a.hasInstructions) return 'none (drop)';
  const parts = [`apply-actions output [${a.outputPorts.map(portLabel).join(', ')}]`];
  if (a.otherActionTypes.length > 0) parts.push(`other action types [${a.otherActionTypes.join(', ')}]`);
  if (a.otherInstructionTypes.length > 0) parts.push(`other instruction types [${a.otherInstructionTypes.join(', ')}]`);
  return parts.join('; ');
}

export function viewEntry(e: FlowStatsEntry): EntryView {
  return {
    priority: e.priority,
    match: describeMatch(e),
    outputs: (e.actions?.outputPorts ?? []).map(portLabel),
    instructions: describeInstructions(e),
    packets: e.packetCount.toString(),
    bytes: e.byteCount.toString(),
  };
}

/** Identity of an entry without its counters: what a table "is", as opposed to how much traffic it has seen. */
export const entryKey = (e: FlowStatsEntry): string => `prio ${e.priority} | ${describeMatch(e)} | ${describeInstructions(e)}`;

export type TableClass = 'empty' | 'equals_policy' | 'differs';

export interface TableAssessment {
  readonly klass: TableClass;
  readonly entryCount: number;
  /** Entries beyond the policy rules and one table-miss entry. */
  readonly extraEntries: number;
  readonly policyRuleCount: number;
  readonly confirmed: number;
  readonly mismatches: readonly string[];
  readonly actionStatus: IsolationReadbackVerdict['actions']['status'];
  readonly tableMiss: IsolationReadbackVerdict['actions']['tableMiss'];
  /**
   * What `equals_policy` proves: every policy rule is present once with the same priority and match fields, there is one priority-0 wildcard entry, and
   * nothing else is in the table. It says nothing about forwarding unless actionStatus is `confirmed`, and nothing about counters.
   */
  readonly note: string;
}

/**
 * Compares a readback with the isolation policy the bridge would install. `empty` is zero entries (a table that holds only a table-miss entry is not
 * empty). `equals_policy` needs a verified match set, exactly policy+1 entries, and no action-level mismatch.
 */
export function assessTable(entries: readonly FlowStatsEntry[], policy: readonly IsolationRule[]): TableAssessment {
  const verdict = verifyIsolationReadback(policy, entries);
  const extra = Math.max(0, entries.length - policy.length - 1);
  const base = {
    entryCount: entries.length,
    extraEntries: extra,
    policyRuleCount: policy.length,
    confirmed: verdict.confirmed.length,
    mismatches: verdict.mismatches,
    actionStatus: verdict.actions.status,
    tableMiss: verdict.actions.tableMiss,
  };
  if (entries.length === 0) return { ...base, klass: 'empty', note: 'the switch reported no flow entries' };
  const same = verdict.verified && extra === 0 && entries.length === policy.length + 1 && verdict.actions.status !== 'mismatch';
  return {
    ...base,
    klass: same ? 'equals_policy' : 'differs',
    note: same
      ? `the table has the ${policy.length} policy rules and one table-miss entry and nothing else; actions are ${verdict.actions.status}`
      : 'the table is not the policy: see mismatches, extraEntries and actionStatus',
  };
}

export interface CounterDelta {
  readonly entry: string;
  /** later minus first, as a decimal string; negative means the counter went down (the entry was rewritten) */
  readonly packets: string;
  readonly bytes: string;
}

/** Per-entry counter change between two readbacks of the same session, for entries present in both. Entries in only one are listed in the notes. */
export function counterDeltas(first: readonly FlowStatsEntry[], later: readonly FlowStatsEntry[]): { deltas: CounterDelta[]; appeared: string[]; vanished: string[] } {
  const a = new Map(first.map((e) => [entryKey(e), e]));
  const b = new Map(later.map((e) => [entryKey(e), e]));
  const deltas: CounterDelta[] = [];
  for (const [k, e] of b) {
    const f = a.get(k);
    if (f !== undefined) deltas.push({ entry: k, packets: (e.packetCount - f.packetCount).toString(), bytes: (e.byteCount - f.byteCount).toString() });
  }
  return {
    deltas,
    appeared: [...b.keys()].filter((k) => !a.has(k)),
    vanished: [...a.keys()].filter((k) => !b.has(k)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------------------------------

export type ProbeOutcome = 'equals_policy' | 'differs' | 'empty' | 'never_reconnected' | 'readback_failed' | 'overall_timeout' | 'bind_failed';

/** One exit code per outcome. 1 is left to fatal errors (bad arguments, an uncaught exception). */
export const EXIT_CODES: Readonly<Record<ProbeOutcome, number>> = {
  equals_policy: 0,
  differs: 2,
  empty: 3,
  never_reconnected: 4,
  readback_failed: 5,
  overall_timeout: 6,
  bind_failed: 7,
};

export const OUTCOME_MESSAGES: Readonly<Record<ProbeOutcome, string>> = {
  equals_policy: 'The switch still held exactly the isolation policy and a table-miss entry after the controller was away.',
  differs: 'The switch held a table that is NOT the isolation policy: it kept some entries, lost some, or has extra ones.',
  empty: 'The switch held NO flow entries after the controller was away.',
  never_reconnected: 'The switch did not connect and complete the OpenFlow handshake within the bounded wait; nothing was read.',
  readback_failed: 'The switch connected, but no flow-table readback succeeded (timeout, error reply or parse failure).',
  overall_timeout: 'The overall time limit ended the run before a readback succeeded.',
  bind_failed: 'The probe could not listen on the OpenFlow port; another controller (the bridge, if it is up) probably holds it. Nothing was sent.',
};

export interface ReadRecord {
  readonly index: number;
  /** milliseconds since the probe started (monotonic) */
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly entries?: readonly EntryView[];
  readonly assessment?: TableAssessment;
}

export interface ProbeSummary {
  readonly outcome: ProbeOutcome;
  readonly exitCode: number;
  readonly message: string;
  readonly connectedAtMs: number | null;
  /** number of completed handshakes seen; more than 1 means the switch reconnected during the run */
  readonly handshakes: number;
  readonly packetIns: string;
  /** server and socket errors seen (decimal string of a BigInt), and the most recent ones */
  readonly serverErrorCount: string;
  readonly recentServerErrors: readonly string[];
  readonly reads: readonly ReadRecord[];
  /** the first successful read decides the outcome; this says whether a later one differed in the entries (counters ignored) */
  readonly tableChangedDuringSession: boolean;
  readonly counterDeltas: readonly CounterDelta[];
  readonly notes: readonly string[];
  readonly elapsedMs: number;
  readonly sentToSwitch: 'hello, features request, echo, flow-stats request only (enforced; see file comment)';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Resolves true if `p` settles before `ms`, false if the time runs out first. The timer is always cleared. */
async function within(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runAwayProbe(
  session: ProbeSession,
  cfg: ProbeConfig,
  policy: readonly IsolationRule[],
  log: (line: string) => void,
): Promise<ProbeSummary> {
  const t0 = process.hrtime.bigint();
  // Integer milliseconds: a BigInt nanosecond difference divided as BigInt, then converted. No float arithmetic on durations or counters in this file.
  const elapsedMs = (): number => Number((process.hrtime.bigint() - t0) / 1_000_000n);
  const remainingMs = (): number => cfg.overallTimeoutMs - elapsedMs();
  const notes: string[] = [];
  const reads: ReadRecord[] = [];
  const rawEntries: FlowStatsEntry[][] = [];
  let handshakes = 0;
  let connectedAtMs: number | null = null;
  let sessionUp = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  session.onNotice((t) => log(`notice: ${t}`));
  session.onReady(() => {
    handshakes += 1;
    sessionUp = true;
    if (connectedAtMs === null) connectedAtMs = elapsedMs();
    resolveReady();
  });
  session.onDisconnected(() => { sessionUp = false; });

  const finish = async (outcome: ProbeOutcome): Promise<ProbeSummary> => {
    await session.close();
    const firstOk = reads.findIndex((r) => r.ok);
    let tableChanged = false;
    let deltas: readonly CounterDelta[] = [];
    if (firstOk >= 0) {
      const first = rawEntries[firstOk] ?? [];
      const lastIdx = reads.map((r) => r.ok).lastIndexOf(true);
      const last = rawEntries[lastIdx] ?? [];
      if (lastIdx > firstOk) {
        const c = counterDeltas(first, last);
        deltas = c.deltas;
        tableChanged = c.appeared.length > 0 || c.vanished.length > 0;
        for (const k of c.appeared) notes.push(`entry appeared between the first and last readback: ${k}`);
        for (const k of c.vanished) notes.push(`entry vanished between the first and last readback: ${k}`);
      }
    }
    if (handshakes > 1) notes.push(`the switch completed ${handshakes} handshakes during the run (it reconnected)`);
    return {
      outcome,
      exitCode: EXIT_CODES[outcome],
      message: OUTCOME_MESSAGES[outcome],
      connectedAtMs,
      handshakes,
      packetIns: session.packetIns().toString(),
      serverErrorCount: session.serverErrors().count.toString(),
      recentServerErrors: session.serverErrors().recent,
      reads,
      tableChangedDuringSession: tableChanged,
      counterDeltas: deltas,
      notes,
      elapsedMs: elapsedMs(),
      sentToSwitch: 'hello, features request, echo, flow-stats request only (enforced; see file comment)',
    };
  };

  try {
    await session.listen(cfg.port, cfg.host);
  } catch (e: unknown) {
    notes.push(`listen on ${cfg.host}:${cfg.port} failed: ${e instanceof Error ? e.message : String(e)}`);
    return finish('bind_failed');
  }
  log(`listening on ${cfg.host}:${cfg.port}; waiting up to ${cfg.reconnectWaitMs} ms for the switch (read-only: nothing will be written to it)`);

  const waitMs = Math.min(cfg.reconnectWaitMs, remainingMs());
  if (!(await within(ready, waitMs))) {
    notes.push(`no completed handshake within ${waitMs} ms`);
    return finish('never_reconnected');
  }
  log(`switch session ready after ${connectedAtMs ?? 0} ms`);

  const firstStart = elapsedMs();
  for (let i = 1; i <= cfg.readbacks; i++) {
    if (i > 1) {
      const due = firstStart + (i - 1) * cfg.readbackIntervalMs;
      if (due + 1_000 > cfg.overallTimeoutMs) { notes.push(`readback ${i} not attempted: the overall time limit would be reached`); break; }
      await sleep(due - elapsedMs());
      if (!sessionUp) { notes.push(`readback ${i} not attempted: the switch session ended`); break; }
    }
    const timeoutMs = Math.min(cfg.readbackTimeoutMs, remainingMs());
    if (timeoutMs <= 0) { notes.push(`readback ${i} not attempted: the overall time limit was reached`); break; }
    const started = elapsedMs();
    try {
      const entries = await session.readFlowStats(timeoutMs);
      const assessment = assessTable(entries, policy);
      rawEntries[reads.length] = [...entries];
      reads.push({ index: i, startedAtMs: started, durationMs: elapsedMs() - started, ok: true, entries: entries.map(viewEntry), assessment });
      log(`readback ${i}: ${entries.length} entries, ${assessment.klass}`);
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      rawEntries[reads.length] = [];
      reads.push({ index: i, startedAtMs: started, durationMs: elapsedMs() - started, ok: false, error });
      log(`readback ${i} failed: ${error}`);
    }
  }

  const first = reads.find((r) => r.ok);
  if (first?.assessment === undefined) return finish(reads.length > 0 && remainingMs() > 0 ? 'readback_failed' : 'overall_timeout');
  return finish(first.assessment.klass);
}
