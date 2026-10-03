/**
 * dataplane-benchmark-report.ts
 * Artifact schema, lossless BigInt (de)serialization, and deterministic Markdown rendering
 * for the Zodiac FX data-plane benchmark.
 *
 * Council Invariants Enforced:
 * - Invariant 6 (Anti-Simulation / Provenance): the results document is a pure function of a
 *   recorded artifact. No number in the rendered report can originate anywhere except a
 *   `BenchArtifact` written by a real run; there is no code path that accepts hand-typed values.
 * - Invariant 2: every measured quantity is a BigInt and stays one. Serialization tags BigInts
 *   instead of letting JSON coerce them to lossy IEEE-754 doubles.
 */

import {
  FLOW_TABLE_CAPACITY,
  summarize,
  type DerivedMetrics,
  type FlowReadbackVerdict,
  type PortDeltas,
  type TapStepVerdict,
} from './dataplane-benchmark.js';

export const ARTIFACT_SCHEMA = 'zodiac-dataplane-bench/v1' as const;
export const RESULTS_BEGIN_MARKER = '<!-- BENCH-RESULTS:BEGIN -->';
export const RESULTS_END_MARKER = '<!-- BENCH-RESULTS:END -->';

export type TestKind = 'tcp' | 'udp_mtu' | 'udp_small' | 'idle' | 'tap_step';

export interface BenchProvenance {
  readonly schema: typeof ARTIFACT_SCHEMA;
  /** Declares a run executed against physical hardware by this tool. Never 'cloud_snapshot'. */
  readonly origin: 'physical_bench_run';
  /** Wall-clock label only. Never used for any duration. */
  readonly startedAtIso: string;
  readonly startedMonotonicNs: bigint;
  readonly finishedMonotonicNs: bigint;
  readonly controllerHost: { readonly hostname: string; readonly platform: string; readonly arch: string; readonly nodeVersion: string };
  readonly switchIdentity: {
    /** From the OFPT_FEATURES_REPLY of the physical switch that connected to our controller socket. */
    readonly datapathId: bigint;
    readonly openflowPeer: string;
    readonly serialPath: string;
    readonly firmwareVersion: string;
    readonly cpuUid: string;
  };
  readonly workload: {
    readonly sshTarget: string;
    readonly iface: string;
    readonly ipv4: string;
    readonly kernel: string;
    readonly iperf3Client: string;
  };
  readonly iperfServer: string;
  readonly tapInterface: string | null;
  readonly tool: { readonly scriptSha256: string; readonly gitCommit: string | null; readonly gitDirty: boolean | null };
  /** false => rule residency was NOT confirmed on silicon; results carry a prominent warning. */
  readonly flowTableVerified: boolean;
  readonly counterSource: string;
}

export interface BenchParams {
  readonly durationSeconds: number;
  readonly trials: number;
  readonly order: 'interleaved' | 'sequential';
  readonly quarantineLevels: readonly number[];
  readonly udpOfferedBps: bigint;
  readonly udpMtuPayloadBytes: number;
  readonly udpSmallPayloadBytes: number;
  readonly tapSweepBps: readonly bigint[];
  readonly tapResolutionBps: bigint;
  readonly tapReturnPath: boolean;
}

export interface ConditionRecord {
  readonly id: string;
  readonly quarantineRequested: number;
  readonly quarantineInstalled: number;
  readonly clamped: boolean;
  readonly mirror: boolean;
  readonly readback: FlowReadbackVerdict | null;
}

export interface TrialRecord {
  readonly ordinal: number;
  readonly conditionId: string;
  readonly test: TestKind;
  readonly offeredBps: bigint | null;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly nominalWindowNs: bigint;
  readonly wallNs: bigint;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly metrics: DerivedMetrics | null;
  readonly portDeltas: PortDeltas | null;
  readonly tapVerdict: TapStepVerdict | null;
  readonly tapPort1RxPackets: bigint | null;
  readonly tapPort3TxPackets: bigint | null;
  readonly tapNicRxPackets: bigint | null;
  readonly tapNicRxDropped: bigint | null;
  readonly rawPortsBefore: string;
  readonly rawPortsAfter: string;
  readonly iperfRawSha256: string | null;
}

export interface TapSweepRecord {
  readonly conditionId: string;
  readonly noiseFloorPpm: bigint;
  readonly status: 'bracketed' | 'not_reached' | 'below_range' | 'aborted';
  readonly cleanBps: bigint | null;
  readonly failBps: bigint | null;
  readonly note: string;
}

export interface BenchArtifact {
  readonly provenance: BenchProvenance;
  readonly params: BenchParams;
  readonly conditions: readonly ConditionRecord[];
  readonly trials: readonly TrialRecord[];
  readonly tapSweep: TapSweepRecord | null;
}

// ---------------------------------------------------------------------------
// Lossless BigInt JSON
// ---------------------------------------------------------------------------

export function serializeArtifact(artifact: BenchArtifact): string {
  return JSON.stringify(
    artifact,
    (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v),
    2,
  );
}

