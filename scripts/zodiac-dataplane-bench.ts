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
  planFlowState,
  refineTapThreshold,
  verifyFlowReadback,
  verifyPlanLoopFree,
} from '../dist/sdn/dataplane-benchmark.js';
import {
  ARTIFACT_SCHEMA,
  injectIntoDocument,
  parseArtifact,
  renderResultsSection,
  serializeArtifact,
} from '../dist/sdn/dataplane-benchmark-report.js';
import type {
  FlowPlan,
  FlowReadbackVerdict,
  FlowStatsEntry,
  IperfTcpResult,
  IperfUdpResult,
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
  verifyPlanLoopFree(plan); // Invariant 4: throws before anything touches the switch
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
    trials.push(await measure(rig, {
      ...udpCommon, test: 'udp_mtu', offeredBps: cfg.udpOfferedBps, udpPayloadBytes: BigInt(cfg.mtuPayload),
      load: () => runIperf(rig, 'udp', D, { bps: cfg.udpOfferedBps, payloadBytes: cfg.mtuPayload }),
    }));
    trials.push(await measure(rig, {
      ...udpCommon, test: 'udp_small', offeredBps: lineRatePayloadBps(PORT_LINK_BPS, BigInt(cfg.smallPayload)),
      udpPayloadBytes: BigInt(cfg.smallPayload),
      load: () =>
        runIperf(rig, 'udp', D, {
          bps: lineRatePayloadBps(PORT_LINK_BPS, BigInt(cfg.smallPayload)),
          payloadBytes: cfg.smallPayload,
        }),
    }));
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

  const of = new OpenFlowServer();
  const switchErrors: string[] = [];
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
    rig: { of, serial, sshTarget, piIface, piIp, server, tapIface, switchErrors },
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

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  switch (cli.cmd) {
    case 'preflight': return cmdPreflight(cli);
    case 'run': return cmdRun(cli);
    case 'render': return cmdRender(cli);
    default:
      process.stdout.write(
        'commands: preflight | run | render <artifact.json>\n' +
          'run flags: --server IP (req) --pi-ssh user@host --pi-iface eth0 --pi-ip 10.0.2.50 --tap-iface IF\n' +
          '           --rules 0,32,128 --duration 10 --trials 5 --order interleaved|sequential\n' +
          '           --udp-mbps N --tap-rates-mbps a,b,c --tap-trials 3 --tap-resolution-mbps 1\n' +
          '           --skip-dataplane --skip-tap --tap-return-path --unverified-flow-table --no-doc\n',
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[bench] FATAL: ${errMessage(e)}\n`);
  process.exit(1);
});
