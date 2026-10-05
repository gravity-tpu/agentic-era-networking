/**
 * dataplane-benchmark.ts
 * Pure, I/O-free core of the Zodiac FX data-plane benchmark.
 *
 * Council Invariants Enforced:
 * - Invariant 2 (Dean & Ghemawat): every counter, rate, and ratio is a 64-bit BigInt.
 *   No floating point touches packet accounting. iperf3 emits floats (bits_per_second,
 *   seconds, lost_percent); this module deliberately never reads them and re-derives
 *   every rate from integer byte/packet counts and a nanosecond window.
 * - Invariant 1 (Anti-Shortcut): malformed input throws; counter regressions invalidate
 *   a trial instead of being guessed at.
 * - Invariant 3 (Fail-Closed): flow plans that would exceed the 128-entry hardware table
 *   are clamped and the clamp is reported, never silently overflowed (NET-2).
 * - Invariant 4 (Verification Asymmetry): every planned path is proven loop-free by
 *   SymbolicRouteVerifier before the plan may be handed to the data plane.
 * - Invariant 6 (Anti-Simulation): this module contains NO measurement data. It only
 *   transforms measurements that a caller obtained from physical hardware.
 */

import { SymbolicRouteVerifier, type NetworkHop } from '../core/routing-verifier.js';
import {
  OFPP_ANY,
  OFPG_ANY,
  OFP_VERSION_1_3,
  OpenFlowType,
} from './openflow-types.js';
import type { ZodiacPortInfo } from './zodiac-serial.js';

// ---------------------------------------------------------------------------
// Physical / protocol constants (each traceable to a datasheet or repo invariant)
// ---------------------------------------------------------------------------

/** NET-2: Zodiac FX hardware flow table ceiling. */
export const FLOW_TABLE_CAPACITY = 128;
/** NET-2: alert threshold (80% high-water mark). */
export const FLOW_TABLE_HIGH_WATER = 102;
/** Matches production: quarantine DROP rules sit above everything else (worst-case scan order). */
export const QUARANTINE_PRIORITY = 65535;
/** Forwarding rules sit below quarantine so every packet is checked against all quarantine rules first. */
export const FORWARD_PRIORITY = 100;
export const NS_PER_SECOND = 1_000_000_000n;
export const PPM = 1_000_000n;

export const PORT_WORKLOAD = 1;
export const PORT_UPLINK = 2;
export const PORT_TAP = 3;

// ---------------------------------------------------------------------------
// Integer arithmetic
// ---------------------------------------------------------------------------

/** count per second, floor. Throws on a non-positive window (fail-closed). */
export function perSecond(count: bigint, windowNs: bigint): bigint {
  if (windowNs <= 0n) throw new Error(`perSecond: non-positive window ${windowNs.toString()} ns`);
  return (count * NS_PER_SECOND) / windowNs;
}

/** bits per second from a byte count, floor. */
export function bitsPerSecond(bytes: bigint, windowNs: bigint): bigint {
  if (windowNs <= 0n) throw new Error(`bitsPerSecond: non-positive window ${windowNs.toString()} ns`);
  return (bytes * 8n * NS_PER_SECOND) / windowNs;
}

/** parts-per-million ratio, floor. Returns null when the denominator is zero (undefined, not 0). */
export function ratioPpm(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator <= 0n) return null;
  return (numerator * PPM) / denominator;
}

/**
 * Per-frame wire overhead for a UDP datagram on untagged Ethernet:
 * 8 UDP + 20 IPv4 + 14 Ethernet + 4 FCS + 8 preamble/SFD + 12 inter-frame gap.
 */
export const UDP_WIRE_OVERHEAD_BYTES = 66n;
/** KSZ8795 ports are 100BASE-TX (datasheet; repo SENTINEL-ROADMAP L376). */
export const PORT_LINK_BPS = 100_000_000n;

