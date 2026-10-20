/**
 * intents-2-4.test.ts
 * INTENT-2 to 4 of the pre-registered evaluation (docs/research/evaluation-plan.md section 3). Each intent has a
 * hand-written reference policy that must satisfy it, and a policy that breaks it must be rejected, so the intents can fail
 * (Invariant 4). Abstract evaluation only: nothing here says how the switch behaves.
 */

import { describe, it, expect } from 'vitest';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy, ETH_TYPE_IPV4 } from '../../src/sdn/port1-isolation.js';
import type { IsolationRule } from '../../src/sdn/port1-isolation.js';
import { checkIntent } from '../../src/sdn/intent-spec.js';
import { PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT, DNS_RESOLVER_IP, QUARANTINED_IP } from '../../src/sdn/intents.js';
import { buildDnsConfinementPolicy, buildQuarantinePolicy, buildTapReturnPolicy } from '../../src/sdn/intent-references.js';
import { triageProposal } from '../../src/sdn/proposal-triage.js';

const rule = (id: string, priority: number, outputPorts: number[], match: IsolationRule['flowMod']['match']): IsolationRule => ({
  id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match },
});
const without = (rules: readonly IsolationRule[], id: string): IsolationRule[] => rules.filter((r) => r.id !== id);
const replace = (rules: readonly IsolationRule[], id: string, fn: (r: IsolationRule) => IsolationRule): IsolationRule[] => rules.map((r) => (r.id === id ? fn(r) : r));
const kinds = (rules: readonly IsolationRule[], spec: Parameters<typeof checkIntent>[1]): string[] => checkIntent(rules, spec).violations.map((v) => v.kind);

describe('INTENT-2 dns-confinement/v1 (host level: L4 ports are not in the match model)', () => {
  const ref = buildDnsConfinementPolicy();
  it('is satisfied by its reference policy', () => {
    expect(checkIntent(ref, DNS_CONFINEMENT_INTENT).satisfied).toBe(true);
    expect(triageProposal(ref, DNS_CONFINEMENT_INTENT).category).toBe('ADMISSIBLE');
  });
  it('rejects the isolation policy, which lets the workload reach every segment host', () => {
    expect(checkIntent(buildPort1IsolationPolicy(), DNS_CONFINEMENT_INTENT).satisfied).toBe(false);
  });
  it('rejects widening the resolver to the whole segment (leak)', () => {
    const wide = replace(ref, 'p1-ipv4-to-resolver', (r) => ({ ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, dstIp: '10.0.2.0', dstIpPrefixLen: 24 } } }));
    expect(kinds(wide, DNS_CONFINEMENT_INTENT)).toContain('leak');
  });
  it('rejects dropping the resolver rule (missing)', () => {
    expect(kinds(without(ref, 'p1-ipv4-to-resolver'), DNS_CONFINEMENT_INTENT)).toContain('missing');
  });
  it('rejects forwarding uplink traffic from any host to the workload', () => {
    const open = replace(ref, 'p2-ipv4-from-resolver', (r) => ({ ...r, flowMod: { ...r.flowMod, match: { inPort: 2, etherType: ETH_TYPE_IPV4 } } }));
    expect(kinds(open, DNS_CONFINEMENT_INTENT)).toContain('leak');
  });
});

describe('INTENT-3 quarantine-precedence/v1', () => {
  const ref = buildQuarantinePolicy();
  it('is satisfied by its reference policy', () => {
    expect(checkIntent(ref, QUARANTINE_PRECEDENCE_INTENT).satisfied).toBe(true);
    expect(triageProposal(ref, QUARANTINE_PRECEDENCE_INTENT).category).toBe('ADMISSIBLE');
  });
  it('rejects the plain isolation policy (no quarantine)', () => {
    expect(kinds(buildPort1IsolationPolicy(), QUARANTINE_PRECEDENCE_INTENT)).toContain('leak');
  });
  it('rejects a quarantine DROP that is outranked by a forwarding rule', () => {
    const low = replace(ref, 'quarantine-src', (r) => ({ ...r, flowMod: { ...r.flowMod, priority: 100 } }));
    const v = checkIntent(low, QUARANTINE_PRECEDENCE_INTENT).violations;
    expect(v.some((x) => x.kind === 'leak' && x.clauseId === 'quarantine-src')).toBe(true);
  });
  it('rejects quarantining only one direction', () => {
    expect(kinds(without(ref, 'quarantine-dst'), QUARANTINE_PRECEDENCE_INTENT)).toContain('leak');
  });
  it('rejects quarantining the wrong host', () => {
    const wrong = replace(ref, 'quarantine-src', (r) => ({ ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, srcIp: '10.0.2.52' } } }));
    expect(kinds(wrong, QUARANTINE_PRECEDENCE_INTENT)).toContain('leak');
  });
  it('names the quarantined host in the intent description', () => {
    expect(QUARANTINE_PRECEDENCE_INTENT.description).toContain(QUARANTINED_IP);
    expect(DNS_CONFINEMENT_INTENT.description).toContain(DNS_RESOLVER_IP);
  });
});

describe('INTENT-4 tap-return-isolation/v1', () => {
  const ref = buildTapReturnPolicy();
  it('is satisfied by its reference policy', () => {
    expect(checkIntent(ref, TAP_RETURN_ISOLATION_INTENT).satisfied).toBe(true);
    expect(triageProposal(ref, TAP_RETURN_ISOLATION_INTENT).category).toBe('ADMISSIBLE');
  });
  it('requires the tap copy and the return path that INTENT-1 only permits', () => {
    expect(kinds(without(ref, 'p1-default-tap-only'), TAP_RETURN_ISOLATION_INTENT)).toContain('missing');
    expect(kinds(without(ref, 'p3-tap-return'), TAP_RETURN_ISOLATION_INTENT)).toContain('missing');
    // INTENT-1 permits both losses: that is the gap the baselines README names.
    expect(checkIntent(without(ref, 'p3-tap-return'), PORT1_ISOLATION_INTENT).satisfied).toBe(true);
  });
  it('rejects a tap return that also leaks to the uplink', () => {
    const leak = replace(ref, 'p3-tap-return', (r) => ({ ...r, flowMod: { ...r.flowMod, outputPorts: [1, 2] } }));
    expect(kinds(leak, TAP_RETURN_ISOLATION_INTENT)).toContain('leak');
  });
  it('rejects a tap return that loops back to the tap (hairpin)', () => {
    const loop = replace(ref, 'p3-tap-return', (r) => ({ ...r, flowMod: { ...r.flowMod, outputPorts: [1, 3] } }));
    expect(triageProposal(loop, TAP_RETURN_ISOLATION_INTENT).categories).toEqual(expect.arrayContaining(['ERR_HAIRPIN', 'ERR_INTENT_LEAK']));
  });
  it('lets the INTENT-1 reference through INTENT-1 and INTENT-4 alike (the reference is the same six rules)', () => {
    expect(checkIntent(ref, PORT1_ISOLATION_INTENT).satisfied).toBe(true);
  });
  it('builds a reference that is rule-for-rule the six-rule isolation policy', () => {
    expect(ref.map((r) => r.id)).toEqual(buildPort1IsolationPolicy().map((r) => r.id));
    expect(rule('x', 1, [1], {}).id).toBe('x');
  });
});
