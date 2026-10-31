/**
 * intents-hard.ts
 * Four additional intents for the agent-proposal evaluation (docs/research/evaluation-plan.md section 13), added because INTENT-1, 2 and 4 sit at or
 * near the ceiling under prompt v3. They are chosen by STRUCTURE (more interacting constraints than the evaluated four), fixed before any model
 * has seen them, and every one is reported whatever a model scores; whether they are harder for a model is the empirical question, not an assumption.
 *
 * Each description is built from the same parameters as its clauses, so the text cannot drift from the specification (the contradiction plan
 * amendment 1 fixed in INTENT-3 and 4). All addresses lie in 10.0.2.0/24, the held-out benchmark subnet, so no training scenario can contain them
 * (`assertDisjointFromBenchmark`). Independent of `intents.ts`, whose four intents stay frozen.
 */

import type { IntentClause, IntentSpec } from './intent-spec.js';
import type { IsolationRule } from './port1-isolation.js';
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
import { DNS_CONFINEMENT_INTENT, DNS_RESOLVER_IP, PORT1_ISOLATION_INTENT, port1IsolationUplinkArpIntent } from './intents.js';

const P1 = ZODIAC_PORT_WORKLOAD;
const P2 = ZODIAC_PORT_UPLINK;
const P3 = ZODIAC_PORT_TAP;

/** Hosts quarantined together by quarantine-set/v1. */
export const QUARANTINE_SET_HOSTS: readonly string[] = ['10.0.2.51', '10.0.2.53', '10.0.2.54'];
/** The host quarantined inside the DNS confinement of dns-quarantine/v1. */
export const DNS_QUARANTINED_HOST = '10.0.2.51';
/** Uplink peers allowed to send ARP to the workload in uplink-arp-confinement/v1. */
export const UPLINK_ARP_PEERS: readonly string[] = ['10.0.2.1', '10.0.2.254'];
/** The file server host of per-host-allowlist/v1. */
export const FILE_SERVER_IP = '10.0.2.20';

const [HOST_A, HOST_B] = DEFAULT_WORKLOAD_HOSTS as readonly [string, string];

const quarantineClauses = (hosts: readonly string[]): IntentClause[] =>
  hosts.flatMap((h) => [
    { id: `quarantine-src-${h}`, match: { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: h, srcIpPrefixLen: 32 }, mustReach: [], mayReach: [] },
    { id: `quarantine-dst-${h}`, match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: h, dstIpPrefixLen: 32 }, mustReach: [], mayReach: [] },
  ]);

/** INTENT-5: the isolation policy plus a quarantine of three hosts, both directions (six DROPs that must outrank every forwarding rule). */
export function quarantineSetIntent(hosts: readonly string[]): IntentSpec {
  return {
    id: 'quarantine-set/v1',
    description:
      `The isolation policy of port1-isolation/v1, plus a quarantine of hosts ${hosts.join(', ')}: IPv4 sent by any of them into P1, ` +
      `and IPv4 addressed to any of them arriving from the uplink P2, must be dropped (reach no port, not even the tap), ` +
      'even though other rules would forward it. Workload segment 10.0.2.0/24 on P1 otherwise may only exchange intra-segment IPv4 with the uplink (P2), ' +
      'and ARP only when claiming one of its own known addresses; everything else from P1 goes only to the tap (P3); ' +
      'the uplink reaches P1 only for IPv4 to the segment and ARP.',
    ports: [P1, P2, P3],
    clauses: [...quarantineClauses(hosts), ...PORT1_ISOLATION_INTENT.clauses],
  };
}

/** INTENT-6: DNS confinement with one host quarantined, so the resolver exception and the quarantine overlap. */
export function dnsQuarantineIntent(host: string): IntentSpec {
  return {
    id: 'dns-quarantine/v1',
    description:
      `${DNS_CONFINEMENT_INTENT.description} In addition, host ${host} is quarantined: IPv4 sent by ${host} into P1 (even to the resolver ${DNS_RESOLVER_IP}) ` +
      `and IPv4 addressed to ${host} arriving from the uplink P2 (even from the resolver) must be dropped (reach no port, not even the tap).`,
    ports: [P1, P2, P3],
    clauses: [...quarantineClauses([host]).map((c) => ({ ...c, id: c.id.replace(`-${host}`, '') })), ...DNS_CONFINEMENT_INTENT.clauses],
  };
}

/** INTENT-7: isolation with the uplink -> workload ARP direction confined to named peers (A10's second half). */
export function uplinkArpConfinementIntent(peers: readonly string[]): IntentSpec {
  const base = port1IsolationUplinkArpIntent(peers);
  return {
    ...base,
    id: 'uplink-arp-confinement/v1',
    description: base.description.replace(
      'for ARP claiming one of its known peer addresses.',
      `for ARP claiming one of its known peer addresses (${peers.join(', ')}); all other ARP from the uplink is dropped.`,
    ),
  };
}

