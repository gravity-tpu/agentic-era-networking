/**
 * hard-intents.test.ts
 * Four additional intents for the agent-proposal evaluation (docs/research/evaluation-plan.md section 13), added because INTENT-1, 2 and 4 are at or near
 * the ceiling under prompt v3. They are chosen by structure (more interacting constraints), not by how a model did on them. Each has a hand-written
 * reference policy that must satisfy it, breakages that must be rejected so the intents can fail (Invariant 4), and a description that names every
 * address its clauses use (the contradiction plan amendment 1 fixed in INTENT-3 and 4). Abstract evaluation only: nothing here says how the switch behaves.
 */

import { describe, it, expect } from 'vitest';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy, ETH_TYPE_ARP, ETH_TYPE_IPV4, WORKLOAD_SUBNET } from '../../src/sdn/port1-isolation.js';
import type { IsolationRule } from '../../src/sdn/port1-isolation.js';
import { checkIntent } from '../../src/sdn/intent-spec.js';
import type { IntentSpec } from '../../src/sdn/intent-spec.js';
import { triageProposal } from '../../src/sdn/proposal-triage.js';
import { generateMutants, scoreMutants } from '../../src/sdn/rule-mutations.js';
import { HELD_OUT_BENCHMARK_INTENT_IDS, HELD_OUT_BENCHMARK_SUBNET_PREFIX } from '../../src/sdn/proposer-lora-dataset.js';
import {
  HARD_INTENTS,
  QUARANTINE_SET_INTENT,
  DNS_QUARANTINE_INTENT,
  UPLINK_ARP_CONFINEMENT_INTENT,
  PER_HOST_ALLOWLIST_INTENT,
  QUARANTINE_SET_HOSTS,
  DNS_QUARANTINED_HOST,
  UPLINK_ARP_PEERS,
  FILE_SERVER_IP,
  intentComplexity,
} from '../../src/sdn/intents-hard.js';
import {
  buildQuarantineSetPolicy,
  buildDnsQuarantinePolicy,
  buildUplinkArpConfinementPolicy,
  buildPerHostAllowlistPolicy,
} from '../../src/sdn/intent-references-hard.js';
import { DNS_RESOLVER_IP, PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { buildDnsConfinementPolicy, buildQuarantinePolicy } from '../../src/sdn/intent-references.js';

const rule = (id: string, priority: number, outputPorts: number[], match: IsolationRule['flowMod']['match']): IsolationRule => ({
  id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match },
});
const without = (rules: readonly IsolationRule[], id: string): IsolationRule[] => rules.filter((r) => r.id !== id);
const replace = (rules: readonly IsolationRule[], id: string, fn: (r: IsolationRule) => IsolationRule): IsolationRule[] => rules.map((r) => (r.id === id ? fn(r) : r));
const kinds = (rules: readonly IsolationRule[], spec: IntentSpec): string[] => checkIntent(rules, spec).violations.map((v) => v.kind);

const REFERENCES: ReadonlyArray<readonly [IntentSpec, readonly IsolationRule[]]> = [
  [QUARANTINE_SET_INTENT, buildQuarantineSetPolicy()],
  [DNS_QUARANTINE_INTENT, buildDnsQuarantinePolicy()],
  [UPLINK_ARP_CONFINEMENT_INTENT, buildUplinkArpConfinementPolicy()],
  [PER_HOST_ALLOWLIST_INTENT, buildPerHostAllowlistPolicy()],
];

describe('every hard intent has a reference policy the verifier accepts', () => {
  for (const [spec, ref] of REFERENCES) {
    it(`${spec.id}: satisfied and admissible`, () => {
      expect(checkIntent(ref, spec).satisfied).toBe(true);
      expect(triageProposal(ref, spec).category).toBe('ADMISSIBLE');
    });
  }
  it('the four intents are exactly the exported set, with distinct ids that are not among the evaluated four', () => {
    expect(HARD_INTENTS.map((s) => s.id)).toEqual(REFERENCES.map(([s]) => s.id));
    expect(new Set(HARD_INTENTS.map((s) => s.id)).size).toBe(4);
    for (const s of HARD_INTENTS) expect(HELD_OUT_BENCHMARK_INTENT_IDS.has(s.id)).toBe(false);
  });
});

