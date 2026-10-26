/**
 * intents.ts
 * Machine-readable intents. Each intent is the specification an LLM-proposed (or human-written)
 * rule set is scored against in the agent-proposal evaluation (docs/research/evaluation-plan.md).
 *
 * Adding an intent here does not change the evaluation once the plan is frozen; new intents go into
 * a new plan version.
 */

import type { IntentSpec } from './intent-spec.js';
import {
  DEFAULT_WORKLOAD_HOSTS,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  WORKLOAD_PREFIX_LEN,
  WORKLOAD_SUBNET,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_WORKLOAD,
} from './port1-isolation.js';

const P1 = ZODIAC_PORT_WORKLOAD;
const P2 = ZODIAC_PORT_UPLINK;
const P3 = ZODIAC_PORT_TAP;

/**
 * Port-1 isolation as an intent, written independently of `buildPort1IsolationPolicy`.
 * Port 4 is the Zodiac FX OpenFlow management port and is not under flow-table control.
 *
 * The ARP clauses encode A10 (ARP confinement, workload -> uplink direction): a known workload host
 * may reach the uplink only by claiming its own address (one clause per `DEFAULT_WORKLOAD_HOSTS`
 * entry, evaluated first); any other ARP_SPA falls to `p1-everything-else`, which permits only the
 * tap. Confirmed on real hardware that firmware 0.86 enforces ARP_SPA matching
 * (docs/benchmarks/results/a10-arp-spa-feasibility/), so this is no longer a knowingly-granted
 * residual exposure the way it was before 2026-10-24 -- see `buildPort1IsolationPolicy`'s docstring
 * for the full history and the uplink -> workload direction's remaining, undemonstrated limit.
 */
