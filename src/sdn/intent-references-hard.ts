/**
 * intent-references-hard.ts
 * Hand-written reference policies for the four additional intents (src/sdn/intents-hard.ts): short, flat rule lists that satisfy their intent. The
 * tests check that, and that breaking each one is detected. Pure: no I/O.
 */

import { FlowModCommand } from './openflow-types.js';
import type { FlowModOptions } from './openflow-types.js';
import {
  buildPort1IsolationPolicy,
  DEFAULT_WORKLOAD_HOSTS,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  PRIORITY_ISOLATION_ALLOW,
  PRIORITY_ISOLATION_TAP_ONLY,
  PRIORITY_TAP_RETURN,
  WORKLOAD_PREFIX_LEN,
  WORKLOAD_SUBNET,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_WORKLOAD,
} from './port1-isolation.js';
import type { IsolationRule } from './port1-isolation.js';
import { DNS_RESOLVER_IP } from './intents.js';
import { PRIORITY_QUARANTINE, buildDnsConfinementPolicy } from './intent-references.js';
import { DNS_QUARANTINED_HOST, FILE_SERVER_IP, QUARANTINE_SET_HOSTS, UPLINK_ARP_PEERS } from './intents-hard.js';

const P1 = ZODIAC_PORT_WORKLOAD;
const P2 = ZODIAC_PORT_UPLINK;
const P3 = ZODIAC_PORT_TAP;

const add = (id: string, priority: number, outputPorts: readonly number[], match: FlowModOptions['match']): IsolationRule => ({
  id,
  flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match },
});

/** INTENT-5: two DROPs per quarantined host above the isolation policy. */
export function buildQuarantineSetPolicy(hosts: readonly string[] = QUARANTINE_SET_HOSTS): readonly IsolationRule[] {
  return [
    ...hosts.flatMap((h) => [
      add(`quarantine-src-${h}`, PRIORITY_QUARANTINE, [], { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: h, srcIpPrefixLen: 32 }),
      add(`quarantine-dst-${h}`, PRIORITY_QUARANTINE, [], { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: h, dstIpPrefixLen: 32 }),
    ]),
    ...buildPort1IsolationPolicy(),
  ];
}

/** INTENT-6: the DNS confinement policy with two DROPs for the quarantined host above it. */
export function buildDnsQuarantinePolicy(host: string = DNS_QUARANTINED_HOST): readonly IsolationRule[] {
  return [
    add('quarantine-src', PRIORITY_QUARANTINE, [], { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: host, srcIpPrefixLen: 32 }),
    add('quarantine-dst', PRIORITY_QUARANTINE, [], { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: host, dstIpPrefixLen: 32 }),
    ...buildDnsConfinementPolicy(),
  ];
}

/** INTENT-7: the isolation policy with uplink ARP confined to the named peers (the builder's opt-in A10 direction). */
export function buildUplinkArpConfinementPolicy(peers: readonly string[] = UPLINK_ARP_PEERS): readonly IsolationRule[] {
  return buildPort1IsolationPolicy(WORKLOAD_SUBNET, WORKLOAD_PREFIX_LEN, DEFAULT_WORKLOAD_HOSTS, peers);
}

/** INTENT-8: per-source allow rules, a file-server return path for the first host only, everything else tap-only or dropped. */
export function buildPerHostAllowlistPolicy(
  hostA: string = DEFAULT_WORKLOAD_HOSTS[0]!,
  hostB: string = DEFAULT_WORKLOAD_HOSTS[1]!,
  resolver: string = DNS_RESOLVER_IP,
  fileServer: string = FILE_SERVER_IP,
): readonly IsolationRule[] {
  const to = (src: string, dst: string) => ({ inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: src, srcIpPrefixLen: 32, dstIp: dst, dstIpPrefixLen: 32 });
  return [
    add('p1-a-to-resolver', PRIORITY_ISOLATION_ALLOW, [P2, P3], to(hostA, resolver)),
    add('p1-a-to-fileserver', PRIORITY_ISOLATION_ALLOW, [P2, P3], to(hostA, fileServer)),
    add('p1-b-to-resolver', PRIORITY_ISOLATION_ALLOW, [P2, P3], to(hostB, resolver)),
    ...[hostA, hostB].map((h) => add(`p1-arp-allow-${h}`, PRIORITY_ISOLATION_ALLOW, [P2, P3], { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: h })),
    add('p1-default-tap-only', PRIORITY_ISOLATION_TAP_ONLY, [P3], { inPort: P1 }),
    add('p2-resolver-to-segment', PRIORITY_ISOLATION_ALLOW, [P1], {
      inPort: P2, etherType: ETH_TYPE_IPV4, srcIp: resolver, srcIpPrefixLen: 32, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN,
    }),
    add('p2-fileserver-to-a', PRIORITY_ISOLATION_ALLOW, [P1], { inPort: P2, etherType: ETH_TYPE_IPV4, srcIp: fileServer, srcIpPrefixLen: 32, dstIp: hostA, dstIpPrefixLen: 32 }),
    add('p2-arp', PRIORITY_ISOLATION_ALLOW, [P1], { inPort: P2, etherType: ETH_TYPE_ARP }),
    add('p3-tap-return', PRIORITY_TAP_RETURN, [P1], { inPort: P3 }),
  ];
}