/** Highest UDP payload bit rate a link can carry at a given payload size (floor). */
export function lineRatePayloadBps(linkBps: bigint, payloadBytes: bigint): bigint {
  if (payloadBytes <= 0n) throw new Error('lineRatePayloadBps: payload must be positive');
  return (linkBps * payloadBytes) / (payloadBytes + UDP_WIRE_OVERHEAD_BYTES);
}

export interface Summary {
  readonly n: number;
  readonly min: bigint;
  readonly median: bigint;
  readonly max: bigint;
}

/** min / median / max over BigInts. Even-length median is the floored mean of the middle pair. */
export function summarize(values: readonly bigint[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
  return { n: sorted.length, min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

// ---------------------------------------------------------------------------
// Switch port counters (KSZ8795 via Zodiac FX `show ports`)
// ---------------------------------------------------------------------------

export interface PortCounterFields {
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxDropped: bigint;
  readonly txDropped: bigint;
  readonly rxCrcErrors: bigint;
}

export type PortDeltas = Readonly<Record<number, PortCounterFields>>;

export type PortDiffResult =
  | { readonly ok: true; readonly deltas: PortDeltas }
  | { readonly ok: false; readonly reason: string };

const COUNTER_KEYS = [
  'rxPackets',
  'txPackets',
  'rxBytes',
  'txBytes',
  'rxDropped',
  'txDropped',
  'rxCrcErrors',
] as const satisfies ReadonlyArray<keyof PortCounterFields>;

/**
 * Per-port counter delta between two `show ports` snapshots.
 *
 * A counter that moves backwards is ambiguous (32-bit wrap vs. switch reset). Guessing
 * would fabricate a number, so the whole window is rejected (Anti-Shortcut / Anti-Simulation).
 */
export function diffPorts(
  before: readonly ZodiacPortInfo[],
  after: readonly ZodiacPortInfo[],
  requiredPorts: readonly number[],
): PortDiffResult {
  const deltas: Record<number, PortCounterFields> = {};
  for (const portNo of requiredPorts) {
    const b = before.find((p) => p.port === portNo);
    const a = after.find((p) => p.port === portNo);
    if (!b || !a) return { ok: false, reason: `port ${portNo} missing from a counter snapshot` };
    const read = (key: (typeof COUNTER_KEYS)[number]): bigint | null => {
      const delta = a[key] - b[key];
      return delta < 0n ? null : delta;
    };
    const fields = {
      rxPackets: read('rxPackets'),
      txPackets: read('txPackets'),
      rxBytes: read('rxBytes'),
      txBytes: read('txBytes'),
      rxDropped: read('rxDropped'),
      txDropped: read('txDropped'),
      rxCrcErrors: read('rxCrcErrors'),
    };
    for (const key of COUNTER_KEYS) {
      if (fields[key] === null) {
        return {
          ok: false,
          reason: `port ${portNo} ${key} regressed (${b[key].toString()} -> ${a[key].toString()}): wrap or reset, window rejected`,
        };
      }
    }
    deltas[portNo] = {
      rxPackets: fields.rxPackets!,
      txPackets: fields.txPackets!,
      rxBytes: fields.rxBytes!,
      txBytes: fields.txBytes!,
      rxDropped: fields.rxDropped!,
      txDropped: fields.txDropped!,
      rxCrcErrors: fields.rxCrcErrors!,
    };
  }
  return { ok: true, deltas };
}

// ---------------------------------------------------------------------------
// iperf3 JSON parsing (integer fields only)
// ---------------------------------------------------------------------------

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`iperf3 JSON: expected object at ${path}`);
  }
  return value as JsonObject;
}

function intField(obj: JsonObject, key: string, path: string): bigint {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`iperf3 JSON: expected non-negative safe integer at ${path}.${key}`);
  }
  return BigInt(v);
}

function optIntField(obj: JsonObject, key: string): bigint | null {
  const v = obj[key];
  if (v === undefined) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
  return BigInt(v);
}

