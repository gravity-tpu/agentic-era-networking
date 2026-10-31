/**
 * wire-run.ts
 * The pure core of the on-wire conformance run (docs/research/evaluation-plan.md section 16): the intent's expectation for a packet, the two
 * verdicts (M1 against the verifier's model, M2 against the intent), and the exact bytes of the frames the testbed sends. No I/O: nothing here
 * touches the switch.
 *
 * M1 asks whether the switch does what the model predicts. M2 asks whether what was observed satisfies the intent's own clause for that packet. A
 * missing delivery is charged only on ports the testbed can observe; a frame seen on a port outside may-reach is a leak wherever it is seen.
 * Invariant 2: integer arithmetic only (the checksum is a 16-bit ones'-complement sum).
 */

import { matchesPacket, ipv4ToUint } from './intent-spec.js';
import type { IntentSpec, PacketClass } from './intent-spec.js';
import { UPLINK_HOST_IP, REAL_WORKLOAD_HOSTS, WORKLOAD_SUBNET_BASE, WORKLOAD_SUBNET_PREFIX_LEN } from './wire-flows.js';
import type { WireFlow } from './wire-flows.js';

const ETH_HEADER = 14;
const IPV4_HEADER = 20;
const UDP_HEADER = 8;
const ARP_BODY = 28;
const IPV4_TTL = 64;
const IP_PROTO_UDP = 17;
const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_ARP = 0x0806;

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

export function macBytes(mac: string): Uint8Array {
  if (!MAC_RE.test(mac)) throw new RangeError(`not a MAC address: ${JSON.stringify(mac)}`);
  return Uint8Array.from(mac.split(':').map((h) => parseInt(h, 16)));
}

export function ipBytes(ip: string): Uint8Array {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new RangeError(`not an IPv4 address: ${JSON.stringify(ip)}`);
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new RangeError(`not an IPv4 address: ${JSON.stringify(ip)}`);
  return Uint8Array.from(out);
}

/** RFC 1071 Internet checksum: the complement of the ones'-complement sum of the 16-bit words (an odd length is padded with a zero byte). */
export function internetChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

export interface UdpFrameSpec { readonly srcMac: string; readonly dstMac: string; readonly srcIp: string; readonly dstIp: string; readonly dstPort: number; readonly payload: Uint8Array }

/** An Ethernet + IPv4 + UDP frame with exactly these header fields (UDP checksum 0, which IPv4 permits). */
export function buildUdpFrame(s: UdpFrameSpec): Uint8Array {
  if (!Number.isInteger(s.dstPort) || s.dstPort < 1 || s.dstPort > 65535) throw new RangeError(`bad UDP port ${s.dstPort}`);
  const udpLen = UDP_HEADER + s.payload.length;
  const total = IPV4_HEADER + udpLen;
  const f = new Uint8Array(ETH_HEADER + total);
  f.set(macBytes(s.dstMac), 0);
  f.set(macBytes(s.srcMac), 6);
  f[12] = ETHERTYPE_IPV4 >>> 8; f[13] = ETHERTYPE_IPV4 & 0xff;
  const ip = ETH_HEADER;
  f[ip] = 0x45; f[ip + 1] = 0;
  f[ip + 2] = total >>> 8; f[ip + 3] = total & 0xff;
  f[ip + 4] = 0; f[ip + 5] = 0;       // identification
  f[ip + 6] = 0x40; f[ip + 7] = 0;    // don't fragment
  f[ip + 8] = IPV4_TTL; f[ip + 9] = IP_PROTO_UDP;
  f.set(ipBytes(s.srcIp), ip + 12);
  f.set(ipBytes(s.dstIp), ip + 16);
  const ck = internetChecksum(f.subarray(ip, ip + IPV4_HEADER));
  f[ip + 10] = ck >>> 8; f[ip + 11] = ck & 0xff;
  const udp = ip + IPV4_HEADER;
  f[udp] = 0xc0; f[udp + 1] = 0x00;   // source port 49152
  f[udp + 2] = s.dstPort >>> 8; f[udp + 3] = s.dstPort & 0xff;
  f[udp + 4] = udpLen >>> 8; f[udp + 5] = udpLen & 0xff;
  f.set(s.payload, udp + UDP_HEADER);
  return f;
}

