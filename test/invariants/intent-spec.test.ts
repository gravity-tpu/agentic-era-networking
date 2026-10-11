/**
 * intent-spec.test.ts
 * Tests for the intent-compliance check (roadmap A11): does a rule set do what the stated
 * intent asked, over every packet class the rules and the intent can distinguish?
 *
 * IMPORTANT (Invariant 6): these tests exercise the abstract evaluator only. They say nothing
 * about how the Zodiac FX firmware behaves; that is the job of the conformance probe (track B).
 */

import { describe, it, expect } from 'vitest';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import type { FlowModOptions } from '../../src/sdn/openflow-types.js';
import {
  buildPort1IsolationPolicy,
  ETH_TYPE_ARP,
  ETH_TYPE_IPV4,
  ZODIAC_PORT_TAP,
  ZODIAC_PORT_UPLINK,
  ZODIAC_PORT_WORKLOAD,
} from '../../src/sdn/port1-isolation.js';
import type { IsolationRule } from '../../src/sdn/port1-isolation.js';
import {
  checkIntent,
  enumeratePacketClasses,
  IntentClassBudgetError,
  type IntentSpec,
} from '../../src/sdn/intent-spec.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';

const rule = (
  id: string,
  priority: number,
  outputPorts: readonly number[],
  match?: FlowModOptions['match'],
): IsolationRule => ({
  id,
  flowMod: {
    command: FlowModCommand.OFPFC_ADD,
    priority,
    outputPorts,
    ...(match !== undefined ? { match } : {}),
  },
});

describe('A11 intent compliance: positive cases', () => {
  it('the shipped port-1 isolation policy satisfies the port-1 isolation intent', () => {
    const verdict = checkIntent(buildPort1IsolationPolicy(), PORT1_ISOLATION_INTENT);
    expect(verdict.violations).toEqual([]);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.classesEvaluated).toBeGreaterThan(0);
  });

  it('an empty rule set satisfies a deny-everything intent (table-miss drops)', () => {
    const denyAll: IntentSpec = { id: 'deny-all', description: 'nothing crosses', ports: [1, 2, 3], clauses: [] };
    expect(checkIntent([], denyAll).satisfied).toBe(true);
  });
});