export interface IperfTcpResult {
  readonly protocol: 'TCP';
  readonly sentBytes: bigint;
  readonly receivedBytes: bigint;
  /** null when the sender platform does not report retransmits. */
  readonly retransmits: bigint | null;
  readonly iperfVersion: string;
}

export interface IperfUdpResult {
  readonly protocol: 'UDP';
  readonly offeredPackets: bigint;
  readonly lostPackets: bigint;
  /** Which JSON path the loss counters were read from (version-dependent). */
  readonly lossSource: 'end.sum_received' | 'end.sum';
  readonly iperfVersion: string;
}

function parseIperfRoot(json: unknown): { root: JsonObject; end: JsonObject; version: string } {
  const root = asObject(json, '$');
  if (typeof root['error'] === 'string') {
    throw new Error(`iperf3 reported an error: ${root['error']}`);
  }
  const start = asObject(root['start'], '$.start');
  const version = typeof start['version'] === 'string' ? start['version'] : 'unknown';
  const end = asObject(root['end'], '$.end');
  return { root, end, version };
}

export function parseIperfTcp(json: unknown): IperfTcpResult {
  const { end, version } = parseIperfRoot(json);
  const sent = asObject(end['sum_sent'], '$.end.sum_sent');
  const received = asObject(end['sum_received'], '$.end.sum_received');
  return {
    protocol: 'TCP',
    sentBytes: intField(sent, 'bytes', '$.end.sum_sent'),
    receivedBytes: intField(received, 'bytes', '$.end.sum_received'),
    retransmits: optIntField(sent, 'retransmits'),
    iperfVersion: version,
  };
}

export function parseIperfUdp(json: unknown): IperfUdpResult {
  const { end, version } = parseIperfRoot(json);
  const receivedObj = end['sum_received'];
  if (receivedObj !== undefined) {
    const r = asObject(receivedObj, '$.end.sum_received');
    if (r['lost_packets'] !== undefined && r['packets'] !== undefined) {
      return {
        protocol: 'UDP',
        offeredPackets: intField(r, 'packets', '$.end.sum_received'),
        lostPackets: intField(r, 'lost_packets', '$.end.sum_received'),
        lossSource: 'end.sum_received',
        iperfVersion: version,
      };
    }
  }
  const sum = asObject(end['sum'], '$.end.sum');
  return {
    protocol: 'UDP',
    offeredPackets: intField(sum, 'packets', '$.end.sum'),
    lostPackets: intField(sum, 'lost_packets', '$.end.sum'),
    lossSource: 'end.sum',
    iperfVersion: version,
  };
}

// ---------------------------------------------------------------------------
// Derived metrics for one measured window
// ---------------------------------------------------------------------------

export interface EndpointCounters {
  /** Independent end-to-end cross-check (Clark): workload NIC tx delta from sysfs. */
  readonly workloadTxPackets: bigint | null;
  readonly workloadTxBytes: bigint | null;
  /** Jetson tap NIC deltas from sysfs; null when no tap interface was supplied. */
  readonly tapRxPackets: bigint | null;
  readonly tapRxDropped: bigint | null;
}

export interface DerivedMetrics {
  /** Receiver-side goodput, bits/s. */
  readonly goodputBps: bigint | null;
  readonly retransmits: bigint | null;
  /** iperf3 UDP loss, ppm of offered packets. null for TCP or zero offered. */
  readonly iperfLossPpm: bigint | null;
  readonly switchPort1RxPps: bigint;
  readonly switchPort2TxPps: bigint;
  readonly switchPort3TxPps: bigint | null;
  /** Workload-NIC transmitted pps (what was really offered). */
  readonly offeredPps: bigint | null;
  /** Signed: Port1 RX packets minus Port2 TX packets over the window. >0 means the switch ate frames. */
  readonly forwardDeficitPackets: bigint;
  readonly forwardLossPpm: bigint | null;
  readonly port1RxDropped: bigint;
  readonly port2TxDropped: bigint;
  readonly port3TxDropped: bigint | null;
  readonly crcErrors: bigint;
}

