#!/usr/bin/env node
/**
 * zodiac-dataplane-bench.ts
 * Physical benchmark of the Zodiac FX data plane (KSZ8795 + SAM4E8E).
 *
 *   RPi 3B+ (Port 1, 10.0.2.50) --> Zodiac FX --> Wi-Fi extender (Port 2)
 *   Jetson mirror tap on Port 3, OpenFlow/management on Port 4.
 *
 * Usage (run ON THE JETSON, with zodiac-bridge.service STOPPED so this script is the
 * switch's sole OpenFlow controller):
 *
 *   npm run build:server
 *   node --experimental-strip-types scripts/zodiac-dataplane-bench.ts preflight --server <iperf3-server-ip>
 *   node --experimental-strip-types scripts/zodiac-dataplane-bench.ts run       --server <iperf3-server-ip> --tap-iface <jetson-tap-nic>
 *   node --experimental-strip-types scripts/zodiac-dataplane-bench.ts render docs/benchmarks/results/<artifact>.json
 *
 * Council Invariants Enforced:
 * - Invariant 2: all counters/rates are BigInt; all durations are process.hrtime.bigint().
 *   iperf3's floating-point fields are never read; rates are re-derived from integer counts.
 * - Invariant 3: fail-closed. Any unverifiable precondition aborts. A table that cannot be
 *   confirmed on silicon aborts unless --unverified-flow-table is given, in which case every
 *   result is stamped flowTableVerified=false.
 * - Invariant 4: every flow plan is proven loop-free before it is sent to the switch.
 * - Invariant 6: no simulation path exists. MOCK_SERIAL is refused. Output is a provenance-
 *   stamped artifact; the results document is rendered from it, never hand-written.
 *
 * Only erasable TypeScript syntax is used (node --experimental-strip-types).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { OpenFlowServer } from '../dist/sdn/openflow-server.js';
import { buildOfpFlowMod, FlowModCommand } from '../dist/sdn/openflow-types.js';
import { ZodiacSerialClient, parseShowPorts } from '../dist/sdn/zodiac-serial.js';
import {
  PORT_LINK_BPS,
  PORT_TAP,
  PORT_UPLINK,
  PORT_WORKLOAD,
  buildFlowStatsRequest,
  classifyTapStep,
  deriveMetrics,
  diffPorts,
  lineRatePayloadBps,
  parseFlowStatsReply,
  parseIperfTcp,
  parseIperfUdp,
  parseOfpError,
  perSecond,
  planFlowState,
  refineTapThreshold,
  verifyFlowReadback,
  verifyPlanAdmissible,
} from '../dist/sdn/dataplane-benchmark.js';
import {
  ARTIFACT_SCHEMA,
  injectIntoDocument,
  parseArtifact,
  renderResultsSection,
  serializeArtifact,
} from '../dist/sdn/dataplane-benchmark-report.js';
import type {
  DerivedMetrics,
  FlowPlan,
  FlowReadbackVerdict,
  FlowStatsEntry,
  IperfTcpResult,
  IperfUdpResult,
  PortDeltas,
  TapStepVerdict,
} from '../dist/sdn/dataplane-benchmark.js';
import type {
  BenchArtifact,
  ConditionRecord,
  TapSweepRecord,
  TestKind,
  TrialRecord,
} from '../dist/sdn/dataplane-benchmark-report.js';
import type { ZodiacPortInfo } from '../dist/sdn/zodiac-serial.js';
import {
  WORKDAY_PROFILES,
  analyzePingGaps,
  framedLineRatePps,
  naiveLineRatePps,
  planDepthCondition,
  rampAddOffsetsMs,
  verifyDepthReadback,
} from '../dist/sdn/dataplane-depth.js';
import type {
  DepthCondition,
  DepthFlow,
  DepthPlan,
  DepthReadbackVerdict,
  WorkdayProfile,
} from '../dist/sdn/dataplane-depth.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (err: unknown) {
    // Council Invariant 1 (Anti-Shortcut Law): Never silently swallow non-ENOENT errors.
    // If .env is missing (ENOENT), it is optional since all flags can be passed via CLI.
    // Any syntax or permission issue in an existing .env file must be observable.
    const isEnoent =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT';
    if (!isEnoent) {
      console.warn(
        `[!] [Bench] Warning: Failed to load .env file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const execFileP = promisify(execFile);
const NS_PER_SECOND = 1_000_000_000n;
const DEFAULT_DOC = 'docs/design/zodiac-fx-dataplane-benchmark.md';
const DEFAULT_OUT_DIR = 'docs/benchmarks/results';
const COUNTER_SOURCE =
  'Zodiac FX serial CLI `show ports` (Port RX/TX packets, bytes, dropped, CRC). ' +
  'Whether firmware sources these from KSZ8795 MIB registers is firmware-defined and is cross-checked here against workload-NIC and tap-NIC sysfs counters.';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  readonly cmd: string;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

const BOOLEAN_FLAGS = new Set([
  'skip-dataplane',
  'skip-tap',
  'tap-return-path',
  'unverified-flow-table',
  'no-doc',
  'skip-depths',
  'skip-variants',
  'skip-hit',
  'allow-dirty',
]);

function parseCli(argv: readonly string[]): Cli {
  const [cmd = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        switches.add(key);
      } else {
        const v = rest[++i];
        if (v === undefined) throw new Error(`flag --${key} requires a value`);
        flags.set(key, v);
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags, switches };
}

function intFlag(cli: Cli, key: string, dflt: number): number {
  const v = cli.flags.get(key);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v)) throw new Error(`--${key} must be a non-negative integer`);
  return Number(v);
}

function mbpsFlag(cli: Cli, key: string): bigint | null {
  const v = cli.flags.get(key);
  if (v === undefined) return null;
  if (!/^\d+$/.test(v)) throw new Error(`--${key} must be a whole number of Mbit/s (no floats)`);
  return BigInt(v) * 1_000_000n;
}

function safeToken(value: string, what: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`${what} contains unsupported characters: ${value}`);
  return value;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const nowNs = (): bigint => process.hrtime.bigint();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const log = (msg: string): void => void process.stderr.write(`[bench ${new Date().toISOString()}] ${msg}\n`);

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stdoutOfFailedExec(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'stdout' in e) {
    const so = (e as { stdout: unknown }).stdout;
    if (typeof so === 'string' && so.trim().length > 0) return so;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rig: serial + OpenFlow + SSH workload
// ---------------------------------------------------------------------------

interface Rig {
  readonly of: OpenFlowServer;
  readonly serial: ZodiacSerialClient;
  readonly sshTarget: string;
  readonly piIface: string;
  readonly piIp: string;
  readonly server: string;
  readonly tapIface: string | null;
  readonly switchErrors: string[];
  /** Increments on every OpenFlow (re)connect: an epoch change means the switch dropped its whole table. */
  readonly epoch: { n: number };
}

