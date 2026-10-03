/**
 * dataplane-benchmark.test.ts
 * Invariant tests for the pure core of the Zodiac FX data-plane benchmark.
 *
 * IMPORTANT (Invariant 6): every value below is a TEST FIXTURE used to prove that the
 * arithmetic, parsers and wire encoders are correct. None of them is, or may be quoted
 * as, a measurement of the physical switch. Real numbers exist only in artifacts written
 * by scripts/zodiac-dataplane-bench.ts against live hardware.
 */

import { describe, it, expect } from 'vitest';
import {
  FLOW_TABLE_CAPACITY,
  QUARANTINE_PRIORITY,
  FORWARD_PRIORITY,
  bitsPerSecond,
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
  ratioPpm,
  refineTapThreshold,
  summarize,
  verifyFlowReadback,
  verifyPlanLoopFree,
  type FlowStatsEntry,
} from '../../src/sdn/dataplane-benchmark.js';
import {
  ARTIFACT_SCHEMA,
  RESULTS_BEGIN_MARKER,
  RESULTS_END_MARKER,
  injectIntoDocument,
  parseArtifact,
  renderResultsSection,
  serializeArtifact,
  type BenchArtifact,
} from '../../src/sdn/dataplane-benchmark-report.js';
import { OpenFlowType, OFP_VERSION_1_3 } from '../../src/sdn/openflow-types.js';
import { parseShowPorts, type ZodiacPortInfo } from '../../src/sdn/zodiac-serial.js';

const port = (n: number, o: Partial<ZodiacPortInfo> = {}): ZodiacPortInfo => ({
  port: n, status: 'UP', vlanType: 'OpenFlow', vlanId: 100,
  rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n,
  ...o,
});

describe('integer arithmetic (Invariant 2)', () => {
  it('derives rates with BigInt floor division and never touches floats', () => {
    expect(bitsPerSecond(125_000_000n, 10_000_000_000n)).toBe(100_000_000n);
    expect(perSecond(1_000n, 4_000_000_000n)).toBe(250n);
    expect(typeof bitsPerSecond(1n, 3n)).toBe('bigint');
  });

  it('fails closed on a non-positive window', () => {
    expect(() => perSecond(1n, 0n)).toThrow();
    expect(() => bitsPerSecond(1n, -5n)).toThrow();
  });

  it('ratioPpm returns null (undefined) rather than 0 when the denominator is zero', () => {
    expect(ratioPpm(5n, 0n)).toBeNull();
    expect(ratioPpm(1n, 1_000_000n)).toBe(1n);
  });

  it('summarizes with exact BigInt median', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([9n, 1n, 5n])).toEqual({ n: 3, min: 1n, median: 5n, max: 9n });
    expect(summarize([1n, 2n, 3n, 10n])?.median).toBe(2n);
  });

  it('computes the payload line rate from physical link speed and frame overhead', () => {
    // 1470 B payload + 66 B overhead on 100 Mbit/s
    expect(lineRatePayloadBps(100_000_000n, 1470n)).toBe((100_000_000n * 1470n) / 1536n);
  });
});

describe('port counter deltas', () => {
  it('computes per-port deltas', () => {
    const r = diffPorts(
      [port(1, { rxPackets: 10n }), port(2, { txPackets: 4n })],
      [port(1, { rxPackets: 110n }), port(2, { txPackets: 104n })],
      [1, 2],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deltas[1]?.rxPackets).toBe(100n);
      expect(r.deltas[2]?.txPackets).toBe(100n);
    }
  });

  it('rejects a regressed counter instead of guessing wrap vs reset', () => {
    const r = diffPorts([port(1, { rxPackets: 100n })], [port(1, { rxPackets: 5n })], [1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/regressed/);
  });

  it('rejects a snapshot missing a required port', () => {
    expect(diffPorts([port(1)], [port(1)], [1, 3]).ok).toBe(false);
  });

  it('parses show-ports output with the shared parser', () => {
    const raw = [
      'Port 1', 'Status: UP', 'VLAN type: OpenFlow', 'VLAN ID: 100',
      'RX Bytes: 12345', 'TX Bytes: 6', 'RX Packets: 77', 'TX Packets: 8',
      'RX Dropped Packets: 2', 'TX Dropped Packets: 3', 'RX CRC Errors: 1',
    ].join('\r\n');
    const [p] = parseShowPorts(raw);
    expect(p).toMatchObject({ port: 1, status: 'UP', rxPackets: 77n, txDropped: 3n, rxCrcErrors: 1n });
  });
});