export interface DeriveInput {
  /** The nominal traffic interval (iperf3 `-t`), the rate denominator. */
  readonly windowNs: bigint;
  readonly deltas: PortDeltas;
  readonly iperf: IperfTcpResult | IperfUdpResult | null;
  /** UDP payload length (iperf3 `-l`), needed to convert delivered datagrams to bits. */
  readonly udpPayloadBytes: bigint | null;
  readonly endpoint: EndpointCounters;
  readonly mirrorEnabled: boolean;
}

export function deriveMetrics(input: DeriveInput): DerivedMetrics {
  const p1 = input.deltas[PORT_WORKLOAD];
  const p2 = input.deltas[PORT_UPLINK];
  const p3 = input.deltas[PORT_TAP];
  if (!p1 || !p2) throw new Error('deriveMetrics: Port 1 and Port 2 deltas are required');
  if (input.mirrorEnabled && !p3) throw new Error('deriveMetrics: Port 3 delta required when mirror enabled');

  let goodputBps: bigint | null = null;
  let retransmits: bigint | null = null;
  let iperfLossPpm: bigint | null = null;
  const ip = input.iperf;
  if (ip && ip.protocol === 'TCP') {
    goodputBps = bitsPerSecond(ip.receivedBytes, input.windowNs);
    retransmits = ip.retransmits;
  } else if (ip && ip.protocol === 'UDP') {
    if (input.udpPayloadBytes === null) throw new Error('deriveMetrics: udpPayloadBytes required for UDP');
    if (ip.lostPackets > ip.offeredPackets) throw new Error('deriveMetrics: lost_packets exceeds packets');
    const delivered = ip.offeredPackets - ip.lostPackets;
    goodputBps = bitsPerSecond(delivered * input.udpPayloadBytes, input.windowNs);
    iperfLossPpm = ratioPpm(ip.lostPackets, ip.offeredPackets);
  }

  const forwardDeficitPackets = p1.rxPackets - p2.txPackets;
  const positiveDeficit = forwardDeficitPackets > 0n ? forwardDeficitPackets : 0n;

  return {
    goodputBps,
    retransmits,
    iperfLossPpm,
    switchPort1RxPps: perSecond(p1.rxPackets, input.windowNs),
    switchPort2TxPps: perSecond(p2.txPackets, input.windowNs),
    switchPort3TxPps: p3 ? perSecond(p3.txPackets, input.windowNs) : null,
    offeredPps:
      input.endpoint.workloadTxPackets === null
        ? null
        : perSecond(input.endpoint.workloadTxPackets, input.windowNs),
    forwardDeficitPackets,
    forwardLossPpm: ratioPpm(positiveDeficit, p1.rxPackets),
    port1RxDropped: p1.rxDropped,
    port2TxDropped: p2.txDropped,
    port3TxDropped: p3 ? p3.txDropped : null,
    crcErrors: p1.rxCrcErrors + p2.rxCrcErrors + (p3 ? p3.rxCrcErrors : 0n),
  };
}

// ---------------------------------------------------------------------------
// Tap-drop detection (Port 3 mirror, KSZ8795 counters)
// ---------------------------------------------------------------------------

export interface TapStepEvidence {
  readonly offeredBps: bigint;
  readonly port1RxPackets: bigint;
  readonly port3TxPackets: bigint;
  readonly port3TxDropped: bigint;
}

export interface TapStepVerdict {
  /** Hard evidence: the switch itself counted TX drops on Port 3. */
  readonly hardDrop: boolean;
  /** Mirror deficit: frames that entered Port 1 but never left Port 3. Signed. */
  readonly deficitPackets: bigint;
  readonly deficitPpm: bigint | null;
  /** Deficit above the empirically measured noise floor (no magic tolerance). */
  readonly softLoss: boolean;
  readonly lossDetected: boolean;
}