async function ssh(rig: Pick<Rig, 'sshTarget'>, remoteCmd: string, timeoutMs: number): Promise<string> {
  const ctl = path.join(os.tmpdir(), `zodiac-bench-ssh-${process.pid}`);
  const { stdout } = await execFileP(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${ctl}`,
      '-o', 'ControlPersist=300',
      rig.sshTarget,
      remoteCmd,
    ],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

interface PortSnapshot {
  readonly readStartNs: bigint;
  readonly readEndNs: bigint;
  readonly raw: string;
  readonly ports: ZodiacPortInfo[];
}

async function readPorts(serial: ZodiacSerialClient): Promise<PortSnapshot> {
  const readStartNs = nowNs();
  const raw = await serial.executeRaw('show ports', 8000);
  const readEndNs = nowNs();
  const ports = parseShowPorts(raw);
  for (const needed of [PORT_WORKLOAD, PORT_UPLINK, PORT_TAP]) {
    if (!ports.some((p) => p.port === needed)) {
      throw new Error(`'show ports' did not return Port ${needed}; raw output length ${raw.length}`);
    }
  }
  return { readStartNs, readEndNs, raw, ports };
}

interface NicReading {
  readonly workloadTxPackets: bigint;
  readonly workloadTxBytes: bigint;
  readonly tapRxPackets: bigint | null;
  readonly tapRxDropped: bigint | null;
}

async function readSysfs(file: string): Promise<bigint> {
  const text = (await fs.readFile(file, 'utf8')).trim();
  if (!/^\d+$/.test(text)) throw new Error(`unexpected sysfs value in ${file}: ${text}`);
  return BigInt(text);
}

async function readNics(rig: Rig): Promise<NicReading> {
  const base = `/sys/class/net/${rig.piIface}/statistics`;
  const out = await ssh(rig, `cat ${base}/tx_packets ${base}/tx_bytes`, 10_000);
  const [pk, by] = out.trim().split(/\s+/);
  if (pk === undefined || by === undefined || !/^\d+$/.test(pk) || !/^\d+$/.test(by)) {
    throw new Error(`unparseable workload NIC counters: ${JSON.stringify(out)}`);
  }
  let tapRxPackets: bigint | null = null;
  let tapRxDropped: bigint | null = null;
  if (rig.tapIface !== null) {
    const tb = `/sys/class/net/${rig.tapIface}/statistics`;
    tapRxPackets = await readSysfs(`${tb}/rx_packets`);
    tapRxDropped = await readSysfs(`${tb}/rx_dropped`);
  }
  return { workloadTxPackets: BigInt(pk), workloadTxBytes: BigInt(by), tapRxPackets, tapRxDropped };
}

// ---------------------------------------------------------------------------
// OpenFlow: flow state install + switch-side readback
// ---------------------------------------------------------------------------

async function readFlows(of: OpenFlowServer): Promise<FlowStatsEntry[]> {
  const xid = of.reserveXid();
  const entries: FlowStatsEntry[] = [];
  return new Promise<FlowStatsEntry[]>((resolve, reject) => {
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      of.off('multipartReply', onReply);
      of.off('ofError', onError);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('OFPMP_FLOW readback timed out'))), 10_000);
    const onReply = (rxXid: number, packet: Buffer): void => {
      if (rxXid !== xid) return;
      try {
        const reply = parseFlowStatsReply(packet);
        entries.push(...reply.entries);
        if (!reply.more) done(() => resolve(entries));
      } catch (e: unknown) {
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    };
    const onError = (rxXid: number, packet: Buffer): void => {
      if (rxXid !== xid) return;
      const info = parseOfpError(packet);
      done(() => reject(new Error(`switch rejected OFPMP_FLOW (type ${info.errorType}, code ${info.errorCode})`)));
    };
    of.on('multipartReply', onReply);
    of.on('ofError', onError);
    try {
      of.sendRaw(buildFlowStatsRequest(xid));
    } catch (e: unknown) {
      done(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

function sendPlannedFlow(of: OpenFlowServer, f: FlowPlan['flows'][number]): void {
  const match = f.kind === 'quarantine' ? { srcIp: f.srcIp } : { inPort: f.inPort };
  of.sendRaw(
    buildOfpFlowMod(
      { command: FlowModCommand.OFPFC_ADD, priority: f.priority, outputPorts: f.outputPorts, match },
      of.reserveXid(),
    ),
  );
}

async function deleteAllFlows(of: OpenFlowServer): Promise<void> {
  of.sendRaw(buildOfpFlowMod({ command: FlowModCommand.OFPFC_DELETE, priority: 0, outputPorts: [] }, of.reserveXid()));
}

interface AppliedCondition {
  readonly record: ConditionRecord;
  readonly plan: FlowPlan;
}

async function applyCondition(
  rig: Rig,
  id: string,
  plan: FlowPlan,
  allowUnverified: boolean,
): Promise<AppliedCondition & { readonly readbackSupported: boolean }> {
  verifyPlanAdmissible(plan); // Invariant 4: throws before anything touches the switch
  rig.switchErrors.length = 0;
  log(`installing condition ${id}: ${plan.quarantineInstalled}/${plan.quarantineRequested} quarantine + ${plan.forwardingRuleCount} forwarding (mirror ${plan.mirror})`);
  await deleteAllFlows(rig.of);
  for (const f of plan.flows) sendPlannedFlow(rig.of, f);

  let verdict: FlowReadbackVerdict | null = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    try {
      const entries = await readFlows(rig.of);
      const v = verifyFlowReadback(plan, entries);
      verdict = rig.switchErrors.length > 0
        ? { ...v, verified: false, mismatches: [...v.mismatches, ...rig.switchErrors] }
        : v;
      if (verdict.verified) break;
      lastErr = verdict.mismatches.join('; ');
    } catch (e: unknown) {
      lastErr = errMessage(e);
    }
  }

  if (verdict !== null && !verdict.verified) {
    throw new Error(`condition ${id}: switch flow table does not match plan after 30 s: ${lastErr}`);
  }
  if (verdict === null) {
    if (!allowUnverified) {
      throw new Error(
        `condition ${id}: cannot read back the switch flow table (${lastErr}). ` +
          'Refusing to report rule-depth results on unverified residency (fail-closed). ' +
          'Re-run with --unverified-flow-table to stamp results as unverified.',
      );
    }
    log(`WARNING: condition ${id} flow residency UNVERIFIED (${lastErr})`);
  }
  return {
    record: {
      id,
      quarantineRequested: plan.quarantineRequested,
      quarantineInstalled: plan.quarantineInstalled,
      clamped: plan.clamped,
      mirror: plan.mirror,
      readback: verdict,
    },
    plan,
    readbackSupported: verdict !== null,
  };
}

// ---------------------------------------------------------------------------
// One measured window
// ---------------------------------------------------------------------------

interface LoadResult {
  readonly iperf: IperfTcpResult | IperfUdpResult | null;
  readonly rawSha256: string | null;
  readonly wallNs: bigint;
}

async function runIperf(
  rig: Rig,
  kind: 'tcp' | 'udp',
  durationS: number,
  udp: { readonly bps: bigint; readonly payloadBytes: number } | null,
): Promise<LoadResult> {
  const udpArgs = kind === 'udp' && udp ? `-u -b ${udp.bps} -l ${udp.payloadBytes}` : '';
  // -B pins the source to the data-plane address; the route was verified at startup to egress via that NIC.
  const cmd = `timeout ${durationS + 25} iperf3 -c ${rig.server} -B ${rig.piIp} -t ${durationS} -J ${udpArgs}`.trim();
  const t0 = nowNs();
  let stdout: string;
  try {
    stdout = await ssh(rig, cmd, (durationS + 40) * 1000);
  } catch (e: unknown) {
    const partial = stdoutOfFailedExec(e);
    if (partial === null) throw e;
    stdout = partial;
  }
  const wallNs = nowNs() - t0;
  const parsed: unknown = JSON.parse(stdout);
  const iperf = kind === 'tcp' ? parseIperfTcp(parsed) : parseIperfUdp(parsed);
  return { iperf, rawSha256: sha256(stdout), wallNs };
}

let ordinalCounter = 0;

async function measure(
  rig: Rig,
  args: {
    readonly test: TestKind;
    readonly conditionId: string;
    readonly mirror: boolean;
    readonly durationS: number;
    readonly offeredBps: bigint | null;
    readonly udpPayloadBytes: bigint | null;
    readonly load: () => Promise<LoadResult>;
  },
): Promise<TrialRecord> {
  const ordinal = ++ordinalCounter;
  const nominalWindowNs = BigInt(args.durationS) * NS_PER_SECOND;
  const startNs = nowNs();
  let rawBefore = '';
  let rawAfter = '';
  const invalid = (reason: string): TrialRecord => ({
    ordinal, conditionId: args.conditionId, test: args.test, offeredBps: args.offeredBps,
    startNs, endNs: nowNs(), nominalWindowNs, wallNs: 0n, valid: false, invalidReason: reason,
    metrics: null, portDeltas: null, tapVerdict: null, tapPort1RxPackets: null, tapPort3TxPackets: null,
    tapNicRxPackets: null, tapNicRxDropped: null, rawPortsBefore: rawBefore, rawPortsAfter: rawAfter,
    iperfRawSha256: null,
  });

  try {
    const before = await readPorts(rig.serial);
    rawBefore = before.raw;
    const nicBefore = await readNics(rig);
    const load = await args.load();
    const nicAfter = await readNics(rig);
    const after = await readPorts(rig.serial);
    rawAfter = after.raw;

    if (load.wallNs < nominalWindowNs) {
      return invalid(`load ended early: wall ${load.wallNs} ns < nominal ${nominalWindowNs} ns`);
    }
    const required = args.mirror ? [PORT_WORKLOAD, PORT_UPLINK, PORT_TAP] : [PORT_WORKLOAD, PORT_UPLINK];
    const diff = diffPorts(before.ports, after.ports, required);
    if (!diff.ok) return invalid(diff.reason);

    const endpoint = {
      workloadTxPackets: nicAfter.workloadTxPackets - nicBefore.workloadTxPackets,
      workloadTxBytes: nicAfter.workloadTxBytes - nicBefore.workloadTxBytes,
      tapRxPackets:
        nicAfter.tapRxPackets !== null && nicBefore.tapRxPackets !== null
          ? nicAfter.tapRxPackets - nicBefore.tapRxPackets
          : null,
      tapRxDropped:
        nicAfter.tapRxDropped !== null && nicBefore.tapRxDropped !== null
          ? nicAfter.tapRxDropped - nicBefore.tapRxDropped
          : null,
    };
    if (endpoint.workloadTxPackets < 0n || (endpoint.tapRxPackets !== null && endpoint.tapRxPackets < 0n)) {
      return invalid('endpoint NIC counter regressed');
    }

    const metrics = deriveMetrics({
      windowNs: nominalWindowNs,
      deltas: diff.deltas,
      iperf: load.iperf,
      udpPayloadBytes: args.udpPayloadBytes,
      endpoint,
      mirrorEnabled: args.mirror,
    });
    const p1 = diff.deltas[PORT_WORKLOAD]!;
    const p3 = diff.deltas[PORT_TAP];
    return {
      ordinal, conditionId: args.conditionId, test: args.test, offeredBps: args.offeredBps,
      startNs, endNs: nowNs(), nominalWindowNs, wallNs: load.wallNs, valid: true, invalidReason: null,
      metrics, portDeltas: diff.deltas, tapVerdict: null,
      tapPort1RxPackets: p3 ? p1.rxPackets : null,
      tapPort3TxPackets: p3 ? p3.txPackets : null,
      tapNicRxPackets: endpoint.tapRxPackets, tapNicRxDropped: endpoint.tapRxDropped,
      rawPortsBefore: before.raw, rawPortsAfter: after.raw, iperfRawSha256: load.rawSha256,
    };
  } catch (e: unknown) {
    return invalid(errMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

interface RunConfig {
  readonly durationS: number;
  readonly trials: number;
  readonly order: 'interleaved' | 'sequential';
  readonly levels: readonly number[];
  readonly udpOfferedBps: bigint;
  readonly mtuPayload: number;
  readonly smallPayload: number;
  readonly tapRates: readonly bigint[];
  readonly tapTrials: number;
  readonly tapResolutionBps: bigint;
  readonly tapReturnPath: boolean;
  readonly allowUnverified: boolean;
  /** Quiescent barrier after every trial so the iperf3 server can reset (0 = none). */
  readonly gapMs: number;
}

async function postBlockQuarantineCheck(rig: Rig, plan: FlowPlan, readbackSupported: boolean): Promise<void> {
  if (!readbackSupported) return;
  const v = verifyFlowReadback(plan, await readFlows(rig.of));
  if (v.quarantinePacketHits !== 0n) {
    throw new Error(
      `quarantine rules matched ${v.quarantinePacketHits} packets: benchmark traffic hit a DROP rule, ` +
        'results invalid (rules were TEST-NET-2 sources and must never match).',
    );
  }
}

async function runDataPlane(rig: Rig, cfg: RunConfig, conditions: ConditionRecord[], trials: TrialRecord[]): Promise<boolean> {
  let allVerified = true;
  const levelsSeq: number[] =
    cfg.order === 'interleaved'
      ? Array.from({ length: cfg.trials }, () => [...cfg.levels]).flat()
      : cfg.levels.flatMap((l) => Array.from({ length: cfg.trials }, () => l));

  let current: { level: number; applied: AppliedCondition & { readbackSupported: boolean } } | null = null;
  for (const level of levelsSeq) {
    if (current === null || current.level !== level || cfg.order === 'interleaved') {
      if (current !== null) await postBlockQuarantineCheck(rig, current.applied.plan, current.applied.readbackSupported);
      const plan = planFlowState({ quarantineRequested: level, mirror: false, tapReturnPath: false });
      const id = `q${level}`;
      const applied = await applyCondition(rig, id, plan, cfg.allowUnverified);
      if (!applied.readbackSupported) allVerified = false;
      if (!conditions.some((c) => c.id === id)) conditions.push(applied.record);
      current = { level, applied };
    }
    const id = current.applied.record.id;
    const D = cfg.durationS;
    const udpCommon = { mirror: false, durationS: D, conditionId: id };

    trials.push(await measure(rig, {
      ...udpCommon, test: 'tcp', offeredBps: null, udpPayloadBytes: null,
      load: () => runIperf(rig, 'tcp', D, null),
    }));
    await sleep(cfg.gapMs);
    trials.push(await measure(rig, {
      ...udpCommon, test: 'udp_mtu', offeredBps: cfg.udpOfferedBps, udpPayloadBytes: BigInt(cfg.mtuPayload),
      load: () => runIperf(rig, 'udp', D, { bps: cfg.udpOfferedBps, payloadBytes: cfg.mtuPayload }),
    }));
    await sleep(cfg.gapMs);
    trials.push(await measure(rig, {
      ...udpCommon, test: 'udp_small', offeredBps: lineRatePayloadBps(PORT_LINK_BPS, BigInt(cfg.smallPayload)),
      udpPayloadBytes: BigInt(cfg.smallPayload),
      load: () =>
        runIperf(rig, 'udp', D, {
          bps: lineRatePayloadBps(PORT_LINK_BPS, BigInt(cfg.smallPayload)),
          payloadBytes: cfg.smallPayload,
        }),
    }));
    await sleep(cfg.gapMs);
    trials.push(await measure(rig, {
      ...udpCommon, test: 'idle', offeredBps: null, udpPayloadBytes: null,
      load: async () => {
        const t0 = nowNs();
        const target = t0 + BigInt(D) * NS_PER_SECOND;
        for (let remaining = target - nowNs(); remaining > 0n; remaining = target - nowNs()) {
          await sleep(Number(remaining / 1_000_000n) + 1);
        }
        return { iperf: null, rawSha256: null, wallNs: nowNs() - t0 };
      },
    }));
    await sleep(cfg.gapMs);
  }
  if (current !== null) await postBlockQuarantineCheck(rig, current.applied.plan, current.applied.readbackSupported);
  return allVerified;
}

async function runTapSweep(
  rig: Rig,
  cfg: RunConfig,
  conditions: ConditionRecord[],
  trials: TrialRecord[],
): Promise<{ record: TapSweepRecord; verified: boolean }> {
  const plan = planFlowState({ quarantineRequested: 0, mirror: true, tapReturnPath: cfg.tapReturnPath });
  const id = 'tap-mirror';
  const applied = await applyCondition(rig, id, plan, cfg.allowUnverified);
  conditions.push(applied.record);

  const rates = [...cfg.tapRates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (rates.length < 2) throw new Error('tap sweep needs at least two offered rates');

  const step = async (bps: bigint): Promise<TrialRecord> =>
    measure(rig, {
      test: 'tap_step', conditionId: id, mirror: true, durationS: cfg.durationS, offeredBps: bps,
      udpPayloadBytes: BigInt(cfg.mtuPayload),
      load: () => runIperf(rig, 'udp', cfg.durationS, { bps, payloadBytes: cfg.mtuPayload }),
    });

  const withVerdict = (t: TrialRecord, floorPpm: bigint): TrialRecord => {
    if (!t.valid || t.tapPort1RxPackets === null || t.tapPort3TxPackets === null || t.metrics === null) return t;
    const verdict: TapStepVerdict = classifyTapStep(
      {
        offeredBps: t.offeredBps!,
        port1RxPackets: t.tapPort1RxPackets,
        port3TxPackets: t.tapPort3TxPackets,
        port3TxDropped: t.metrics.port3TxDropped ?? 0n,
      },
      floorPpm,
    );
    return { ...t, tapVerdict: verdict };
  };

  // Calibration at the lowest rate establishes the noise floor on THIS rig.
  const calibration: TrialRecord[] = [];
  for (let i = 0; i < cfg.tapTrials; i++) calibration.push(await step(rates[0]!));
  const calValid = calibration.filter((t) => t.valid);
  if (calValid.length === 0) {
    trials.push(...calibration);
    return { record: sweepRecord(id, 0n, 'aborted', null, null, 'no valid calibration trials'), verified: applied.readbackSupported };
  }
  let floorPpm = 0n;
  for (const t of calValid) {
    const d = classifyTapStep(
      { offeredBps: t.offeredBps!, port1RxPackets: t.tapPort1RxPackets!, port3TxPackets: t.tapPort3TxPackets!, port3TxDropped: 0n },
      0n,
    ).deficitPpm;
    if (d !== null && d > floorPpm) floorPpm = d;
  }
  const calClassified = calibration.map((t) => withVerdict(t, floorPpm));
  trials.push(...calClassified);
  if (calClassified.some((t) => t.tapVerdict?.hardDrop === true)) {
    return {
      record: sweepRecord(id, floorPpm, 'below_range', null, rates[0]!, 'Port 3 TX drops already present at the lowest offered rate'),
      verified: applied.readbackSupported,
    };
  }

  // probeRate: any valid trial showing loss marks the rate lossy; all-invalid aborts.
  const probeRate = async (bps: bigint): Promise<boolean> => {
    let lossy = false;
    let anyValid = false;
    for (let i = 0; i < cfg.tapTrials; i++) {
      const t = withVerdict(await step(bps), floorPpm);
      trials.push(t);
      if (t.valid) {
        anyValid = true;
        if (t.tapVerdict?.lossDetected === true) lossy = true;
      }
    }
    if (!anyValid) throw new Error(`all tap trials invalid at ${bps} bit/s`);
    return lossy;
  };

  let clean = rates[0]!;
  let fail: bigint | null = null;
  try {
    for (const bps of rates.slice(1)) {
      if (await probeRate(bps)) {
        fail = bps;
        break;
      }
      clean = bps;
    }
    if (fail === null) {
      return { record: sweepRecord(id, floorPpm, 'not_reached', clean, null, 'highest tested rate showed no tap loss'), verified: applied.readbackSupported };
    }
    const bracket = await refineTapThreshold({
      cleanBps: clean, failBps: fail, resolutionBps: cfg.tapResolutionBps, probe: probeRate,
    });
    return {
      record: sweepRecord(id, floorPpm, 'bracketed', bracket.cleanBps, bracket.failBps,
        `bisection to ${cfg.tapResolutionBps} bit/s resolution over ${bracket.probes.length} refinement rates; response is not assumed monotonic, every probe is in the table`),
      verified: applied.readbackSupported,
    };
  } catch (e: unknown) {
    return { record: sweepRecord(id, floorPpm, 'aborted', null, null, errMessage(e)), verified: applied.readbackSupported };
  }
}

function sweepRecord(
  conditionId: string, noiseFloorPpm: bigint, status: TapSweepRecord['status'],
  cleanBps: bigint | null, failBps: bigint | null, note: string,
): TapSweepRecord {
  return { conditionId, noiseFloorPpm, status, cleanBps, failBps, note };
}

// ---------------------------------------------------------------------------
// Setup / preconditions
// ---------------------------------------------------------------------------

async function connectRig(cli: Cli): Promise<{ rig: Rig; identity: BenchArtifact['provenance']['switchIdentity']; workload: BenchArtifact['provenance']['workload'] }> {
  if (process.env['MOCK_SERIAL']) {
    throw new Error('MOCK_SERIAL is set: refusing to benchmark (Invariant 6, Anti-Simulation Law)');
  }
  const serverRaw = cli.flags.get('server');
  if (serverRaw === undefined || serverRaw.length === 0) {
    throw new Error('--server <iperf3 server reachable through Port 2> is required');
  }
  const server = safeToken(serverRaw, '--server', /^[A-Za-z0-9.-]+$/);
  const sshTarget = safeToken(cli.flags.get('pi-ssh') ?? process.env['BENCH_PI_SSH'] ?? 'pi@10.0.0.45', '--pi-ssh', /^[A-Za-z0-9_.@-]+$/);
  const piIface = safeToken(cli.flags.get('pi-iface') ?? 'eth0', '--pi-iface', /^[A-Za-z0-9_.-]+$/);
  const piIp = safeToken(cli.flags.get('pi-ip') ?? '10.0.2.50', '--pi-ip', /^\d{1,3}(\.\d{1,3}){3}$/);
  const tapIfaceRaw = cli.flags.get('tap-iface');
  const tapIface = tapIfaceRaw === undefined ? null : safeToken(tapIfaceRaw, '--tap-iface', /^[A-Za-z0-9_.-]+$/);

  const serial = new ZodiacSerialClient(cli.flags.get('serial-path') ?? process.env['ZODIAC_SERIAL_PATH']);
  const status = await serial.getStatus();
  const serialPath = await serial.getResolvedPath();
  if (status.firmwareVersion === 'Unknown') {
    throw new Error('Zodiac FX did not answer `show status` over serial; cannot attest the device');
  }
  const snap = await readPorts(serial);
  for (const p of [PORT_WORKLOAD, PORT_UPLINK]) {
    const info = snap.ports.find((x) => x.port === p)!;
    if (info.status !== 'UP') throw new Error(`Port ${p} link is DOWN`);
  }
  if (tapIface !== null && snap.ports.find((x) => x.port === PORT_TAP)!.status !== 'UP') {
    throw new Error('Port 3 link is DOWN but a tap interface was requested');
  }

  // Workload topology attestation: the iperf3 path MUST leave via the data-plane NIC.
  const ipOut = await ssh({ sshTarget }, `ip -4 -o addr show dev ${piIface}`, 10_000);
  if (!ipOut.includes(`inet ${piIp}/`)) throw new Error(`${piIface} on ${sshTarget} does not carry ${piIp}: ${ipOut.trim()}`);
  const routeOut = await ssh({ sshTarget }, `ip -4 -o route get ${server} from ${piIp}`, 10_000);
  if (!new RegExp(`\\bdev ${piIface}\\b`).test(routeOut)) {
    throw new Error(
      `route to ${server} from ${piIp} egresses via a different NIC, so traffic would bypass the switch: ${routeOut.trim()}`,
    );
  }
  const kernel = (await ssh({ sshTarget }, 'uname -sr', 10_000)).trim();
  const iperf3Client = (await ssh({ sshTarget }, 'iperf3 --version | head -n1', 10_000)).trim();

  // Default keeps the production 8 s dead-peer rule. --of-dead-peer-ms lengthens it so a benchmark can observe how long
  // the switch CPU stalls instead of having the controller sever the session (and the switch drop its table) first.
  const deadPeerMs = cli.flags.get('of-dead-peer-ms');
  if (deadPeerMs !== undefined && !/^\d+$/.test(deadPeerMs)) throw new Error('--of-dead-peer-ms must be a non-negative integer');
  const of = deadPeerMs === undefined ? new OpenFlowServer() : new OpenFlowServer(BigInt(deadPeerMs) * 1_000_000n);
  const switchErrors: string[] = [];
  const epoch = { n: 0 };
  of.on('connected', () => { epoch.n++; });
  of.on('error', (e: unknown) => log(`openflow error: ${errMessage(e)}`));
  of.on('clientError', (e: unknown) => log(`openflow client error: ${errMessage(e)}`));
  of.on('ofError', (xid: number, packet: Buffer) => {
    const i = parseOfpError(packet);
    switchErrors.push(`OFPT_ERROR xid=${xid} type=${i.errorType} code=${i.errorCode}`);
  });
  const host = cli.flags.get('controller-host') ?? process.env['SDN_CONTROLLER_IP'] ?? '0.0.0.0';
  try {
    await of.listen(6633, host);
  } catch (e: unknown) {
    throw new Error(
      `cannot bind OpenFlow 6633 on ${host} (${errMessage(e)}). Stop zodiac-bridge.service first: ` +
        'this tool must be the switch\'s only controller.',
    );
  }
  log(`waiting for the physical switch to connect to ${host}:6633 ...`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('switch did not complete the OpenFlow handshake within 180 s')), 180_000);
    const check = (): void => {
      if (of.metrics.state === 'ESTABLISHED') {
        clearTimeout(t);
        resolve();
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  });
  const features = of.metrics.switchFeatures;
  if (!features) throw new Error('switch session established without FEATURES_REPLY');

  return {
    rig: { of, serial, sshTarget, piIface, piIp, server, tapIface, switchErrors, epoch },
    identity: {
      datapathId: features.datapathId,
      openflowPeer: of.metrics.connectedAddress ?? 'unknown',
      serialPath,
      firmwareVersion: status.firmwareVersion,
      cpuUid: status.cpuUid,
    },
    workload: { sshTarget, iface: piIface, ipv4: piIp, kernel, iperf3Client },
  };
}

async function gitInfo(): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const { stdout: head } = await execFileP('git', ['rev-parse', '--short', 'HEAD']);
    const { stdout: porcelain } = await execFileP('git', ['status', '--porcelain']);
    return { commit: head.trim(), dirty: porcelain.trim().length > 0 };
  } catch (e: unknown) {
    log(`git metadata unavailable: ${errMessage(e)}`);
    return { commit: null, dirty: null };
  }
}

async function assertCleanGit(cli: Cli): Promise<void> {
  const git = await gitInfo();
  if (git.dirty && !cli.switches.has('allow-dirty')) {
    throw new Error(
      'Working tree is dirty (uncommitted changes detected). ' +
      'Benchmark artifacts for headline results must be strictly reproducible from clean commits. ' +
      'Pass --allow-dirty to override for exploratory runs.'
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPreflight(cli: Cli): Promise<void> {
  const { rig, identity, workload } = await connectRig(cli);
  try {
    const entries = await readFlows(rig.of).then(
      (e) => `readable, ${e.length} entries currently installed`,
      (e: unknown) => `NOT readable: ${errMessage(e)}`,
    );
    log(`switch DPID 0x${identity.datapathId.toString(16)} firmware ${identity.firmwareVersion} @ ${identity.serialPath}`);
    log(`workload ${workload.sshTarget} ${workload.iface} ${workload.ipv4} (${workload.kernel}; ${workload.iperf3Client})`);
    log(`switch flow-table readback (OFPMP_FLOW): ${entries}`);
    log('preflight passed. No flows were modified and no traffic was generated.');
  } finally {
    await rig.of.close();
  }
}

async function cmdRun(cli: Cli): Promise<void> {
  await assertCleanGit(cli);
  const startedMonotonicNs = nowNs();
  const startedAtIso = new Date().toISOString();
  const mtuPayload = intFlag(cli, 'mtu-payload', 1470);
  const smallPayload = intFlag(cli, 'small-payload', 64);
  const mtuCap = lineRatePayloadBps(PORT_LINK_BPS, BigInt(mtuPayload));
  const tapRates = cli.flags.has('tap-rates-mbps')
    ? cli.flags.get('tap-rates-mbps')!.split(',').map((s) => {
        if (!/^\d+$/.test(s.trim())) throw new Error('--tap-rates-mbps must be comma-separated whole numbers');
        return BigInt(s.trim()) * 1_000_000n;
      })
    : // Default grid: 10%..100% of the physical payload line rate, integer math, derived not tuned.
      Array.from({ length: 10 }, (_, i) => (mtuCap * BigInt(i + 1)) / 10n);

  const cfg: RunConfig = {
    durationS: intFlag(cli, 'duration', 10),
    trials: intFlag(cli, 'trials', 5),
    order: cli.flags.get('order') === 'sequential' ? 'sequential' : 'interleaved',
    levels: (cli.flags.get('rules') ?? '0,32,128').split(',').map((s) => {
      if (!/^\d+$/.test(s.trim())) throw new Error('--rules must be comma-separated integers');
      return Number(s.trim());
    }),
    udpOfferedBps: mbpsFlag(cli, 'udp-mbps') ?? mtuCap,
    mtuPayload,
    smallPayload,
    tapRates,
    tapTrials: intFlag(cli, 'tap-trials', 3),
    tapResolutionBps: mbpsFlag(cli, 'tap-resolution-mbps') ?? 1_000_000n,
    tapReturnPath: cli.switches.has('tap-return-path'),
    allowUnverified: cli.switches.has('unverified-flow-table'),
    gapMs: intFlag(cli, 'gap-seconds', 0) * 1000,
  };
  if (cfg.durationS < 1 || cfg.trials < 1 || cfg.tapTrials < 1) throw new Error('duration/trials must be >= 1');

  const { rig, identity, workload } = await connectRig(cli);
  const conditions: ConditionRecord[] = [];
  const trials: TrialRecord[] = [];
  let tapSweep: TapSweepRecord | null = null;
  let flowTableVerified = true;
  let failure: unknown = null;

  const onSignal = (): void => {
    log('interrupted: clearing flow table (fail-closed default-drop) and exiting');
    deleteAllFlows(rig.of).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);

  try {
    if (!cli.switches.has('skip-dataplane')) {
      flowTableVerified = (await runDataPlane(rig, cfg, conditions, trials)) && flowTableVerified;
    }
    if (!cli.switches.has('skip-tap')) {
      if (rig.tapIface === null) log('NOTE: no --tap-iface; Port 3 is judged by switch counters only (no tap-NIC cross-check)');
      const r = await runTapSweep(rig, cfg, conditions, trials);
      tapSweep = r.record;
      flowTableVerified = r.verified && flowTableVerified;
    }
  } catch (e: unknown) {
    failure = e;
    log(`ABORTED: ${errMessage(e)}`);
  } finally {
    try {
      await deleteAllFlows(rig.of);
      log('flow table cleared; restart zodiac-bridge.service to restore production rules');
    } catch (e: unknown) {
      log(`WARNING: could not clear flow table: ${errMessage(e)}`);
    }
    await rig.of.close();
  }

  const scriptPath = new URL(import.meta.url).pathname;
  const git = await gitInfo();
  const artifact: BenchArtifact = {
    provenance: {
      schema: ARTIFACT_SCHEMA,
      origin: 'physical_bench_run',
      startedAtIso,
      startedMonotonicNs,
      finishedMonotonicNs: nowNs(),
      controllerHost: { hostname: os.hostname(), platform: process.platform, arch: process.arch, nodeVersion: process.version },
      switchIdentity: identity,
      workload,
      iperfServer: rig.server,
      tapInterface: rig.tapIface,
      tool: { scriptSha256: sha256(await fs.readFile(scriptPath)), gitCommit: git.commit, gitDirty: git.dirty },
      flowTableVerified,
      counterSource: COUNTER_SOURCE,
    },
    params: {
      durationSeconds: cfg.durationS, trials: cfg.trials, order: cfg.order, quarantineLevels: cfg.levels,
      udpOfferedBps: cfg.udpOfferedBps, udpMtuPayloadBytes: cfg.mtuPayload, udpSmallPayloadBytes: cfg.smallPayload,
      tapSweepBps: cfg.tapRates, tapResolutionBps: cfg.tapResolutionBps, tapReturnPath: cfg.tapReturnPath,
    },
    conditions,
    trials,
    tapSweep,
  };

  const outDir = cli.flags.get('out') ?? DEFAULT_OUT_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `dataplane-${startedAtIso.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, serializeArtifact(artifact), 'utf8');
  log(`artifact written: ${file}`);

  if (!cli.switches.has('no-doc')) await renderDoc(artifact, cli.flags.get('doc') ?? DEFAULT_DOC);
  if (failure !== null) throw failure;
}

async function renderDoc(artifact: BenchArtifact, docPath: string): Promise<void> {
  const doc = await fs.readFile(docPath, 'utf8');
  await fs.writeFile(docPath, injectIntoDocument(doc, renderResultsSection(artifact)), 'utf8');
  log(`results rendered into ${docPath}`);
}

async function cmdRender(cli: Cli): Promise<void> {
  const file = cli.positional[0];
  if (!file) throw new Error('usage: render <artifact.json> [--doc path]');
  const artifact = parseArtifact(await fs.readFile(file, 'utf8'));
  await renderDoc(artifact, cli.flags.get('doc') ?? DEFAULT_DOC);
}

// ---------------------------------------------------------------------------
// Depth sweep / blackout / working-window benchmarks
// (extend the three-depth run above; same rig, same fail-closed rules)
// ---------------------------------------------------------------------------

const DEPTH_SCHEMA = 'zodiac-depth-bench/v1';
const DEFAULT_DEPTH_OUT_DIR = 'docs/benchmarks/results';
/** Secondary workload address used only by the drop_hit test; never a real endpoint. */
const HIT_SRC_IP = '10.0.2.51';
const HIT_SENDER_PATH = '/tmp/zodiac_udp_hit.py';
/** 64-byte UDP payloads are offered at a fixed packet rate: line rate (~96k pps) hung the iperf3 client in the first run. */
const UDP_P64_PPS = 30_000n;
const UDP_P572_PAYLOAD = 572; // 600-byte IPv4 packet: the roadmap's "typical HTTP" size

type UdpTestKind = 'udp_p64' | 'udp_p572' | 'udp_p1470';
type DepthTestKind = UdpTestKind | 'tcp' | 'drop_hit';
const ALL_DEPTH_TESTS: readonly DepthTestKind[] = ['udp_p64', 'udp_p572', 'udp_p1470', 'tcp', 'drop_hit'];

function udpTestSpec(kind: UdpTestKind): { payload: number; bps: bigint } {
  if (kind === 'udp_p64') return { payload: 64, bps: UDP_P64_PPS * 64n * 8n };
  const payload = kind === 'udp_p572' ? UDP_P572_PAYLOAD : 1470;
  return { payload, bps: lineRatePayloadBps(PORT_LINK_BPS, BigInt(payload)) };
}

function parseIntList(raw: string, what: string): number[] {
  if (raw === 'none' || raw === '') return [];
  return raw.split(',').map((s) => {
    if (!/^\d+$/.test(s.trim())) throw new Error(`${what} must be comma-separated non-negative integers`);
    return Number(s.trim());
  });
}

function parseTestList(raw: string, what: string): DepthTestKind[] {
  if (raw === 'none' || raw === '') return [];
  return raw.split(',').map((s) => {
    const t = s.trim() as DepthTestKind;
    if (!ALL_DEPTH_TESTS.includes(t)) throw new Error(`${what}: unknown test '${s}' (known: ${ALL_DEPTH_TESTS.join(', ')})`);
    return t;
  });
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $bigint: v.toString() } : v;
}