export function parseArtifact(text: string): BenchArtifact {
  const parsed: unknown = JSON.parse(text, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec);
      if (keys.length === 1 && keys[0] === '$bigint' && typeof rec['$bigint'] === 'string') {
        return BigInt(rec['$bigint']);
      }
    }
    return v;
  });
  if (typeof parsed !== 'object' || parsed === null) throw new Error('artifact: not an object');
  const prov = (parsed as { provenance?: { schema?: unknown; origin?: unknown } }).provenance;
  if (!prov || prov.schema !== ARTIFACT_SCHEMA) {
    throw new Error(`artifact: schema must be ${ARTIFACT_SCHEMA}`);
  }
  if (prov.origin !== 'physical_bench_run') {
    throw new Error("artifact: origin must be 'physical_bench_run'; refusing to render unattested data");
  }
  return parsed as BenchArtifact;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmt = (v: bigint | null): string => (v === null ? 'n/a' : v.toString());
const mbit = (bps: bigint | null): string => (bps === null ? 'n/a' : (bps / 1_000_000n).toString());

function cell(values: readonly (bigint | null)[]): string {
  const present = values.filter((v): v is bigint => v !== null);
  const s = summarize(present);
  if (!s) return 'n/a';
  return `${s.min} / ${s.median} / ${s.max}`;
}

function pickMetrics(trials: readonly TrialRecord[], f: (m: DerivedMetrics) => bigint | null): (bigint | null)[] {
  return trials.filter((t) => t.valid && t.metrics !== null).map((t) => f(t.metrics!));
}