/**
 * Classifies one tap step. `noiseFloorPpm` is the largest deficit observed at the
 * calibration (lowest) rate, so the tolerance is measured on this very rig rather than
 * hardcoded (Invariant 5).
 */
export function classifyTapStep(step: TapStepEvidence, noiseFloorPpm: bigint): TapStepVerdict {
  const deficitPackets = step.port1RxPackets - step.port3TxPackets;
  const positive = deficitPackets > 0n ? deficitPackets : 0n;
  const deficitPpm = ratioPpm(positive, step.port1RxPackets);
  const hardDrop = step.port3TxDropped > 0n;
  const softLoss = deficitPpm !== null && deficitPpm > noiseFloorPpm;
  return { hardDrop, deficitPackets, deficitPpm, softLoss, lossDetected: hardDrop || softLoss };
}

export interface ThresholdBracket {
  /** Highest rate known clean. */
  readonly cleanBps: bigint;
  /** Lowest rate known lossy. */
  readonly failBps: bigint;
  readonly probes: ReadonlyArray<{ readonly bps: bigint; readonly lossDetected: boolean }>;
}

/**
 * Integer bisection of the tap-loss onset between a known-clean and known-lossy rate.
 * `probe` must perform a real measurement. Terminates in O(log2((hi-lo)/resolution)) probes.
 * Non-monotonic response (noise) is not hidden: every probe is returned.
 */
export async function refineTapThreshold(args: {
  readonly cleanBps: bigint;
  readonly failBps: bigint;
  readonly resolutionBps: bigint;
  readonly probe: (bps: bigint) => Promise<boolean>;
}): Promise<ThresholdBracket> {
  if (args.resolutionBps <= 0n) throw new Error('refineTapThreshold: resolution must be positive');
  if (args.failBps <= args.cleanBps) throw new Error('refineTapThreshold: failBps must exceed cleanBps');
  let lo = args.cleanBps;
  let hi = args.failBps;
  const probes: Array<{ bps: bigint; lossDetected: boolean }> = [];
  while (hi - lo > args.resolutionBps) {
    const mid = lo + (hi - lo) / 2n;
    const lossDetected = await args.probe(mid);
    probes.push({ bps: mid, lossDetected });
    if (lossDetected) hi = mid;
    else lo = mid;
  }
  return { cleanBps: lo, failBps: hi, probes };
}

// ---------------------------------------------------------------------------
// Flow-table plan (what we intend to install) + loop-free proof
// ---------------------------------------------------------------------------

export interface PlannedFlow {
  readonly kind: 'forward' | 'quarantine';
  readonly priority: number;
  readonly inPort?: number;
  readonly srcIp?: string;
  /** Empty = DROP. */
  readonly outputPorts: readonly number[];
}

export interface FlowPlan {
  readonly flows: readonly PlannedFlow[];
  readonly quarantineRequested: number;
  readonly quarantineInstalled: number;
  /** true when the request could not fit beside the mandatory forwarding rules. */
  readonly clamped: boolean;
  readonly forwardingRuleCount: number;
  readonly mirror: boolean;
}

/**
 * Builds the flow plan. Forwarding rules are mandatory (Port1<->Port2) so the benchmark
 * exercises the switch's rule path rather than the controller punt path. Quarantine rules
 * match TEST-NET-2 (RFC 5737, 198.51.100.0/24) sources that can never appear on the wire,
 * so they populate the table without ever matching benchmark traffic.
 *
 * No table-miss rule is installed: the benchmark traffic is fully covered by in_port rules
 * and an absent table-miss is OpenFlow 1.3 default-drop (fail-closed).
 */