/** INTENT-8: two workload hosts with different destination allowlists, and a return path that is asymmetric per source. */
export function perHostAllowlistIntent(hostA: string, hostB: string, resolver: string, fileServer: string): IntentSpec {
  const ip = (inPort: number, extra: Record<string, unknown>) => ({ inPort, etherType: ETH_TYPE_IPV4, ...extra });
  const to = (src: string, dst: string) => ip(P1, { srcIp: src, srcIpPrefixLen: 32, dstIp: dst, dstIpPrefixLen: 32 });
  return {
    id: 'per-host-allowlist/v1',
    description:
      `Two workload hosts on P1 have different permissions. Host ${hostA} may send IPv4 to the DNS resolver ${resolver} and to the file server ${fileServer}; ` +
      `host ${hostB} may send IPv4 only to the resolver ${resolver}; those permitted packets leave via P2. ` +
      `ARP from P1 is allowed (out of P2) only when claiming one of its own known addresses (${hostA} or ${hostB}). ` +
      'Everything else from P1, including any other destination and any other source address, goes only to the tap (P3). ' +
      `From the uplink (P2): IPv4 from the resolver ${resolver} to the segment 10.0.2.0/24 reaches P1; IPv4 from the file server ${fileServer} reaches P1 ` +
      `only when addressed to ${hostA} (not to any other segment host); ARP reaches P1; all other traffic from P2 is dropped. The tap (P3) may return traffic to P1.`,
    ports: [P1, P2, P3],
    clauses: [
      { id: 'p1-a-to-resolver', match: to(hostA, resolver), mustReach: [P2], mayReach: [P2, P3] },
      { id: 'p1-a-to-fileserver', match: to(hostA, fileServer), mustReach: [P2], mayReach: [P2, P3] },
      { id: 'p1-b-to-resolver', match: to(hostB, resolver), mustReach: [P2], mayReach: [P2, P3] },
      ...[hostA, hostB].map((h) => ({ id: `p1-arp-allow-${h}`, match: { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: h }, mustReach: [P2], mayReach: [P2, P3] })),
      { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [], mayReach: [P3] },
      {
        id: 'p2-resolver-to-segment',
        match: ip(P2, { srcIp: resolver, srcIpPrefixLen: 32, dstIp: WORKLOAD_SUBNET, dstIpPrefixLen: WORKLOAD_PREFIX_LEN }),
        mustReach: [P1],
        mayReach: [P1],
      },
      { id: 'p2-fileserver-to-a', match: ip(P2, { srcIp: fileServer, srcIpPrefixLen: 32, dstIp: hostA, dstIpPrefixLen: 32 }), mustReach: [P1], mayReach: [P1] },
      { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
      { id: 'p2-everything-else', match: { inPort: P2 }, mustReach: [], mayReach: [] },
      { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [], mayReach: [P1] },
    ],
  };
}

export const QUARANTINE_SET_INTENT: IntentSpec = quarantineSetIntent(QUARANTINE_SET_HOSTS);
export const DNS_QUARANTINE_INTENT: IntentSpec = dnsQuarantineIntent(DNS_QUARANTINED_HOST);
export const UPLINK_ARP_CONFINEMENT_INTENT: IntentSpec = uplinkArpConfinementIntent(UPLINK_ARP_PEERS);
export const PER_HOST_ALLOWLIST_INTENT: IntentSpec = perHostAllowlistIntent(HOST_A, HOST_B, DNS_RESOLVER_IP, FILE_SERVER_IP);

/** The four additional intents, in the order of the plan (INTENT-5 to 8). */
export const HARD_INTENTS: readonly IntentSpec[] = [QUARANTINE_SET_INTENT, DNS_QUARANTINE_INTENT, UPLINK_ARP_CONFINEMENT_INTENT, PER_HOST_ALLOWLIST_INTENT];

export interface IntentComplexity {
  readonly clauses: number;
  readonly referenceRules: number;
  readonly priorityTiers: number;
  readonly namedAddresses: number;
}

/**
 * The structural measures fixed in advance (plan section 13.2): clauses in the specification, rules in the hand-written reference, distinct
 * priorities in that reference, and host addresses the description must name beyond the two the prompt already lists.
 */
export function intentComplexity(spec: IntentSpec, reference: readonly IsolationRule[]): IntentComplexity {
  const known = new Set<string>([...DEFAULT_WORKLOAD_HOSTS, WORKLOAD_SUBNET]);
  const named = new Set((spec.description.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter((a) => !known.has(a)));
  return {
    clauses: spec.clauses.length,
    referenceRules: reference.length,
    priorityTiers: new Set(reference.map((r) => r.flowMod.priority)).size,
    namedAddresses: named.size,
  };
}
