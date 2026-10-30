/**
 * proposer-lora-dataset.ts
 * Deterministic, verifier-grounded SFT and DPO dataset generator for fine-tuning a local OpenFlow
 * policy proposer (e.g. Qwen 3.8 27B via LoRA), strictly disjoint from the four pre-registered
 * benchmark intents in `src/sdn/intents.ts`.
 *
 * Invariant 3 & 4 (Fail closed & Verify before actuating):
 *   - `assertDisjointFromBenchmark` refuses any training intent whose canonical hash matches one
 *     of the four pinned evaluation intents or that references any address in the held-out
 *     `10.0.2.0/24` benchmark workload subnet.
 *   - Every positive ("chosen" / reference) rule set is verified `ADMISSIBLE` by `triageProposal`
 *     before inclusion; any failure throws.
 *   - Every negative ("rejected" / Turn-1) rule set is verified inadmissible by `parseProposal` +
 *     `triageProposal`; surviving mutants (equivalent under the intent) are never emitted as negatives.
 *
 * Invariant 6 (Provenance):
 *   - Every dataset summary carries `source: 'synthetic_verifier_grounded'` and records the four
 *     held-out benchmark intent SHA-256 hashes it was checked against.
 *
 * Pure module: no I/O.
 */

import { FlowModCommand, type FlowModMatchOptions } from './openflow-types.js';
import type { IntentSpec } from './intent-spec.js';
import {
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  PRIORITY_ISOLATION_ALLOW,
  PRIORITY_ISOLATION_TAP_ONLY,
  PRIORITY_TAP_RETURN,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_WORKLOAD,
  type IsolationRule,
} from './port1-isolation.js';
import {
  PORT1_ISOLATION_INTENT,
  DNS_CONFINEMENT_INTENT,
  QUARANTINE_PRECEDENCE_INTENT,
  TAP_RETURN_ISOLATION_INTENT,
} from './intents.js';
import { intentSha256 } from './intent-hash.js';
import { generateMutants } from './rule-mutations.js';
import {
  CATEGORY_PRECEDENCE,
  parseProposal,
  proposalFromRules,
  triageProposal,
  type FailureCategory,
} from './proposal-triage.js';
import { PROPOSER_SYSTEM_PROMPT_V2 } from './proposer-prompt.js';

const P1 = ZODIAC_PORT_WORKLOAD;
const P2 = ZODIAC_PORT_UPLINK;
const P3 = ZODIAC_PORT_TAP;

/** Matches MAX_FEEDBACK_LINES in scripts/agent-eval.ts so repair turns are byte-identical in format. */
export const MAX_FEEDBACK_LINES = 12;

export const HELD_OUT_BENCHMARK_SUBNET_PREFIX = '10.0.2.';

export const HELD_OUT_BENCHMARK_INTENT_IDS: ReadonlySet<string> = new Set([
  PORT1_ISOLATION_INTENT.id,
  DNS_CONFINEMENT_INTENT.id,
  QUARANTINE_PRECEDENCE_INTENT.id,
  TAP_RETURN_ISOLATION_INTENT.id,
]);

export const HELD_OUT_BENCHMARK_INTENT_HASHES: ReadonlySet<string> = new Set([
  intentSha256(PORT1_ISOLATION_INTENT),
  intentSha256(DNS_CONFINEMENT_INTENT),
  intentSha256(QUARANTINE_PRECEDENCE_INTENT),
  intentSha256(TAP_RETURN_ISOLATION_INTENT),
]);

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface SftExample {
  readonly id: string;
  readonly scenarioId: string;
  readonly kind: 'sft-zero-shot' | 'sft-repair';
  readonly failureCategory: 'ADMISSIBLE' | FailureCategory;
  readonly operator: string;
  readonly messages: readonly ChatMessage[];
}

export interface DpoPair {
  readonly id: string;
  readonly scenarioId: string;
  readonly failureCategory: FailureCategory;
  readonly operator: string;
  readonly prompt: readonly ChatMessage[];
  readonly chosen: string;
  readonly rejected: string;
  readonly verifierDetails: readonly string[];
}