describe('a description states what its clauses require (the lesson of plan amendment 1)', () => {
  const addressesOf = (spec: IntentSpec): string[] => {
    const out = new Set<string>();
    for (const c of spec.clauses) for (const v of [c.match.srcIp, c.match.dstIp, c.match.arpSpa, c.match.arpTpa]) if (v && v !== WORKLOAD_SUBNET) out.add(v);
    return [...out];
  };
  for (const spec of HARD_INTENTS) {
    it(`${spec.id}: names every host address its clauses use, except the two known workload hosts the prompt already lists`, () => {
      const known = new Set(['10.0.2.50', '10.0.2.52']);
      for (const a of addressesOf(spec)) if (!known.has(a)) expect(spec.description, `${spec.id}: clauses use ${a} but the description does not name it`).toContain(a);
    });
    it(`${spec.id}: stays inside the held-out benchmark subnet, so no training scenario can contain it`, () => {
      for (const a of addressesOf(spec)) expect(a.startsWith(HELD_OUT_BENCHMARK_SUBNET_PREFIX), `${spec.id}: ${a}`).toBe(true);
    });
  }
  it('the check can fail: a description that omits a quarantined host is detected', () => {
    const stale = QUARANTINE_SET_INTENT.description.replace(QUARANTINE_SET_HOSTS[2]!, 'another host');
    expect(stale).not.toContain(QUARANTINE_SET_HOSTS[2]);
  });
});

describe('quarantine-set/v1: three quarantined hosts, both directions', () => {
  const ref = buildQuarantineSetPolicy();
  it('rejects the plain isolation policy', () => {
    expect(kinds(buildPort1IsolationPolicy(), QUARANTINE_SET_INTENT)).toContain('leak');
  });
  it('rejects forgetting the third host in one direction', () => {
    expect(kinds(without(ref, `quarantine-src-${QUARANTINE_SET_HOSTS[2]}`), QUARANTINE_SET_INTENT)).toContain('leak');
  });
  it('rejects a quarantine DROP outranked by a forwarding rule', () => {
    const low = replace(ref, `quarantine-dst-${QUARANTINE_SET_HOSTS[1]}`, (r) => ({ ...r, flowMod: { ...r.flowMod, priority: 100 } }));
    expect(kinds(low, QUARANTINE_SET_INTENT)).toContain('leak');
  });
  it('rejects quarantining the wrong third host', () => {
    const wrong = replace(ref, `quarantine-src-${QUARANTINE_SET_HOSTS[2]}`, (r) => ({ ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, srcIp: '10.0.2.99' } } }));
    expect(kinds(wrong, QUARANTINE_SET_INTENT)).toContain('leak');
  });
});

describe('dns-quarantine/v1: the resolver exception versus a quarantine inside the segment', () => {
  const ref = buildDnsQuarantinePolicy();
  it('rejects plain DNS confinement (the quarantined host still reaches the resolver)', () => {
    const dnsOnly = ref.filter((r) => !r.id.startsWith('quarantine-'));
    expect(kinds(dnsOnly, DNS_QUARANTINE_INTENT)).toContain('leak');
  });
  it('rejects a quarantine DROP below the resolver allow rule', () => {
    const low = replace(ref, 'quarantine-src', (r) => ({ ...r, flowMod: { ...r.flowMod, priority: 100 } }));
    expect(kinds(low, DNS_QUARANTINE_INTENT)).toContain('leak');
  });
  it('rejects widening the resolver rule to the whole segment', () => {
    const wide = replace(ref, 'p1-ipv4-to-resolver', (r) => ({ ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, dstIp: '10.0.2.0', dstIpPrefixLen: 24 } } }));
    expect(kinds(wide, DNS_QUARANTINE_INTENT)).toContain('leak');
  });
  it('rejects dropping the resolver rule', () => {
    expect(kinds(without(ref, 'p1-ipv4-to-resolver'), DNS_QUARANTINE_INTENT)).toContain('missing');
  });
  it('names both the resolver and the quarantined host', () => {
    expect(DNS_QUARANTINE_INTENT.description).toContain(DNS_RESOLVER_IP);
    expect(DNS_QUARANTINE_INTENT.description).toContain(DNS_QUARANTINED_HOST);
  });
});

describe('uplink-arp-confinement/v1: ARP from the uplink only for named peers', () => {
  const ref = buildUplinkArpConfinementPolicy();
  it('rejects the isolation policy with the unconfined uplink ARP rule', () => {
    expect(kinds(buildPort1IsolationPolicy(), UPLINK_ARP_CONFINEMENT_INTENT)).toContain('leak');
  });
  it('rejects omitting a peer', () => {
    expect(kinds(without(ref, `p2-arp-allow-${UPLINK_ARP_PEERS[1]}`), UPLINK_ARP_CONFINEMENT_INTENT)).toContain('missing');
  });
  it('rejects allowing a peer to claim a whole prefix', () => {
    const wide = replace(ref, `p2-arp-allow-${UPLINK_ARP_PEERS[0]}`, (r) => ({ ...r, flowMod: { ...r.flowMod, match: { inPort: 2, etherType: ETH_TYPE_ARP } } }));
    expect(kinds(wide, UPLINK_ARP_CONFINEMENT_INTENT)).toContain('leak');
  });
  it('names every peer', () => {
    for (const p of UPLINK_ARP_PEERS) expect(UPLINK_ARP_CONFINEMENT_INTENT.description).toContain(p);
  });
});