export interface ArpFrameSpec { readonly srcMac: string; readonly spa: string; readonly tpa: string }

/** A broadcast ARP request with exactly this sender hardware address, sender protocol address and target protocol address. */
export function buildArpRequestFrame(s: ArpFrameSpec): Uint8Array {
  const f = new Uint8Array(ETH_HEADER + ARP_BODY);
  f.fill(0xff, 0, 6);
  f.set(macBytes(s.srcMac), 6);
  f[12] = ETHERTYPE_ARP >>> 8; f[13] = ETHERTYPE_ARP & 0xff;
  f[14] = 0; f[15] = 1;               // hardware type: Ethernet
  f[16] = ETHERTYPE_IPV4 >>> 8; f[17] = ETHERTYPE_IPV4 & 0xff;
  f[18] = 6; f[19] = 4;
  f[20] = 0; f[21] = 1;               // opcode: request
  f.set(macBytes(s.srcMac), 22);
  f.set(ipBytes(s.spa), 28);
  f.fill(0, 32, 38);
  f.set(ipBytes(s.tpa), 38);
  return f;
}

export interface IntentExpectation { readonly clauseId: string; readonly mustReach: readonly number[]; readonly mayReach: readonly number[] }

/** The first intent clause whose match covers the packet decides; a packet no clause covers is default-denied. */
export function intentExpectation(spec: IntentSpec, packet: PacketClass): IntentExpectation {
  for (const c of spec.clauses) {
    if (matchesPacket(c.match, packet)) return { clauseId: c.id, mustReach: [...c.mustReach], mayReach: [...c.mayReach] };
  }
  return { clauseId: 'default-deny', mustReach: [], mayReach: [] };
}

const norm = (ports: readonly number[]): number[] => [...new Set(ports)].sort((a, b) => a - b);
const minus = (a: readonly number[], b: readonly number[]): number[] => a.filter((p) => !b.includes(p));

export interface M1Verdict { readonly agrees: boolean; readonly seenNotPredicted: number[]; readonly predictedNotSeen: number[] }

/** M1: observed ports against the model's predicted ports (both already restricted to the ports the testbed can observe). */
export function m1Verdict(predicted: readonly number[], observed: readonly number[]): M1Verdict {
  const p = norm(predicted);
  const o = norm(observed);
  const seenNotPredicted = minus(o, p);
  const predictedNotSeen = minus(p, o);
  return { agrees: seenNotPredicted.length === 0 && predictedNotSeen.length === 0, seenNotPredicted, predictedNotSeen };
}

export interface M2Verdict { readonly compliant: boolean; readonly leaks: number[]; readonly missing: number[] }

/** M2: observed ports against the intent's clause. Missing deliveries count only on ports the testbed can observe. */
export function m2Verdict(expectation: IntentExpectation, observed: readonly number[], observable: readonly number[]): M2Verdict {
  const o = norm(observed);
  const leaks = minus(o, expectation.mayReach);
  const missing = minus(expectation.mustReach.filter((p) => observable.includes(p)), o);
  return { compliant: leaks.length === 0 && missing.length === 0, leaks, missing };
}

export type SendPlan =
  | { readonly via: 'raw-from-node' }
  | { readonly via: 'udp-from-mac'; readonly aliasIp: string | null }
  | { readonly via: 'unsendable'; readonly reason: string };

const inWorkloadSubnet = (ip: string): boolean => (ipv4ToUint(ip) >>> (32 - WORKLOAD_SUBNET_PREFIX_LEN)) === (ipv4ToUint(WORKLOAD_SUBNET_BASE) >>> (32 - WORKLOAD_SUBNET_PREFIX_LEN));

