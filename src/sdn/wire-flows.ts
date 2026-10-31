/**
 * wire-flows.ts
 * Which flows the testbed can send for the on-wire conformance run, and which of them tell one rule set from another
 * (docs/research/track-a-closeout-plan.md, Phase 0). Pure functions, no I/O: nothing here touches the switch.
 *
 * The verifier's model only distinguishes packets by in_port, EtherType, MACs, IPv4 src/dst and ARP SPA/TPA (src/sdn/intent-spec.ts), so
 * two rule sets can be told apart on the wire only by a flow that differs in those fields. This module enumerates such flows from the
 * addresses the rule sets mention (and the boundaries of their prefixes), tags each with how the testbed would have to realise it, and picks
 * a small set that separates a reference from its look-alikes by prediction. It does NOT say what the switch does: that is what the wire run
 * measures. A set no flow separates is an equivalent mutant over the modelled fields or needs a flow the testbed cannot send; it is
 * reported, never dropped silently.
 *
 * What a mode means (a declaration to be validated at the bench, plan Phase 1; the owner accepted aliases and forged frames, 2026-10-31):
 *   Real        the sender is a real testbed host using its own address.
 *   Alias       a real host with an added IP alias on the workload subnet (reversible, documented).
 *   Forged      a raw frame from a workload NIC with a source outside the workload subnet or an ARP claim for an address the sender does not own.
 *   PortThree   a frame injected into port 3 (the tap) by transmitting from the O2 capture NIC. The capture NICs are receive-only today (they are the
 *               ground truth), so this needs the owner's explicit approval; without it no rule set can be tested for how it treats frames from the tap.
 *   Unavailable the testbed has no sender for it.
 * Frames entering port 1 are the untrusted segment's and come from a workload NIC. Frames entering port 2 come from one Linux node whose USB NIC the owner
 * placed on the isolated uplink VLAN (2026-10-31) with the Zodiac's P2 link: the only other host on that segment, so a forged frame there reaches no cache.
 */

import { matchesPacket, ipv4ToUint, uintToIpv4, ETH_TYPE_IPV4_INTENT, ETH_TYPE_ARP_INTENT } from './intent-spec.js';
import type { PacketClass } from './intent-spec.js';
import type { FlowModMatchOptions } from './openflow-types.js';

export const FlowMode = { Real: 0, Alias: 1, Forged: 2, PortThree: 3, Unavailable: 4 } as const;
export type FlowMode = (typeof FlowMode)[keyof typeof FlowMode];

/** The workload subnet and the hosts that really exist on it (`.agents/network-context.md`). */
export const WORKLOAD_SUBNET_BASE = '10.0.2.0';
export const WORKLOAD_SUBNET_PREFIX_LEN = 24;
export const REAL_WORKLOAD_HOSTS: readonly string[] = ['10.0.2.50', '10.0.2.51', '10.0.2.52'];
/** The Mac on the lab LAN: a real destination address for flows leaving port 1, no longer a sender. */
export const UPLINK_HOST_IP = '10.0.0.119';
/** Ports the testbed can send into, and the ports it can see traffic leave by (O2/O3 captures, and a listener for port 1). */
export const SENDABLE_IN_PORTS: readonly number[] = [1, 2, 3];
// Port 3 ingress: the sender is the O2 NIC itself, so a frame seen back on port 3 is not evidence; only ports 1 (listener) and 2 (O3) count.
const OBSERVABLE: Readonly<Record<number, readonly number[]>> = { 1: [2, 3], 2: [1, 3], 3: [1, 2] };

export interface WireFlow {
  readonly id: string;
  readonly packet: PacketClass;
  readonly mode: FlowMode;
  /** Ports where a frame of this flow would be seen if the switch sent it there. */
  readonly observable: readonly number[];
}

export interface WireRule { readonly id: string; readonly priority: number; readonly outputPorts: readonly number[]; readonly match: FlowModMatchOptions }
export interface WireRuleSet { readonly id: string; readonly rules: readonly WireRule[] }

