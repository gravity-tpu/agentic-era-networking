/**
 * rule-hygiene.test.ts
 * Invariant tests for A5 (shadowed rules) and A6 (equal-priority conflicts, duplicate keys).
 *
 * IMPORTANT (Invariant 6): these are structural checks over fixture rule sets. They are not measurements of
 * the physical switch, and they say nothing about how the firmware resolves ties.
 */

import { describe, it, expect } from 'vitest';
import { checkRuleHygiene, HygieneInputError } from '../../src/sdn/rule-hygiene.js';
import { IntentClassBudgetError } from '../../src/sdn/intent-spec.js';
import { FlowModCommand, type FlowModMatchOptions } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy, ETH_TYPE_ARP, ETH_TYPE_IPV4, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { planDepthCondition, type DepthCondition } from '../../src/sdn/dataplane-depth.js';

function rule(id: string, priority: number, outputPorts: readonly number[], match: FlowModMatchOptions): IsolationRule {
  return { id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match } };
}

const ipv4 = (extra: FlowModMatchOptions): FlowModMatchOptions => ({ etherType: ETH_TYPE_IPV4, ...extra });

function depthRules(cond: Partial<DepthCondition> & Pick<DepthCondition, 'depth'>): IsolationRule[] {
  const plan = planDepthCondition({
    id: 'fixture',
    match: 'host32',
    priorityOrder: 'quarantine_above',
    installOrder: 'quarantine_first',
    distinctPriorities: false,
    hit: null,
    ...cond,
  });
  return plan.flows.map((f, i) => ({
    id: `${f.kind}-${i}`,
    flowMod: {
      command: FlowModCommand.OFPFC_ADD,
      priority: f.priority,
      outputPorts: f.outputPorts,
      match: f.kind === 'forward' ? { inPort: f.inPort } : { etherType: ETH_TYPE_IPV4, srcIp: f.srcIp, srcIpPrefixLen: f.srcPrefixLen },
    },
  }));
}

describe('A5: shadowed rules', () => {
  it('passes the deployed Port 1 isolation policy', () => {
    const v = checkRuleHygiene(buildPort1IsolationPolicy());
    expect(v.violations).toEqual([]);
    expect(v.satisfied).toBe(true);
    expect(v.classesEvaluated).toBeGreaterThan(0);
  });

  it('flags a rule fully covered by one higher-priority rule, naming both', () => {
    const v = checkRuleHygiene([
      rule('high', 200, [2], { inPort: 1 }),
      rule('low-arp', 100, [3], { inPort: 1, etherType: ETH_TYPE_ARP }),
    ]);
    expect(v.satisfied).toBe(false);
    const s = v.violations.filter((x) => x.kind === 'shadowed');
    expect(s).toHaveLength(1);
    expect(s[0]?.property).toBe('A5');
    expect(s[0]?.ruleIds).toEqual(['low-arp', 'high']);
  });

  it('flags a rule covered only by several rules together (exact union coverage)', () => {
    const v = checkRuleHygiene([
      rule('lo-half', 200, [2], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 25 })),
      rule('hi-half', 200, [2], ipv4({ inPort: 1, srcIp: '10.0.0.128', srcIpPrefixLen: 25 })),
      rule('whole', 100, [3], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 24 })),
    ]);
    const s = v.violations.find((x) => x.kind === 'shadowed');
    expect(s?.ruleIds[0]).toBe('whole');
    expect(new Set(s?.ruleIds.slice(1))).toEqual(new Set(['lo-half', 'hi-half']));
  });

  it('does not flag a rule covered by two halves when one half is missing', () => {
    const v = checkRuleHygiene([
      rule('lo-half', 200, [2], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 25 })),
      rule('whole', 100, [3], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 24 })),
    ]);
    expect(v.violations.filter((x) => x.kind === 'shadowed')).toEqual([]);
  });

  it('does not flag ordinary layering (partial overlap where the lower rule still wins some packets)', () => {
    const v = checkRuleHygiene([
      rule('specific', 200, [2], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 25 })),
      rule('general', 100, [3], { inPort: 1 }),
    ]);
    expect(v.satisfied).toBe(true);
  });

  it('counts a port nobody names: a rule with no in_port is not shadowed by rules on the named ports', () => {
    const v = checkRuleHygiene(
      [
        rule('on-1', 200, [2], { inPort: 1 }),
        rule('on-2', 200, [1], { inPort: 2 }),
        rule('any-port', 100, [], ipv4({ srcIp: '198.51.100.1' })),
      ],
      { ports: [1, 2] },
    );
    expect(v.violations.filter((x) => x.kind === 'shadowed')).toEqual([]);
  });

  it('accepts every measured benchmark layout', () => {
    const layouts: Array<Partial<DepthCondition>> = [
      { priorityOrder: 'quarantine_above', installOrder: 'quarantine_first' },
      { priorityOrder: 'forward_above', installOrder: 'forward_first' },
      { priorityOrder: 'forward_above', installOrder: 'quarantine_first' },
      { priorityOrder: 'quarantine_above', installOrder: 'forward_first', distinctPriorities: true },
    ];
    for (const l of layouts) {
      const v = checkRuleHygiene(depthRules({ ...l, depth: 16 }));
      expect(v.violations, JSON.stringify(l)).toEqual([]);
    }
  });

  it('flags the dead quarantine rule when a forwarding rule on the same ingress port outranks it', () => {
    // A quarantine DROP pinned to in_port 1 under a higher-priority in_port-1 forwarding rule can never fire.
    // (A source-only quarantine rule is not fully shadowed in this layout; A4 is the property for that hazard.)
    const v = checkRuleHygiene([
      rule('fwd-p1', 65535, [2], { inPort: 1 }),
      rule('quarantine-p1-src', 1000, [], ipv4({ inPort: 1, srcIp: '10.0.2.50' })),
    ]);
    const s = v.violations.find((x) => x.kind === 'shadowed');
    expect(s?.ruleIds).toEqual(['quarantine-p1-src', 'fwd-p1']);
  });
});

