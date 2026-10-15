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
import { buildOfpFlowMod } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import { analyzeFlowProbe, FLOW_PROBE_ORIGIN, type FlowProbeReport } from '../../src/sdn/flow-probe.js';
import { buildPort1IsolationPolicy, verifyIsolationReadback } from '../../src/sdn/port1-isolation.js';

const DIR = 'docs/benchmarks/results/flow-probe';
const NAME = 'flow-probe-2026-10-15T05-25-07-405Z';
const reportText = readFileSync(`${DIR}/${NAME}.json`, 'utf8');
const report = JSON.parse(reportText) as FlowProbeReport;
const meta = JSON.parse(readFileSync(`${DIR}/${NAME}.meta.json`, 'utf8')) as Record<string, unknown>;
const policy = buildPort1IsolationPolicy();

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
    // A /24 mask in dotted form; the policy's IPv4 rules are the only masked matches.
    const maskOf = (len: number | undefined): string | undefined => (len === 24 ? '255.255.255.0' : undefined);
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