export function planFlowState(args: {
  readonly quarantineRequested: number;
  readonly mirror: boolean;
  readonly tapReturnPath: boolean;
  readonly capacity?: number;
}): FlowPlan {
  const capacity = args.capacity ?? FLOW_TABLE_CAPACITY;
  if (!Number.isInteger(args.quarantineRequested) || args.quarantineRequested < 0) {
    throw new Error('planFlowState: quarantineRequested must be a non-negative integer');
  }
  const forwards: PlannedFlow[] = [
    {
      kind: 'forward',
      priority: FORWARD_PRIORITY,
      inPort: PORT_WORKLOAD,
      outputPorts: args.mirror ? [PORT_UPLINK, PORT_TAP] : [PORT_UPLINK],
    },
    { kind: 'forward', priority: FORWARD_PRIORITY, inPort: PORT_UPLINK, outputPorts: [PORT_WORKLOAD] },
  ];
  if (args.mirror && args.tapReturnPath) {
    forwards.push({
      kind: 'forward',
      priority: FORWARD_PRIORITY,
      inPort: PORT_TAP,
      outputPorts: [PORT_WORKLOAD],
    });
  }
  const room = capacity - forwards.length;
  if (room < 0) throw new Error('planFlowState: forwarding rules alone exceed table capacity');
  const installed = Math.min(args.quarantineRequested, room);
  if (installed > 253) throw new Error('planFlowState: quarantine address pool (198.51.100.1-253) exhausted');
  const quarantine: PlannedFlow[] = [];
  for (let i = 0; i < installed; i++) {
    quarantine.push({
      kind: 'quarantine',
      priority: QUARANTINE_PRIORITY,
      srcIp: `198.51.100.${i + 1}`,
      outputPorts: [],
    });
  }
  return {
    flows: [...quarantine, ...forwards],
    quarantineRequested: args.quarantineRequested,
    quarantineInstalled: installed,
    clamped: installed < args.quarantineRequested,
    forwardingRuleCount: forwards.length,
    mirror: args.mirror,
  };
}

/**
 * Invariant 4: prove every path the plan creates is loop-free before it may touch the switch.
 * Directional paths are verified independently (a flow and its return flow are different
 * flows, not a cycle). Throws RoutingLoopDetectedError on failure.
 */