export interface TrainingScenario {
  readonly family: 'segment-isolation' | 'service-confinement' | 'quarantine-override' | 'bidirectional-arp-tap';
  readonly subnet: string;
  readonly prefixLen: number;
  readonly workloadHosts: readonly string[];
  readonly spec: IntentSpec;
  readonly referenceRules: readonly IsolationRule[];
}

export interface DatasetSummary {
  readonly schema: 'proposer-lora-dataset/v1';
  readonly source: 'synthetic_verifier_grounded';
  readonly heldOutBenchmarkHashes: readonly string[];
  readonly scenarioCount: number;
  readonly sftZeroShotCount: number;
  readonly sftRepairCount: number;
  readonly dpoPairCount: number;
  readonly failureCategoryCounts: Readonly<Record<FailureCategory, number>>;
}

export interface ProposerLoraDataset {
  readonly scenarios: readonly TrainingScenario[];
  readonly sftZeroShot: readonly SftExample[];
  readonly sftRepair: readonly SftExample[];
  readonly dpoPairs: readonly DpoPair[];
  readonly summary: DatasetSummary;
}

interface SubnetProfile {
  readonly tag: string;
  readonly subnet: string;
  readonly prefixLen: number;
  readonly workloadHosts: readonly string[];
  readonly serviceIp: string;
  readonly quarantinedIp: string;
  readonly uplinkArpPeer: string;
}

const TRAINING_SUBNET_PROFILES: readonly SubnetProfile[] = [
  {
    tag: 's10-10-0',
    subnet: '10.10.0.0',
    prefixLen: 24,
    workloadHosts: ['10.10.0.11', '10.10.0.12'],
    serviceIp: '10.10.0.1',
    quarantinedIp: '10.10.0.13',
    uplinkArpPeer: '10.10.0.254',
  },
  {
    tag: 's10-20-4',
    subnet: '10.20.4.0',
    prefixLen: 24,
    workloadHosts: ['10.20.4.21', '10.20.4.22', '10.20.4.23'],
    serviceIp: '10.20.4.1',
    quarantinedIp: '10.20.4.99',
    uplinkArpPeer: '10.20.4.250',
  },
  {
    tag: 's172-16-8',
    subnet: '172.16.8.0',
    prefixLen: 24,
    workloadHosts: ['172.16.8.40', '172.16.8.41'],
    serviceIp: '172.16.8.2',
    quarantinedIp: '172.16.8.42',
    uplinkArpPeer: '172.16.8.1',
  },
  {
    tag: 's192-168-50',
    subnet: '192.168.50.0',
    prefixLen: 24,
    workloadHosts: ['192.168.50.10', '192.168.50.20'],
    serviceIp: '192.168.50.53',
    quarantinedIp: '192.168.50.30',
    uplinkArpPeer: '192.168.50.1',
  },
  {
    tag: 's10-42-0',
    subnet: '10.42.0.0',
    prefixLen: 24,
    workloadHosts: ['10.42.0.70', '10.42.0.71'],
    serviceIp: '10.42.0.5',
    quarantinedIp: '10.42.0.72',
    uplinkArpPeer: '10.42.0.254',
  },
  {
    tag: 's172-30-12',
    subnet: '172.30.12.0',
    prefixLen: 24,
    workloadHosts: ['172.30.12.101', '172.30.12.102', '172.30.12.103'],
    serviceIp: '172.30.12.1',
    quarantinedIp: '172.30.12.104',
    uplinkArpPeer: '172.30.12.254',
  },
  {
    tag: 's192-168-120',
    subnet: '192.168.120.0',
    prefixLen: 24,
    workloadHosts: ['192.168.120.15', '192.168.120.16'],
    serviceIp: '192.168.120.1',
    quarantinedIp: '192.168.120.17',
    uplinkArpPeer: '192.168.120.254',
  },
  {
    tag: 's10-99-1',
    subnet: '10.99.1.0',
    prefixLen: 24,
    workloadHosts: ['10.99.1.60', '10.99.1.61'],
    serviceIp: '10.99.1.9',
    quarantinedIp: '10.99.1.62',
    uplinkArpPeer: '10.99.1.1',
  },
];

/**
 * Fail-closed check ensuring a training scenario never collides with the four held-out benchmark
 * intents or references any address inside the benchmark's `10.0.2.0/24` workload subnet.
 */