describe('A11 intent compliance: negative cases (the check must be able to fail)', () => {
  it('reports a leak when the workload catch-all forwards to the uplink', () => {
    const leaky = buildPort1IsolationPolicy().map((r) =>
      r.id === 'p1-default-tap-only'
        ? rule(r.id, r.flowMod.priority, [ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP], r.flowMod.match)
        : r,
    );
    const verdict = checkIntent(leaky, PORT1_ISOLATION_INTENT);
    expect(verdict.satisfied).toBe(false);
    const leak = verdict.violations.find((v) => v.kind === 'leak');
    expect(leak).toBeDefined();
    if (!leak) return;
    expect(leak.ruleIds).toContain('p1-default-tap-only');
    expect(leak.ports).toContain(ZODIAC_PORT_UPLINK);
    expect(leak.packet?.inPort).toBe(ZODIAC_PORT_WORKLOAD);
  });

  it('reports a missing delivery when the uplink-to-segment rule is removed', () => {
    const broken = buildPort1IsolationPolicy().filter((r) => r.id !== 'p2-ipv4-to-segment');
    const verdict = checkIntent(broken, PORT1_ISOLATION_INTENT);
    expect(verdict.satisfied).toBe(false);
    const missing = verdict.violations.find((v) => v.kind === 'missing');
    expect(missing).toBeDefined();
    if (!missing) return;
    expect(missing.packet?.inPort).toBe(ZODIAC_PORT_UPLINK);
    expect(missing.packet?.etherType).toBe(ETH_TYPE_IPV4);
    expect(missing.ports).toContain(ZODIAC_PORT_WORKLOAD);
  });

  it('reports a leak when an allow is widened from /24 to /16 (verifier-accepted shape, wrong intent)', () => {
    const widened = buildPort1IsolationPolicy().map((r) =>
      r.id === 'p2-ipv4-to-segment'
        ? rule(r.id, r.flowMod.priority, [ZODIAC_PORT_WORKLOAD], { ...r.flowMod.match, dstIp: '10.0.0.0', dstIpPrefixLen: 16 })
        : r,
    );
    const verdict = checkIntent(widened, PORT1_ISOLATION_INTENT);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'leak' && v.ruleIds.includes('p2-ipv4-to-segment'))).toBe(true);
  });

  it('reports ambiguity when two equal-priority rules overlap with different outputs', () => {
    const rules = [
      rule('a', 100, [2], { inPort: 1, etherType: ETH_TYPE_IPV4 }),
      rule('b', 100, [3], { inPort: 1, etherType: ETH_TYPE_IPV4, srcIp: '10.0.2.0', srcIpPrefixLen: 24 }),
    ];
    const anyIntent: IntentSpec = {
      id: 'permissive',
      description: 'anything may go anywhere',
      ports: [1, 2, 3],
      clauses: [{ id: 'all', match: {}, mustReach: [], mayReach: [1, 2, 3] }],
    };
    const verdict = checkIntent(rules, anyIntent);
    expect(verdict.satisfied).toBe(false);
    const amb = verdict.violations.find((v) => v.kind === 'ambiguous');
    expect(amb).toBeDefined();
    if (!amb) return;
    expect([...amb.ruleIds].sort()).toEqual(['a', 'b']);
  });

  it('reports an IPv4 match without the eth_type prerequisite as an invalid rule', () => {
    const denyAll: IntentSpec = { id: 'deny-all', description: 'nothing crosses', ports: [1, 2, 3], clauses: [] };
    const verdict = checkIntent([rule('no-ethtype', 10, [3], { inPort: 1, srcIp: '10.0.2.0', srcIpPrefixLen: 24 })], denyAll);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'invalid-rule' && v.ruleIds[0] === 'no-ethtype')).toBe(true);
  });

  it('rejects a malformed intent where mustReach is not a subset of mayReach', () => {
    const bad: IntentSpec = {
      id: 'bad', description: 'contradictory', ports: [1, 2],
      clauses: [{ id: 'c', match: {}, mustReach: [2], mayReach: [] }],
    };
    expect(() => checkIntent([], bad)).toThrow(/mustReach/);
  });

  it('a deny-everything intent rejects any forwarding rule', () => {
    const denyAll: IntentSpec = { id: 'deny-all', description: 'nothing crosses', ports: [1, 2, 3], clauses: [] };
    const verdict = checkIntent([rule('x', 10, [2], { inPort: 1 })], denyAll);
    expect(verdict.satisfied).toBe(false);
    const v0 = verdict.violations[0];
    expect(v0).toBeDefined();
    if (!v0) return;
    expect(v0.kind).toBe('leak');
    expect(v0.clauseId).toBe('default-deny');
  });
});

describe('packet-class enumeration', () => {
  it('distinguishes inside and outside every prefix boundary', () => {
    const classes = enumeratePacketClasses(
      [{ inPort: 1, etherType: ETH_TYPE_IPV4, srcIp: '10.0.2.0', srcIpPrefixLen: 24 }],
      [1, 2],
    );
    const ipv4From1 = classes.filter((c) => c.inPort === 1 && c.etherType === ETH_TYPE_IPV4);
    const srcs = new Set(ipv4From1.map((c) => c.srcIp));
    expect(srcs.has('10.0.2.0')).toBe(true); // inside
    expect(srcs.has('0.0.0.0')).toBe(true); // below
    expect(srcs.has('10.0.3.0')).toBe(true); // above
  });

  it('gives non-IPv4 classes no IP fields (OpenFlow 1.3 prerequisites)', () => {
    const classes = enumeratePacketClasses([{ inPort: 1, etherType: ETH_TYPE_ARP }, { srcIp: '10.0.2.0' }], [1]);
    for (const c of classes.filter((x) => x.etherType !== ETH_TYPE_IPV4)) {
      expect(c.srcIp).toBeUndefined();
      expect(c.dstIp).toBeUndefined();
    }
  });

  it('fails closed when the class count exceeds the configured budget (Invariant 5)', () => {
    expect(() =>
      checkIntent(buildPort1IsolationPolicy(), PORT1_ISOLATION_INTENT, { maxPacketClasses: 2 }),
    ).toThrow(IntentClassBudgetError);
  });

  it('rejects a malformed prefix instead of guessing (Invariant 3)', () => {
    expect(() => enumeratePacketClasses([{ srcIp: '10.0.2.0', srcIpPrefixLen: 33 }], [1])).toThrow();
    expect(() => enumeratePacketClasses([{ srcIp: '10.0.2' }], [1])).toThrow();
  });
});
