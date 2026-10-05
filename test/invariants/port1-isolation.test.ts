/**
 * port1-isolation.test.ts
 * Invariant tests for the Zodiac Port 1 workload isolation policy.
 *
 * IMPORTANT (Invariant 6): these tests prove policy structure and wire encoding only.
 * They are not measurements of the physical switch.
 */

import { describe, it, expect } from 'vitest';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import {
  buildPort1IsolationPolicy,
  verifyPort1Isolation,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_WORKLOAD,
} from '../../src/sdn/port1-isolation.js';
import type { IsolationRule } from '../../src/sdn/port1-isolation.js';

/** Collects OXM TLV type headers (uint32) from an encoded FlowMod. */
function oxmHeaders(buf: Buffer): number[] {
  const matchLen = buf.readUInt16BE(50);
  const headers: number[] = [];
  let off = 52;
  const end = 48 + matchLen;
  while (off < end) {
    const h = buf.readUInt32BE(off);
    headers.push(h);
    off += 4 + (h & 0xff);
  }
  return headers;
}

describe('Port 1 isolation policy', () => {
  const policy = buildPort1IsolationPolicy();

  it('passes the symbolic verifier', () => {
    expect(verifyPort1Isolation(policy)).toEqual([]);
  });

  it('never forwards non-confined workload traffic to the uplink', () => {
    for (const { flowMod } of policy) {
      const m = flowMod.match;
      if (m?.inPort !== ZODIAC_PORT_WORKLOAD) continue;
      if (!(flowMod.outputPorts ?? []).includes(ZODIAC_PORT_UPLINK)) continue;
      const arp = m.etherType === ETH_TYPE_ARP;
      const confinedIpv4 =
        m.etherType === ETH_TYPE_IPV4 &&
        m.srcIp === '10.0.2.0' && m.srcIpPrefixLen === 24 &&
        m.dstIp === '10.0.2.0' && m.dstIpPrefixLen === 24;
      expect(arp || confinedIpv4).toBe(true);
    }
  });

  it('mirrors every workload frame class to the sentinel tap', () => {
    const p1 = policy.filter((r) => r.flowMod.match?.inPort === ZODIAC_PORT_WORKLOAD);
    expect(p1.length).toBe(3);
    for (const r of p1) expect(r.flowMod.outputPorts).toContain(ZODIAC_PORT_TAP);
  });

  it('catch-all is strictly lower priority than the allow rules', () => {
    const catchAll = policy.find((r) => r.id === 'p1-default-tap-only');
    const allows = policy.filter((r) => r.id === 'p1-ipv4-intra-segment' || r.id === 'p1-arp');
    expect(catchAll?.flowMod.outputPorts).toEqual([ZODIAC_PORT_TAP]);
    for (const a of allows) expect(a.flowMod.priority).toBeGreaterThan(catchAll?.flowMod.priority ?? Infinity);
    for (const r of policy) expect(r.flowMod.priority).toBeLessThan(65535);
  });

  it('rejects the legacy port-only bridge (in_port=1 → [2,3])', () => {
    const legacy: IsolationRule[] = [
      { id: 'legacy-p1', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [2, 3], match: { inPort: 1 } } },
      { id: 'legacy-p2', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [1], match: { inPort: 2 } } },
    ];
    const v = verifyPort1Isolation(legacy);
    expect(v.some((s) => s.startsWith('legacy-p1'))).toBe(true);
    expect(v.some((s) => s.startsWith('legacy-p2'))).toBe(true);
  });

  it('rejects a widened /16 source or a missing destination confinement', () => {
    const widened: IsolationRule[] = [
      ...policy.filter((r) => r.id !== 'p1-ipv4-intra-segment'),
      {
        id: 'widened',
        flowMod: {
          command: FlowModCommand.OFPFC_ADD, priority: 200, outputPorts: [2, 3],
          match: { inPort: 1, etherType: ETH_TYPE_IPV4, srcIp: '10.0.0.0', srcIpPrefixLen: 16 },
        },
      },
    ];
    expect(verifyPort1Isolation(widened).some((s) => s.startsWith('widened'))).toBe(true);
  });

  it('encodes masked IPV4_SRC and IPV4_DST OXMs with ETH_TYPE prerequisite', () => {
    const rule = policy.find((r) => r.id === 'p1-ipv4-intra-segment');
    expect(rule).toBeDefined();
    if (!rule) return;
    const buf = buildOfpFlowMod(rule.flowMod, 1);
    const headers = oxmHeaders(buf);
    expect(headers).toContain(0x80000a02); // ETH_TYPE
    expect(headers).toContain(0x80001708); // IPV4_SRC/mask
    expect(headers).toContain(0x80001908); // IPV4_DST/mask
    expect(headers).toContain(0x80000004); // IN_PORT
    expect(headers.indexOf(0x80000a02)).toBeLessThan(headers.indexOf(0x80001708));
    // Mask value for /24 directly follows the 10.0.2.0 value in the DST TLV.
    const dstAt = buf.indexOf(Buffer.from([0x80, 0x00, 0x19, 0x08]));
    expect(buf.readUInt32BE(dstAt + 4)).toBe(0x0a000200);
    expect(buf.readUInt32BE(dstAt + 8)).toBe(0xffffff00);
  });

  it('fails closed on a dstIp with host bits outside the prefix', () => {
    expect(() =>
      buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 1, match: { dstIp: '10.0.2.5', dstIpPrefixLen: 24 } }, 1),
    ).toThrow(/host bits/);
    expect(() =>
      buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 1, match: { dstIp: '10.0.2.0', dstIpPrefixLen: 0 } }, 1),
    ).toThrow(/dstIpPrefixLen/);
  });
});