export function renderResultsSection(artifact: BenchArtifact): string {
  const p = artifact.provenance;
  const out: string[] = [];
  const push = (s: string = ''): void => void out.push(s);

  push(`### Run ${p.startedAtIso}`);
  push();
  push('| Field | Value |');
  push('| :--- | :--- |');
  push(`| Provenance origin | \`${p.origin}\` (physical bench run, schema \`${p.schema}\`) |`);
  push(`| Switch datapath ID | \`0x${p.switchIdentity.datapathId.toString(16)}\` via OpenFlow peer \`${p.switchIdentity.openflowPeer}\` |`);
  push(`| Switch firmware | \`${p.switchIdentity.firmwareVersion}\` on \`${p.switchIdentity.serialPath}\` |`);
  push(`| Counter source | ${p.counterSource} |`);
  push(`| Workload | \`${p.workload.sshTarget}\` \`${p.workload.iface}\` \`${p.workload.ipv4}\`, ${p.workload.kernel}, ${p.workload.iperf3Client} |`);
  push(`| iperf3 server | \`${p.iperfServer}\` |`);
  push(`| Tap NIC cross-check | ${p.tapInterface === null ? 'not supplied' : `\`${p.tapInterface}\``} |`);
  push(`| Tool | script sha256 \`${p.tool.scriptSha256.slice(0, 16)}\`, git \`${p.tool.gitCommit ?? 'unknown'}\`${p.tool.gitDirty ? ' (dirty tree)' : ''} |`);
  push(`| Monotonic span | ${(p.finishedMonotonicNs - p.startedMonotonicNs).toString()} ns |`);
  push(`| Params | ${artifact.params.durationSeconds}s/test, ${artifact.params.trials} trials, ${artifact.params.order}, UDP offered ${artifact.params.udpOfferedBps} bit/s |`);
  push();

  if (!p.flowTableVerified) {
    push('> [!WARNING]');
    push('> Flow-table residency was **not** confirmed on the switch (OFPMP_FLOW readback unavailable). Rule counts below are controller-side intent only.');
    push();
  }
  const clamped = artifact.conditions.filter((c) => c.clamped);
  if (clamped.length > 0) {
    push('> [!NOTE]');
    push(
      `> The ${FLOW_TABLE_CAPACITY}-entry table must also hold the mandatory forwarding rules, so these conditions installed fewer quarantine rules than requested: ` +
        clamped.map((c) => `${c.quarantineRequested} requested / ${c.quarantineInstalled} installed`).join('; ') + '.',
    );
    push();
  }

  const dataConditions = artifact.conditions.filter((c) => !c.mirror);
  if (dataConditions.length > 0) {
    push('#### Quarantine-depth data plane (Port 1 to Port 2, mirror off)');
    push();
    push('Each cell is min / median / max over valid trials. Throughput is receiver goodput in bit/s from integer byte counts over the nominal test window.');
    push();
    push('| Quarantine rules (req/inst) | Table verified | Test | Valid/total | Goodput bit/s | Goodput Mbit/s (median, floor) | Switch P1 RX pps | Switch P2 TX pps | iperf loss ppm | Switch fwd loss ppm | Retransmits | P1 RX drop | P2 TX drop |');
    push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const c of dataConditions) {
      for (const test of ['tcp', 'udp_mtu', 'udp_small'] as const) {
        const ts = artifact.trials.filter((t) => t.conditionId === c.id && t.test === test);
        if (ts.length === 0) continue;
        const valid = ts.filter((t) => t.valid);
        const gp = summarize(pickMetrics(ts, (m) => m.goodputBps).filter((v): v is bigint => v !== null));
        push(
          `| ${c.quarantineRequested}/${c.quarantineInstalled} | ${c.readback?.verified ? 'yes' : 'NO'} | ${test} | ${valid.length}/${ts.length} | ` +
            `${cell(pickMetrics(ts, (m) => m.goodputBps))} | ${mbit(gp ? gp.median : null)} | ` +
            `${cell(pickMetrics(ts, (m) => m.switchPort1RxPps))} | ${cell(pickMetrics(ts, (m) => m.switchPort2TxPps))} | ` +
            `${cell(pickMetrics(ts, (m) => m.iperfLossPpm))} | ${cell(pickMetrics(ts, (m) => m.forwardLossPpm))} | ` +
            `${cell(pickMetrics(ts, (m) => m.retransmits))} | ${cell(pickMetrics(ts, (m) => m.port1RxDropped))} | ${cell(pickMetrics(ts, (m) => m.port2TxDropped))} |`,
        );
      }
      const idle = artifact.trials.filter((t) => t.conditionId === c.id && t.test === 'idle' && t.valid && t.metrics);
      if (idle.length > 0) {
        push(
          `| ${c.quarantineRequested}/${c.quarantineInstalled} | ${c.readback?.verified ? 'yes' : 'NO'} | idle (noise floor) | ${idle.length}/${idle.length} | n/a | n/a | ` +
            `${cell(pickMetrics(idle, (m) => m.switchPort1RxPps))} | ${cell(pickMetrics(idle, (m) => m.switchPort2TxPps))} | n/a | n/a | n/a | n/a | n/a |`,
        );
      }
    }
    push();
  }

  const invalid = artifact.trials.filter((t) => !t.valid);
  if (invalid.length > 0) {
    push('#### Rejected trials');
    push();
    push('| Ordinal | Condition | Test | Reason |');
    push('| :--- | :--- | :--- | :--- |');
    for (const t of invalid) push(`| ${t.ordinal} | ${t.conditionId} | ${t.test} | ${t.invalidReason ?? 'unspecified'} |`);
    push();
  }

  const sweep = artifact.tapSweep;
  if (sweep) {
    push('#### Port 3 mirror tap-drop threshold');
    push();
    push(`Noise floor (measured at the lowest rate, no tolerance constant): ${sweep.noiseFloorPpm} ppm.`);
    push();
    push('| Offered bit/s | Offered Mbit/s | P1 RX pkts | P3 TX pkts | P3 TX dropped | Deficit ppm | Hard drop | Soft loss | Tap NIC rx pkts | Tap NIC rx dropped | Valid |');
    push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
    const steps = artifact.trials
      .filter((t) => t.test === 'tap_step')
      .sort((a, b) => (a.offeredBps! < b.offeredBps! ? -1 : a.offeredBps! > b.offeredBps! ? 1 : a.ordinal - b.ordinal));
    for (const t of steps) {
      const v = t.tapVerdict;
      push(
        `| ${fmt(t.offeredBps)} | ${mbit(t.offeredBps)} | ${fmt(t.tapPort1RxPackets)} | ${fmt(t.tapPort3TxPackets)} | ` +
          `${fmt(t.metrics?.port3TxDropped ?? null)} | ${fmt(v?.deficitPpm ?? null)} | ${v ? (v.hardDrop ? 'yes' : 'no') : 'n/a'} | ` +
          `${v ? (v.softLoss ? 'yes' : 'no') : 'n/a'} | ${fmt(t.tapNicRxPackets)} | ${fmt(t.tapNicRxDropped)} | ${t.valid ? 'yes' : 'no'} |`,
      );
    }
    push();
    switch (sweep.status) {
      case 'bracketed':
        push(`**Result:** loss onset lies in (${sweep.cleanBps} bit/s, ${sweep.failBps} bit/s]. Highest clean rate ${sweep.cleanBps} bit/s; lowest lossy rate ${sweep.failBps} bit/s.`);
        break;
      case 'not_reached':
        push(`**Result:** no tap loss detected up to the highest offered rate (${sweep.cleanBps} bit/s). The threshold is above the tested range; it is not extrapolated.`);
        break;
      case 'below_range':
        push(`**Result:** loss already present at the lowest offered rate (${sweep.failBps} bit/s). The threshold is below the tested range; it is not extrapolated.`);
        break;
      case 'aborted':
        push('**Result:** sweep aborted; no threshold is claimed.');
        break;
    }
    push();
    push(`Note: ${sweep.note}`);
    push();
  }
  return out.join('\n');
}

/** Replaces the region between the result markers. Throws if either marker is absent. */
export function injectIntoDocument(doc: string, section: string): string {
  const b = doc.indexOf(RESULTS_BEGIN_MARKER);
  const e = doc.indexOf(RESULTS_END_MARKER);
  if (b < 0 || e < 0 || e < b) {
    throw new Error(`document must contain ${RESULTS_BEGIN_MARKER} ... ${RESULTS_END_MARKER}`);
  }
  return `${doc.slice(0, b + RESULTS_BEGIN_MARKER.length)}\n\n${section}\n${doc.slice(e)}`;
}
