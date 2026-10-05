/**
 * dataplane-depth.test.ts
 * Invariant tests for the pure core of the Zodiac FX depth / working-window benchmarks.
 *
 * IMPORTANT (Invariant 6): every value below is a TEST FIXTURE proving arithmetic, planners,
 * parsers and wire encoders. None is a measurement of the physical switch.
 */

import { describe, it, expect } from 'vitest';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import type { FlowStatsEntry } from '../../src/sdn/dataplane-benchmark.js';
import {
  MAX_QUARANTINE_DEPTH,
  analyzePingGaps,
  framedLineRatePps,
  hitIndex,
  naiveLineRatePps,
  planDepthCondition,
  rampAddOffsetsMs,
  rulesAtOffset,
  udpPayloadForIpPacket,
  verifyDepthReadback,
} from '../../src/sdn/dataplane-depth.js';
import type { DepthCondition, DepthPlan } from '../../src/sdn/dataplane-depth.js';

const base: DepthCondition = {
  id: 't',
  depth: 4,
  match: 'host32',
  priorityOrder: 'quarantine_above',
  installOrder: 'quarantine_first',
  distinctPriorities: false,
  hit: null,
};

/** Builds the entries a switch would report for a plan (fixture for verifier tests). */
function entriesFor(plan: DepthPlan, withMatch: boolean): FlowStatsEntry[] {
  return plan.flows.map((f) => ({
    tableId: 0,
    priority: f.priority,
    packetCount: 0n,
    byteCount: 0n,
    ...(withMatch && f.kind === 'forward' ? { inPort: f.inPort! } : {}),
    ...(withMatch && f.kind !== 'forward'
      ? { srcIp: f.srcIp!, ...(f.srcPrefixLen === 16 ? { srcMask: '255.255.0.0' } : {}) }
      : {}),
  }));
}

describe('line-rate arithmetic (the roadmap 20,800 pps theory)', () => {
  it('reproduces the roadmap figure and the framed figure for 600-byte packets', () => {
    expect(naiveLineRatePps(100_000_000n, 600n)).toBe(20_833n);
    // 600-byte IP packet = 572-byte UDP payload = 638 wire bytes
    expect(udpPayloadForIpPacket(600)).toBe(572);
    expect(framedLineRatePps(100_000_000n, 572n)).toBe(19_592n);
  });
  it('rejects nonsensical sizes', () => {
    expect(() => naiveLineRatePps(1n, 0n)).toThrow();
    expect(() => udpPayloadForIpPacket(28)).toThrow();
  });
});

describe('planDepthCondition', () => {
  it('matches the original benchmark layout by default (shared priority 65535, forwards at 100)', () => {
    const p = planDepthCondition(base);
    expect(p.flows).toHaveLength(6);
    expect(p.flows.slice(0, 4).every((f) => f.priority === 65535 && f.kind === 'quarantine')).toBe(true);
    expect(p.flows.slice(4).every((f) => f.priority === 100 && f.kind === 'forward')).toBe(true);
  });
  it('throws instead of clamping beyond table room', () => {
    expect(() => planDepthCondition({ ...base, depth: MAX_QUARANTINE_DEPTH + 1 })).toThrow(/exceeds table room/);
    expect(planDepthCondition({ ...base, depth: MAX_QUARANTINE_DEPTH }).flows).toHaveLength(128);
  });
  it('orders forwards first when asked and flips priorities for forward_above', () => {
    const p = planDepthCondition({ ...base, installOrder: 'forward_first', priorityOrder: 'forward_above' });
    expect(p.flows[0]!.kind).toBe('forward');
    expect(p.flows[0]!.priority).toBe(65535);
    expect(p.flows[2]!.priority).toBe(1000);
  });
  it('never lets a benign quarantine address collide with workload or receiver addressing', () => {
    const p = planDepthCondition({ ...base, depth: MAX_QUARANTINE_DEPTH, match: 'net16' });
    const ips = p.flows.filter((f) => f.kind === 'quarantine').map((f) => f.srcIp!);
    expect(new Set(ips).size).toBe(ips.length);
    expect(ips.every((ip) => ip.startsWith('240.') && ip.endsWith('.0.0'))).toBe(true);
    const h = planDepthCondition({ ...base, depth: 10 });
    expect(h.flows.filter((f) => f.kind === 'quarantine').every((f) => f.srcIp!.startsWith('198.51.100.'))).toBe(true);
  });
  it('places the hit rule at the requested position with distinct descending priorities', () => {
    for (const [pos, idx] of [['first', 0], ['middle', 4], ['last', 9]] as const) {
      const p = planDepthCondition({ ...base, depth: 10, hit: pos });
      const q = p.flows.filter((f) => f.kind !== 'forward');
      expect(q.findIndex((f) => f.kind === 'hit')).toBe(idx);
      expect(hitIndex(10, pos)).toBe(idx);
      const prios = q.map((f) => f.priority);
      expect([...prios].sort((a, b) => b - a)).toEqual(prios);
      expect(new Set(prios).size).toBe(prios.length);
      expect(p.hitPriority).toBe(q[idx]!.priority);
    }
  });
  it('rejects hit rules on prefix matches or empty tables', () => {
    expect(() => planDepthCondition({ ...base, hit: 'first', match: 'net16' })).toThrow();
    expect(() => planDepthCondition({ ...base, depth: 0, hit: 'first' })).toThrow();
  });
});

