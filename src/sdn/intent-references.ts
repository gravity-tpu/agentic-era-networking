/**
 * intent-references.ts
 * Hand-written reference policies for INTENT-2 to 4 of the agent-proposal evaluation
 * (docs/research/evaluation-plan.md section 2: the human-engineered baseline). Each is a short, flat rule list that
 * satisfies its intent in src/sdn/intents.ts; the tests check that, and that breaking each one is detected.
 * Pure: no I/O. INTENT-1's reference is `buildPort1IsolationPolicy`.
 */

import { FlowModCommand } from './openflow-types.js';
import type { FlowModOptions } from './openflow-types.js';
import {
  buildPort1IsolationPolicy,
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
import { DNS_RESOLVER_IP, QUARANTINED_IP } from './intents.js';

/** Above every forwarding rule, so a quarantine DROP always wins (the point of INTENT-3). */
export const PRIORITY_QUARANTINE = 300;

const P1 = ZODIAC_PORT_WORKLOAD;
const P2 = ZODIAC_PORT_UPLINK;
const P3 = ZODIAC_PORT_TAP;

const add = (id: string, priority: number, outputPorts: readonly number[], match: FlowModOptions['match']): IsolationRule => ({
  id,
  flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match },
});

/** INTENT-2: the workload reaches only the resolver host (and ARP); replies only from the resolver. */
export function buildDnsConfinementPolicy(): readonly IsolationRule[] {
  return [
    add('p1-ipv4-to-resolver', PRIORITY_ISOLATION_ALLOW, [P2, P3], {
      inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: WORKLOAD_SUBNET, srcIpPrefixLen: WORKLOAD_PREFIX_LEN, dstIp: DNS_RESOLVER_IP, dstIpPrefixLen: 32,
    }),
    add('p1-arp', PRIORITY_ISOLATION_ALLOW, [P2, P3], { inPort: P1, etherType: ETH_TYPE_ARP }),
    add('p1-default-tap-only', PRIORITY_ISOLATION_TAP_ONLY, [P3], { inPort: P1 }),
    add('p2-ipv4-from-resolver', PRIORITY_ISOLATION_ALLOW, [P1], {
      inPort: P2, etherType: ETH_TYPE_IPV4, srcIp: DNS_RESOLVER_IP, srcIpPrefixLen: 32, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN,
    }),
    add('p2-arp', PRIORITY_ISOLATION_ALLOW, [P1], { inPort: P2, etherType: ETH_TYPE_ARP }),
    add('p3-tap-return', PRIORITY_TAP_RETURN, [P1], { inPort: P3 }),
  ];
}

/** INTENT-3: the isolation policy plus two DROP rules for the quarantined host, above everything else. */
export function buildQuarantinePolicy(): readonly IsolationRule[] {
  return [
    add('quarantine-src', PRIORITY_QUARANTINE, [], { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: QUARANTINED_IP, srcIpPrefixLen: 32 }),
    add('quarantine-dst', PRIORITY_QUARANTINE, [], { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: QUARANTINED_IP, dstIpPrefixLen: 32 }),
    ...buildPort1IsolationPolicy(),
  ];
}

/** INTENT-4: the same six rules as the isolation policy; what changes is the intent, which now requires the tap copy and return. */
export function buildTapReturnPolicy(): readonly IsolationRule[] {
  return buildPort1IsolationPolicy();
}