const inWorkloadSubnet = (ip: string): boolean => (ipv4ToUint(ip) >>> (32 - WORKLOAD_SUBNET_PREFIX_LEN)) === (ipv4ToUint(WORKLOAD_SUBNET_BASE) >>> (32 - WORKLOAD_SUBNET_PREFIX_LEN));

/** The mode the sender address of a flow needs, by the port the frame enters. */
function sourceMode(inPort: number, _etherType: number, src: string): FlowMode {
  if (inPort === 3) return FlowMode.PortThree;
  if (inPort === 1) {
    if (REAL_WORKLOAD_HOSTS.includes(src)) return FlowMode.Real;
    return inWorkloadSubnet(src) ? FlowMode.Alias : FlowMode.Forged;
  }
  // Entering port 2: a raw frame from the uplink-side Linux node (node-01's USB NIC on the isolated uplink VLAN), so any source, ARP included, is a forged frame.
  return FlowMode.Forged;
}

function destinationMode(dst: string): FlowMode {
  if (REAL_WORKLOAD_HOSTS.includes(dst) || dst === UPLINK_HOST_IP) return FlowMode.Real;
  return inWorkloadSubnet(dst) ? FlowMode.Alias : FlowMode.Forged;
}

const maxMode = (a: FlowMode, b: FlowMode): FlowMode => (a > b ? a : b) as FlowMode;

/** Candidate flows over `addresses`: IPv4 and ARP, entering port 1 or 2, every source and destination pair, keeping those needing at most `allowed`. */
export function candidateFlows(addresses: readonly string[], allowed: FlowMode): WireFlow[] {
  const all = [...new Set([...addresses, ...REAL_WORKLOAD_HOSTS, UPLINK_HOST_IP])].sort((a, b) => ipv4ToUint(a) - ipv4ToUint(b));
  const out: WireFlow[] = [];
  for (const inPort of SENDABLE_IN_PORTS) {
    for (const etherType of [ETH_TYPE_IPV4_INTENT, ETH_TYPE_ARP_INTENT]) {
      for (const src of all) {
        for (const dst of all) {
          // An IPv4 frame with identical source and destination address (a land-style packet) is not a flow: the hardware does not forward it (finding F1,
          // 2026-10-31: 3 of 3 hosts, nothing seen on O2 or O3 while the model predicts forwarding), so it would only make a gate flow fail. A gratuitous ARP (spa equals tpa) is kept.
          if (etherType === ETH_TYPE_IPV4_INTENT && src === dst) continue;
          const mode = maxMode(sourceMode(inPort, etherType, src), destinationMode(dst));
          if (mode > allowed) continue;
          const srcMac = `02:00:00:00:00:${inPort.toString(16).padStart(2, '0')}`;
          const packet: PacketClass = etherType === ETH_TYPE_ARP_INTENT
            ? { inPort, etherType, srcMac, dstMac: 'ff:ff:ff:ff:ff:ff', arpSpa: src, arpTpa: dst }
            : { inPort, etherType, srcMac, dstMac: '02:00:00:00:00:fe', srcIp: src, dstIp: dst };
          out.push({ id: `p${inPort}-${etherType === ETH_TYPE_ARP_INTENT ? 'arp' : 'ip'}-${src}-${dst}`, packet, mode, observable: OBSERVABLE[inPort] ?? [] });
        }
      }
    }
  }
  return out;
}

/** Prefix lengths a match may carry: whole numbers 0 to 32 (a fractional or out-of-range length is rejected, not guessed at). */
export const MAX_PREFIX_LEN = 32;