/**
 * How the testbed would send a flow, or why it cannot. Every frame entering port 1 is a raw frame from a workload node's NIC carrying the flow's
 * exact header fields (so a real host's own address, an alias and a forged source are one mechanism). Frames entering port 2 come from the Mac
 * through its kernel stack, so only IPv4 to a destination in the workload subnet is possible (anything else would leave the lab by the router
 * and never reach the switch), to a real workload host (the kernel must resolve it by ARP), from the Mac's own address or from an alias on the workload subnet. There is no sender for ARP from the uplink
 * side or for frames entering port 3. An unsendable flow is reported with its reason and never counted as agreement.
 */
export function sendPlanFor(flow: WireFlow): SendPlan {
  const p = flow.packet;
  if (p.inPort === 1) return { via: 'raw-from-node' };
  if (p.inPort !== 2) return { via: 'unsendable', reason: `no sender can inject into port ${p.inPort} (the capture NICs are receive-only; decision 8, 2026-10-31)` };
  if (p.etherType !== 0x0800) return { via: 'unsendable', reason: 'no Linux sender on the uplink side: the Mac cannot send an ARP frame with a chosen sender address' };
  const src = p.srcIp ?? '';
  const dst = p.dstIp ?? '';
  if (!inWorkloadSubnet(dst)) return { via: 'unsendable', reason: 'the Mac would route a destination outside the workload subnet to the internet, not through the switch; it would leave the lab' };
  if (!REAL_WORKLOAD_HOSTS.includes(dst)) return { via: 'unsendable', reason: 'no host answers ARP for that workload address, so the Mac kernel cannot send the frame (a static neighbour entry is not built)' };
  if (src === UPLINK_HOST_IP) return { via: 'udp-from-mac', aliasIp: null };
  if (inWorkloadSubnet(src)) return { via: 'udp-from-mac', aliasIp: src };
  return { via: 'unsendable', reason: 'the source is neither the Mac nor an address the Mac can alias on the workload subnet' };
}

/** The capture filter that counts exactly the frames of one flow in its own window: UDP by its unique destination port, ARP by the flow's source MAC. */
export function captureFilterFor(flow: WireFlow, tag: number): string {
  if (flow.packet.etherType === 0x0806) { macBytes(flow.packet.srcMac); return `arp and ether src ${flow.packet.srcMac.toLowerCase()}`; }
  if (!Number.isInteger(tag) || tag < 1 || tag > 65535) throw new RangeError(`bad UDP tag ${tag}`);
  return `udp dst port ${tag}`;
}

const IFACE_RE = /^[a-z][a-z0-9]{0,14}$/;
const HEX_RE = /^(?:[0-9a-f]{2})+$/;
export const MAX_RAW_FRAMES = 10;

/** A Python 3 program (run with root on the sending node) that sends each hex-encoded frame out of `iface` as a raw frame, `spacingS` seconds apart. Inputs are validated: nothing else is interpolated. */
export function rawSendPython(iface: string, framesHex: readonly string[], spacingMs: number): string {
  if (!IFACE_RE.test(iface)) throw new RangeError(`bad interface name ${JSON.stringify(iface)}`);
  if (framesHex.length < 1 || framesHex.length > MAX_RAW_FRAMES) throw new RangeError(`frame count must be 1 to ${MAX_RAW_FRAMES}`);
  for (const h of framesHex) if (!HEX_RE.test(h)) throw new RangeError('frame is not lowercase hex');
  if (!Number.isInteger(spacingMs) || spacingMs < 0 || spacingMs > 2000) throw new RangeError('spacing must be an integer from 0 to 2000 ms');
  return [
    'import socket, time',
    `s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)`,
    `s.bind(('${iface}', 0))`,
    `for h in [${framesHex.map((h) => `'${h}'`).join(', ')}]:`,
    '    s.send(bytes.fromhex(h))',
    `    time.sleep(${spacingMs} / 1000)`,
    "print('sent')",
    '',
  ].join('\n');
}
