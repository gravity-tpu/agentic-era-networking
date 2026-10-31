/**
 * test/invariants/wire-run.test.ts
 * The pure core of the on-wire conformance run (plan section 16): the intent's expectation for a packet, the two verdicts (M1 against the
 * model, M2 against the intent), and the exact bytes of the frames the testbed sends. Nothing here touches the switch.
 */
import { describe, it, expect } from 'vitest';
import {
  internetChecksum,
  buildUdpFrame,
  buildArpRequestFrame,
  intentExpectation,
  m1Verdict,
  m2Verdict,
  macBytes,
  ipBytes,
  sendPlanFor,
  captureFilterFor,
  rawSendPython,
} from '../../src/sdn/wire-run.js';
import { candidateFlows, predictOutcome, FlowMode, addressUniverse } from '../../src/sdn/wire-flows.js';
import type { WireRuleSet } from '../../src/sdn/wire-flows.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';

describe('internetChecksum', () => {
  it('matches the RFC 1071 worked example', () => {
    // 00 01 f2 03 f4 f5 f6 f7 sums to ddf2; the checksum is its complement, 220d
    expect(internetChecksum(Uint8Array.from([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]))).toBe(0x220d);
  });
  it('pads an odd length with a zero byte', () => {
    expect(internetChecksum(Uint8Array.from([0x12, 0x34, 0x56]))).toBe((~(0x1234 + 0x5600) & 0xffff) >>> 0);
  });
  it('a header that includes its own checksum sums to zero', () => {
    const f = buildUdpFrame({ srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.2.50', dstIp: '10.0.0.119', dstPort: 41000, payload: Uint8Array.from([1, 2, 3]) });
    expect(internetChecksum(f.subarray(14, 34))).toBe(0);
  });
});

describe('frame builders', () => {
  it('builds a UDP frame with the exact fields requested', () => {
    const f = buildUdpFrame({ srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.2.50', dstIp: '10.0.0.119', dstPort: 41007, payload: Uint8Array.from([9, 9]) });
    expect(Array.from(f.subarray(0, 6))).toEqual(Array.from(macBytes('02:00:00:00:00:fe')));
    expect(Array.from(f.subarray(6, 12))).toEqual(Array.from(macBytes('02:00:00:00:00:01')));
    expect(f[12]).toBe(0x08); expect(f[13]).toBe(0x00);            // EtherType IPv4
    expect(f[14]).toBe(0x45); expect(f[23]).toBe(17);              // IPv4 header length 5 words; protocol UDP
    expect(Array.from(f.subarray(26, 30))).toEqual(Array.from(ipBytes('10.0.2.50')));
    expect(Array.from(f.subarray(30, 34))).toEqual(Array.from(ipBytes('10.0.0.119')));
    expect((f[36]! << 8) | f[37]!).toBe(41007);                    // UDP destination port
    expect((f[16]! << 8) | f[17]!).toBe(20 + 8 + 2);               // IPv4 total length
    expect(f.length).toBe(14 + 20 + 8 + 2);
  });
  it('builds an ARP request with the sender and target protocol addresses requested', () => {
    const f = buildArpRequestFrame({ srcMac: '02:00:00:00:00:01', spa: '10.0.2.53', tpa: '10.0.2.50' });
    expect(Array.from(f.subarray(0, 6))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(f[12]).toBe(0x08); expect(f[13]).toBe(0x06);            // EtherType ARP
    expect(f[20]).toBe(0x00); expect(f[21]).toBe(0x01);            // opcode: request
    expect(Array.from(f.subarray(22, 28))).toEqual(Array.from(macBytes('02:00:00:00:00:01')));
    expect(Array.from(f.subarray(28, 32))).toEqual(Array.from(ipBytes('10.0.2.53')));
    expect(Array.from(f.subarray(38, 42))).toEqual(Array.from(ipBytes('10.0.2.50')));
  });
  it('rejects a malformed address or MAC instead of guessing', () => {
    expect(() => ipBytes('10.0.2')).toThrow();
    expect(() => ipBytes('10.0.2.256')).toThrow();
    expect(() => macBytes('02:00:00:00:00')).toThrow();
    expect(() => macBytes('zz:00:00:00:00:01')).toThrow();
  });
});

describe('intentExpectation', () => {
  it('returns the first matching clause, else default-deny', () => {
    const ipToUplinkHost = { inPort: 1, etherType: 0x0800, srcMac: 'x', dstMac: 'y', srcIp: '10.0.2.50', dstIp: '10.0.2.52' };
    const e = intentExpectation(PORT1_ISOLATION_INTENT, ipToUplinkHost);
    expect(e.clauseId).toBe('p1-ipv4-intra-segment');
    expect(e.mustReach).toEqual([2]);
    expect(e.mayReach).toEqual([2, 3]);
    const stray = intentExpectation(PORT1_ISOLATION_INTENT, { ...ipToUplinkHost, dstIp: '8.8.8.8' });
    expect(stray.mustReach.length).toBeLessThanOrEqual(stray.mayReach.length);
  });
  it('falls to default-deny for a packet no clause covers', () => {
    const e = intentExpectation({ ...PORT1_ISOLATION_INTENT, clauses: [] }, { inPort: 1, etherType: 0x0800, srcMac: 'a', dstMac: 'b' });
    expect(e).toEqual({ clauseId: 'default-deny', mustReach: [], mayReach: [] });
  });
});

describe('M1: agreement with the model', () => {
  it('agrees when the observed ports equal the predicted ones, in any order', () => {
    expect(m1Verdict([2, 3], [3, 2]).agrees).toBe(true);
    expect(m1Verdict([], []).agrees).toBe(true);
  });
  it('names a frame seen where the model predicts none, and one missing where the model predicts it', () => {
    const seen = m1Verdict([3], [2, 3]);
    expect(seen).toMatchObject({ agrees: false, seenNotPredicted: [2], predictedNotSeen: [] });
    const missing = m1Verdict([2, 3], [3]);
    expect(missing).toMatchObject({ agrees: false, seenNotPredicted: [], predictedNotSeen: [2] });
  });
});

describe('M2: behaviour against the intent', () => {
  const exp = { clauseId: 'c', mustReach: [2, 3], mayReach: [2, 3] };
  it('is compliant when every observable must-reach port was seen and nothing outside may-reach was', () => {
    expect(m2Verdict(exp, [2, 3], [2, 3]).compliant).toBe(true);
  });
  it('flags a leak: a frame seen on a port the intent does not allow', () => {
    expect(m2Verdict({ clauseId: 'c', mustReach: [], mayReach: [3] }, [2, 3], [2, 3])).toMatchObject({ compliant: false, leaks: [2] });
  });
  it('flags a missing delivery on a port the testbed can observe', () => {
    expect(m2Verdict(exp, [3], [2, 3])).toMatchObject({ compliant: false, missing: [2] });
  });
  it('does not charge a missing delivery on a port the testbed cannot observe', () => {
    expect(m2Verdict({ clauseId: 'c', mustReach: [1, 2], mayReach: [1, 2] }, [2], [2, 3])).toMatchObject({ compliant: true, missing: [] });
  });
});

describe('offline consistency: an admissible set predicts intent-compliant behaviour on every candidate flow', () => {
  it('holds for the reference policy of INTENT-1 (A11 says so; M2 over predictions must agree)', () => {
    const ref = buildPort1IsolationPolicy();
    const set: WireRuleSet = { id: 'ref', rules: ref.map((r) => ({ id: r.id, priority: r.flowMod.priority, outputPorts: [...(r.flowMod.outputPorts ?? [])], match: { ...(r.flowMod.match ?? {}) } })) };
    const flows = candidateFlows(addressUniverse([set], ['10.0.2.53']), FlowMode.Forged);
    for (const f of flows) {
      const predicted = predictOutcome(set.rules, f);
      const v = m2Verdict(intentExpectation(PORT1_ISOLATION_INTENT, f.packet), predicted, f.observable);
      expect(v.compliant, `${f.id}: ${JSON.stringify(v)}`).toBe(true);
    }
  });
  it('can fail: a leaky set predicts a non-compliant outcome on some flow', () => {
    const leaky: WireRuleSet = { id: 'leaky', rules: [{ id: 'all', priority: 1, outputPorts: [1, 2, 3], match: {} }] };
    const flows = candidateFlows(addressUniverse([leaky]), FlowMode.Forged);
    const bad = flows.filter((f) => !m2Verdict(intentExpectation(PORT1_ISOLATION_INTENT, f.packet), predictOutcome(leaky.rules, f), f.observable).compliant);
    expect(bad.length).toBeGreaterThan(0);
  });
});

describe('sendPlanFor: how the testbed would send a flow, or why it cannot', () => {
  const ip = (inPort: number, srcIp: string, dstIp: string): import('../../src/sdn/wire-flows.js').WireFlow => ({ id: `f-${inPort}-${srcIp}-${dstIp}`, mode: 0, observable: inPort === 1 ? [2, 3] : [1, 3], packet: { inPort, etherType: 0x0800, srcMac: '02:00:00:00:00:0' + inPort, dstMac: '02:00:00:00:00:fe', srcIp, dstIp } });
  const arp = (inPort: number, spa: string, tpa: string): import('../../src/sdn/wire-flows.js').WireFlow => ({ id: `a-${inPort}-${spa}-${tpa}`, mode: 0, observable: inPort === 1 ? [2, 3] : [1, 3], packet: { inPort, etherType: 0x0806, srcMac: '02:00:00:00:00:0' + inPort, dstMac: 'ff:ff:ff:ff:ff:ff', arpSpa: spa, arpTpa: tpa } });
  it('sends every port 1 frame as a raw frame from a workload node, with the flow\'s exact header fields', () => {
    expect(sendPlanFor(ip(1, '10.0.2.53', '8.8.8.8'))).toEqual({ via: 'raw-from-node' });
    expect(sendPlanFor(arp(1, '10.0.2.50', '10.0.0.119'))).toEqual({ via: 'raw-from-node' });
  });
  it('sends a port 2 IPv4 flow from the Mac only to a destination in the workload subnet', () => {
    expect(sendPlanFor(ip(2, '10.0.0.119', '10.0.2.52'))).toEqual({ via: 'udp-from-mac', aliasIp: null });
    expect(sendPlanFor(ip(2, '10.0.2.119', '10.0.2.52'))).toEqual({ via: 'udp-from-mac', aliasIp: '10.0.2.119' });
  });
  it('cannot send a port 2 flow whose destination is outside the workload subnet: the Mac would send it to the internet, not to the switch', () => {
    const p = sendPlanFor(ip(2, '10.0.0.119', '8.8.8.8'));
    expect(p.via).toBe('unsendable');
    expect((p as { reason: string }).reason).toMatch(/internet|leave/);
  });
  it('cannot send a port 2 ARP flow (no Linux sender on the uplink side) or a port 3 flow', () => {
    expect(sendPlanFor(arp(2, '10.0.0.119', '10.0.2.50')).via).toBe('unsendable');
    expect(sendPlanFor(ip(3, '10.0.2.50', '10.0.2.52')).via).toBe('unsendable');
  });
  it('cannot send a port 2 flow from a source that is neither the Mac nor in the workload subnet', () => {
    expect(sendPlanFor(ip(2, '8.8.8.8', '10.0.2.52')).via).toBe('unsendable');
  });
});

describe('sendPlanFor: a port 2 destination must be a real host', () => {
  it('cannot send to a workload address no host answers for', () => {
    const f = { id: 'x', mode: 1 as const, observable: [1, 3], packet: { inPort: 2, etherType: 0x0800, srcMac: '02:00:00:00:00:02', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.0.119', dstIp: '10.0.2.53' } };
    const p = sendPlanFor(f);
    expect(p.via).toBe('unsendable');
    expect((p as { reason: string }).reason).toMatch(/ARP/);
  });
});

describe('captureFilterFor', () => {
  const udp = { id: 'u', mode: 0 as const, observable: [2, 3], packet: { inPort: 1, etherType: 0x0800, srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:fe', srcIp: '10.0.2.50', dstIp: '10.0.0.119' } };
  const arpFlow = { id: 'a', mode: 0 as const, observable: [2, 3], packet: { inPort: 1, etherType: 0x0806, srcMac: '02:00:00:00:00:01', dstMac: 'ff:ff:ff:ff:ff:ff', arpSpa: '10.0.2.50', arpTpa: '10.0.2.52' } };
  it('keys UDP on its unique destination port and ARP on the flow\'s source MAC', () => {
    expect(captureFilterFor(udp, 41007)).toBe('udp dst port 41007');
    expect(captureFilterFor(arpFlow, 41008)).toBe('arp and ether src 02:00:00:00:00:01');
  });
  it('rejects a bad tag or a malformed MAC instead of building a filter from it', () => {
    expect(() => captureFilterFor(udp, 0)).toThrow(RangeError);
    expect(() => captureFilterFor(udp, 70000)).toThrow(RangeError);
    expect(() => captureFilterFor({ ...arpFlow, packet: { ...arpFlow.packet, srcMac: "x'; rm -rf /" } }, 1)).toThrow();
  });
});

describe('rawSendPython', () => {
  it('embeds only validated hex and interface name', () => {
    const code = rawSendPython('eth0', ['aabbcc', '00ff'], 200);
    expect(code).toContain("s.bind(('eth0', 0))");
    expect(code).toContain("['aabbcc', '00ff']");
    expect(code).toContain('time.sleep(200 / 1000)');
  });
  it('rejects an unsafe interface name, non-hex frames, too many frames and an out-of-range spacing', () => {
    expect(() => rawSendPython("eth0'; import os", ['aa'], 0)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', ["aa'); import os; ('"], 0)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', ['AA'], 0)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', [], 0)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', Array.from({ length: 11 }, () => 'aa'), 0)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', ['aa'], -1)).toThrow(RangeError);
    expect(() => rawSendPython('eth0', ['aa'], 2001)).toThrow(RangeError);
  });
});