// ---- OpenFlow session watch ---------------------------------------------------

interface SessionEvent {
  readonly tNs: bigint;
  readonly event: 'connected' | 'ready' | 'disconnected' | 'deadPeerTimeout' | 'echoLatency' | 'silence';
  /** echoLatency / silence: nanoseconds; connected / disconnected / deadPeerTimeout: peer address. */
  readonly detail: bigint | string;
}

/** Records session transitions, echo RTTs and any >1 s gap with no message from the switch (a CPU-stall signal). */
function watchSession(rig: Rig): SessionEvent[] {
  const events: SessionEvent[] = [];
  const push = (event: SessionEvent['event'], detail: bigint | string): void => void events.push({ tNs: nowNs(), event, detail });
  let lastRx = 0n;
  rig.of.on('connected', (a: string) => { lastRx = 0n; push('connected', a); log(`OpenFlow session connected (${a})`); });
  rig.of.on('ready', () => push('ready', ''));
  rig.of.on('disconnected', (a: string) => { push('disconnected', a); log(`OpenFlow session DISCONNECTED (${a}) - the switch will drop its flow table`); });
  rig.of.on('deadPeerTimeout', (a: string) => { push('deadPeerTimeout', a); log(`controller dead-peer timeout: no message from the switch (${a})`); });
  rig.of.on('echoLatency', (ns: bigint) => push('echoLatency', ns));
  rig.of.on('rawMessage', () => {
    const now = nowNs();
    // The switch is silent between heartbeats by design, so a long gap is NOT by itself a stall; echoLatency is the signal.
    if (lastRx > 0n && now - lastRx > NS_PER_SECOND) push('silence', now - lastRx);
    lastRx = now;
  });
  // The built-in heartbeat is ~15 s apart; probe the switch CPU once a second so a stall is visible as a slow or missing echo.
  setInterval(() => rig.of.pingEcho(), 1000).unref();
  return events;
}