export const PORT1_ISOLATION_INTENT: IntentSpec = {
  id: 'port1-isolation/v1',
  description:
    'Workload segment 10.0.2.0/24 on P1 may only exchange intra-segment IPv4 with the uplink (P2), and ARP only ' +
    'when claiming one of its own known addresses; everything else from P1 goes only to the tap (P3); the uplink ' +
    'reaches P1 only for IPv4 to the segment and ARP.',
  ports: [P1, P2, P3],
  clauses: [
    {
      id: 'p1-ipv4-intra-segment',
      match: {
        inPort: P1,
        etherType: ETH_TYPE_IPV4,
        srcIp: WORKLOAD_SUBNET,
        srcIpPrefixLen: WORKLOAD_PREFIX_LEN,
        dstIp: WORKLOAD_SUBNET,
        dstIpPrefixLen: WORKLOAD_PREFIX_LEN,
      },
      mustReach: [P2],
      mayReach: [P2, P3],
    },
    ...DEFAULT_WORKLOAD_HOSTS.map((host) => ({
      id: `p1-arp-allow-${host}`,
      match: { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: host },
      mustReach: [P2],
      mayReach: [P2, P3],
    })),
    { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [], mayReach: [P3] },
    {
      id: 'p2-ipv4-to-segment',
      match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
      mustReach: [P1],
      mayReach: [P1],
    },
    { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
    { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [], mayReach: [P1] },
  ],
};

/**
 * Port-1 isolation with the uplink -> workload ARP direction confined (A10's second half). A NEW intent, not an edit of
 * PORT1_ISOLATION_INTENT: intents are frozen once an evaluation plan is, and the four evaluated intents must not move.
 * ARP from the uplink reaches the workload only when it claims one of `uplinkArpPeers` (one clause per peer, evaluated
 * first); any other uplink ARP reaches nothing. Written independently of `buildPort1IsolationPolicy`.
 */
export function port1IsolationUplinkArpIntent(uplinkArpPeers: readonly string[]): IntentSpec {
  return {
    ...PORT1_ISOLATION_INTENT,
    id: 'port1-isolation-uplink-arp/v1',
    description:
      PORT1_ISOLATION_INTENT.description.replace(
        'the uplink reaches P1 only for IPv4 to the segment and ARP.',
        'the uplink reaches P1 only for IPv4 to the segment and for ARP claiming one of its known peer addresses.',
      ),
    clauses: [
      ...PORT1_ISOLATION_INTENT.clauses.filter((c) => c.id !== 'p2-arp' && c.id !== 'p3-tap-return'),
      ...uplinkArpPeers.map((peer) => ({
        id: `p2-arp-allow-${peer}`,
        match: { inPort: P2, etherType: ETH_TYPE_ARP, arpSpa: peer },
        mustReach: [P1],
        mayReach: [P1],
      })),
      { id: 'p2-arp-other', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [], mayReach: [] },
      ...PORT1_ISOLATION_INTENT.clauses.filter((c) => c.id === 'p3-tap-return'),
    ],
  };
}

/** The resolver INTENT-2 allows the workload to reach (the plan names 10.0.2.1). */
export const DNS_RESOLVER_IP = '10.0.2.1';
/** The host INTENT-3 quarantines (the plan names 10.0.2.51). */
export const QUARANTINED_IP = '10.0.2.51';

/**
 * INTENT-2 (plan section 3: DNS confinement), weakened from "UDP port 53" to "the resolver host".
 * The match model has no layer-4 fields (`FlowModMatchOptions`: in_port, eth_type, MACs, IPv4 src and dst), so a
 * port-53 restriction cannot be written, proposed or checked. This intent confines the workload to one host, which is
 * what the model can verify; it does not prove only DNS reaches that host. A deviation from the pre-registered text,
 * to be disclosed wherever results for it are published.
 */
export const DNS_CONFINEMENT_INTENT: IntentSpec = {
  id: 'dns-confinement/v1',
  description:
    `Workload segment 10.0.2.0/24 on P1 may reach only its DNS resolver ${DNS_RESOLVER_IP} (IPv4, out of P2) and may use ARP (out of P2); ` +
    `everything else from P1 goes only to the tap (P3). From the uplink (P2) only IPv4 from ${DNS_RESOLVER_IP} to the segment and ARP reach P1; ` +
    'everything else from P2 is dropped. The tap (P3) may return traffic to P1.',
  ports: [P1, P2, P3],
  clauses: [
    {
      id: 'p1-ipv4-to-resolver',
      match: { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: WORKLOAD_SUBNET, srcIpPrefixLen: WORKLOAD_PREFIX_LEN, dstIp: DNS_RESOLVER_IP, dstIpPrefixLen: 32 },
      mustReach: [P2],
      mayReach: [P2, P3],
    },
    { id: 'p1-arp', match: { inPort: P1, etherType: ETH_TYPE_ARP }, mustReach: [P2], mayReach: [P2, P3] },
    { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [], mayReach: [P3] },
    {
      id: 'p2-ipv4-from-resolver',
      match: { inPort: P2, etherType: ETH_TYPE_IPV4, srcIp: DNS_RESOLVER_IP, srcIpPrefixLen: 32, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
      mustReach: [P1],
      mayReach: [P1],
    },
    { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
    { id: 'p2-everything-else', match: { inPort: P2 }, mustReach: [], mayReach: [] },
    { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [], mayReach: [P1] },
  ],
};

/**
 * INTENT-3 (plan section 3: quarantine precedence): the isolation intent plus a quarantine of one host. Clauses are
 * first-match, so the two quarantine clauses sit ahead of the isolation clauses: IPv4 from the quarantined host on P1,
 * and IPv4 to it from P2, must reach no port. A correct proposal has to rank its DROP above every forwarding rule that
 * also matches. ARP carries no IPv4 source in the match model, so ARP from the host is still permitted (a documented limit,
 * the same ARP residual as INTENT-1).
 */
export const QUARANTINE_PRECEDENCE_INTENT: IntentSpec = {
  id: 'quarantine-precedence/v1',
  description:
    `The isolation policy of port1-isolation/v1, plus a quarantine of host ${QUARANTINED_IP}: IPv4 sent by ${QUARANTINED_IP} into P1, ` +
    `and IPv4 addressed to ${QUARANTINED_IP} arriving from the uplink P2, must be dropped (reach no port, not even the tap), ` +
    'even though other rules would forward it. Workload segment 10.0.2.0/24 on P1 otherwise may only exchange intra-segment IPv4 and ARP with the uplink (P2); ' +
    'everything else from P1 goes only to the tap (P3); the uplink reaches P1 only for IPv4 to the segment and ARP.',
  ports: [P1, P2, P3],
  clauses: [
    { id: 'quarantine-src', match: { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: QUARANTINED_IP, srcIpPrefixLen: 32 }, mustReach: [], mayReach: [] },
    { id: 'quarantine-dst', match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: QUARANTINED_IP, dstIpPrefixLen: 32 }, mustReach: [], mayReach: [] },
    ...PORT1_ISOLATION_INTENT.clauses,
  ],
};

/**
 * INTENT-4 (plan section 3: tap return isolation): the isolation intent with the tap made load-bearing. Every frame from
 * P1 must reach the tap for inspection, and the tap's frames must come back to P1 and nowhere else. INTENT-1 only permits
 * both (`mayReach`), so losing the tap copy or the return is not a fault there; here it is.
 */
export const TAP_RETURN_ISOLATION_INTENT: IntentSpec = {
  id: 'tap-return-isolation/v1',
  description:
    'Every frame from the workload segment on P1 must be copied to the tap (P3) for inspection; intra-segment IPv4 (10.0.2.0/24 to 10.0.2.0/24) and ARP from P1 must also reach the uplink (P2), and nothing else from P1 may reach P2. ' +
    'Frames arriving from the tap (P3) must be returned to P1, and must never reach the uplink (P2) or go back out the tap (P3). ' +
    'From the uplink (P2) only IPv4 to the segment and ARP reach P1.',
  ports: [P1, P2, P3],
  clauses: [
    {
      id: 'p1-ipv4-intra-segment',
      match: { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: WORKLOAD_SUBNET, srcIpPrefixLen: WORKLOAD_PREFIX_LEN, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
      mustReach: [P2, P3],
      mayReach: [P2, P3],
    },
    ...DEFAULT_WORKLOAD_HOSTS.map((host) => ({
      id: `p1-arp-allow-${host}`,
      match: { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: host },
      mustReach: [P2, P3],
      mayReach: [P2, P3],
    })),
    { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [P3], mayReach: [P3] },
    {
      id: 'p2-ipv4-to-segment',
      match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN },
      mustReach: [P1],
      mayReach: [P1],
    },
    { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
    { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [P1], mayReach: [P1] },
  ],
};