describe('iperf3 parsing reads integers only', () => {
  it('parses TCP bytes and retransmits, ignoring float fields', () => {
    const r = parseIperfTcp({
      start: { version: 'iperf 3.9' },
      end: {
        sum_sent: { bytes: 1000, retransmits: 4, bits_per_second: 1.5e7 },
        sum_received: { bytes: 990, bits_per_second: 1.4e7 },
      },
    });
    expect(r).toMatchObject({ sentBytes: 1000n, receivedBytes: 990n, retransmits: 4n });
  });

  it('parses UDP loss from end.sum_received when present, else end.sum', () => {
    const a = parseIperfUdp({ start: {}, end: { sum_received: { packets: 100, lost_packets: 3 }, sum: { packets: 1, lost_packets: 1 } } });
    expect(a).toMatchObject({ offeredPackets: 100n, lostPackets: 3n, lossSource: 'end.sum_received' });
    const b = parseIperfUdp({ start: {}, end: { sum: { packets: 50, lost_packets: 2 } } });
    expect(b).toMatchObject({ offeredPackets: 50n, lostPackets: 2n, lossSource: 'end.sum' });
  });

  it('throws on an iperf3 error payload and on non-integer counters', () => {
    expect(() => parseIperfTcp({ error: 'unable to connect' })).toThrow(/unable to connect/);
    expect(() => parseIperfTcp({ start: {}, end: { sum_sent: { bytes: 1.5 }, sum_received: { bytes: 1 } } })).toThrow();
  });
});

describe('derived metrics', () => {
  const deltas = {
    1: { rxPackets: 1000n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxDropped: 1n, txDropped: 0n, rxCrcErrors: 0n },
    2: { rxPackets: 0n, txPackets: 990n, rxBytes: 0n, txBytes: 0n, rxDropped: 0n, txDropped: 2n, rxCrcErrors: 0n },
    3: { rxPackets: 0n, txPackets: 900n, rxBytes: 0n, txBytes: 0n, rxDropped: 0n, txDropped: 7n, rxCrcErrors: 0n },
  };
  const endpoint = { workloadTxPackets: 1000n, workloadTxBytes: 0n, tapRxPackets: null, tapRxDropped: null };

  it('computes switch pps, forward loss ppm and UDP goodput from integer counts', () => {
    const m = deriveMetrics({
      windowNs: 10_000_000_000n,
      deltas,
      iperf: { protocol: 'UDP', offeredPackets: 1000n, lostPackets: 10n, lossSource: 'end.sum', iperfVersion: 'x' },
      udpPayloadBytes: 1470n,
      endpoint,
      mirrorEnabled: true,
    });
    expect(m.switchPort1RxPps).toBe(100n);
    expect(m.switchPort2TxPps).toBe(99n);
    expect(m.forwardDeficitPackets).toBe(10n);
    expect(m.forwardLossPpm).toBe(10_000n);
    expect(m.iperfLossPpm).toBe(10_000n);
    expect(m.goodputBps).toBe((990n * 1470n * 8n * 1_000_000_000n) / 10_000_000_000n);
    expect(m.port3TxDropped).toBe(7n);
  });

  it('demands Port 3 deltas when the mirror is enabled', () => {
    const { 3: _p3, ...noTap } = deltas;
    expect(() =>
      deriveMetrics({ windowNs: 1n, deltas: noTap, iperf: null, udpPayloadBytes: null, endpoint, mirrorEnabled: true }),
    ).toThrow();
  });
});

describe('tap-drop classification and threshold search', () => {
  it('flags hard drops regardless of noise floor', () => {
    const v = classifyTapStep({ offeredBps: 1n, port1RxPackets: 1000n, port3TxPackets: 1000n, port3TxDropped: 1n }, 500n);
    expect(v.hardDrop).toBe(true);
    expect(v.lossDetected).toBe(true);
  });

  it('flags soft loss only above the measured noise floor', () => {
    const below = classifyTapStep({ offeredBps: 1n, port1RxPackets: 1_000_000n, port3TxPackets: 999_900n, port3TxDropped: 0n }, 200n);
    expect(below.deficitPpm).toBe(100n);
    expect(below.softLoss).toBe(false);
    const above = classifyTapStep({ offeredBps: 1n, port1RxPackets: 1_000_000n, port3TxPackets: 999_000n, port3TxDropped: 0n }, 200n);
    expect(above.softLoss).toBe(true);
  });

  it('bisects to the requested resolution using only probe results', async () => {
    // The probe stands in for a measurement purely to exercise the search logic.
    const onset = 62_300_000n;
    const calls: bigint[] = [];
    const bracket = await refineTapThreshold({
      cleanBps: 10_000_000n, failBps: 100_000_000n, resolutionBps: 1_000_000n,
      probe: async (bps) => { calls.push(bps); return bps >= onset; },
    });
    expect(bracket.failBps - bracket.cleanBps <= 1_000_000n).toBe(true);
    expect(bracket.cleanBps < onset && onset <= bracket.failBps).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(7);
    expect(bracket.probes.length).toBe(calls.length);
  });

  it('rejects an inverted bracket', async () => {
    await expect(refineTapThreshold({ cleanBps: 5n, failBps: 5n, resolutionBps: 1n, probe: async () => true })).rejects.toThrow();
  });
});