describe('verifyDepthReadback', () => {
  it('accepts a faithful table and counts hits separately', () => {
    const p = planDepthCondition({ ...base, depth: 6, hit: 'middle' });
    const e = entriesFor(p, true).map((x) => (x.priority === p.hitPriority ? { ...x, packetCount: 500n } : x));
    const v = verifyDepthReadback(p, e);
    expect(v.verified).toBe(true);
    expect(v.matchContentChecked).toBe(true);
    expect(v.hitRulePackets).toBe(500n);
    expect(v.benignQuarantineHits).toBe(0n);
  });
  it('flags a benign rule that matched traffic', () => {
    const p = planDepthCondition(base);
    const e = entriesFor(p, false);
    e[0] = { ...e[0]!, packetCount: 3n };
    expect(verifyDepthReadback(p, e).benignQuarantineHits).toBe(3n);
  });
  it('fails closed when a /16 plan cannot be verified from the firmware match report', () => {
    const p = planDepthCondition({ ...base, match: 'net16' });
    const v = verifyDepthReadback(p, entriesFor(p, false));
    expect(v.verified).toBe(false);
    expect(v.mismatches.join(' ')).toMatch(/no verifiable match/);
  });
  it('detects a /16 rule the switch widened or narrowed', () => {
    const p = planDepthCondition({ ...base, match: 'net16', depth: 2 });
    const e = entriesFor(p, true).map((x) => (x.srcMask ? { ...x, srcMask: '255.255.255.255' } : x));
    const v = verifyDepthReadback(p, e);
    expect(v.verified).toBe(false);
  });
  it('detects count mismatches and unexpected priorities', () => {
    const p = planDepthCondition(base);
    expect(verifyDepthReadback(p, entriesFor(p, false).slice(1)).verified).toBe(false);
    const extra = [...entriesFor(p, false), { tableId: 0, priority: 7, packetCount: 0n, byteCount: 0n }];
    expect(verifyDepthReadback(p, extra).verified).toBe(false);
  });
  it('only needs count agreement for plain host rules (matches the original benchmark)', () => {
    const p = planDepthCondition(base);
    const v = verifyDepthReadback(p, entriesFor(p, false));
    expect(v.verified).toBe(true);
    expect(v.matchContentChecked).toBe(false);
  });
});

describe('masked IPv4 source match encoding', () => {
  const find = (buf: Buffer, hdr: number): number => {
    for (let i = 48; i + 4 <= buf.length; i++) if (buf.readUInt32BE(i) === hdr) return i;
    return -1;
  };
  it('encodes a /16 as OXM IPV4_SRC with HASMASK', () => {
    const buf = buildOfpFlowMod(
      { command: FlowModCommand.OFPFC_ADD, priority: 10, outputPorts: [], match: { srcIp: '240.5.0.0', srcIpPrefixLen: 16 } },
      1,
    );
    const at = find(buf, 0x80001708);
    expect(at).toBeGreaterThan(0);
    expect([...buf.subarray(at + 4, at + 8)]).toEqual([240, 5, 0, 0]);
    expect([...buf.subarray(at + 8, at + 12)]).toEqual([255, 255, 0, 0]);
    expect(buf.length % 8).toBe(0);
  });
  it('keeps /32 and unspecified prefixes on the exact-match encoding', () => {
    for (const m of [{ srcIp: '1.2.3.4' }, { srcIp: '1.2.3.4', srcIpPrefixLen: 32 }]) {
      const buf = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 10, outputPorts: [], match: m }, 1);
      expect(find(buf, 0x80001604)).toBeGreaterThan(0);
      expect(find(buf, 0x80001708)).toBe(-1);
    }
  });
  it('refuses host bits outside the mask and invalid lengths (no silent widening)', () => {
    const bad = (m: { srcIp: string; srcIpPrefixLen: number }): (() => Buffer) => () =>
      buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 1, outputPorts: [], match: m }, 1);
    expect(bad({ srcIp: '240.5.1.0', srcIpPrefixLen: 16 })).toThrow(/host bits/);
    expect(bad({ srcIp: '240.5.0.0', srcIpPrefixLen: 0 })).toThrow();
    expect(bad({ srcIp: '240.5.0.0', srcIpPrefixLen: 33 })).toThrow();
  });
});

