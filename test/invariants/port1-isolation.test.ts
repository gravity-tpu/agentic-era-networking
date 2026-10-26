/**
 * port1-isolation.test.ts
 * Invariant tests for the Zodiac Port 1 workload isolation policy.
 *
 * IMPORTANT (Invariant 6): these tests prove policy structure and wire encoding only.
 * They are not measurements of the physical switch.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import {
  buildPort1IsolationPolicy,
  verifyPort1Isolation,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_WORKLOAD,
  verifyIsolationReadback,
} from '../../src/sdn/port1-isolation.js';
import type { IsolationRule } from '../../src/sdn/port1-isolation.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import { readFlowStats, MAX_READBACK_FLOW_ENTRIES } from '../../src/sdn/flow-readback.js';
import type { OpenFlowServer } from '../../src/sdn/openflow-server.js';

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
    expect(p1.length).toBe(4); // ipv4-intra-segment, 2 per-host arp-allow, default-tap-only
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

/**
 * Builds a wire-format OFPMP_FLOW reply whose entries carry exactly the OXM match bytes of the
 * given FlowMods (fixture for parser + verifier; not a switch measurement).
 */
function flowStatsReplyFrom(flowMods: readonly Buffer[]): Buffer {
  const entries = flowMods.map((fm) => {
    const priority = fm.readUInt16BE(30);
    const matchPadded = Math.max(8, Math.ceil(fm.readUInt16BE(50) / 8) * 8);
    const match = fm.subarray(48, 48 + matchPadded);
    const e = Buffer.alloc(48 + match.length);
    e.writeUInt16BE(e.length, 0);
    e.writeUInt16BE(priority, 12);
    match.copy(e, 48);
    return e;
  });
  const body = Buffer.concat(entries);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt8(4, 0);
  hdr.writeUInt8(19, 1); // OFPT_MULTIPART_REPLY
  hdr.writeUInt16BE(16 + body.length, 2);
  hdr.writeUInt16BE(1, 8); // OFPMP_FLOW
  return Buffer.concat([hdr, body]);
}

describe('Port 1 isolation switch readback', () => {
  const policy = buildPort1IsolationPolicy();
  const tableMiss = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);
  const policyBufs = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));

  it('confirms every rule when the switch reports the exact match set', () => {
    const { entries } = parseFlowStatsReply(flowStatsReplyFrom([tableMiss, ...policyBufs]));
    const ipv4 = entries.find((e) => e.priority === 200 && e.inPort === 1 && e.ethType === ETH_TYPE_IPV4);
    expect(ipv4).toMatchObject({ srcIp: '10.0.2.0', srcMask: '255.255.255.0', dstIp: '10.0.2.0', dstMask: '255.255.255.0' });
    const v = verifyIsolationReadback(policy, entries);
    expect(v.mismatches).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.confirmed).toHaveLength(policy.length);
  });

  it('flags a switch that silently dropped the IPv4 masks (widened match)', () => {
    const widened = policy.map((r) =>
      r.id === 'p1-ipv4-intra-segment'
        ? { ...r, flowMod: { ...r.flowMod, match: { inPort: 1, etherType: ETH_TYPE_IPV4 } } }
        : r,
    );
    const bufs = widened.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
    const { entries } = parseFlowStatsReply(flowStatsReplyFrom([tableMiss, ...bufs]));
    const v = verifyIsolationReadback(policy, entries);
    expect(v.verified).toBe(false);
    expect(v.mismatches.some((m) => m.startsWith('p1-ipv4-intra-segment') && m.includes('different match fields'))).toBe(true);
  });

  it('flags missing rules and a missing table-miss entry', () => {
    const { entries } = parseFlowStatsReply(flowStatsReplyFrom(policyBufs.slice(1)));
    const v = verifyIsolationReadback(policy, entries);
    expect(v.verified).toBe(false);
    expect(v.mismatches.some((m) => m.startsWith('p1-ipv4-intra-segment'))).toBe(true);
    expect(v.mismatches).toContain('table-miss: no priority-0 wildcard entry on switch');
  });

  it('flags duplicate entries', () => {
    const { entries } = parseFlowStatsReply(flowStatsReplyFrom([tableMiss, ...policyBufs, policyBufs[0] as Buffer]));
    const v = verifyIsolationReadback(policy, entries);
    expect(v.mismatches.some((m) => m.includes('duplicate'))).toBe(true);
  });

  it('enforces bounded memory allocation and aborts when flow entries exceed maxEntries (Ghemawat Invariant)', async () => {
    class MockOpenFlowServer extends EventEmitter {
      public reserveXid(): number {
        return 42;
      }
      public sendRaw(_packet: Buffer): void {}
    }

    const mockServer = new MockOpenFlowServer();
    const readPromise = readFlowStats(mockServer, 1000, 2);
    // Reply contains 7 entries (table-miss + 6 isolation rules), which exceeds maxEntries = 2
    const replyBuf = flowStatsReplyFrom([tableMiss, ...policyBufs]);
    mockServer.emit('multipartReply', 42, replyBuf);

    await expect(readPromise).rejects.toThrow(/exceeded max flow entries limit/);
  });
});