describe('flow plan (NET-2 silicon budget, Invariant 4 loop-freedom)', () => {
  it('installs exactly the requested count when it fits', () => {
    const p = planFlowState({ quarantineRequested: 32, mirror: false, tapReturnPath: false });
    expect(p.quarantineInstalled).toBe(32);
    expect(p.clamped).toBe(false);
    expect(p.flows.length).toBe(34);
  });

  it('clamps 128 quarantine rules to leave room for forwarding rules, and reports the clamp', () => {
    const p = planFlowState({ quarantineRequested: 128, mirror: false, tapReturnPath: false });
    expect(p.quarantineInstalled).toBe(FLOW_TABLE_CAPACITY - p.forwardingRuleCount);
    expect(p.quarantineInstalled).toBe(126);
    expect(p.clamped).toBe(true);
    expect(p.flows.length).toBeLessThanOrEqual(FLOW_TABLE_CAPACITY);
  });

  it('quarantine rules use TEST-NET-2 sources that cannot match workload traffic', () => {
    const p = planFlowState({ quarantineRequested: 128, mirror: false, tapReturnPath: false });
    for (const f of p.flows.filter((x) => x.kind === 'quarantine')) {
      expect(f.srcIp).toMatch(/^198\.51\.100\.\d+$/);
      expect(f.priority).toBe(QUARANTINE_PRIORITY);
      expect(f.outputPorts).toEqual([]); // DROP
    }
  });

  it('mirror mode copies Port 1 ingress to Port 3 inside the forwarding rule', () => {
    const p = planFlowState({ quarantineRequested: 0, mirror: true, tapReturnPath: false });
    const fwd = p.flows.find((f) => f.inPort === 1);
    expect(fwd?.outputPorts).toEqual([2, 3]);
    expect(fwd?.priority).toBe(FORWARD_PRIORITY);
    expect(p.flows.some((f) => f.inPort === 3)).toBe(false);
  });

  it('every produced plan passes the symbolic loop-free verifier', () => {
    for (const mirror of [false, true]) {
      expect(() => verifyPlanLoopFree(planFlowState({ quarantineRequested: 32, mirror, tapReturnPath: mirror }))).not.toThrow();
    }
  });
});

describe('OpenFlow multipart flow-stats wire code', () => {
  it('encodes a 56-byte OFPMP_FLOW request', () => {
    const b = buildFlowStatsRequest(0xabcd);
    expect(b.length).toBe(56);
    expect(b.readUInt8(0)).toBe(OFP_VERSION_1_3);
    expect(b.readUInt8(1)).toBe(OpenFlowType.OFPT_MULTIPART_REQUEST);
    expect(b.readUInt16BE(2)).toBe(56);
    expect(b.readUInt32BE(4)).toBe(0xabcd);
    expect(b.readUInt16BE(8)).toBe(1);
  });

  function entry(priority: number, pkts: bigint): Buffer {
    const e = Buffer.alloc(56);
    e.writeUInt16BE(56, 0);
    e.writeUInt16BE(priority, 12);
    e.writeBigUInt64BE(pkts, 32);
    e.writeBigUInt64BE(pkts * 100n, 40);
    e.writeUInt16BE(1, 48); // OXM match header
    e.writeUInt16BE(4, 50);
    return e;
  }
  function reply(entries: Buffer[], more: boolean): Buffer {
    const head = Buffer.alloc(16);
    head.writeUInt8(OFP_VERSION_1_3, 0);
    head.writeUInt8(OpenFlowType.OFPT_MULTIPART_REPLY, 1);
    head.writeUInt16BE(1, 8);
    head.writeUInt16BE(more ? 1 : 0, 10);
    const body = Buffer.concat(entries);
    head.writeUInt16BE(16 + body.length, 2);
    return Buffer.concat([head, body]);
  }

  it('parses entries and the REPLY_MORE flag', () => {
    const r = parseFlowStatsReply(reply([entry(65535, 0n), entry(100, 42n)], true));
    expect(r.more).toBe(true);
    expect(r.entries.map((e) => e.priority)).toEqual([65535, 100]);
    expect(r.entries[1]?.packetCount).toBe(42n);
    expect(r.entries[1]?.byteCount).toBe(4200n);
  });

  it('fails closed on truncated or malformed entries', () => {
    const bad = reply([entry(1, 0n)], false).subarray(0, 40);
    expect(() => parseFlowStatsReply(bad)).toThrow();
  });

  it('decodes OFPT_ERROR type and code', () => {
    const e = Buffer.alloc(12);
    e.writeUInt16BE(5, 8);
    e.writeUInt16BE(1, 10);
    expect(parseOfpError(e)).toEqual({ errorType: 5, errorCode: 1 });
  });

  it('verifies the readback against the plan by exact count and detects quarantine hits', () => {
    const plan = planFlowState({ quarantineRequested: 3, mirror: false, tapReturnPath: false });
    const mk = (priority: number, packetCount = 0n): FlowStatsEntry => ({ tableId: 0, priority, packetCount, byteCount: 0n });
    const good = [mk(65535), mk(65535), mk(65535), mk(100), mk(100)];
    expect(verifyFlowReadback(plan, good).verified).toBe(true);
    expect(verifyFlowReadback(plan, good.slice(1)).verified).toBe(false);
    expect(verifyFlowReadback(plan, [mk(65535, 9n), mk(65535), mk(65535), mk(100), mk(100)]).quarantinePacketHits).toBe(9n);
  });
});