describe('parseFlowStatsReply match extraction', () => {
  /** One ofp_flow_stats entry with the given OXM TLVs and no instructions. */
  function entry(priority: number, oxms: Buffer[]): Buffer {
    const oxm = Buffer.concat(oxms);
    const matchLen = 4 + oxm.length;
    const padded = Math.ceil(matchLen / 8) * 8;
    const len = 48 + padded;
    const b = Buffer.alloc(len);
    b.writeUInt16BE(len, 0);
    b.writeUInt16BE(priority, 12);
    b.writeUInt16BE(1, 48);
    b.writeUInt16BE(matchLen, 50);
    oxm.copy(b, 52);
    return b;
  }
  const reply = (entries: Buffer[]): Buffer => {
    const head = Buffer.alloc(16);
    head.writeUInt8(0x04, 0);
    head.writeUInt8(19, 1); // OFPT_MULTIPART_REPLY
    head.writeUInt16BE(1, 8); // OFPMP_FLOW
    const body = Buffer.concat(entries);
    head.writeUInt16BE(16 + body.length, 2);
    return Buffer.concat([head, body]);
  };
  const tlv = (hdr: number, payload: number[]): Buffer => {
    const b = Buffer.alloc(4 + payload.length);
    b.writeUInt32BE(hdr, 0);
    Buffer.from(payload).copy(b, 4);
    return b;
  };

  it('extracts masked and exact source IPs and in_port', () => {
    const p = parseFlowStatsReply(
      reply([
        entry(65535, [tlv(0x80000a02, [8, 0]), tlv(0x80001708, [240, 7, 0, 0, 255, 255, 0, 0])]),
        entry(65534, [tlv(0x80000a02, [8, 0]), tlv(0x80001604, [198, 51, 100, 9])]),
        entry(100, [tlv(0x80000004, [0, 0, 0, 1])]),
      ]),
    );
    expect(p.entries[0]).toMatchObject({ priority: 65535, srcIp: '240.7.0.0', srcMask: '255.255.0.0' });
    expect(p.entries[1]).toMatchObject({ priority: 65534, srcIp: '198.51.100.9' });
    expect(p.entries[1]!.srcMask).toBeUndefined();
    expect(p.entries[2]).toMatchObject({ priority: 100, inPort: 1 });
  });
  it('does not throw on an empty or non-standard match (callers fail closed)', () => {
    const p = parseFlowStatsReply(reply([entry(5, [])]));
    expect(p.entries[0]!.srcIp).toBeUndefined();
  });
});

describe('rule ramp', () => {
  it('spreads rules strictly inside the window and ramps monotonically', () => {
    const o = rampAddOffsetsMs(24, 300_000);
    expect(o).toHaveLength(24);
    expect(o[0]!).toBeGreaterThan(0);
    expect(o[23]!).toBeLessThan(300_000);
    expect([...o].sort((a, b) => a - b)).toEqual(o);
    expect(rulesAtOffset(o, 0)).toBe(0);
    expect(rulesAtOffset(o, 299_999)).toBe(24);
  });
  it('handles zero targets and rejects bad windows', () => {
    expect(rampAddOffsetsMs(0, 1000)).toEqual([]);
    expect(() => rampAddOffsetsMs(1, 0)).toThrow();
  });
});

describe('analyzePingGaps', () => {
  const out = [
    '[1759540000.000000] 64 bytes from 10.0.2.119: icmp_seq=1 ttl=64 time=3.1 ms',
    '[1759540000.010000] 64 bytes from 10.0.2.119: icmp_seq=2 ttl=64 time=3.0 ms',
    '[1759540001.510000] 64 bytes from 10.0.2.119: icmp_seq=150 ttl=64 time=3.2 ms',
    '[1759540001.520000] 64 bytes from 10.0.2.119: icmp_seq=151 ttl=64 time=3.1 ms',
    '',
    '--- 10.0.2.119 ping statistics ---',
    '160 packets transmitted, 4 received, 97% packet loss, time 1600ms',
  ].join('\n');
  it('finds the outage without floating point', () => {
    const r = analyzePingGaps(out, 50_000n);
    expect(r.received).toBe(4);
    expect(r.sent).toBe(160);
    expect(r.maxGapUs).toBe(1_500_000n);
    expect(r.gaps).toEqual([{ startUs: 1759540000010000n, durationUs: 1_500_000n }]);
  });
  it('returns null gap with fewer than two replies', () => {
    expect(analyzePingGaps('', 1n).maxGapUs).toBeNull();
  });
});
