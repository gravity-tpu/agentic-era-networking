import { describe, it, expect } from 'vitest';
import {
  HELD_OUT_BENCHMARK_INTENT_HASHES,
  assertDisjointFromBenchmark,
  buildProposerLoraDataset,
  buildTrainingScenarios,
} from '../../src/sdn/proposer-lora-dataset.js';
import {
  PORT1_ISOLATION_INTENT,
  DNS_CONFINEMENT_INTENT,
  QUARANTINE_PRECEDENCE_INTENT,
  TAP_RETURN_ISOLATION_INTENT,
} from '../../src/sdn/intents.js';
import { parseProposal, triageProposal } from '../../src/sdn/proposal-triage.js';
import { intentSha256 } from '../../src/sdn/intent-hash.js';

describe('proposer-lora-dataset invariants (train/test disjointness and verifier grounding)', () => {
  it('pins all four benchmark intent hashes in HELD_OUT_BENCHMARK_INTENT_HASHES', () => {
    for (const spec of [
      PORT1_ISOLATION_INTENT,
      DNS_CONFINEMENT_INTENT,
      QUARANTINE_PRECEDENCE_INTENT,
      TAP_RETURN_ISOLATION_INTENT,
    ]) {
      expect(HELD_OUT_BENCHMARK_INTENT_HASHES.has(intentSha256(spec))).toBe(true);
    }
  });

  it('the disjointness check can fail: rejects every held-out benchmark intent and any 10.0.2.0/24 address', () => {
    for (const spec of [
      PORT1_ISOLATION_INTENT,
      DNS_CONFINEMENT_INTENT,
      QUARANTINE_PRECEDENCE_INTENT,
      TAP_RETURN_ISOLATION_INTENT,
    ]) {
      expect(() => assertDisjointFromBenchmark(spec, ['10.10.0.50'])).toThrow(/benchmark/i);
    }

    const leakedClauseSpec = {
      id: 'train-leak-clause/v1',
      description: 'Segment 10.10.0.0/24 on P1.',
      ports: [1, 2, 3],
      clauses: [
        {
          id: 'c1',
          match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.50', srcIpPrefixLen: 32 },
          mustReach: [2],
          mayReach: [2],
        },
      ],
    };
    expect(() => assertDisjointFromBenchmark(leakedClauseSpec, ['10.10.0.50'])).toThrow(/10\.0\.2\./);

    const leakedHostSpec = {
      id: 'train-leak-host/v1',
      description: 'Segment 10.10.0.0/24 on P1.',
      ports: [1, 2, 3],
      clauses: [
        {
          id: 'c1',
          match: { inPort: 1, etherType: 0x0800, srcIp: '10.10.0.0', srcIpPrefixLen: 24 },
          mustReach: [2],
          mayReach: [2],
        },
      ],
    };
    expect(() => assertDisjointFromBenchmark(leakedHostSpec, ['10.0.2.52'])).toThrow(/10\.0\.2\./);
  });

  it('every generated training scenario is disjoint from the benchmark and has a verifier-admissible reference policy', () => {
    const scenarios = buildTrainingScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(24);
    const seenIds = new Set<string>();
    const seenHashes = new Set<string>();

    for (const s of scenarios) {
      expect(seenIds.has(s.spec.id)).toBe(false);
      seenIds.add(s.spec.id);

      const h = intentSha256(s.spec);
      expect(seenHashes.has(h)).toBe(false);
      seenHashes.add(h);

      expect(() => assertDisjointFromBenchmark(s.spec, s.workloadHosts)).not.toThrow();

      const verdict = triageProposal(s.referenceRules, s.spec);
      expect(verdict.category, `${s.spec.id}: ${verdict.details.join('; ')}`).toBe('ADMISSIBLE');
    }
  });

  it('every generated SFT and DPO example is grounded by parseProposal and triageProposal', () => {
    const dataset = buildProposerLoraDataset();
    expect(dataset.sftZeroShot.length).toBeGreaterThanOrEqual(24);
    expect(dataset.sftRepair.length).toBeGreaterThan(150);
    expect(dataset.dpoPairs.length).toBe(dataset.sftRepair.length);

    const scenarioById = new Map(dataset.scenarios.map((s) => [s.spec.id, s]));

    for (const dpo of dataset.dpoPairs) {
      const scenario = scenarioById.get(dpo.scenarioId);
      expect(scenario).toBeDefined();

      // Chosen must parse and be ADMISSIBLE
      const chosenParsed = parseProposal(dpo.chosen);
      expect(chosenParsed.ok).toBe(true);
      if (chosenParsed.ok) {
        const chosenVerdict = triageProposal(chosenParsed.rules, scenario!.spec);
        expect(chosenVerdict.category).toBe('ADMISSIBLE');
      }

      // Rejected must fail either parseProposal or triageProposal with the recorded primary category
      const rejectedParsed = parseProposal(dpo.rejected);
      const rejectedVerdict = rejectedParsed.ok
        ? triageProposal(rejectedParsed.rules, scenario!.spec)
        : { category: rejectedParsed.category, categories: [rejectedParsed.category], details: [rejectedParsed.detail] };
      expect(rejectedVerdict.category).not.toBe('ADMISSIBLE');
      expect(rejectedVerdict.category).toBe(dpo.failureCategory);
      expect(dpo.verifierDetails.length).toBeGreaterThan(0);
    }

    // Check coverage across the failure categories
    for (const requiredCategory of [
      'ERR_SYNTAX',
      'ERR_PREREQUISITE',
      'ERR_HAIRPIN',
      'ERR_AMBIGUITY',
      'ERR_SHADOWED',
      'ERR_INTENT_LEAK',
      'ERR_INTENT_MISSING',
    ] as const) {
      expect(
        dataset.summary.failureCategoryCounts[requiredCategory] ?? 0,
        `expected non-zero coverage for ${requiredCategory}`,
      ).toBeGreaterThan(0);
    }
  });

  it('is purely deterministic across repeated invocations', () => {
    const a = buildProposerLoraDataset();
    const b = buildProposerLoraDataset();
    expect(a.summary).toEqual(b.summary);
    expect(a.dpoPairs.length).toBe(b.dpoPairs.length);
    expect(a.dpoPairs[0]).toEqual(b.dpoPairs[0]);
  });
});