describe('artifact provenance and rendering (Invariant 6)', () => {
  const artifact = (origin: string): string =>
    serializeArtifact({
      provenance: {
        schema: ARTIFACT_SCHEMA,
        origin: origin as 'physical_bench_run',
        startedAtIso: 'T', startedMonotonicNs: 1n, finishedMonotonicNs: 2n,
        controllerHost: { hostname: 'h', platform: 'linux', arch: 'arm64', nodeVersion: 'v22' },
        switchIdentity: { datapathId: 255n, openflowPeer: 'p', serialPath: '/dev/x', firmwareVersion: 'f', cpuUid: 'u' },
        workload: { sshTarget: 'a@b', iface: 'eth0', ipv4: '10.0.2.50', kernel: 'k', iperf3Client: 'i' },
        iperfServer: 's', tapInterface: null,
        tool: { scriptSha256: 'a'.repeat(64), gitCommit: null, gitDirty: null },
        flowTableVerified: false, counterSource: 'c',
      },
      params: {
        durationSeconds: 1, trials: 1, order: 'interleaved', quarantineLevels: [0], udpOfferedBps: 1n,
        udpMtuPayloadBytes: 1, udpSmallPayloadBytes: 1, tapSweepBps: [], tapResolutionBps: 1n, tapReturnPath: false,
      },
      conditions: [{ id: 'q128', quarantineRequested: 128, quarantineInstalled: 126, clamped: true, mirror: false, readback: null }],
      trials: [],
      tapSweep: null,
    } satisfies BenchArtifact);

  it('round-trips BigInts losslessly beyond 2^53', () => {
    const big = 2n ** 63n + 12345n;
    const text = JSON.stringify({ x: { $bigint: big.toString() } });
    expect(text).toContain(big.toString());
    const parsed = parseArtifact(artifact('physical_bench_run'));
    expect(parsed.provenance.switchIdentity.datapathId).toBe(255n);
  });

  it('refuses to load an artifact that is not attested as a physical run', () => {
    expect(() => parseArtifact(artifact('cloud_snapshot'))).toThrow(/physical_bench_run/);
  });

  it('warns loudly when the flow table was unverified and when rules were clamped', () => {
    const md = renderResultsSection(parseArtifact(artifact('physical_bench_run')));
    expect(md).toMatch(/not\*\* confirmed on the switch/);
    expect(md).toMatch(/128 requested \/ 126 installed|requested.*126 installed/);
  });

  it('injects only between markers and rejects documents without them', () => {
    const doc = `a\n${RESULTS_BEGIN_MARKER}\nold\n${RESULTS_END_MARKER}\nb`;
    const out = injectIntoDocument(doc, 'NEW');
    expect(out).toContain('NEW');
    expect(out).not.toContain('old');
    expect(out.startsWith('a\n')).toBe(true);
    expect(out.endsWith('\nb')).toBe(true);
    expect(() => injectIntoDocument('no markers', 'x')).toThrow();
  });
});
