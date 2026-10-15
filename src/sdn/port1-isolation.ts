/**
 * port1-isolation.ts
 * Baseline Zodiac FX data-plane policy that isolates the untrusted workload segment
 * (Zodiac Port 1 → NETGEAR → RPi, 10.0.2.0/24) from the lab LAN / WAN reachable via Port 2.
 *
 * Physical reality: Port 2 is wired to the ISP Wi-Fi extender (lab LAN 10.0.0.0/24,
 * gateway 10.0.0.1 → Internet). A port-only `in_port=1 → [2,3]` rule bridges every workload
 * frame (DHCP, mDNS, spoofed 10.0.0.x sources, default-gateway traffic) onto the household
 * L2 domain, leaving `never-default` on the workload host as the only guard — a guard the
 * untrusted workload itself controls. This module replaces that with a fail-closed policy:
 *
 *   prio 200  in_port=1, IPv4 src 10.0.2.0/24 dst 10.0.2.0/24 → [P2, P3]
 *   prio 200  in_port=1, ARP                                    → [P2, P3]
 *   prio 150  in_port=1, anything else                          → [P3]   (sentinel tap only)
 *   prio 200  in_port=2, IPv4 dst 10.0.2.0/24                   → [P1]
 *   prio 200  in_port=2, ARP                                    → [P1]
 *   prio 100  in_port=3                                         → [P1]   (tap return path)
 *   prio 0    table-miss (installed separately)                 → DROP
 *
 * Quarantine DROPs at 65535 still override everything here.
 *
 * Residual exposure (documented, not hidden): ARP is forwarded across P1⟷P2 because Zodiac FX
 * firmware 0.86 ARP_TPA/ARP_SPA OXM support is unverified. ARP alone cannot carry IPv4 payloads,
 * so LAN/WAN reachability remains blocked; it only discloses L2/L3 address bindings.
 */

import type { FlowModOptions } from './openflow-types.js';
import { FlowModCommand } from './openflow-types.js';
import type { FlowStatsEntry } from './dataplane-benchmark.js';
import { verifyActionReadback, type ActionReadbackVerdict } from './action-readback.js';

export const ETH_TYPE_IPV4 = 0x0800;
export const ETH_TYPE_ARP = 0x0806;

export const ZODIAC_PORT_WORKLOAD = 1;
export const ZODIAC_PORT_UPLINK = 2;
export const ZODIAC_PORT_TAP = 3;

export const WORKLOAD_SUBNET = '10.0.2.0';
export const WORKLOAD_PREFIX_LEN = 24;

export const PRIORITY_ISOLATION_ALLOW = 200;
export const PRIORITY_ISOLATION_TAP_ONLY = 150;
export const PRIORITY_TAP_RETURN = 100;

export interface IsolationRule {
  /** Human-readable identifier used in logs and verifier diagnostics. */
  readonly id: string;
  readonly flowMod: FlowModOptions;
}

/**
 * Pure policy builder. No I/O; deterministic output for identical inputs.
 */
export function buildPort1IsolationPolicy(
  subnet: string = WORKLOAD_SUBNET,
  prefixLen: number = WORKLOAD_PREFIX_LEN,
): readonly IsolationRule[] {
  const add = (priority: number, outputPorts: readonly number[], match: FlowModOptions['match']): FlowModOptions => ({
    command: FlowModCommand.OFPFC_ADD,
    priority,
    outputPorts,
    match,
  });

  return [
    {
      id: 'p1-ipv4-intra-segment',
      flowMod: add(PRIORITY_ISOLATION_ALLOW, [ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP], {
        inPort: ZODIAC_PORT_WORKLOAD,
        etherType: ETH_TYPE_IPV4,
        srcIp: subnet,
        srcIpPrefixLen: prefixLen,
        dstIp: subnet,
        dstIpPrefixLen: prefixLen,
      }),
    },
    {
      id: 'p1-arp',
      flowMod: add(PRIORITY_ISOLATION_ALLOW, [ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP], {
        inPort: ZODIAC_PORT_WORKLOAD,
        etherType: ETH_TYPE_ARP,
      }),
    },
    {
      id: 'p1-default-tap-only',
      flowMod: add(PRIORITY_ISOLATION_TAP_ONLY, [ZODIAC_PORT_TAP], {
        inPort: ZODIAC_PORT_WORKLOAD,
      }),
    },
    {
      id: 'p2-ipv4-to-segment',
      flowMod: add(PRIORITY_ISOLATION_ALLOW, [ZODIAC_PORT_WORKLOAD], {
        inPort: ZODIAC_PORT_UPLINK,
        etherType: ETH_TYPE_IPV4,
        dstIp: subnet,
        dstIpPrefixLen: prefixLen,
      }),
    },
    {
      id: 'p2-arp',
      flowMod: add(PRIORITY_ISOLATION_ALLOW, [ZODIAC_PORT_WORKLOAD], {
        inPort: ZODIAC_PORT_UPLINK,
        etherType: ETH_TYPE_ARP,
      }),
    },
    {
      id: 'p3-tap-return',
      flowMod: add(PRIORITY_TAP_RETURN, [ZODIAC_PORT_WORKLOAD], {
        inPort: ZODIAC_PORT_TAP,
      }),
    },
  ];
}