export function assertDisjointFromBenchmark(spec: IntentSpec, workloadHosts: readonly string[]): void {
  if (HELD_OUT_BENCHMARK_INTENT_IDS.has(spec.id)) {
    throw new Error(`training intent ${spec.id} collides with held-out benchmark intent ID`);
  }
  const hash = intentSha256(spec);
  if (HELD_OUT_BENCHMARK_INTENT_HASHES.has(hash)) {
    throw new Error(`training intent ${spec.id} (${hash}) matches a held-out benchmark intent hash`);
  }
  if (spec.description.includes(HELD_OUT_BENCHMARK_SUBNET_PREFIX)) {
    throw new Error(`training intent ${spec.id} description references held-out subnet ${HELD_OUT_BENCHMARK_SUBNET_PREFIX}0/24`);
  }
  for (const host of workloadHosts) {
    if (host.startsWith(HELD_OUT_BENCHMARK_SUBNET_PREFIX)) {
      throw new Error(`training intent ${spec.id} workload host ${host} is in held-out subnet ${HELD_OUT_BENCHMARK_SUBNET_PREFIX}0/24`);
    }
  }
  for (const clause of spec.clauses) {
    for (const field of ['srcIp', 'dstIp', 'arpSpa', 'arpTpa'] as const) {
      const val = clause.match[field];
      if (val !== undefined && val.startsWith(HELD_OUT_BENCHMARK_SUBNET_PREFIX)) {
        throw new Error(`training intent ${spec.id} clause ${clause.id}.${field}=${val} is in held-out subnet ${HELD_OUT_BENCHMARK_SUBNET_PREFIX}0/24`);
      }
    }
  }
}

function makeRule(id: string, priority: number, outputPorts: readonly number[], match: FlowModMatchOptions): IsolationRule {
  return {
    id,
    flowMod: {
      command: FlowModCommand.OFPFC_ADD,
      priority,
      outputPorts: [...outputPorts],
      match,
    },
  };
}

function buildScenarioPrompt(spec: IntentSpec, workloadHosts: readonly string[]): readonly ChatMessage[] {
  return [
    { role: 'system', content: PROPOSER_SYSTEM_PROMPT_V2 },
    {
      role: 'user',
      content:
        `Intent: ${spec.description}\nKnown workload host addresses: ${workloadHosts.join(', ')}.\n` +
        'Write the rule set that implements this intent.',
    },
  ];
}

