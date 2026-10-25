/**
 * flow-probe-real-capture.test.ts
 * Regression tests on the FIRST REAL capture of the Zodiac FX flow table: docs/benchmarks/results/flow-probe/
 * flow-probe-2026-10-15T05-25-07-405Z.json (origin physical_readback, taken from the live switch through the bridge's
 * read-only probe, firmware declared by the operator as 0.86, tool commit 36920e0, clean tree).
 *
 * This is the one place the suite uses bytes the switch actually sent. Every other flow-stats fixture in the repo is
 * synthetic. What it pins is a MEASURED FACT about one switch on one day: firmware 0.86 reports each rule's
 * instruction block, byte for byte as the controller encoded it, and reports no instructions for the table-miss.
 * It is not evidence about other firmware versions or other switches.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import { analyzeFlowProbe, FLOW_PROBE_ORIGIN, type FlowProbeReport } from '../../src/sdn/flow-probe.js';
import {
  verifyIsolationReadback,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  ZODIAC_PORT_WORKLOAD,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_TAP,
  WORKLOAD_SUBNET,
  WORKLOAD_PREFIX_LEN,
  PRIORITY_ISOLATION_ALLOW,
  PRIORITY_ISOLATION_TAP_ONLY,
  PRIORITY_TAP_RETURN,
  type IsolationRule,
} from '../../src/sdn/port1-isolation.js';

const DIR = 'docs/benchmarks/results/flow-probe';
const NAME = 'flow-probe-2026-10-15T05-25-07-405Z';
const reportText = readFileSync(`${DIR}/${NAME}.json`, 'utf8');
const report = JSON.parse(reportText) as FlowProbeReport;
const meta = JSON.parse(readFileSync(`${DIR}/${NAME}.meta.json`, 'utf8')) as Record<string, unknown>;

/**
 * The policy as it actually was deployed on the switch on 2026-10-15, BEFORE the A10 fix
 * (per-host ARP confinement, docs/benchmarks/results/a10-arp-spa-feasibility/) changed
 * `buildPort1IsolationPolicy()`'s default shape from 6 rules to 7. This capture is a frozen,
 * real artifact (Invariant 6) of what the switch reported that day -- it must be compared
 * against what was actually on the switch then, not against whatever the live policy builder
 * returns today. Hand-frozen here rather than calling buildPort1IsolationPolicy(), which now
 * returns a different (correct, but different) shape.
 */
const policy: readonly IsolationRule[] = [
  {
    id: 'p1-ipv4-intra-segment',
    flowMod: {
      command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_ISOLATION_ALLOW, outputPorts: [ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP],
      match: { inPort: ZODIAC_PORT_WORKLOAD, etherType: ETH_TYPE_IPV4, srcIp: WORKLOAD_SUBNET, srcIpPrefixLen: WORKLOAD_PREFIX_LEN, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
    },
  },
  {
    id: 'p1-arp',
    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_ISOLATION_ALLOW, outputPorts: [ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP], match: { inPort: ZODIAC_PORT_WORKLOAD, etherType: ETH_TYPE_ARP } },
  },
  {
    id: 'p1-default-tap-only',
    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_ISOLATION_TAP_ONLY, outputPorts: [ZODIAC_PORT_TAP], match: { inPort: ZODIAC_PORT_WORKLOAD } },
  },
  {
    id: 'p2-ipv4-to-segment',
    flowMod: {
      command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_ISOLATION_ALLOW, outputPorts: [ZODIAC_PORT_WORKLOAD],
      match: { inPort: ZODIAC_PORT_UPLINK, etherType: ETH_TYPE_IPV4, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
    },
  },
  {
    id: 'p2-arp',
    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_ISOLATION_ALLOW, outputPorts: [ZODIAC_PORT_WORKLOAD], match: { inPort: ZODIAC_PORT_UPLINK, etherType: ETH_TYPE_ARP } },
  },
  {
    id: 'p3-tap-return',
    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: PRIORITY_TAP_RETURN, outputPorts: [ZODIAC_PORT_WORKLOAD], match: { inPort: ZODIAC_PORT_TAP } },
  },
];

/** Bytes after the ofp_match: where the instruction block starts in an ofp_flow_stats entry. */
function instructionBytes(entry: Buffer): Buffer {
  const matchLen = entry.readUInt16BE(48 + 2);
  return entry.subarray(48 + Math.max(8, Math.ceil(matchLen / 8) * 8));
}