/** Addresses a collection of rule sets mentions, plus the first and last address of each prefix and the addresses just outside it. */
export function addressUniverse(sets: readonly WireRuleSet[], extra: readonly string[] = []): string[] {
  const out = new Set<string>(extra);
  const add = (n: bigint): void => { if (n >= 0n && n <= 0xffff_ffffn) out.add(uintToIpv4(Number(n))); };
  const fields: ReadonlyArray<readonly [keyof FlowModMatchOptions, keyof FlowModMatchOptions]> = [['srcIp', 'srcIpPrefixLen'], ['dstIp', 'dstIpPrefixLen'], ['arpSpa', 'arpSpaPrefixLen'], ['arpTpa', 'arpTpaPrefixLen']];
  for (const s of sets) {
    for (const r of s.rules) {
      for (const [f, p] of fields) {
        const v = r.match[f];
        if (typeof v !== 'string') continue;
        const rawLen = r.match[p];
        const len = rawLen === undefined ? MAX_PREFIX_LEN : rawLen;
        if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > MAX_PREFIX_LEN) throw new RangeError(`${s.id}/${r.id}: ${String(p)} must be a whole number from 0 to ${MAX_PREFIX_LEN}, got ${String(rawLen)}`);
        const size = 1n << BigInt(MAX_PREFIX_LEN - len);
        const lo = (BigInt(ipv4ToUint(v)) / size) * size;
        add(lo - 1n); add(lo); add(lo + size - 1n); add(lo + size);
      }
    }
  }
  return [...out];
}

/** Where the rules send a frame of this flow, restricted to the ports the testbed can observe. A table miss drops (fail closed). */
export function predictOutcome(rules: readonly WireRule[], flow: WireFlow): number[] {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    if (!matchesPacket(r.match, flow.packet)) continue;
    return [...new Set(r.outputPorts)].filter((p) => flow.observable.includes(p)).sort((a, b) => a - b);
  }
  return [];
}

export interface FlowSelection {
  readonly flows: readonly WireFlow[];
  /** Ids of the other rule sets some chosen flow tells from the reference (by prediction). */
  readonly separated: readonly string[];
  /** Ids no candidate flow tells from the reference within the allowed modes and the budget. */
  readonly unseparated: readonly string[];
}

const key = (ports: readonly number[]): string => ports.join(',');

/** Upper bound on candidates x other sets (Invariant 5): the separation matrix is built in full. About 400,000 cells at most today. */
export const MAX_SEPARATION_CELLS = 5_000_000;

/** Greedy cover: repeatedly take the flow that separates the most not-yet-separated sets from `reference`, up to `maxFlows`. Ties: lower mode, then id. */
export function selectFlows(candidates: readonly WireFlow[], reference: WireRuleSet, others: readonly WireRuleSet[], maxFlows: number, maxCells: number = MAX_SEPARATION_CELLS): FlowSelection {
  if (!Number.isInteger(maxFlows) || maxFlows < 0) throw new RangeError(`maxFlows must be a non-negative integer, got ${maxFlows}`);
  if (candidates.length * others.length > maxCells) throw new RangeError(`${candidates.length} candidate flows x ${others.length} sets exceeds ${maxCells}; narrow the address universe or the pool`);
  const refOutcome = candidates.map((f) => key(predictOutcome(reference.rules, f)));
  const diff: boolean[][] = candidates.map((f, i) => others.map((o) => key(predictOutcome(o.rules, f)) !== refOutcome[i]));
  const covered = new Array<boolean>(others.length).fill(false);
  const chosen: WireFlow[] = [];
  const order = candidates.map((_, i) => i).sort((a, b) => candidates[a]!.mode - candidates[b]!.mode || (candidates[a]!.id < candidates[b]!.id ? -1 : 1));
  while (chosen.length < maxFlows) {
    let best = -1;
    let bestGain = 0;
    for (const i of order) {
      let gain = 0;
      for (let j = 0; j < others.length; j++) if (!covered[j] && diff[i]![j]) gain++;
      if (gain > bestGain) { best = i; bestGain = gain; }
    }
    if (best < 0) break;
    chosen.push(candidates[best]!);
    for (let j = 0; j < others.length; j++) if (diff[best]![j]) covered[j] = true;
  }
  return {
    flows: chosen,
    separated: others.filter((_, j) => covered[j]).map((o) => o.id),
    unseparated: others.filter((_, j) => !covered[j]).map((o) => o.id),
  };
}