export function buildTrainingScenarios(): readonly TrainingScenario[] {
  const out: TrainingScenario[] = [];

  for (const p of TRAINING_SUBNET_PROFILES) {
    // 1. Segment isolation (mirrors natural phrasing without parenthetical "(subnet to subnet)")
    const segSpec: IntentSpec = {
      id: `train-segment-isolation-${p.tag}/v1`,
      description:
        `Workload segment ${p.subnet}/${p.prefixLen} on P1 may only exchange intra-segment IPv4 with the uplink (P2), and ARP only ` +
        'when claiming one of its own known addresses; everything else from P1 goes only to the tap (P3); the uplink ' +
        'reaches P1 only for IPv4 to the segment and ARP.',
      ports: [P1, P2, P3],
      clauses: [
        {
          id: 'p1-ipv4-intra-segment',
          match: {
            inPort: P1,
            etherType: ETH_TYPE_IPV4,
            srcIp: p.subnet,
            srcIpPrefixLen: p.prefixLen,
            dstIp: p.subnet,
            dstIpPrefixLen: p.prefixLen,
          },
          mustReach: [P2],
          mayReach: [P2, P3],
        },
        ...p.workloadHosts.map((host) => ({
          id: `p1-arp-allow-${host}`,
          match: { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: host },
          mustReach: [P2],
          mayReach: [P2, P3],
        })),
        { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [], mayReach: [P3] },
        {
          id: 'p2-ipv4-to-segment',
          match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: p.subnet, dstIpPrefixLen: p.prefixLen },
          mustReach: [P1],
          mayReach: [P1],
        },
        { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
        { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [], mayReach: [P1] },
      ],
    };
    const segRules: readonly IsolationRule[] = [
      makeRule('p1-ipv4-intra-segment', PRIORITY_ISOLATION_ALLOW, [P2, P3], {
        inPort: P1,
        etherType: ETH_TYPE_IPV4,
        srcIp: p.subnet,
        srcIpPrefixLen: p.prefixLen,
        dstIp: p.subnet,
        dstIpPrefixLen: p.prefixLen,
      }),
      ...p.workloadHosts.map((host) =>
        makeRule(`p1-arp-allow-${host}`, PRIORITY_ISOLATION_ALLOW, [P2, P3], {
          inPort: P1,
          etherType: ETH_TYPE_ARP,
          arpSpa: host,
        }),
      ),
      makeRule('p1-tap-only', PRIORITY_ISOLATION_TAP_ONLY, [P3], { inPort: P1 }),
      makeRule('p2-ipv4-to-segment', PRIORITY_ISOLATION_ALLOW, [P1], {
        inPort: P2,
        etherType: ETH_TYPE_IPV4,
        dstIp: p.subnet,
        dstIpPrefixLen: p.prefixLen,
      }),
      makeRule('p2-arp', PRIORITY_ISOLATION_ALLOW, [P1], { inPort: P2, etherType: ETH_TYPE_ARP }),
      makeRule('p3-tap-return', PRIORITY_TAP_RETURN, [P1], { inPort: P3 }),
    ];
    out.push({
      family: 'segment-isolation',
      subnet: p.subnet,
      prefixLen: p.prefixLen,
      workloadHosts: p.workloadHosts,
      spec: segSpec,
      referenceRules: segRules,
    });

    // 2. Service/gateway confinement (requires anti-spoofing srcIp on P1 -> serviceIp)
    const svcSpec: IntentSpec = {
      id: `train-service-confinement-${p.tag}/v1`,
      description:
        `Workload segment ${p.subnet}/${p.prefixLen} on P1 may reach only its service gateway ${p.serviceIp} (IPv4, out of P2) and may use ARP (out of P2); ` +
        `everything else from P1 goes only to the tap (P3). From the uplink (P2) only IPv4 from ${p.serviceIp} to the segment and ARP reach P1; ` +
        'everything else from P2 is dropped. The tap (P3) may return traffic to P1.',
      ports: [P1, P2, P3],
      clauses: [
        {
          id: 'p1-ipv4-to-service',
          match: {
            inPort: P1,
            etherType: ETH_TYPE_IPV4,
            srcIp: p.subnet,
            srcIpPrefixLen: p.prefixLen,
            dstIp: p.serviceIp,
            dstIpPrefixLen: 32,
          },
          mustReach: [P2],
          mayReach: [P2, P3],
        },
        { id: 'p1-arp', match: { inPort: P1, etherType: ETH_TYPE_ARP }, mustReach: [P2], mayReach: [P2, P3] },
        { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [], mayReach: [P3] },
        {
          id: 'p2-ipv4-from-service',
          match: {
            inPort: P2,
            etherType: ETH_TYPE_IPV4,
            srcIp: p.serviceIp,
            srcIpPrefixLen: 32,
            dstIp: p.subnet,
            dstIpPrefixLen: p.prefixLen,
          },
          mustReach: [P1],
          mayReach: [P1],
        },
        { id: 'p2-arp', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [P1], mayReach: [P1] },
        { id: 'p2-everything-else', match: { inPort: P2 }, mustReach: [], mayReach: [] },
        { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [], mayReach: [P1] },
      ],
    };
    const svcRules: readonly IsolationRule[] = [
      makeRule('p1-ipv4-to-service', PRIORITY_ISOLATION_ALLOW, [P2, P3], {
        inPort: P1,
        etherType: ETH_TYPE_IPV4,
        srcIp: p.subnet,
        srcIpPrefixLen: p.prefixLen,
        dstIp: p.serviceIp,
      }),
      makeRule('p1-arp', PRIORITY_ISOLATION_ALLOW, [P2, P3], { inPort: P1, etherType: ETH_TYPE_ARP }),
      makeRule('p1-tap-only', PRIORITY_ISOLATION_TAP_ONLY, [P3], { inPort: P1 }),
      makeRule('p2-ipv4-from-service', PRIORITY_ISOLATION_ALLOW, [P1], {
        inPort: P2,
        etherType: ETH_TYPE_IPV4,
        srcIp: p.serviceIp,
        dstIp: p.subnet,
        dstIpPrefixLen: p.prefixLen,
      }),
      makeRule('p2-arp', PRIORITY_ISOLATION_ALLOW, [P1], { inPort: P2, etherType: ETH_TYPE_ARP }),
      makeRule('p3-tap-return', PRIORITY_TAP_RETURN, [P1], { inPort: P3 }),
    ];
    out.push({
      family: 'service-confinement',
      subnet: p.subnet,
      prefixLen: p.prefixLen,
      workloadHosts: p.workloadHosts,
      spec: svcSpec,
      referenceRules: svcRules,
    });

    // 3. Quarantine override above intra-segment isolation
    const quarSpec: IntentSpec = {
      id: `train-quarantine-override-${p.tag}/v1`,
      description:
        `Quarantine host ${p.quarantinedIp} on segment ${p.subnet}/${p.prefixLen}: IPv4 sent by ${p.quarantinedIp} into P1, ` +
        `and IPv4 addressed to ${p.quarantinedIp} arriving from the uplink P2, must be dropped (reach no port, not even the tap), ` +
        `even though other rules would forward it. Workload segment ${p.subnet}/${p.prefixLen} on P1 otherwise may only exchange intra-segment IPv4 with the uplink (P2), and ARP only when claiming one of its own known addresses; ` +
        'everything else from P1 goes only to the tap (P3); the uplink reaches P1 only for IPv4 to the segment and ARP.',
      ports: [P1, P2, P3],
      clauses: [
        {
          id: 'quarantine-src',
          match: { inPort: P1, etherType: ETH_TYPE_IPV4, srcIp: p.quarantinedIp, srcIpPrefixLen: 32 },
          mustReach: [],
          mayReach: [],
        },
        {
          id: 'quarantine-dst',
          match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: p.quarantinedIp, dstIpPrefixLen: 32 },
          mustReach: [],
          mayReach: [],
        },
        ...segSpec.clauses,
      ],
    };
    const quarRules: readonly IsolationRule[] = [
      makeRule('quarantine-src', 65535, [], {
        inPort: P1,
        etherType: ETH_TYPE_IPV4,
        srcIp: p.quarantinedIp,
      }),
      makeRule('quarantine-dst', 65535, [], {
        inPort: P2,
        etherType: ETH_TYPE_IPV4,
        dstIp: p.quarantinedIp,
      }),
      ...segRules,
    ];
    out.push({
      family: 'quarantine-override',
      subnet: p.subnet,
      prefixLen: p.prefixLen,
      workloadHosts: p.workloadHosts,
      spec: quarSpec,
      referenceRules: quarRules,
    });

    // 4. Bidirectional ARP confinement + mandatory tap copy on P1 + mandatory tap return on P3
    const bidiSpec: IntentSpec = {
      id: `train-bidi-arp-tap-${p.tag}/v1`,
      description:
        `Every frame from the workload segment ${p.subnet}/${p.prefixLen} on P1 must be copied to the tap (P3) for inspection; ` +
        `intra-segment IPv4 and ARP from P1 claiming one of its own known addresses must also reach the uplink (P2), and nothing else from P1 may reach P2. ` +
        `From the uplink (P2), only IPv4 to ${p.subnet}/${p.prefixLen} and ARP claiming peer ${p.uplinkArpPeer} reach P1; all other uplink traffic is dropped. ` +
        'Frames arriving from the tap (P3) must be returned to P1, and must never reach P2 or P3.',
      ports: [P1, P2, P3],
      clauses: [
        {
          id: 'p1-ipv4-intra-segment',
          match: {
            inPort: P1,
            etherType: ETH_TYPE_IPV4,
            srcIp: p.subnet,
            srcIpPrefixLen: p.prefixLen,
            dstIp: p.subnet,
            dstIpPrefixLen: p.prefixLen,
          },
          mustReach: [P2, P3],
          mayReach: [P2, P3],
        },
        ...p.workloadHosts.map((host) => ({
          id: `p1-arp-allow-${host}`,
          match: { inPort: P1, etherType: ETH_TYPE_ARP, arpSpa: host },
          mustReach: [P2, P3],
          mayReach: [P2, P3],
        })),
        { id: 'p1-everything-else', match: { inPort: P1 }, mustReach: [P3], mayReach: [P3] },
        {
          id: 'p2-ipv4-to-segment',
          match: { inPort: P2, etherType: ETH_TYPE_IPV4, dstIp: p.subnet, dstIpPrefixLen: p.prefixLen },
          mustReach: [P1],
          mayReach: [P1],
        },
        {
          id: `p2-arp-allow-${p.uplinkArpPeer}`,
          match: { inPort: P2, etherType: ETH_TYPE_ARP, arpSpa: p.uplinkArpPeer },
          mustReach: [P1],
          mayReach: [P1],
        },
        { id: 'p2-arp-other', match: { inPort: P2, etherType: ETH_TYPE_ARP }, mustReach: [], mayReach: [] },
        { id: 'p3-tap-return', match: { inPort: P3 }, mustReach: [P1], mayReach: [P1] },
      ],
    };
    const bidiRules: readonly IsolationRule[] = [
      makeRule('p1-ipv4-intra-segment', PRIORITY_ISOLATION_ALLOW, [P2, P3], {
        inPort: P1,
        etherType: ETH_TYPE_IPV4,
        srcIp: p.subnet,
        srcIpPrefixLen: p.prefixLen,
        dstIp: p.subnet,
        dstIpPrefixLen: p.prefixLen,
      }),
      ...p.workloadHosts.map((host) =>
        makeRule(`p1-arp-allow-${host}`, PRIORITY_ISOLATION_ALLOW, [P2, P3], {
          inPort: P1,
          etherType: ETH_TYPE_ARP,
          arpSpa: host,
        }),
      ),
      makeRule('p1-tap-only', PRIORITY_ISOLATION_TAP_ONLY, [P3], { inPort: P1 }),
      makeRule('p2-ipv4-to-segment', PRIORITY_ISOLATION_ALLOW, [P1], {
        inPort: P2,
        etherType: ETH_TYPE_IPV4,
        dstIp: p.subnet,
        dstIpPrefixLen: p.prefixLen,
      }),
      makeRule(`p2-arp-allow-${p.uplinkArpPeer}`, PRIORITY_ISOLATION_ALLOW, [P1], {
        inPort: P2,
        etherType: ETH_TYPE_ARP,
        arpSpa: p.uplinkArpPeer,
      }),
      makeRule('p3-tap-return', PRIORITY_TAP_RETURN, [P1], { inPort: P3 }),
    ];
    out.push({
      family: 'bidirectional-arp-tap',
      subnet: p.subnet,
      prefixLen: p.prefixLen,
      workloadHosts: p.workloadHosts,
      spec: bidiSpec,
      referenceRules: bidiRules,
    });
  }

  for (const s of out) {
    assertDisjointFromBenchmark(s.spec, s.workloadHosts);
    const verdict = triageProposal(s.referenceRules, s.spec);
    if (verdict.category !== 'ADMISSIBLE') {
      throw new Error(`reference policy for ${s.spec.id} is not admissible: ${verdict.details.join('; ')}`);
    }
  }

  return out;
}

