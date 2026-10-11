/**
 * rule-mutations.test.ts
 * Mutation baseline for the agent-proposal evaluation: deterministic single-point mutations of a
 * correct rule set, scored against a checker. A mutant the checker accepts either is equivalent to
 * the original for the intent or exposes a blind spot; both are reported, neither is hidden.
 *
 * IMPORTANT (Invariant 6): abstract evaluation only; no hardware is involved.
 */

import { describe, it, expect } from 'vitest';
import { buildPort1IsolationPolicy, verifyPort1Isolation } from '../../src/sdn/port1-isolation.js';
import { checkIntent } from '../../src/sdn/intent-spec.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { generateMutants, scoreMutants, MUTATION_OPERATORS } from '../../src/sdn/rule-mutations.js';

const base = buildPort1IsolationPolicy();
const ports = PORT1_ISOLATION_INTENT.ports;

describe('mutant generation', () => {
  it('is deterministic', () => {
    const a = generateMutants(base, ports).map((m) => m.id);
    const b = generateMutants(base, ports).map((m) => m.id);
    expect(a).toEqual(b);
  });

  it('produces unique ids and exercises every operator on the port-1 policy', () => {
    const mutants = generateMutants(base, ports);
    expect(new Set(mutants.map((m) => m.id)).size).toBe(mutants.length);
    const used = new Set(mutants.map((m) => m.operator));
    for (const op of MUTATION_OPERATORS) expect(used.has(op)).toBe(true);
  });

  it('never mutates the input rule set', () => {
    const before = JSON.stringify(base);
    generateMutants(base, ports);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('each mutant differs from the original', () => {
    const original = JSON.stringify(base);
    for (const m of generateMutants(base, ports)) expect(JSON.stringify(m.rules)).not.toBe(original);
  });
});

describe('mutation score', () => {
  const intentKill = (rules: Parameters<typeof checkIntent>[0]): boolean => !checkIntent(rules, PORT1_ISOLATION_INTENT).satisfied;

  it('partitions mutants into killed and survived', () => {
    const mutants = generateMutants(base, ports);
    const score = scoreMutants(mutants, intentKill);
    expect(score.killed.length + score.survived.length).toBe(mutants.length);
    expect(score.total).toBe(mutants.length);
  });

  it('the intent check kills mutants that the structural isolation verifier lets through', () => {
    // Dropping the uplink-to-segment rule breaks the intent (missing delivery) but is structurally safe.
    const mutants = generateMutants(base, ports);
    const dropP2 = mutants.find((m) => m.operator === 'drop-rule' && m.targetRuleId === 'p2-ipv4-to-segment');
    expect(dropP2).toBeDefined();
    if (!dropP2) return;
    expect(verifyPort1Isolation(dropP2.rules)).toEqual([]);
    expect(intentKill(dropP2.rules)).toBe(true);
  });

  it('reports survivors explicitly rather than hiding them', () => {
    // Removing the optional tap copy (P3) from an allow rule is permitted by the intent: an
    // equivalent mutant for this intent. It must show up as a survivor.
    const mutants = generateMutants(base, ports);
    const score = scoreMutants(mutants, intentKill);
    const tapRemoval = score.survived.find(
      (m) => m.operator === 'remove-output' && m.targetRuleId === 'p1-ipv4-intra-segment' && m.id.endsWith(':3'),
    );
    expect(tapRemoval).toBeDefined();
  });

  it('a checker that rejects nothing scores zero (a check that cannot fail is not verification)', () => {
    const score = scoreMutants(generateMutants(base, ports), () => false);
    expect(score.killed).toEqual([]);
  });
});