/**
 * Symbolic verifier (Council Invariant 4). Proves, over the rule set alone, that no rule can
 * emit workload traffic onto the uplink unless it is ARP or IPv4 confined to the workload
 * subnet on BOTH source and destination, and that no uplink traffic reaches the workload
 * unless it is ARP or IPv4 destined to the workload subnet.
 *
 * Returns the list of violations; an empty list means the policy is admissible.
 */
export function verifyPort1Isolation(
  rules: readonly IsolationRule[],
  subnet: string = WORKLOAD_SUBNET,
  prefixLen: number = WORKLOAD_PREFIX_LEN,
): string[] {
  const violations: string[] = [];
  const confined = (ip: string | undefined, len: number | undefined): boolean =>
    ip === subnet && (len ?? 32) >= prefixLen;

  for (const { id, flowMod } of rules) {
    const m = flowMod.match;
    const out = flowMod.outputPorts ?? [];
    if (m?.inPort === undefined) {
      violations.push(`${id}: rule without in_port match is ambiguous (fail-closed requires explicit ingress)`);
      continue;
    }

    const isArp = m.etherType === ETH_TYPE_ARP && m.srcIp === undefined && m.dstIp === undefined;
    const isIpv4 = m.etherType === ETH_TYPE_IPV4;

    if (m.inPort === ZODIAC_PORT_WORKLOAD && out.includes(ZODIAC_PORT_UPLINK)) {
      const ok = isArp || (isIpv4 && confined(m.srcIp, m.srcIpPrefixLen) && confined(m.dstIp, m.dstIpPrefixLen));
      if (!ok) violations.push(`${id}: workload → uplink without 10.0.2.0/24 src+dst confinement`);
    }

    if (m.inPort === ZODIAC_PORT_UPLINK && out.includes(ZODIAC_PORT_WORKLOAD)) {
      const ok = isArp || (isIpv4 && confined(m.dstIp, m.dstIpPrefixLen));
      if (!ok) violations.push(`${id}: uplink → workload without 10.0.2.0/24 dst confinement`);
    }

    if (out.includes(m.inPort)) {
      violations.push(`${id}: hairpin output to ingress port ${m.inPort}`);
    }
  }

  // The workload port must have a lower-priority catch-all that never reaches the uplink;
  // otherwise unmatched workload frames fall to table-miss (still safe) but lose sentinel visibility.
  const catchAll = rules.find(
    (r) =>
      r.flowMod.match?.inPort === ZODIAC_PORT_WORKLOAD &&
      r.flowMod.match.etherType === undefined &&
      r.flowMod.match.srcIp === undefined &&
      r.flowMod.match.dstIp === undefined,
  );
  if (!catchAll) {
    violations.push('missing workload catch-all → tap rule (sentinel would be blind to dropped traffic)');
  } else if ((catchAll.flowMod.outputPorts ?? []).includes(ZODIAC_PORT_UPLINK)) {
    violations.push(`${catchAll.id}: workload catch-all forwards to uplink`);
  }

  return violations;
}