interface CandidateNegative {
  readonly id: string;
  readonly operator: string;
  readonly rawJson: string;
}

/**
 * Generates candidate negative proposals for a scenario:
 * 1. All single-point mutants from `generateMutants(referenceRules, [1, 2, 3])` (`src/sdn/rule-mutations.ts`)
 * 2. Targeted structural/syntax faults observed in LLM evaluations (`ERR_HAIRPIN`, `ERR_PREREQUISITE`,
 *    `ERR_SYNTAX`, `ERR_SHADOWED`, `ERR_AMBIGUITY`, and P2-unmatched-to-tap leaks).
 */
function buildCandidateNegatives(scenario: TrainingScenario): readonly CandidateNegative[] {
  const out: CandidateNegative[] = [];
  const ref = scenario.referenceRules;

  for (const m of generateMutants(ref, [P1, P2, P3])) {
    out.push({
      id: `${scenario.spec.id}::${m.id}`,
      operator: m.operator,
      rawJson: proposalFromRules(m.rules),
    });
  }

  // Targeted 1: ERR_HAIRPIN (rule outputs back to its own ingress port)
  const firstRule = ref[0]!;
  if (firstRule.flowMod.match?.inPort !== undefined) {
    const hairpinRules: IsolationRule[] = [
      makeRule(
        firstRule.id,
        firstRule.flowMod.priority,
        [firstRule.flowMod.match.inPort, ...(firstRule.flowMod.outputPorts ?? [])],
        firstRule.flowMod.match,
      ),
      ...ref.slice(1),
    ];
    out.push({
      id: `${scenario.spec.id}::hairpin:${firstRule.id}`,
      operator: 'inject-hairpin',
      rawJson: proposalFromRules(hairpinRules),
    });
  }

  // Targeted 2: ERR_AMBIGUITY (equal-priority conflicting outputPorts on same match)
  const ambigRules: IsolationRule[] = [
    ...ref,
    makeRule(`${firstRule.id}-conflict`, firstRule.flowMod.priority, [P3], firstRule.flowMod.match ?? {}),
  ];
  out.push({
    id: `${scenario.spec.id}::ambiguity:${firstRule.id}`,
    operator: 'inject-equal-priority-conflict',
    rawJson: proposalFromRules(ambigRules),
  });

  // Targeted 3: ERR_SHADOWED (lower-priority rule completely covered by `p1-tap-only` at priority 150)
  const shadowedRules: IsolationRule[] = [
    ...ref,
    makeRule('p1-shadowed-dead-rule', PRIORITY_ISOLATION_TAP_ONLY - 50, [P2], {
      inPort: P1,
      etherType: ETH_TYPE_IPV4,
      srcIp: scenario.workloadHosts[0]!,
    }),
  ];
  out.push({
    id: `${scenario.spec.id}::shadowed:p1-shadowed-dead-rule`,
    operator: 'inject-shadowed-rule',
    rawJson: proposalFromRules(shadowedRules),
  });

  // Targeted 4: ERR_SYNTAX (hallucinated field name `srcIpPrefix`, matching Qwen's Turn-1 slip on INTENT-3 seed 3)
  const syntaxBadObj = ref.map((r, idx) =>
    idx === 0
      ? {
          id: r.id,
          priority: r.flowMod.priority,
          outputPorts: r.flowMod.outputPorts ?? [],
          match: {
            inPort: P1,
            etherType: ETH_TYPE_IPV4,
            srcIpPrefix: scenario.subnet,
            srcIpPrefixLen: scenario.prefixLen,
          },
        }
      : {
          id: r.id,
          priority: r.flowMod.priority,
          outputPorts: r.flowMod.outputPorts ?? [],
          match: r.flowMod.match ?? {},
        },
  );
  out.push({
    id: `${scenario.spec.id}::syntax:srcIpPrefix`,
    operator: 'syntax-unknown-field',
    rawJson: JSON.stringify(syntaxBadObj),
  });

  // Targeted 5: ERR_INTENT_LEAK via sending unmatched P2 traffic to the P3 tap (observed in Qwen INTENT-3 seeds 4 & 5)
  const p2TapLeakRules: IsolationRule[] = [
    ...ref,
    makeRule('p2-catchall-to-tap', 10, [P3], { inPort: P2 }),
  ];
  out.push({
    id: `${scenario.spec.id}::leak:p2-catchall-to-tap`,
    operator: 'p2-unmatched-to-tap',
    rawJson: proposalFromRules(p2TapLeakRules),
  });

  // Targeted 6: ERR_INTENT_MISSING via over-constraining P2 -> P1 return traffic with srcIp: subnet/prefixLen
  // (observed in Qwen pv3 pilot seed 2: gateway return traffic on Port 2 can have external srcIp, only dstIp is segment-scoped)
  const p2ReturnRuleIdx = ref.findIndex(
    (r) =>
      r.flowMod.match?.inPort === P2 &&
      r.flowMod.match.etherType === ETH_TYPE_IPV4 &&
      r.flowMod.match.srcIp === undefined &&
      (r.flowMod.outputPorts ?? []).includes(P1),
  );
  if (p2ReturnRuleIdx !== -1) {
    const p2ReturnRule = ref[p2ReturnRuleIdx]!;
    const overconstrainedP2Rules: IsolationRule[] = ref.map((r, idx) =>
      idx === p2ReturnRuleIdx
        ? makeRule(p2ReturnRule.id, p2ReturnRule.flowMod.priority, p2ReturnRule.flowMod.outputPorts ?? [], {
            ...p2ReturnRule.flowMod.match,
            srcIp: scenario.subnet,
            srcIpPrefixLen: scenario.prefixLen,
          })
        : r,
    );
    out.push({
      id: `${scenario.spec.id}::narrow-p2-srcip:${p2ReturnRule.id}`,
      operator: 'narrow-p2-return-srcip',
      rawJson: proposalFromRules(overconstrainedP2Rules),
    });
  }

  return out;
}