describe('A6: conflicts and duplicate keys', () => {
  it('flags equal-priority overlapping rules with different outputs', () => {
    const v = checkRuleHygiene([
      rule('a', 100, [2], { inPort: 1 }),
      rule('b', 100, [3], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 24 })),
    ]);
    const c = v.violations.filter((x) => x.kind === 'conflict');
    expect(c).toHaveLength(1);
    expect(c[0]?.property).toBe('A6');
    expect(new Set(c[0]?.ruleIds)).toEqual(new Set(['a', 'b']));
    expect(c[0]?.packet?.inPort).toBe(1);
  });

  it('does not flag equal-priority overlaps whose outputs agree (any order of the same ports)', () => {
    const v = checkRuleHygiene([
      rule('a', 100, [2, 3], { inPort: 1 }),
      rule('b', 100, [3, 2], ipv4({ inPort: 1, srcIp: '10.0.0.0', srcIpPrefixLen: 24 })),
    ]);
    expect(v.satisfied).toBe(true);
  });

  it('does not flag equal-priority rules that do not overlap', () => {
    const v = checkRuleHygiene([rule('a', 100, [2], { inPort: 1 }), rule('b', 100, [3], { inPort: 2 })]);
    expect(v.satisfied).toBe(true);
  });

  it('flags identical match and priority as a duplicate key even when the outputs agree', () => {
    const v = checkRuleHygiene([
      rule('first', 100, [2], ipv4({ inPort: 1, srcIp: '10.0.0.5' })),
      rule('second', 100, [2], ipv4({ inPort: 1, srcIp: '10.0.0.5', srcIpPrefixLen: 32 })), // /32 spelled out
    ]);
    const d = v.violations.filter((x) => x.kind === 'duplicate-key');
    expect(d).toHaveLength(1);
    expect(d[0]?.ruleIds).toEqual(['first', 'second']);
    expect(d[0]?.detail).toContain('keep only the last');
  });

  it('reports a duplicate key once, not also as a conflict, when the outputs differ', () => {
    const v = checkRuleHygiene([rule('x', 100, [2], { inPort: 1 }), rule('y', 100, [3], { inPort: 1 })]);
    expect(v.violations.map((x) => x.kind)).toEqual(['duplicate-key']);
  });

  it('treats MAC case differences as the same match', () => {
    const v = checkRuleHygiene([
      rule('m1', 100, [2], { srcMac: 'AA:BB:CC:DD:EE:FF' }),
      rule('m2', 100, [2], { srcMac: 'aa:bb:cc:dd:ee:ff' }),
    ]);
    expect(v.violations.map((x) => x.kind)).toEqual(['duplicate-key']);
  });
});

describe('input handling', () => {
  it('reports an IPv4 match without the eth_type prerequisite and does not pass', () => {
    const v = checkRuleHygiene([rule('bad', 100, [2], { inPort: 1, srcIp: '10.0.0.1' })]);
    expect(v.satisfied).toBe(false);
    expect(v.violations[0]).toMatchObject({ property: 'prerequisite', kind: 'invalid-rule', ruleIds: ['bad'] });
  });

  it('rejects duplicate rule ids instead of merging them', () => {
    expect(() => checkRuleHygiene([rule('same', 100, [2], { inPort: 1 }), rule('same', 200, [3], { inPort: 2 })])).toThrow(
      HygieneInputError,
    );
  });

  it('throws when the packet-class budget would be exceeded rather than returning a partial verdict', () => {
    expect(() => checkRuleHygiene(depthRules({ depth: 60 }), { maxPacketClasses: 10 })).toThrow(IntentClassBudgetError);
  });

  it('passes an empty rule set (everything falls to table-miss) with nothing to flag', () => {
    expect(checkRuleHygiene([]).satisfied).toBe(true);
  });
});