function prefixLenToMask(len: number | undefined): string | undefined {
  if (len === undefined || len === 32) return undefined; // exact match: switch reports no mask
  if (!Number.isInteger(len) || len < 0 || len > 32) throw new Error(`prefix length out of range: ${len}`);
  if (len === 0) return '0.0.0.0'; // JS masks shift counts to 5 bits: `<< 32` would be `<< 0`
  const m = (0xffffffff << (32 - len)) >>> 0;
  return `${m >>> 24}.${(m >>> 16) & 0xff}.${(m >>> 8) & 0xff}.${m & 0xff}`;
}

export interface IsolationReadbackVerdict {
  /** Match level only: every rule present exactly once with identical match fields, plus a table-miss entry. */
  readonly verified: boolean;
  /** Policy rule ids confirmed present on the switch with an exact field-for-field match. */
  readonly confirmed: readonly string[];
  readonly mismatches: readonly string[];
  /** Action level (output ports, table-miss drop) from the same reply. See action-readback.ts. */
  readonly actions: ActionReadbackVerdict;
  /**
   * True only when the match level verified AND the switch reported the intended output ports. False when the
   * switch reported different actions, and also when it reported none, so it never claims more than was seen.
   */
  readonly provenForwarding: boolean;
}

/**
 * Compares the switch's own OFPMP_FLOW readback against the intended isolation policy.
 * Each policy rule must appear exactly once with identical priority, in_port, eth_type and
 * masked IPv4 src/dst. A table-miss entry at priority 0 must also be present.
 *
 * Scope note: `verified` is match level only. Output actions are checked separately and reported in `actions`;
 * `provenForwarding` is true only when both hold. Whether the Zodiac FX firmware reports instructions in
 * flow stats is unmeasured, so on that hardware `actions.status` may well be `unobservable`; forwarding
 * behaviour is then covered only by the on-wire leak test in the runbook.
 */
export function verifyIsolationReadback(
  rules: readonly IsolationRule[],
  entries: readonly FlowStatsEntry[],
): IsolationReadbackVerdict {
  const confirmed: string[] = [];
  const mismatches: string[] = [];
  const matchedEntries = new Map<string, FlowStatsEntry>();

  for (const { id, flowMod } of rules) {
    const m = flowMod.match;
    const want = {
      priority: flowMod.priority,
      inPort: m?.inPort,
      ethType: m?.etherType,
      srcIp: m?.srcIp,
      srcMask: prefixLenToMask(m?.srcIpPrefixLen),
      dstIp: m?.dstIp,
      dstMask: prefixLenToMask(m?.dstIpPrefixLen),
    };
    const hits = entries.filter(
      (e) =>
        e.priority === want.priority &&
        e.inPort === want.inPort &&
        e.ethType === want.ethType &&
        e.srcIp === want.srcIp &&
        e.srcMask === want.srcMask &&
        e.dstIp === want.dstIp &&
        e.dstMask === want.dstMask,
    );
    if (hits.length === 1) {
      confirmed.push(id);
      const only = hits[0];
      if (only !== undefined) matchedEntries.set(id, only);
    } else if (hits.length === 0) {
      const samePrio = entries.filter((e) => e.priority === want.priority && e.inPort === want.inPort);
      mismatches.push(
        samePrio.length > 0
          ? `${id}: switch holds priority ${want.priority} in_port ${String(want.inPort)} but with different match fields ${JSON.stringify(samePrio.map(({ ethType, srcIp, srcMask, dstIp, dstMask }) => ({ ethType, srcIp, srcMask, dstIp, dstMask })))}`
          : `${id}: not present on switch (priority ${want.priority}, in_port ${String(want.inPort)})`,
      );
    } else {
      mismatches.push(`${id}: ${hits.length} duplicate entries on switch`);
    }
  }

  if (!entries.some((e) => e.priority === 0 && e.inPort === undefined && e.ethType === undefined)) {
    mismatches.push('table-miss: no priority-0 wildcard entry on switch');
  }

  const actions = verifyActionReadback(
    rules.map((r) => ({ id: r.id, outputPorts: r.flowMod.outputPorts ?? [] })),
    matchedEntries,
    entries,
  );
  const verified = mismatches.length === 0;
  return { verified, confirmed, mismatches, actions, provenForwarding: verified && actions.status === 'confirmed' };
}