export function buildProposerLoraDataset(): ProposerLoraDataset {
  const scenarios = buildTrainingScenarios();
  const sftZeroShot: SftExample[] = [];
  const sftRepair: SftExample[] = [];
  const dpoPairs: DpoPair[] = [];
  const categoryCounts = new Map<FailureCategory, number>(CATEGORY_PRECEDENCE.map((c) => [c, 0]));

  for (const scenario of scenarios) {
    const promptMessages = buildScenarioPrompt(scenario.spec, scenario.workloadHosts);
    const chosenJson = proposalFromRules(scenario.referenceRules);

    sftZeroShot.push({
      id: `${scenario.spec.id}::zero-shot`,
      scenarioId: scenario.spec.id,
      kind: 'sft-zero-shot',
      failureCategory: 'ADMISSIBLE',
      operator: 'reference',
      messages: [...promptMessages, { role: 'assistant', content: chosenJson }],
    });

    const candidates = buildCandidateNegatives(scenario);
    const seenRejectedJson = new Set<string>();

    for (const cand of candidates) {
      if (seenRejectedJson.has(cand.rawJson)) continue;
      const parsed = parseProposal(cand.rawJson);
      const verdict = parsed.ok
        ? triageProposal(parsed.rules, scenario.spec)
        : { category: parsed.category, categories: [parsed.category], details: [parsed.detail] };

      // Fail closed: surviving mutants (admissible under the intent) are never emitted as negative examples.
      if (verdict.category === 'ADMISSIBLE') continue;
      seenRejectedJson.add(cand.rawJson);

      const primaryCategory: FailureCategory = verdict.category;
      categoryCounts.set(primaryCategory, (categoryCounts.get(primaryCategory) ?? 0) + 1);
      const feedbackLines = verdict.details.slice(0, MAX_FEEDBACK_LINES);
      const feedbackPrompt =
        `The verifier rejected that rule set.\n${feedbackLines.join('\n')}\n` +
        'Fix every problem and reply with the complete corrected JSON array only.';

      dpoPairs.push({
        id: cand.id,
        scenarioId: scenario.spec.id,
        failureCategory: primaryCategory,
        operator: cand.operator,
        prompt: promptMessages,
        chosen: chosenJson,
        rejected: cand.rawJson,
        verifierDetails: feedbackLines,
      });

      sftRepair.push({
        id: cand.id,
        scenarioId: scenario.spec.id,
        kind: 'sft-repair',
        failureCategory: primaryCategory,
        operator: cand.operator,
        messages: [
          ...promptMessages,
          { role: 'assistant', content: cand.rawJson },
          { role: 'user', content: feedbackPrompt },
          { role: 'assistant', content: chosenJson },
        ],
      });
    }
  }

  const failureCategoryCounts = Object.fromEntries(
    CATEGORY_PRECEDENCE.map((c) => [c, categoryCounts.get(c) ?? 0]),
  ) as Record<FailureCategory, number>;

  return {
    scenarios,
    sftZeroShot,
    sftRepair,
    dpoPairs,
    summary: {
      schema: 'proposer-lora-dataset/v1',
      source: 'synthetic_verifier_grounded',
      heldOutBenchmarkHashes: [...HELD_OUT_BENCHMARK_INTENT_HASHES],
      scenarioCount: scenarios.length,
      sftZeroShotCount: sftZeroShot.length,
      sftRepairCount: sftRepair.length,
      dpoPairCount: dpoPairs.length,
      failureCategoryCounts,
    },
  };
}