export function verifyPlanLoopFree(plan: FlowPlan): void {
  const path = (nodes: readonly string[]): NetworkHop[] =>
    nodes.slice(0, -1).map((n, i) => ({ fromNode: n, toNode: nodes[i + 1]!, cost: 1 }));
  SymbolicRouteVerifier.verifyLoopFree(path(['rpi', 'zodiac:p1', 'zodiac:p2', 'extender']));
  SymbolicRouteVerifier.verifyLoopFree(path(['extender', 'zodiac:p2', 'zodiac:p1', 'rpi']));
  if (plan.mirror) {
    SymbolicRouteVerifier.verifyLoopFree(path(['zodiac:p1', 'zodiac:p3', 'jetson-tap']));
  }
  for (const f of plan.flows) {
    if (f.kind === 'quarantine') {
      SymbolicRouteVerifier.verifyLoopFree([{ fromNode: f.srcIp ?? 'unknown', toNode: 'DROP', cost: 0 }]);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenFlow 1.3 wire helpers: barrier + flow-stats multipart (switch-side readback)
// ---------------------------------------------------------------------------

const OFPMP_FLOW = 1;
const OFPTT_ALL = 0xff;

/** OFPMP_FLOW request matching every flow in every table (56 bytes). */
export function buildFlowStatsRequest(xid: number, tableId: number = OFPTT_ALL): Buffer {
  const buf = Buffer.alloc(56);
  buf.writeUInt8(OFP_VERSION_1_3, 0);
  buf.writeUInt8(OpenFlowType.OFPT_MULTIPART_REQUEST, 1);
  buf.writeUInt16BE(56, 2);
  buf.writeUInt32BE(xid, 4);
  buf.writeUInt16BE(OFPMP_FLOW, 8); // multipart type
  buf.writeUInt16BE(0, 10); // flags
  // body (ofp_flow_stats_request)
  buf.writeUInt8(tableId, 16);
  buf.writeUInt32BE(OFPP_ANY, 20); // out_port
  buf.writeUInt32BE(OFPG_ANY, 24); // out_group
  // cookie/cookie_mask = 0 at 32/40
  // empty OXM match at 48: type=1 (OXM), length=4, 4B pad
  buf.writeUInt16BE(1, 48);
  buf.writeUInt16BE(4, 50);
  return buf;
}

export interface FlowStatsEntry {
  readonly tableId: number;
  readonly priority: number;
  readonly packetCount: bigint;
  readonly byteCount: bigint;
  /** IPV4_SRC value the switch reports for this entry; absent if no such match field was reported. */
  readonly srcIp?: string;
  /** IPV4_SRC mask as dotted quad; absent for an exact (unmasked) match. */
  readonly srcMask?: string;
  /** IN_PORT value the switch reports for this entry, if any. */
  readonly inPort?: number;
  /** ETH_TYPE value the switch reports for this entry, if any. */
  readonly ethType?: number;
  /** IPV4_DST value the switch reports for this entry; absent if no such match field was reported. */
  readonly dstIp?: string;
  /** IPV4_DST mask as dotted quad; absent for an exact (unmasked) match. */
  readonly dstMask?: string;
}

const OXM_CLASS_BASIC = 0x8000;
const OXM_FIELD_IN_PORT = 0;
const OXM_FIELD_ETH_TYPE = 5;
const OXM_FIELD_IPV4_SRC = 11;
const OXM_FIELD_IPV4_DST = 12;

const dotted = (b: Buffer, off: number): string => `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;

/**
 * Best-effort parse of the ofp_match carried in an ofp_flow_stats entry. Never throws: firmware
 * that reports a non-standard match yields an entry without match fields, and callers that
 * need the match (masked-rule verification) treat the absence as a mismatch (fail-closed).
 */
function parseEntryMatch(
  packet: Buffer,
  matchOff: number,
  entryEnd: number,
): Omit<FlowStatsEntry, 'tableId' | 'priority' | 'packetCount' | 'byteCount'> {
  const out: { srcIp?: string; srcMask?: string; inPort?: number; ethType?: number; dstIp?: string; dstMask?: string } = {};
  if (matchOff + 4 > entryEnd || packet.readUInt16BE(matchOff) !== 1) return out;
  const matchLen = packet.readUInt16BE(matchOff + 2);
  const end = Math.min(matchOff + matchLen, entryEnd);
  let p = matchOff + 4;
  while (p + 4 <= end) {
    const cls = packet.readUInt16BE(p);
    const fieldByte = packet.readUInt8(p + 2);
    const len = packet.readUInt8(p + 3);
    if (p + 4 + len > end) break;
    const field = fieldByte >> 1;
    const hasMask = (fieldByte & 1) === 1;
    if (cls === OXM_CLASS_BASIC && field === OXM_FIELD_IPV4_SRC) {
      if (!hasMask && len === 4) out.srcIp = dotted(packet, p + 4);
      else if (hasMask && len === 8) {
        out.srcIp = dotted(packet, p + 4);
        out.srcMask = dotted(packet, p + 8);
      }
    } else if (cls === OXM_CLASS_BASIC && field === OXM_FIELD_IN_PORT && !hasMask && len === 4) {
      out.inPort = packet.readUInt32BE(p + 4);
    } else if (cls === OXM_CLASS_BASIC && field === OXM_FIELD_ETH_TYPE && !hasMask && len === 2) {
      out.ethType = packet.readUInt16BE(p + 4);
    } else if (cls === OXM_CLASS_BASIC && field === OXM_FIELD_IPV4_DST) {
      if (!hasMask && len === 4) out.dstIp = dotted(packet, p + 4);
      else if (hasMask && len === 8) {
        out.dstIp = dotted(packet, p + 4);
        out.dstMask = dotted(packet, p + 8);
      }
    }
    p += 4 + len;
  }
  return out;
}

export interface FlowStatsReply {
  readonly entries: readonly FlowStatsEntry[];
  /** OFPMPF_REPLY_MORE: further reply messages with the same xid follow. */
  readonly more: boolean;
}

export function parseFlowStatsReply(packet: Buffer): FlowStatsReply {
  if (packet.length < 16) throw new Error(`flow-stats reply underflow: ${packet.length} bytes`);
  if (packet.readUInt8(1) !== OpenFlowType.OFPT_MULTIPART_REPLY) {
    throw new Error('flow-stats reply: not an OFPT_MULTIPART_REPLY');
  }
  const mpType = packet.readUInt16BE(8);
  if (mpType !== OFPMP_FLOW) throw new Error(`flow-stats reply: unexpected multipart type ${mpType}`);
  const more = (packet.readUInt16BE(10) & 0x0001) !== 0;
  const entries: FlowStatsEntry[] = [];
  let off = 16;
  while (off < packet.length) {
    if (off + 48 > packet.length) throw new Error('flow-stats reply: truncated entry header');
    const len = packet.readUInt16BE(off);
    if (len < 56 || off + len > packet.length) {
      throw new Error(`flow-stats reply: invalid entry length ${len} at offset ${off}`);
    }
    entries.push({
      tableId: packet.readUInt8(off + 2),
      priority: packet.readUInt16BE(off + 12),
      packetCount: packet.readBigUInt64BE(off + 32),
      byteCount: packet.readBigUInt64BE(off + 40),
      ...parseEntryMatch(packet, off + 48, off + len),
    });
    off += len;
  }
  return { entries, more };
}

export interface OfpErrorInfo {
  readonly errorType: number;
  readonly errorCode: number;
}

export function parseOfpError(packet: Buffer): OfpErrorInfo {
  if (packet.length < 12) throw new Error(`OFPT_ERROR underflow: ${packet.length} bytes`);
  return { errorType: packet.readUInt16BE(8), errorCode: packet.readUInt16BE(10) };
}

export interface FlowReadbackVerdict {
  readonly verified: boolean;
  readonly totalEntries: bigint;
  readonly byPriority: Readonly<Record<string, bigint>>;
  readonly mismatches: readonly string[];
  /** Quarantine rules must never match benchmark traffic; any hit invalidates the run. */
  readonly quarantinePacketHits: bigint;
}

/** Compares switch-reported flow entries against the plan. Exact-count equality required. */
export function verifyFlowReadback(plan: FlowPlan, entries: readonly FlowStatsEntry[]): FlowReadbackVerdict {
  const byPriority: Record<string, bigint> = {};
  let quarantinePacketHits = 0n;
  for (const e of entries) {
    const k = String(e.priority);
    byPriority[k] = (byPriority[k] ?? 0n) + 1n;
    if (e.priority === QUARANTINE_PRIORITY) quarantinePacketHits += e.packetCount;
  }
  const mismatches: string[] = [];
  const expectedQuarantine = BigInt(plan.quarantineInstalled);
  const gotQuarantine = byPriority[String(QUARANTINE_PRIORITY)] ?? 0n;
  if (gotQuarantine !== expectedQuarantine) {
    mismatches.push(`quarantine entries: expected ${expectedQuarantine}, switch reports ${gotQuarantine}`);
  }
  const expectedForward = BigInt(plan.forwardingRuleCount);
  const gotForward = byPriority[String(FORWARD_PRIORITY)] ?? 0n;
  if (gotForward !== expectedForward) {
    mismatches.push(`forwarding entries: expected ${expectedForward}, switch reports ${gotForward}`);
  }
  const expectedTotal = BigInt(plan.flows.length);
  if (BigInt(entries.length) !== expectedTotal) {
    mismatches.push(`total entries: expected ${expectedTotal}, switch reports ${entries.length}`);
  }
  return {
    verified: mismatches.length === 0,
    totalEntries: BigInt(entries.length),
    byPriority,
    mismatches,
    quarantinePacketHits,
  };
}