describe('per-host-allowlist/v1: different destinations per workload host, asymmetric return path', () => {
  const ref = buildPerHostAllowlistPolicy();
  it('rejects giving the second host the file server', () => {
    const extra = [rule('p1-b-to-fileserver', 200, [2, 3], { inPort: 1, etherType: ETH_TYPE_IPV4, srcIp: '10.0.2.52', srcIpPrefixLen: 32, dstIp: FILE_SERVER_IP, dstIpPrefixLen: 32 }), ...ref];
    expect(kinds(extra, PER_HOST_ALLOWLIST_INTENT)).toContain('leak');
  });
  it("rejects removing the first host's file server rule", () => {
    expect(kinds(without(ref, 'p1-a-to-fileserver'), PER_HOST_ALLOWLIST_INTENT)).toContain('missing');
  });
  it('rejects returning file-server traffic to the whole segment instead of only the first host', () => {
    const wide = replace(ref, 'p2-fileserver-to-a', (r) => ({ ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, dstIp: '10.0.2.0', dstIpPrefixLen: 24 } } }));
    expect(kinds(wide, PER_HOST_ALLOWLIST_INTENT)).toContain('leak');
  });
  it('rejects the plain isolation policy (both hosts could reach every segment host)', () => {
    expect(kinds(buildPort1IsolationPolicy(), PER_HOST_ALLOWLIST_INTENT)).not.toEqual([]);
  });
});

describe('the intents can fail broadly: mutants of each reference are mostly rejected', () => {
  for (const [spec, ref] of REFERENCES) {
    it(`${spec.id}: at least 60% of mutants are rejected`, () => {
      const score = scoreMutants(generateMutants(ref, spec.ports), (rules) => triageProposal(rules, spec).category !== 'ADMISSIBLE');
      expect(score.total).toBeGreaterThan(10);
      expect(score.killed.length / score.total).toBeGreaterThanOrEqual(0.6);
    });
  }
});

describe('structural complexity, fixed in advance (plan section 13.2): what makes these intents larger than INTENT-1', () => {
  it('the evaluated four have the pinned measures the plan compares against', () => {
    expect({
      'port1-isolation/v1': intentComplexity(PORT1_ISOLATION_INTENT, buildPort1IsolationPolicy()),
      'dns-confinement/v1': intentComplexity(DNS_CONFINEMENT_INTENT, buildDnsConfinementPolicy()),
      'quarantine-precedence/v1': intentComplexity(QUARANTINE_PRECEDENCE_INTENT, buildQuarantinePolicy()),
      'tap-return-isolation/v1': intentComplexity(TAP_RETURN_ISOLATION_INTENT, buildPort1IsolationPolicy()),
    }).toEqual({
      'port1-isolation/v1': { clauses: 7, referenceRules: 7, priorityTiers: 3, namedAddresses: 0 },
      'dns-confinement/v1': { clauses: 7, referenceRules: 6, priorityTiers: 3, namedAddresses: 1 },
      'quarantine-precedence/v1': { clauses: 9, referenceRules: 9, priorityTiers: 4, namedAddresses: 1 },
      'tap-return-isolation/v1': { clauses: 7, referenceRules: 7, priorityTiers: 3, namedAddresses: 0 },
    });
  });
  it('reports the clause count, reference rule count and priority tiers, and they are pinned', () => {
    const rows = REFERENCES.map(([spec, ref]) => [spec.id, intentComplexity(spec, ref)] as const);
    expect(Object.fromEntries(rows)).toEqual({
      'quarantine-set/v1': { clauses: 13, referenceRules: 13, priorityTiers: 4, namedAddresses: 3 },
      'dns-quarantine/v1': { clauses: 9, referenceRules: 8, priorityTiers: 4, namedAddresses: 2 },
      'uplink-arp-confinement/v1': { clauses: 9, referenceRules: 8, priorityTiers: 3, namedAddresses: 2 },
      'per-host-allowlist/v1': { clauses: 11, referenceRules: 10, priorityTiers: 3, namedAddresses: 2 },
    });
  });
});