/** Waits for the switch to reconnect (it redials on its own) and returns how long that took. */
async function awaitReconnect(rig: Rig, timeoutMs: number): Promise<bigint> {
  const t0 = nowNs();
  while (rig.of.metrics.state !== 'ESTABLISHED') {
    if (nowNs() - t0 > BigInt(timeoutMs) * 1_000_000n) throw new Error(`switch did not reconnect within ${timeoutMs} ms`);
    await sleep(100);
  }
  return nowNs() - t0;
}

/**
 * After a load ends, waits for the switch to prove its control plane is alive (an echo reply) or lose its session.
 * A stall that began under load can surface seconds after the load stops (the controller's dead-peer rule is 8 s).
 */
async function awaitControlPlane(
  rig: Rig, events: readonly SessionEvent[], afterNs: bigint, maxMs: number,
): Promise<{ lost: boolean; echoRecoveryNs: bigint | null }> {
  const t0 = nowNs();
  while (nowNs() - t0 < BigInt(maxMs) * 1_000_000n) {
    if (rig.of.metrics.state !== 'ESTABLISHED') return { lost: true, echoRecoveryNs: null };
    const e = events.find((x) => x.event === 'echoLatency' && x.tNs > afterNs);
    if (e !== undefined) return { lost: false, echoRecoveryNs: e.tNs - afterNs };
    await sleep(200);
  }
  return { lost: rig.of.metrics.state !== 'ESTABLISHED', echoRecoveryNs: null };
}

/** If the switch lost its session during/after a trial, wait for the redial and restore the plan. Returns whether it was lost. */
async function recoverIfLost(
  rig: Rig, plan: DepthPlan, allowUnverified: boolean, events: readonly SessionEvent[], sinceNs: bigint,
): Promise<boolean> {
  const cp = await awaitControlPlane(rig, events, nowNs(), 20_000);
  const lost = cp.lost || events.some((e) => e.event === 'disconnected' && e.tNs >= sinceNs);
  if (!lost) return false;
  log(`session lost around ${plan.condition.id}; waiting for reconnect and restoring the table`);
  await awaitReconnect(rig, 120_000);
  await applyDepthPlan(rig, plan, allowUnverified);
  await sleep(6000); // let the iperf3 server drop whatever the dead path left behind
  return true;
}

function requireSession(rig: Rig, where: string): void {
  if (rig.of.metrics.state !== 'ESTABLISHED') throw new Error(`OpenFlow session lost (${rig.of.metrics.state}) ${where}`);
}

// ---- flow install helpers --------------------------------------------------

function sendDepthFlow(of: OpenFlowServer, f: DepthFlow, command: FlowModCommand = FlowModCommand.OFPFC_ADD): void {
  const match = f.kind === 'forward' ? { inPort: f.inPort } : { srcIp: f.srcIp, srcIpPrefixLen: f.srcPrefixLen };
  of.sendRaw(
    buildOfpFlowMod(
      { command, priority: f.priority, outputPorts: command === FlowModCommand.OFPFC_ADD ? f.outputPorts : [], match },
      of.reserveXid(),
    ),
  );
}

function asFlowPlan(plan: DepthPlan): FlowPlan {
  return {
    flows: plan.flows.map((f) => ({
      kind: f.kind === 'forward' ? 'forward' : 'quarantine',
      priority: f.priority,
      ...(f.inPort !== undefined ? { inPort: f.inPort } : {}),
      ...(f.srcIp !== undefined ? { srcIp: f.srcIp } : {}),
      outputPorts: f.outputPorts,
    })),
    quarantineRequested: plan.condition.depth,
    quarantineInstalled: plan.condition.depth,
    clamped: false,
    forwardingRuleCount: plan.forwardingRuleCount,
    mirror: false,
  };
}

function baseCondition(id: string, depth: number): DepthCondition {
  return { id, depth, match: 'host32', priorityOrder: 'quarantine_above', installOrder: 'quarantine_first', distinctPriorities: false, hit: null };
}

/** Polls the switch table until it matches `plan` (or fails closed). Returns the last verdict, or null if unreadable and allowed. */
class SessionChanged extends Error {}

async function awaitDepthReadback(
  rig: Rig, plan: DepthPlan, allowUnverified: boolean, attempts: number, pollMs: number, epoch0?: number,
): Promise<DepthReadbackVerdict | null> {
  let verdict: DepthReadbackVerdict | null = null;
  let lastErr = '';
  // Bound the whole verification by wall-clock time: each readback can itself wait 10 s, so a poll *count* alone allows
  // minutes-to-hours of silent waiting when the switch stops answering flow-stats requests.
  const deadlineNs = nowNs() + BigInt(attempts * pollMs * 2 + 15_000) * 1_000_000n;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(pollMs);
    if (nowNs() > deadlineNs) {
      throw new Error(`condition ${plan.condition.id}: switch flow table readback timed out (deadline); last: ${lastErr || 'no reply'}`);
    }
    // The switch drops its whole table when the session drops; polling an emptied table can never succeed.
    if (epoch0 !== undefined && (rig.epoch.n !== epoch0 || rig.of.metrics.state !== 'ESTABLISHED')) {
      throw new SessionChanged(`OpenFlow session changed while verifying ${plan.condition.id}`);
    }
    try {
      const v = verifyDepthReadback(plan, await readFlows(rig.of));
      verdict = rig.switchErrors.length > 0
        ? { ...v, verified: false, mismatches: [...v.mismatches, ...rig.switchErrors] }
        : v;
      if (verdict.verified) break;
      lastErr = verdict.mismatches.join('; ');
    } catch (e: unknown) {
      lastErr = errMessage(e);
    }
  }
  if (verdict !== null && !verdict.verified) {
    throw new Error(`condition ${plan.condition.id}: switch flow table does not match plan after ${attempts} polls: ${lastErr}`);
  }
  if (verdict === null) {
    if (!allowUnverified) {
      throw new Error(
        `condition ${plan.condition.id}: cannot read back the switch flow table (${lastErr}). Refusing to report on unverified ` +
          'residency (fail-closed). Re-run with --unverified-flow-table to stamp results as unverified.',
      );
    }
    log(`WARNING: condition ${plan.condition.id} flow residency UNVERIFIED (${lastErr})`);
  }
  return verdict;
}

/**
 * Runs `fn` against a settled session and re-runs it from scratch if the session changes underneath it
 * (a switch-initiated reconnect empties its table, so a half-finished install must be redone, not polled).
 */
