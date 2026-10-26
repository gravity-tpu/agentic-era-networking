import { describe, it, expect } from 'vitest';
import { intentSha256 } from '../../src/sdn/intent-hash.js';
import { PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT } from '../../src/sdn/intents.js';

/**
 * The four evaluated intents, pinned. The A10 policy work changed INTENT-1, 3 and 4 in place after results had been recorded against them
 * and nothing failed (docs/benchmarks/results/agent-evaluation/qwen3.8-27b.md, "What it does not show"). If this test fails you have changed
 * a specification that results are recorded against. Do not just update the hash: the evaluation plan (docs/research/evaluation-plan.md,
 * section 10) says a changed intent needs a new plan version and new runs, and agent-eval summaries record `intentSha256` so a result can say
 * which version of the question it answered. Update the hash in the same change as the plan entry.
 *
 * These are the specifications as of 2026-10-26 (after the A10 per-host ARP change, which INTENT-1, 3 and 4 inherit). INTENT-3 and INTENT-4 were
 * re-pinned the same day by plan amendment 1 (docs/research/evaluation-plan.md section 10.6): their descriptions still told the model to allow ARP
 * generally while their clauses required per-host ARP, so a model that followed the text could not pass.
 */
const PINNED: ReadonlyArray<readonly [string, typeof PORT1_ISOLATION_INTENT, string]> = [
  ['port1-isolation/v1', PORT1_ISOLATION_INTENT, 'dbd30d4265caec03e274ad66c9336157969e72f1ba3b30e0f680c72434e780ed'],
  ['dns-confinement/v1', DNS_CONFINEMENT_INTENT, 'e632d34f157f69ff57016ff3fb06dfe3cbdf0e0c4c898dc66db0e104c1d50041'],
  ['quarantine-precedence/v1', QUARANTINE_PRECEDENCE_INTENT, '0fad17b4c7254f0207f986a2e582fb408eb1d061d8e18a96e700bded879679e4'],
  ['tap-return-isolation/v1', TAP_RETURN_ISOLATION_INTENT, '04bf2c63c9b4e2d85abb04154582672594b30d03db3a0b145491342797c08183'],
];

describe('the evaluated intents are pinned', () => {
  for (const [id, spec, hash] of PINNED) {
    it(`${id} still has the pinned specification`, () => {
      expect(spec.id).toBe(id);
      expect(intentSha256(spec)).toBe(hash);
    });
  }

  it('a description states the per-host ARP rule whenever the clauses require it (the contradiction plan amendment 1 fixed)', () => {
    for (const [id, spec] of PINNED) {
      const perHostArp = spec.clauses.some((c) => c.id.startsWith('p1-arp-allow-'));
      if (perHostArp) expect(spec.description, `${id}: clauses require per-host ARP but the description does not say so`).toMatch(/ARP[^.;]*claiming one of its own known addresses/);
    }
  });

  it('the description check can fail: a description that allows ARP generally is rejected', () => {
    const stale = TAP_RETURN_ISOLATION_INTENT.description.replace('ARP from P1 claiming one of its own known addresses must', 'ARP from P1 must');
    expect(stale).not.toMatch(/ARP[^.;]*claiming one of its own known addresses/);
  });

  it('the hash can fail: it changes when a clause, a port set or the clause order changes', () => {
    const base = intentSha256(PORT1_ISOLATION_INTENT);
    const clauses = [...PORT1_ISOLATION_INTENT.clauses];
    expect(intentSha256({ ...PORT1_ISOLATION_INTENT, clauses: clauses.slice().reverse() })).not.toBe(base);
    expect(intentSha256({ ...PORT1_ISOLATION_INTENT, clauses: clauses.slice(1) })).not.toBe(base);
    expect(intentSha256({ ...PORT1_ISOLATION_INTENT, description: PORT1_ISOLATION_INTENT.description + ' ' })).not.toBe(base);
  });

  it('is independent of object key order', () => {
    const a = { id: 'x', description: 'd', ports: [1, 2], clauses: [{ id: 'c', match: { inPort: 1, etherType: 2054 }, mustReach: [2], mayReach: [2] }] };
    const b = { clauses: [{ mayReach: [2], mustReach: [2], match: { etherType: 2054, inPort: 1 }, id: 'c' }], ports: [1, 2], description: 'd', id: 'x' };
    expect(intentSha256(a)).toBe(intentSha256(b));
  });
});
