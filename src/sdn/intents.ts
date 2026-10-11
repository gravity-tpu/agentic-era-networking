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
 * The ARP clauses encode the documented residual exposure (ARP crosses P1 and P2 because
 * ARP_SPA/ARP_TPA matching is unverified in firmware 0.86, roadmap A10). They are permissions the
 * intent grants knowingly, not something the checker overlooks.
 */
export const PORT1_ISOLATION_INTENT: IntentSpec = {
  id: 'port1-isolation/v1',
  description:
    'Workload segment 10.0.2.0/24 on P1 may only exchange intra-segment IPv4 and ARP with the uplink (P2); ' +
    'everything else from P1 goes only to the tap (P3); the uplink reaches P1 only for IPv4 to the segment and ARP.',
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
    { id: 'p1-arp', match: { inPort: P1, etherType: ETH_TYPE_ARP }, mustReach: [P2], mayReach: [P2, P3] },
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