describe('the real capture: provenance', () => {
  it('is a physical readback, and the sidecar describes exactly this file', () => {
    expect(report.origin).toBe(FLOW_PROBE_ORIGIN);
    expect(meta['origin']).toBe('physical_readback');
    expect(meta['reportSha256']).toBe(createHash('sha256').update(reportText).digest('hex'));
    expect(meta['rawRepliesSha256']).toBe(report.rawRepliesSha256);
    expect(meta['firmwareDeclaredByOperator']).toBe('0.86'); // declared by the operator, not measured by the probe
    expect(meta['tool']).toMatchObject({ gitCommit: '36920e0', gitDirty: false });
  });

  it('its summary re-derives from its own raw bytes', () => {
    expect(analyzeFlowProbe(report, policy).disagreements).toEqual([]);
  });
});

describe('the real capture: what firmware 0.86 reported', () => {
  it('reports instructions, and every rule matches the policy at both levels', () => {
    expect(report.finding).toBe('reports-instructions');
    expect(report.entryCount).toBe(7); // table-miss + six isolation rules
    expect(report.readback.verified).toBe(true);
    expect(report.readback.actions.status).toBe('confirmed');
    expect(report.readback.actions.tableMiss).toBe('drops');
    expect(report.readback.actions.switchReportsActions).toBe(true);
    expect(report.readback.provenForwarding).toBe(true);
  });

  it('the current parser and verifier still reach that verdict from the raw reply bytes', () => {
    const replies = report.rawRepliesHex.map((h) => Buffer.from(h, 'hex'));
    const entries = replies.flatMap((r) => parseFlowStatsReply(r).entries);
    const v = verifyIsolationReadback(policy, entries);
    expect(v.verified).toBe(true);
    expect(v.actions.status).toBe('confirmed');
    expect(v.provenForwarding).toBe(true);
  });

  it('echoes each rule\'s instruction bytes exactly as the controller encoded them', () => {
    // The dotted mask the switch reports for a prefix. An exact (/32 or omitted) match reports no mask. Any other
    // length is converted generally; an out-of-range one throws rather than quietly matching nothing.
    const maskOf = (len: number | undefined): string | undefined => {
      if (len === undefined || len === 32) return undefined;
      if (!Number.isInteger(len) || len < 1 || len > 31) throw new Error(`unsupported prefix length ${len}`);
      const m = (0xffffffff << (32 - len)) >>> 0;
      return `${m >>> 24}.${(m >>> 16) & 255}.${(m >>> 8) & 255}.${m & 255}`;
    };
    const paired = new Set<string>();
    policy.forEach((rule, i) => {
      const m = rule.flowMod.match ?? {};
      // Every field of the match, masks included, and exactly one entry: no loose first-match pairing.
      const candidates = report.entries.filter(
        (e) =>
          e.priority === rule.flowMod.priority &&
          e.inPort === m.inPort &&
          e.ethType === m.etherType &&
          e.srcIp === m.srcIp &&
          e.srcMask === maskOf(m.srcIpPrefixLen) &&
          e.dstIp === m.dstIp &&
          e.dstMask === maskOf(m.dstIpPrefixLen),
      );
      expect(candidates, rule.id).toHaveLength(1);
      const entry = candidates[0];
      paired.add(entry?.entryHex ?? '');
      const fm = buildOfpFlowMod(rule.flowMod, i + 1);
      const ours = fm.subarray(48 + Math.max(8, Math.ceil(fm.readUInt16BE(50) / 8) * 8));
      const theirs = instructionBytes(Buffer.from(entry?.entryHex ?? '', 'hex'));
      expect(theirs.toString('hex'), rule.id).toBe(ours.toString('hex'));
    });
    expect(paired.size).toBe(policy.length); // six rules, six distinct entries
  });

  // OpenFlow 1.3 defines a matched entry with no instructions as an empty action set, which drops the packet. That
  // is the specification's meaning, and this asserts only what the bytes show: an entry with no instruction bytes.
  // Whether the firmware honours it on the wire is a question for the O1/O3 captures, not for this readback.
  it('the table-miss entry carries no instruction bytes (an empty action set: a drop under OpenFlow 1.3)', () => {
    const miss = report.entries.find((e) => e.priority === 0);
    expect(miss?.actions.hasInstructions).toBe(false);
    expect(Buffer.from(miss?.entryHex ?? '', 'hex').length).toBe(56);
  });
});