async function withSessionRetry<T>(
  rig: Rig, what: string, fn: (epoch: number, attempt: number) => Promise<T>, tries = 6,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    await awaitReconnect(rig, 120_000);
    if (attempt > 0) await sleep(1000);
    const epoch = rig.epoch.n;
    try {
      return await fn(epoch, attempt);
    } catch (e: unknown) {
      if (e instanceof SessionChanged || /not in ESTABLISHED|readback timed out/.test(errMessage(e))) {
        lastErr = e;
        log(`${what}: session changed mid-operation (attempt ${attempt + 1}/${tries}); retrying`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${what}: session kept changing after ${tries} attempts: ${errMessage(lastErr)}`);
}

async function applyDepthPlan(rig: Rig, plan: DepthPlan, allowUnverified: boolean): Promise<DepthReadbackVerdict | null> {
  verifyPlanAdmissible(asFlowPlan(plan)); // Invariant 4: before anything touches the switch
  const c = plan.condition;
  log(`installing ${c.id}: depth ${c.depth} ${c.match} ${c.priorityOrder}/${c.installOrder}${c.hit ? ` hit:${c.hit}` : ''}${c.distinctPriorities ? ' distinct' : ''}`);
  return withSessionRetry(rig, `install ${c.id}`, async (epoch) => {
    rig.switchErrors.length = 0;
    await deleteAllFlows(rig.of);
    for (const f of plan.flows) sendDepthFlow(rig.of, f);
    return awaitDepthReadback(rig, plan, allowUnverified, 30, 1000, epoch);
  });
}

async function checkNoBenignHits(rig: Rig, plan: DepthPlan): Promise<void> {
  const v = verifyDepthReadback(plan, await readFlows(rig.of));
  if (v.benignQuarantineHits !== 0n) {
    throw new Error(`benign quarantine rules matched ${v.benignQuarantineHits} packets in ${plan.condition.id}: results invalid`);
  }
}

// ---- workload helpers -----------------------------------------------------

const HIT_SENDER_PY = `import socket, sys, time
src, dst, port, size, secs = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
rate = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind((src, 0))
payload = b"x" * size
BATCH = 16
start = time.monotonic()
end = start + secs
n = 0
while True:
    now = time.monotonic()
    if now >= end:
        break
    if rate > 0:
        due = start + n / rate
        if now < due:
            time.sleep(min(due - now, 0.01))
            continue
    for _ in range(BATCH):
        s.sendto(payload, (dst, port))
    n += BATCH
print(n)
`;

async function setupHitSender(rig: Rig): Promise<void> {
  const b64 = Buffer.from(HIT_SENDER_PY).toString('base64');
  await ssh(rig, `echo ${b64} | base64 -d > ${HIT_SENDER_PATH}`, 10_000);
  await ssh(rig, `sudo -n ip addr add ${HIT_SRC_IP}/24 dev ${rig.piIface} 2>/dev/null || true; ip -4 -o addr show dev ${rig.piIface}`, 10_000);
  // Warm the neighbour cache so ARP resolution is not part of a measured window.
  await ssh(rig, `ping -c 2 -W 2 -I ${rig.piIp} ${rig.server} >/dev/null 2>&1 || true`, 15_000);
}

async function teardownHitSender(rig: Rig): Promise<void> {
  try {
    await ssh(rig, `sudo -n ip addr del ${HIT_SRC_IP}/24 dev ${rig.piIface} 2>/dev/null || true; rm -f ${HIT_SENDER_PATH}`, 10_000);
  } catch (e: unknown) {
    log(`WARNING: could not remove ${HIT_SRC_IP} from ${rig.piIface}: ${errMessage(e)}`);
  }
}

async function runHitFlood(rig: Rig, durationS: number, payload: number, ratePps = 0): Promise<LoadResult> {
  const t0 = nowNs();
  await ssh(rig, `timeout ${durationS + 15} python3 ${HIT_SENDER_PATH} ${HIT_SRC_IP} ${rig.server} 9 ${payload} ${durationS} ${ratePps}`, (durationS + 30) * 1000);
  return { iperf: null, rawSha256: null, wallNs: nowNs() - t0 };
}

async function runTcpTest(rig: Rig, durationS: number): Promise<LoadResult> {
  return runIperf(rig, 'tcp', durationS, null);
}

// ---- one measured depth window --------------------------------------------

interface DepthTrialRecord {
  readonly ordinal: number;
  readonly conditionId: string;
  readonly test: DepthTestKind;
  readonly payloadBytes: number | null;
  readonly offeredBps: bigint | null;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly nominalWindowNs: bigint;
  readonly wallNs: bigint;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly metrics: DerivedMetrics | null;
  /** Packets the intentional hit rule counted during the window (drop_hit only). */
  readonly hitRulePackets: bigint | null;
  readonly portDeltas: PortDeltas | null;
  readonly iperfRawSha256: string | null;
  readonly rawPortsBefore: string;
  readonly rawPortsAfter: string;
  /** The switch dropped its OpenFlow session (and table) during or just after this trial; its numbers are suspect. */
  readonly sessionLost: boolean;
}

let depthOrdinal = 0;

async function measureDepth(
  rig: Rig,
  plan: DepthPlan,
  a: { readonly test: DepthTestKind; readonly durationS: number; readonly payloadBytes: number | null; readonly offeredBps: bigint | null; readonly load: () => Promise<LoadResult> },
): Promise<DepthTrialRecord> {
  const ordinal = ++depthOrdinal;
  const nominalWindowNs = BigInt(a.durationS) * NS_PER_SECOND;
  const startNs = nowNs();
  const conditionId = plan.condition.id;
  let rawBefore = '';
  let rawAfter = '';
  const invalid = (reason: string): DepthTrialRecord => ({
    ordinal, conditionId, test: a.test, payloadBytes: a.payloadBytes, offeredBps: a.offeredBps, startNs, endNs: nowNs(),
    nominalWindowNs, wallNs: 0n, valid: false, invalidReason: reason, metrics: null, hitRulePackets: null, portDeltas: null,
    iperfRawSha256: null, rawPortsBefore: rawBefore, rawPortsAfter: rawAfter, sessionLost: false,
  });
  try {
    const hitBefore = plan.hitPriority === null ? null : verifyDepthReadback(plan, await readFlows(rig.of)).hitRulePackets;
    const before = await readPorts(rig.serial);
    rawBefore = before.raw;
    const nicBefore = await readNics(rig);
    const load = await a.load();
    const nicAfter = await readNics(rig);
    const after = await readPorts(rig.serial);
    rawAfter = after.raw;
    const hitAfter = plan.hitPriority === null ? null : verifyDepthReadback(plan, await readFlows(rig.of)).hitRulePackets;

    if (load.wallNs < nominalWindowNs) return invalid(`load ended early: wall ${load.wallNs} ns < nominal ${nominalWindowNs} ns`);
    const diff = diffPorts(before.ports, after.ports, [PORT_WORKLOAD, PORT_UPLINK]);
    if (!diff.ok) return invalid(diff.reason);
    const endpoint = {
      workloadTxPackets: nicAfter.workloadTxPackets - nicBefore.workloadTxPackets,
      workloadTxBytes: nicAfter.workloadTxBytes - nicBefore.workloadTxBytes,
      tapRxPackets: null,
      tapRxDropped: null,
    };
    if (endpoint.workloadTxPackets < 0n) return invalid('endpoint NIC counter regressed');
    const metrics = deriveMetrics({
      windowNs: nominalWindowNs, deltas: diff.deltas, iperf: load.iperf,
      udpPayloadBytes: a.payloadBytes === null ? null : BigInt(a.payloadBytes), endpoint, mirrorEnabled: false,
    });
    return {
      ordinal, conditionId, test: a.test, payloadBytes: a.payloadBytes, offeredBps: a.offeredBps, startNs, endNs: nowNs(),
      nominalWindowNs, wallNs: load.wallNs, valid: true, invalidReason: null, metrics,
      hitRulePackets: hitBefore !== null && hitAfter !== null ? hitAfter - hitBefore : null,
      portDeltas: diff.deltas, iperfRawSha256: load.rawSha256, rawPortsBefore: before.raw, rawPortsAfter: after.raw,
      sessionLost: false,
    };
  } catch (e: unknown) {
    return invalid(errMessage(e));
  }
}

function loadFor(rig: Rig, test: DepthTestKind, durationS: number): {
  load: () => Promise<LoadResult>; payloadBytes: number | null; offeredBps: bigint | null;
} {
  if (test === 'tcp') return { load: () => runTcpTest(rig, durationS), payloadBytes: null, offeredBps: null };
  if (test === 'drop_hit') {
    return { load: () => runHitFlood(rig, durationS, UDP_P572_PAYLOAD), payloadBytes: UDP_P572_PAYLOAD, offeredBps: null };
  }
  const s = udpTestSpec(test);
  return {
    load: () => runIperf(rig, 'udp', durationS, { bps: s.bps, payloadBytes: s.payload }),
    payloadBytes: s.payload, offeredBps: s.bps,
  };
}

// ---- artifact plumbing ------------------------------------------------------

async function depthProvenance(args: {
  readonly command: string;
  readonly startedAtIso: string;
  readonly startedMonotonicNs: bigint;
  readonly identity: BenchArtifact['provenance']['switchIdentity'];
  readonly workload: BenchArtifact['provenance']['workload'];
  readonly rig: Rig;
  readonly flowTableVerified: boolean;
}): Promise<Record<string, unknown>> {
  const git = await gitInfo();
  return {
    schema: DEPTH_SCHEMA,
    origin: 'physical_bench_run',
    command: args.command,
    startedAtIso: args.startedAtIso,
    startedMonotonicNs: args.startedMonotonicNs,
    finishedMonotonicNs: nowNs(),
    controllerHost: { hostname: os.hostname(), platform: process.platform, arch: process.arch, nodeVersion: process.version },
    switchIdentity: args.identity,
    workload: args.workload,
    iperfServer: args.rig.server,
    tool: { scriptSha256: sha256(await fs.readFile(new URL(import.meta.url).pathname)), gitCommit: git.commit, gitDirty: git.dirty },
    flowTableVerified: args.flowTableVerified,
    counterSource: COUNTER_SOURCE,
  };
}

async function writeDepthArtifact(cli: Cli, name: string, startedAtIso: string, body: Record<string, unknown>): Promise<string> {
  const outDir = cli.flags.get('out') ?? DEFAULT_DEPTH_OUT_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${name}-${startedAtIso.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(body, jsonReplacer, 2), 'utf8');
  log(`artifact written: ${file}`);
  return file;
}

function installAbortHandler(rig: Rig): void {
  process.once('SIGINT', () => {
    log('interrupted: clearing flow table (fail-closed default-drop) and exiting');
    deleteAllFlows(rig.of).finally(() => process.exit(130));
  });
}

// ---- sweep ---------------------------------------------------------------------

interface SweepItem {
  readonly cond: DepthCondition;
  readonly tests: readonly DepthTestKind[];
  readonly group: 'depth' | 'variant';
}

interface SweepConfig {
  readonly durationS: number;
  readonly trials: number;
  readonly gapS: number;
  readonly allowUnverified: boolean;
  readonly items: readonly SweepItem[];
}

function buildSweepConfig(cli: Cli): SweepConfig {
  const depths = parseIntList(cli.flags.get('depths') ?? '0,1,2,4,8,16,24,32,48,64,96,126', '--depths');
  const variantDepths = parseIntList(cli.flags.get('variant-depths') ?? '32,126', '--variant-depths');
  const tests = parseTestList(cli.flags.get('tests') ?? 'udp_p64,udp_p572,udp_p1470,tcp', '--tests');
  const variantTests = parseTestList(cli.flags.get('variant-tests') ?? 'udp_p572', '--variant-tests');
  const items: SweepItem[] = [];
  if (!cli.switches.has('skip-depths')) {
    for (const d of depths) items.push({ cond: baseCondition(`d${d}`, d), tests, group: 'depth' });
  }
  if (!cli.switches.has('skip-variants')) {
    for (const d of variantDepths) {
      const b = baseCondition('', d);
      const mk = (id: string, over: Partial<DepthCondition>): SweepItem => ({ cond: { ...b, id: `d${d}-${id}`, ...over }, tests: variantTests, group: 'variant' });
      items.push(mk('distinct', { distinctPriorities: true }));
      items.push(mk('fwdabove', { priorityOrder: 'forward_above' }));
      items.push(mk('fwdfirst', { installOrder: 'forward_first' }));
      items.push(mk('fwdabove-fwdfirst', { priorityOrder: 'forward_above', installOrder: 'forward_first' }));
      items.push(mk('net16', { match: 'net16' }));
      if (!cli.switches.has('skip-hit') && d >= 1) {
        for (const hp of ['first', 'middle', 'last'] as const) {
          items.push({ cond: { ...b, id: `d${d}-hit${hp}`, hit: hp, distinctPriorities: true }, tests: ['drop_hit'], group: 'variant' });
        }
      }
    }
  }
  return {
    durationS: intFlag(cli, 'duration', 10),
    trials: intFlag(cli, 'trials', 4),
    gapS: intFlag(cli, 'gap-seconds', 2),
    allowUnverified: cli.switches.has('unverified-flow-table'),
    items,
  };
}

/** Rough wall-clock estimate; real runs add serial/ssh latency (measured ~3-5 s per trial in the first benchmark). */
function estimateSweepSeconds(cfg: SweepConfig): number {
  let s = 0;
  for (const it of cfg.items) s += cfg.trials * (6 + it.tests.length * (cfg.durationS + cfg.gapS + 4));
  return s;
}

async function cmdPlan(cli: Cli): Promise<void> {
  const cfg = buildSweepConfig(cli);
  const w = intFlag(cli, 'window-seconds', 300);
  const total = intFlag(cli, 'total-seconds', 3600);
  const out: string[] = [];
  out.push(`SWEEP: ${cfg.items.length} conditions x ${cfg.trials} rounds, ${cfg.durationS}s windows, ${cfg.gapS}s gap`);
  for (const it of cfg.items) {
    const p = planDepthCondition(it.cond, HIT_SRC_IP); // throws on an invalid layout
    out.push(`  ${it.cond.id.padEnd(22)} ${String(p.flows.length).padStart(3)} flows  tests: ${it.tests.join(',')}`);
  }
  const trialCount = cfg.items.reduce((n, it) => n + it.tests.length, 0) * cfg.trials;
  out.push(`  total trials: ${trialCount}; estimated ${Math.round(estimateSweepSeconds(cfg) / 60)} min`);
  const ladderDepths = parseIntList(cli.flags.get('ladder-depths') ?? '0,16,32,64,126', '--ladder-depths').length;
  const ladderRates = parseIntList(cli.flags.get('rates-pps') ?? '500,1000,2000,4000,6000,8000,10000,12000,15000', '--rates-pps').length;
  const ladderStep = intFlag(cli, 'step-seconds', 45);
  out.push(`LADDER: ${ladderDepths} depths x up to ${ladderRates} rates x ${ladderStep}s (stops early at saturation/session loss); at most ~${Math.round((ladderDepths * ladderRates * (ladderStep + 8)) / 60)} min per round`);
  out.push(`WORKDAY: ${total / w} windows of ${w}s per profile; profiles ${JSON.stringify(WORKDAY_PROFILES)}; ~${Math.round((total + 60 * (total / w)) / 60)} min each`);
  const naive = naiveLineRatePps(PORT_LINK_BPS, 600n);
  const framed = framedLineRatePps(PORT_LINK_BPS, BigInt(UDP_P572_PAYLOAD));
  out.push(`THEORY: 100 Mbit/s / (600 B x 8) = ${naive} pps (roadmap); with Ethernet framing a 600 B IP packet gives ${framed} pps`);
  process.stdout.write(out.join('\n') + '\n');
}

async function cmdSweep(cli: Cli): Promise<void> {
  await assertCleanGit(cli);
  const cfg = buildSweepConfig(cli);
  if (cfg.items.length === 0) throw new Error('sweep: nothing to run (all groups skipped)');
  for (const it of cfg.items) planDepthCondition(it.cond, HIT_SRC_IP); // validate every layout before touching hardware
  const startedMonotonicNs = nowNs();
  const startedAtIso = new Date().toISOString();
  log(`sweep: ${cfg.items.length} conditions x ${cfg.trials} rounds, estimated ${Math.round(estimateSweepSeconds(cfg) / 60)} min`);
  const { rig, identity, workload } = await connectRig(cli);
  installAbortHandler(rig);
  const sessionEvents = watchSession(rig);
  const conditions = new Map<string, { plan: DepthPlan; readback: DepthReadbackVerdict | null }>();
  const trials: DepthTrialRecord[] = [];
  const failedConditions: Array<{ id: string; round: number; error: string }> = [];
  let consecutiveFailures = 0;
  const needsHit = cfg.items.some((it) => it.cond.hit !== null);
  let flowTableVerified = true;
  let failure: unknown = null;
  try {
    if (needsHit) await setupHitSender(rig);
    for (let round = 0; round < cfg.trials; round++) {
      const order = round % 2 === 0 ? cfg.items : [...cfg.items].reverse(); // alternate direction to balance drift
      log(`round ${round + 1}/${cfg.trials}`);
      for (const it of order) {
        const plan = planDepthCondition(it.cond, HIT_SRC_IP);
        let readback: DepthReadbackVerdict | null;
        try {
          readback = await applyDepthPlan(rig, plan, cfg.allowUnverified);
          consecutiveFailures = 0;
        } catch (e: unknown) {
          // A condition the switch cannot hold or report (e.g. masked matches) fails alone; a dead session or a
          // run of failures aborts the sweep (fail-closed, but without discarding already-collected trials).
          if (rig.of.metrics.state !== 'ESTABLISHED' || ++consecutiveFailures >= 3) throw e;
          failedConditions.push({ id: it.cond.id, round: round + 1, error: errMessage(e) });
          log(`condition ${it.cond.id} skipped: ${errMessage(e)}`);
          continue;
        }
        if (readback === null) flowTableVerified = false;
        if (!conditions.has(it.cond.id)) conditions.set(it.cond.id, { plan, readback });
        for (const test of it.tests) {
          if (rig.of.metrics.state !== 'ESTABLISHED') {
            await awaitReconnect(rig, 120_000);
            await applyDepthPlan(rig, plan, cfg.allowUnverified);
          }
          const spec = loadFor(rig, test, cfg.durationS);
          const trial = await measureDepth(rig, plan, { test, durationS: cfg.durationS, ...spec });
          const lost = await recoverIfLost(rig, plan, cfg.allowUnverified, sessionEvents, trial.startNs);
          trials.push(lost ? { ...trial, sessionLost: true } : trial);
          if (cfg.gapS > 0) await sleep(cfg.gapS * 1000);
        }
        if (readback !== null) await checkNoBenignHits(rig, plan);
      }
    }
  } catch (e: unknown) {
    failure = e;
    log(`ABORTED: ${errMessage(e)}`);
  } finally {
    try {
      await deleteAllFlows(rig.of);
      log('flow table cleared; restart zodiac-bridge.service to restore production rules');
    } catch (e: unknown) {
      log(`WARNING: could not clear flow table: ${errMessage(e)}`);
    }
    if (needsHit) await teardownHitSender(rig);
    await rig.of.close();
  }
  await writeDepthArtifact(cli, 'depth-sweep', startedAtIso, {
    provenance: await depthProvenance({ command: 'sweep', startedAtIso, startedMonotonicNs, identity, workload, rig, flowTableVerified }),
    params: {
      durationSeconds: cfg.durationS, trials: cfg.trials, gapSeconds: cfg.gapS,
      udpP64Pps: UDP_P64_PPS, udpP572Payload: UDP_P572_PAYLOAD, hitSrcIp: HIT_SRC_IP,
      naiveLineRatePps600: naiveLineRatePps(PORT_LINK_BPS, 600n),
      framedLineRatePps600: framedLineRatePps(PORT_LINK_BPS, BigInt(UDP_P572_PAYLOAD)),
    },
    conditions: [...conditions.values()].map((c) => ({
      id: c.plan.condition.id, group: cfg.items.find((i) => i.cond.id === c.plan.condition.id)?.group ?? null,
      condition: c.plan.condition, flowCount: c.plan.flows.length, hitPriority: c.plan.hitPriority, readback: c.readback,
    })),
    failedConditions,
    sessionEvents,
    trials,
  });
  if (failure !== null) throw failure;
}

// ---- blackout ------------------------------------------------------------------

type FlushMode = 'none' | 'wipe' | 'selective';

/**
 * Removes the quarantine rules of `from` and leaves forwarding intact (selective), or wipes the whole
 * table and re-adds forwarding (wipe). Returns after the FLOW_MODs are sent; callers poll for residency.
 */
function sendFlush(rig: Rig, mode: FlushMode, from: DepthPlan, to: DepthPlan): void {
  if (mode === 'none') return;
  if (mode === 'wipe') {
    void deleteAllFlows(rig.of);
    for (const f of to.flows) sendDepthFlow(rig.of, f);
    return;
  }
  for (const f of from.flows) if (f.kind !== 'forward') sendDepthFlow(rig.of, f, FlowModCommand.OFPFC_DELETE_STRICT);
}

interface BlackoutRecord {
  readonly depth: number;
  readonly mode: FlushMode;
  readonly loaded: boolean;
  readonly rep: number;
  /** Time from sending the flush until the switch reports the post-flush table. null if never verified. */
  readonly flushToVerifiedNs: bigint | null;
  readonly flushSendNs: bigint;
  readonly pingSent: number | null;
  readonly pingReceived: number;
  readonly maxGapUs: bigint | null;
  readonly gaps: ReadonlyArray<{ startUs: bigint; durationUs: bigint }>;
  readonly error: string | null;
}

async function cmdBlackout(cli: Cli): Promise<void> {
  await assertCleanGit(cli);
  const reps = intFlag(cli, 'reps', 3);
  const depths = parseIntList(cli.flags.get('depths') ?? '0,126', '--depths');
  const modes = (cli.flags.get('modes') ?? 'none,wipe,selective').split(',').map((m) => m.trim() as FlushMode);
  for (const m of modes) if (!['none', 'wipe', 'selective'].includes(m)) throw new Error(`--modes: unknown mode '${m}'`);
  const loads = (cli.flags.get('loads') ?? 'idle,udp').split(',').map((m) => m.trim());
  for (const l of loads) if (l !== 'idle' && l !== 'udp') throw new Error(`--loads: unknown load '${l}'`);
  const loadPps = intFlag(cli, 'load-pps', 1000); // below capacity even at 126 rules (see the rate ladder)
  const runS = intFlag(cli, 'run-seconds', 16);
  const preS = intFlag(cli, 'pre-seconds', 5);
  const allowUnverified = cli.switches.has('unverified-flow-table');
  const gapThresholdUs = 100_000n;
  const startedMonotonicNs = nowNs();
  const startedAtIso = new Date().toISOString();
  const { rig, identity, workload } = await connectRig(cli);
  installAbortHandler(rig);
  const sessionEvents = watchSession(rig);
  const records: BlackoutRecord[] = [];
  let failure: unknown = null;
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const depth of depths) {
        for (const mode of modes) {
          if (mode === 'selective' && depth === 0) continue; // nothing to remove selectively
          for (const load of loads) {
            const plan = planDepthCondition(baseCondition(`blackout-d${depth}`, depth));
            const after = planDepthCondition(baseCondition('blackout-after', 0));
            if (rig.of.metrics.state !== 'ESTABLISHED') await awaitReconnect(rig, 120_000);
            await applyDepthPlan(rig, plan, allowUnverified);
            const udpBps = BigInt(loadPps) * BigInt(UDP_P572_PAYLOAD) * 8n;
            const pingCount = runS * 100;
            const pingP = ssh(rig, `sudo -n ping -D -i 0.01 -c ${pingCount} -I ${rig.piIface} ${rig.server} 2>&1 || true`, (runS + 30) * 1000);
            const loadP: Promise<unknown> = load === 'udp'
              ? runIperf(rig, 'udp', runS - 1, { bps: udpBps, payloadBytes: UDP_P572_PAYLOAD }).catch((e: unknown) => errMessage(e))
              : Promise.resolve(null);
            await sleep(preS * 1000);
            const flushSendNs = nowNs();
            let flushToVerifiedNs: bigint | null = null;
            let error: string | null = null;
            try {
              sendFlush(rig, mode, plan, after);
              if (mode !== 'none') {
                await awaitDepthReadback(rig, after, false, 200, 100);
                flushToVerifiedNs = nowNs() - flushSendNs;
              }
            } catch (e: unknown) {
              error = errMessage(e);
            }
            const pingOut = await pingP;
            await loadP;
            const g = analyzePingGaps(pingOut, gapThresholdUs);
            records.push({
              depth, mode, loaded: load === 'udp', rep, flushToVerifiedNs, flushSendNs, pingSent: g.sent,
              pingReceived: g.received, maxGapUs: g.maxGapUs, gaps: g.gaps, error,
            });
            log(`blackout depth=${depth} mode=${mode} load=${load} rep=${rep + 1}: max ping gap ${g.maxGapUs === null ? 'n/a' : `${g.maxGapUs / 1000n} ms`}, flush->verified ${flushToVerifiedNs === null ? 'n/a' : `${flushToVerifiedNs / 1_000_000n} ms`}${error ? ` ERROR ${error}` : ''}`);
            await sleep(2000);
          }
        }
      }
    }
  } catch (e: unknown) {
    failure = e;
    log(`ABORTED: ${errMessage(e)}`);
  } finally {
    try {
      await deleteAllFlows(rig.of);
      log('flow table cleared; restart zodiac-bridge.service to restore production rules');
    } catch (e: unknown) {
      log(`WARNING: could not clear flow table: ${errMessage(e)}`);
    }
    await rig.of.close();
  }
  await writeDepthArtifact(cli, 'depth-blackout', startedAtIso, {
    provenance: await depthProvenance({ command: 'blackout', startedAtIso, startedMonotonicNs, identity, workload, rig, flowTableVerified: !allowUnverified }),
    params: { reps, depths, modes, loads, loadPps, runSeconds: runS, preSeconds: preS, pingIntervalMs: 10, gapThresholdUs },
    records,
    sessionEvents,
  });
  if (failure !== null) throw failure;
}

// ---- rate ladder ----------------------------------------------------------------

type LadderLayout = 'base' | 'fwdfirst' | 'fwdabove' | 'fwdinstall' | 'net16' | 'distinct' | 'hitfirst' | 'hitmiddle' | 'hitlast';
const LADDER_LAYOUTS: readonly LadderLayout[] = ['base', 'fwdfirst', 'fwdabove', 'fwdinstall', 'net16', 'distinct', 'hitfirst', 'hitmiddle', 'hitlast'];

interface LadderStep {
  readonly round: number;
  readonly depth: number;
  readonly layout: LadderLayout;
  readonly offeredPps: bigint;
  readonly trial: DepthTrialRecord;
  /** The switch dropped the OpenFlow session (and its table) during this step. */
  readonly sessionLost: boolean;
  /** Why the climb at this depth stopped after this step, if it did. */
  readonly stopped: 'session_lost' | 'saturated' | 'invalid' | null;
  /** Time to reconnect and restore the table after a loss. */
  readonly recoveryNs: bigint | null;
  /** After the load ended, how long until the switch answered an echo again (CPU recovery from overload). null if it never did. */
  readonly echoRecoveryNs: bigint | null;
}

function ladderCondition(depth: number, layout: LadderLayout): DepthCondition {
  const b = baseCondition(`ladder-${layout}-d${depth}`, depth);
  switch (layout) {
    case 'fwdfirst': return { ...b, priorityOrder: 'forward_above', installOrder: 'forward_first' };
    case 'fwdabove': return { ...b, priorityOrder: 'forward_above' };
    case 'fwdinstall': return { ...b, installOrder: 'forward_first' };
    case 'net16': return { ...b, match: 'net16' };
    case 'distinct': return { ...b, distinctPriorities: true };
    case 'hitfirst': return { ...b, distinctPriorities: true, hit: 'first' };
    case 'hitmiddle': return { ...b, distinctPriorities: true, hit: 'middle' };
    case 'hitlast': return { ...b, distinctPriorities: true, hit: 'last' };
    default: return b;
  }
}

/**
 * Control for the sweep: at each rule depth, hold the offered 600 B UDP packet rate at increasing fixed values.
 * Below the switch's capacity the forwarded rate should equal the offered rate and any receiver loss is downstream
 * (Wi-Fi extender / receiver); above it the forwarded rate flattens at the switch limit. Echo latency in the session
 * events shows whether the switch CPU is still answering the controller.
 */
async function cmdLadder(cli: Cli): Promise<void> {
  await assertCleanGit(cli);
  const depths = parseIntList(cli.flags.get('depths') ?? '0,16,32,64,126', '--depths');
  const rates = parseIntList(cli.flags.get('rates-pps') ?? '500,1000,2000,4000,6000,8000,10000,12000,15000', '--rates-pps');
  const stepS = intFlag(cli, 'step-seconds', 45);
  const rounds = intFlag(cli, 'rounds', 1);
  const gapS = intFlag(cli, 'gap-seconds', 2);
  const layoutRaw = cli.flags.get('layout') ?? 'base';
  if (!LADDER_LAYOUTS.includes(layoutRaw as LadderLayout)) throw new Error(`--layout must be one of ${LADDER_LAYOUTS.join(', ')}`);
  const layout = layoutRaw as LadderLayout;
  const payload = intFlag(cli, 'payload', UDP_P572_PAYLOAD);
  if (payload < 18 || payload > 1472) throw new Error('--payload must be 18..1472 bytes');
  const isHit = layout.startsWith('hit');
  const testLabel: DepthTestKind = isHit ? 'drop_hit' : payload === 64 ? 'udp_p64' : payload === 1470 ? 'udp_p1470' : 'udp_p572';
  if (rates.length === 0 || depths.length === 0) throw new Error('ladder: --depths and --rates-pps must not be empty');
  if (stepS < 10) throw new Error('--step-seconds must be >= 10');
  const allowUnverified = cli.switches.has('unverified-flow-table');
  for (const d of depths) planDepthCondition(ladderCondition(d, layout), HIT_SRC_IP); // validate before touching hardware
  const startedMonotonicNs = nowNs();
  const startedAtIso = new Date().toISOString();
  log(`ladder: ${depths.length} depths x up to ${rates.length} rates x ${stepS}s, ${rounds} round(s), layout ${layout}`);
  const { rig, identity, workload } = await connectRig(cli);
  installAbortHandler(rig);
  const sessionEvents = watchSession(rig);
  const steps: LadderStep[] = [];
  let flowTableVerified = true;
  let failure: unknown = null;
  try {
    if (isHit) await setupHitSender(rig);
    for (let round = 0; round < rounds; round++) {
      for (const depth of depths) {
        const plan = planDepthCondition(ladderCondition(depth, layout), HIT_SRC_IP);
        if ((await applyDepthPlan(rig, plan, allowUnverified)) === null) flowTableVerified = false;
        let saturatedSteps = 0;
        let invalidSteps = 0;
        for (const rate of rates) {
          requireSession(rig, `before ladder d${depth} @${rate} pps`);
          const pps = BigInt(rate);
          const bps = pps * BigInt(payload) * 8n;
          const runStep = (): Promise<DepthTrialRecord> => measureDepth(rig, plan, {
            test: testLabel, durationS: stepS, payloadBytes: payload, offeredBps: bps,
            load: isHit ? () => runHitFlood(rig, stepS, payload, rate) : () => runIperf(rig, 'udp', stepS, { bps, payloadBytes: payload }),
          });
          let trial = await runStep();
          if (!trial.valid && /server is busy/.test(trial.invalidReason ?? '')) {
            // A client killed in an earlier step can leave the server mid-test; give it time to reset and retry once.
            log(`ladder d${depth} @${rate} pps: iperf3 server busy, retrying once`);
            await sleep(6000);
            trial = await runStep();
          }
          const cp = await awaitControlPlane(rig, sessionEvents, trial.endNs, 20_000);
          const sessionLost =
            cp.lost || sessionEvents.some((e) => e.event === 'disconnected' && e.tNs >= trial.startNs);
          let stopped: LadderStep['stopped'] = null;
          let recoveryNs: bigint | null = null;
          if (sessionLost) {
            stopped = 'session_lost';
            const tR = nowNs();
            await awaitReconnect(rig, 120_000);
            if ((await applyDepthPlan(rig, plan, allowUnverified)) === null) flowTableVerified = false;
            recoveryNs = nowNs() - tR;
            await sleep(6000); // let the iperf3 server drop the test the dead path left behind
          } else if (!trial.valid || trial.metrics === null) {
            if (++invalidSteps >= 2) stopped = 'invalid';
          } else {
            // Forwarding layouts: what left Port 2. Drop-hit layouts: what the DROP rule counted (nothing is forwarded).
            const handled = isHit
              ? (trial.hitRulePackets === null ? 0n : perSecond(trial.hitRulePackets, trial.nominalWindowNs))
              : trial.metrics.switchPort2TxPps;
            if (handled * 100n < pps * 90n && ++saturatedSteps >= 2) stopped = 'saturated';
          }
          steps.push({ round: round + 1, depth, layout, offeredPps: pps, trial, sessionLost, stopped, recoveryNs, echoRecoveryNs: cp.echoRecoveryNs });
          const m = trial.metrics;
          log(`ladder d${depth} offered ${rate} pps: ${m ? `p1 RX ${m.switchPort1RxPps} p2 TX ${m.switchPort2TxPps} pps, receiver loss ${m.iperfLossPpm ?? 'n/a'} ppm` : `INVALID ${trial.invalidReason}`}${sessionLost ? ' SESSION LOST' : ''}${cp.echoRecoveryNs !== null ? ` echo back in ${cp.echoRecoveryNs / 1_000_000n} ms` : ''}${stopped ? ` -> stop (${stopped})` : ''}`);
          if (stopped !== null) break;
          if (gapS > 0) await sleep(gapS * 1000);
        }
        await checkNoBenignHits(rig, plan).catch((e: unknown) => log(`WARNING: post-depth hit check: ${errMessage(e)}`));
      }
    }
  } catch (e: unknown) {
    failure = e;
    log(`ABORTED: ${errMessage(e)}`);
  } finally {
    try {
      await deleteAllFlows(rig.of);
      log('flow table cleared; restart zodiac-bridge.service to restore production rules');
    } catch (e: unknown) {
      log(`WARNING: could not clear flow table: ${errMessage(e)}`);
    }
    if (isHit) await teardownHitSender(rig);
    await rig.of.close();
  }
  await writeDepthArtifact(cli, `depth-ladder-${layout}${payload === UDP_P572_PAYLOAD ? '' : `-p${payload}`}`, startedAtIso, {
    provenance: await depthProvenance({ command: 'ladder', startedAtIso, startedMonotonicNs, identity, workload, rig, flowTableVerified }),
    params: {
      depths, ratesPps: rates, stepSeconds: stepS, rounds, gapSeconds: gapS, layout, udpPayloadBytes: payload,
      ofDeadPeerMs: cli.flags.get('of-dead-peer-ms') ?? 'default(8000)',
      framedLineRatePps600: framedLineRatePps(PORT_LINK_BPS, BigInt(UDP_P572_PAYLOAD)),
    },
    steps,
    sessionEvents,
  });
  if (failure !== null) throw failure;
}

// ---- working-window simulation -------------------------------------------------

interface WorkdaySample {
  readonly offsetMs: number;
  readonly rules: number;
  readonly dtNs: bigint;
  readonly p1RxPackets: bigint;
  readonly p2TxPackets: bigint;
  readonly p1RxBytes: bigint;
  readonly p2TxBytes: bigint;
  readonly p1RxDropped: bigint;
  readonly p2TxDropped: bigint;
  readonly p1RxPps: bigint;
  readonly p2TxPps: bigint;
}

interface IperfIntervalBytes {
  readonly bytes: bigint;
  readonly packets: bigint | null;
}

function iperfIntervals(json: unknown): IperfIntervalBytes[] {
  if (typeof json !== 'object' || json === null) return [];
  const iv = (json as { intervals?: unknown }).intervals;
  if (!Array.isArray(iv)) return [];
  const out: IperfIntervalBytes[] = [];
  for (const x of iv) {
    const sum = (x as { sum?: { bytes?: unknown; packets?: unknown } }).sum;
    if (sum === undefined || typeof sum.bytes !== 'number') continue;
    out.push({ bytes: BigInt(Math.trunc(sum.bytes)), packets: typeof sum.packets === 'number' ? BigInt(Math.trunc(sum.packets)) : null });
  }
  return out;
}

interface FlowSummary {
  readonly error: string | null;
  readonly intervals: readonly IperfIntervalBytes[];
  readonly end: IperfTcpResult | IperfUdpResult | null;
  readonly rawSha256: string | null;
}

async function runLongIperf(
  rig: Rig, port: number, kind: 'tcp' | 'udp', seconds: number, udp: { bps: bigint; payload: number } | null,
  tcpBps: bigint | null = null,
): Promise<FlowSummary> {
  // An unlimited TCP flow is a saturating load by construction; cap it to model a bounded working flow.
  const udpArgs = kind === 'udp' && udp ? `-u -b ${udp.bps} -l ${udp.payload}` : kind === 'tcp' && tcpBps !== null && tcpBps > 0n ? `-b ${tcpBps}` : '';
  const cmd = `timeout ${seconds + 25} iperf3 -c ${rig.server} -p ${port} -B ${rig.piIp} -t ${seconds} -i 10 -J ${udpArgs}`.trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await runLongIperfOnce(rig, cmd, kind, seconds);
    // A client killed by an earlier outage can leave the server mid-test for a few seconds; retry instead of losing the window.
    if (r.error !== null && /server is busy/.test(r.error) && attempt < 2) {
      await sleep(6000);
      continue;
    }
    // The one-shot receiver restarts between clients; a client arriving in that instant is refused.
    if (r.error !== null && /Connection refused/.test(r.error) && attempt < 2) {
      await sleep(2000);
      continue;
    }
    return r;
  }
  throw new Error('unreachable');
}

async function runLongIperfOnce(rig: Rig, cmd: string, kind: 'tcp' | 'udp', seconds: number): Promise<FlowSummary> {
  try {
    let stdout: string;
    try {
      stdout = await ssh(rig, cmd, (seconds + 40) * 1000);
    } catch (e: unknown) {
      const partial = stdoutOfFailedExec(e);
      if (partial === null) throw e;
      stdout = partial;
    }
    const parsed: unknown = JSON.parse(stdout);
    let end: IperfTcpResult | IperfUdpResult | null = null;
    let error: string | null = null;
    try {
      end = kind === 'tcp' ? parseIperfTcp(parsed) : parseIperfUdp(parsed);
    } catch (e: unknown) {
      error = errMessage(e);
    }
    return { error, intervals: iperfIntervals(parsed), end, rawSha256: sha256(stdout) };
  } catch (e: unknown) {
    return { error: errMessage(e), intervals: [], end: null, rawSha256: null };
  }
}

interface WorkdayWindow {
  readonly index: number;
  readonly flushMode: FlushMode;
  readonly flushSendNs: bigint | null;
  readonly flushToVerifiedNs: bigint | null;
  readonly loadStartNs: bigint;
  readonly addedAtMs: readonly number[];
  readonly samples: readonly WorkdaySample[];
  readonly verifications: ReadonlyArray<{ readonly offsetMs: number; readonly rules: number; readonly verified: boolean; readonly benignHits: bigint; readonly mismatches: readonly string[] }>;
  readonly udp: FlowSummary;
  readonly tcp: FlowSummary;
  /** Times the switch dropped the OpenFlow session (and its table) mid-window, and how recovery went. */
  readonly sessionLosses: ReadonlyArray<{ readonly offsetMs: number; readonly rules: number; readonly reconnectNs: bigint; readonly reinstallNs: bigint }>;
}

async function cmdWorkday(cli: Cli): Promise<void> {
  await assertCleanGit(cli);
  const profileRaw = cli.flags.get('profile') ?? 'typical';
  if (!(profileRaw in WORKDAY_PROFILES)) throw new Error(`--profile must be one of ${Object.keys(WORKDAY_PROFILES).join(', ')}`);
  const profile = profileRaw as WorkdayProfile;
  const target = WORKDAY_PROFILES[profile];
  const windowS = intFlag(cli, 'window-seconds', 300);
  const totalS = intFlag(cli, 'total-seconds', 3600);
  const sampleS = intFlag(cli, 'sample-seconds', 10);
  const verifyS = intFlag(cli, 'verify-seconds', 60);
  const udpPct = intFlag(cli, 'udp-load-percent', 50);
  const tcpMbps = intFlag(cli, 'tcp-mbps', 5); // 0 = unlimited (saturating)
  const tcpBps = BigInt(tcpMbps) * 1_000_000n;
  const udpPort = intFlag(cli, 'udp-port', 5201);
  const tcpPort = intFlag(cli, 'tcp-port', 5202);
  const flushModeRaw = cli.flags.get('flush-mode') ?? 'selective';
  if (flushModeRaw !== 'wipe' && flushModeRaw !== 'selective') throw new Error('--flush-mode must be wipe or selective');
  const flushMode: FlushMode = flushModeRaw;
  if (windowS < 20 || totalS < windowS || totalS % windowS !== 0) throw new Error('--total-seconds must be a multiple of --window-seconds (>= 20)');
  if (udpPct < 1 || udpPct > 100) throw new Error('--udp-load-percent must be 1..100');
  const windows = totalS / windowS;
  const windowMs = windowS * 1000;
  const allowUnverified = cli.switches.has('unverified-flow-table');
  const offsets = rampAddOffsetsMs(target, windowMs);
  const fullPlan = planDepthCondition(baseCondition('workday-full', target));
  const quarantineFlows = fullPlan.flows.filter((f) => f.kind === 'quarantine');
  const udpPps = (framedLineRatePps(PORT_LINK_BPS, BigInt(UDP_P572_PAYLOAD)) * BigInt(udpPct)) / 100n;
  const udpSpec = { bps: udpPps * BigInt(UDP_P572_PAYLOAD) * 8n, payload: UDP_P572_PAYLOAD };

  const startedMonotonicNs = nowNs();
  const startedAtIso = new Date().toISOString();
  const { rig, identity, workload } = await connectRig(cli);
  installAbortHandler(rig);
  const sessionEvents = watchSession(rig);
  const results: WorkdayWindow[] = [];
  let failure: unknown = null;
  let flowTableVerified = true;
  try {
    log(`workday profile=${profile} (${target} rules/window) ${windows} windows x ${windowS}s, flush=${flushMode}, udp ${udpPps} pps x ${UDP_P572_PAYLOAD} B + tcp`);
    let installed = 0;
    let sessionLossCount = 0;
    let tableEpoch = rig.epoch.n;
    for (let w = 0; w < windows; w++) {
      const prevPlan = planDepthCondition(baseCondition('workday-prev', installed));
      const zero = planDepthCondition(baseCondition('workday-zero', 0));
      let flushSendNs: bigint | null = null;
      let flushToVerifiedNs: bigint | null = null;
      if (w === 0) {
        verifyPlanAdmissible(asFlowPlan(fullPlan));
        const v0 = await withSessionRetry(rig, 'initial table', async (epoch) => {
          rig.switchErrors.length = 0;
          await deleteAllFlows(rig.of);
          for (const f of zero.flows) sendDepthFlow(rig.of, f);
          return awaitDepthReadback(rig, zero, allowUnverified, 30, 1000, epoch);
        });
        if (v0 === null) flowTableVerified = false;
        tableEpoch = rig.epoch.n;
        // Probe only now: with forwarding installed the path is live (an empty table is default-drop).
        for (const port of [udpPort, tcpPort]) {
          const probe = await runLongIperf(rig, port, 'tcp', 1, null);
          if (probe.error !== null) {
            throw new Error(`iperf3 server not reachable on port ${port} (start: iperf3 -s -B ${rig.server} -p ${port}): ${probe.error}`);
          }
        }
      } else {
        flushSendNs = nowNs();
        await withSessionRetry(rig, `flush before window ${w + 1}`, async (epoch, attempt) => {
          if (attempt === 0 && epoch === tableEpoch) sendFlush(rig, flushMode, prevPlan, zero);
          else {
            // The table is already gone (session changed since we installed it): rebuild forwarding from nothing.
            await deleteAllFlows(rig.of);
            for (const f of zero.flows) sendDepthFlow(rig.of, f);
          }
          await awaitDepthReadback(rig, zero, allowUnverified, 300, 100, epoch);
        });
        tableEpoch = rig.epoch.n;
        flushToVerifiedNs = nowNs() - flushSendNs;
      }
      installed = 0;
      log(`window ${w + 1}/${windows}: table reset${flushToVerifiedNs === null ? '' : ` in ${flushToVerifiedNs / 1_000_000n} ms`}; starting load`);

      const udpP = runLongIperf(rig, udpPort, 'udp', windowS, udpSpec);
      const tcpP = runLongIperf(rig, tcpPort, 'tcp', windowS, null, tcpBps);
      const t0 = nowNs();
      const samples: WorkdaySample[] = [];
      const verifications: WorkdayWindow['verifications'][number][] = [];
      const addedAtMs: number[] = [];
      const sessionLosses: WorkdayWindow['sessionLosses'][number][] = [];
      let prev = await readPorts(rig.serial);
      let prevMid = (prev.readStartNs + prev.readEndNs) / 2n;
      let nextSample = sampleS * 1000;
      let nextVerify = verifyS * 1000;
      for (;;) {
        const elapsedMs = Number((nowNs() - t0) / 1_000_000n);
        if (elapsedMs >= windowMs) break;
        if (rig.of.metrics.state !== 'ESTABLISHED' || rig.epoch.n !== tableEpoch) {
          // The switch dropped the session and with it the whole table. Do what a production controller must:
          // wait for the redial, re-sync every rule installed so far, and keep going. The outage is the finding.
          if (++sessionLossCount > 40 * windows) throw new Error('too many OpenFlow session losses; aborting');
          const lossAt = elapsedMs;
          log(`window ${w + 1} @${lossAt}ms: OpenFlow session lost with ${installed} rules; waiting for reconnect`);
          const reconnectNs = await awaitReconnect(rig, 120_000);
          const resync = planDepthCondition(baseCondition('workday-resync', installed));
          const tR = nowNs();
          await withSessionRetry(rig, `resync window ${w + 1}`, async (epoch) => {
            rig.switchErrors.length = 0;
            await deleteAllFlows(rig.of);
            for (const f of resync.flows) sendDepthFlow(rig.of, f);
            await awaitDepthReadback(rig, resync, allowUnverified, 300, 100, epoch);
          });
          tableEpoch = rig.epoch.n;
          const reinstallNs = nowNs() - tR;
          sessionLosses.push({ offsetMs: lossAt, rules: installed, reconnectNs, reinstallNs });
          log(`window ${w + 1}: reconnected in ${reconnectNs / 1_000_000n} ms, table restored in ${reinstallNs / 1_000_000n} ms`);
          prev = await readPorts(rig.serial);
          prevMid = (prev.readStartNs + prev.readEndNs) / 2n;
          continue;
        }
        while (installed < offsets.length && offsets[installed]! <= elapsedMs) {
          sendDepthFlow(rig.of, quarantineFlows[installed]!);
          addedAtMs.push(elapsedMs);
          installed++;
        }
        if (elapsedMs >= nextSample) {
          const cur = await readPorts(rig.serial);
          const curMid = (cur.readStartNs + cur.readEndNs) / 2n;
          const diff = diffPorts(prev.ports, cur.ports, [PORT_WORKLOAD, PORT_UPLINK]);
          if (diff.ok) {
            const dt = curMid - prevMid;
            const p1 = diff.deltas[PORT_WORKLOAD]!;
            const p2 = diff.deltas[PORT_UPLINK]!;
            samples.push({
              offsetMs: elapsedMs, rules: installed, dtNs: dt,
              p1RxPackets: p1.rxPackets, p2TxPackets: p2.txPackets, p1RxBytes: p1.rxBytes, p2TxBytes: p2.txBytes,
              p1RxDropped: p1.rxDropped, p2TxDropped: p2.txDropped,
              p1RxPps: perSecond(p1.rxPackets, dt), p2TxPps: perSecond(p2.txPackets, dt),
            });
          } else {
            log(`sample skipped: ${diff.reason}`);
          }
          prev = cur;
          prevMid = curMid;
          nextSample += sampleS * 1000;
        }
        if (elapsedMs >= nextVerify) {
          const now = planDepthCondition(baseCondition('workday-now', installed));
          // A stalled switch can time the readback out; record that instead of ending the run.
          const v = await readFlows(rig.of).then((e) => verifyDepthReadback(now, e), (e: unknown) => errMessage(e));
          if (typeof v === 'string') {
            verifications.push({ offsetMs: elapsedMs, rules: installed, verified: false, benignHits: 0n, mismatches: [`readback failed: ${v}`] });
            log(`window ${w + 1} @${elapsedMs}ms: periodic table check failed: ${v}`);
          } else {
            verifications.push({ offsetMs: elapsedMs, rules: installed, verified: v.verified, benignHits: v.benignQuarantineHits, mismatches: v.mismatches });
            if (!v.verified) log(`window ${w + 1} @${elapsedMs}ms: table mismatch: ${v.mismatches.join('; ')}`);
          }
          nextVerify += verifyS * 1000;
        }
        await sleep(200);
      }
      const [udp, tcp] = await Promise.all([udpP, tcpP]);
      const endPlan = planDepthCondition(baseCondition('workday-end', installed));
      // A session loss at or just after the window edge empties the table; that is an observation, not a reason to stop.
      // The next window's flush notices the epoch change and rebuilds from nothing.
      const sessionChangedAtEnd = rig.epoch.n !== tableEpoch || rig.of.metrics.state !== 'ESTABLISHED';
      let endV: DepthReadbackVerdict | null = null;
      if (!sessionChangedAtEnd) {
        endV = await readFlows(rig.of).then((e) => verifyDepthReadback(endPlan, e), () => null);
      }
      if (endV === null) {
        verifications.push({ offsetMs: windowMs, rules: installed, verified: false, benignHits: 0n, mismatches: ['session changed at or after the window end; table not verified'] });
      } else {
        verifications.push({ offsetMs: windowMs, rules: installed, verified: endV.verified, benignHits: endV.benignQuarantineHits, mismatches: endV.mismatches });
      }
      results.push({ index: w, flushMode, flushSendNs, flushToVerifiedNs, loadStartNs: t0, addedAtMs, samples, verifications, udp, tcp, sessionLosses });
      const last = samples[samples.length - 1];
      const endNote = endV === null ? ' SESSION CHANGED AT WINDOW END' : endV.verified ? '' : ' TABLE MISMATCH (same session)';
      log(`window ${w + 1} done: ${installed} rules, ${samples.length} samples, last p1 RX ${last ? last.p1RxPps : 'n/a'} pps; udp ${udp.error ?? 'ok'} tcp ${tcp.error ?? 'ok'}${endNote}`);
      if (endV !== null && !endV.verified && endV.benignQuarantineHits !== 0n) {
        throw new Error(`window ${w + 1}: benign quarantine rules matched ${endV.benignQuarantineHits} packets; results invalid`);
      }
    }
  } catch (e: unknown) {
    failure = e;
    log(`ABORTED: ${errMessage(e)}`);
  } finally {
    try {
      await deleteAllFlows(rig.of);
      log('flow table cleared; restart zodiac-bridge.service to restore production rules');
    } catch (e: unknown) {
      log(`WARNING: could not clear flow table: ${errMessage(e)}`);
    }
    await rig.of.close();
  }
  await writeDepthArtifact(cli, `depth-workday-${profile}`, startedAtIso, {
    provenance: await depthProvenance({ command: 'workday', startedAtIso, startedMonotonicNs, identity, workload, rig, flowTableVerified }),
    params: {
      profile, targetRulesPerWindow: target, windowSeconds: windowS, totalSeconds: totalS, windows, sampleSeconds: sampleS,
      ofDeadPeerMs: cli.flags.get('of-dead-peer-ms') ?? 'default(8000)', flushMode, udpLoadPercent: udpPct, tcpMbps, udpPps, udpPayloadBytes: UDP_P572_PAYLOAD, udpPort, tcpPort, rampOffsetsMs: offsets,
    },
    windows: results,
    completedWindows: results.length,
    sessionEvents,
  });
  if (failure !== null) throw failure;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  switch (cli.cmd) {
    case 'preflight': return cmdPreflight(cli);
    case 'run': return cmdRun(cli);
    case 'render': return cmdRender(cli);
    case 'plan': return cmdPlan(cli);
    case 'sweep': return cmdSweep(cli);
    case 'blackout': return cmdBlackout(cli);
    case 'workday': return cmdWorkday(cli);
    case 'ladder': return cmdLadder(cli);
    default:
      process.stdout.write(
        'commands: preflight | run | render <artifact.json> | plan | sweep | blackout | workday | ladder\n' +
          'run flags: --server IP (req) --pi-ssh user@host --pi-iface eth0 --pi-ip 10.0.2.50 --tap-iface IF\n' +
          '           --rules 0,32,128 --duration 10 --trials 5 --order interleaved|sequential\n' +
          '           --udp-mbps N --tap-rates-mbps a,b,c --tap-trials 3 --tap-resolution-mbps 1\n' +
          '           --skip-dataplane --skip-tap --tap-return-path --unverified-flow-table --no-doc --gap-seconds N\n' +
          'sweep flags: --depths 0,1,2,4,... --trials 4 --duration 10 --gap-seconds 2 --tests udp_p64,udp_p572,udp_p1470,tcp\n' +
          '           --variant-depths 32,126 --variant-tests udp_p572 --skip-depths --skip-variants --skip-hit --out DIR\n' +
          'blackout flags: --reps 3 --depths 0,126 --modes none,wipe,selective --loads idle,udp --out DIR\n' +
          'any run: --of-dead-peer-ms N (default 8000, the production rule) | --allow-dirty (permit uncommitted git tree)\n' +
          'ladder flags: --depths 0,16,32,64,126 --rates-pps 500,1000,2000,... --step-seconds 45 --rounds 1 --layout base|fwdfirst|fwdabove|fwdinstall|net16|distinct --payload 572\n' +
          'workday flags: --profile low|typical|worst --window-seconds 300 --total-seconds 3600 --flush-mode selective|wipe\n' +
          '           --udp-load-percent 50 --tcp-mbps 5 --udp-port 5201 --tcp-port 5202 --out DIR  (needs iperf3 servers on both ports)\n' +
          'plan: prints the sweep matrix and time estimates; touches no hardware\n',
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[bench] FATAL: ${errMessage(e)}\n`);
  process.exit(1);
});
