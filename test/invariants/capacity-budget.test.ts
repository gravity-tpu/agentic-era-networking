/**
 * capacity-budget.test.ts
 * Invariant tests for A7 (rule budget) and A8 (capacity budget).
 *
 * IMPORTANT (Invariant 6): the packet rates below come from the cost model, which is fitted to stored physical
 * artifacts; the rule sets are structural fixtures. Nothing here is a new measurement of the switch.
 */

import { describe, it, expect } from 'vitest';
import {
  BudgetInputError,
  DEFAULT_QUARANTINE_RESERVE,
  TABLE_MISS_ENTRIES,
  checkCapacityBudget,
  checkRuleBudget,
  classifyForCostModel,
} from '../../src/sdn/capacity-budget.js';
import { FLOW_TABLE_CAPACITY } from '../../src/sdn/dataplane-benchmark.js';
import {
  planDepthCondition,
  type DepthCondition,
  type DepthFlow,
} from '../../src/sdn/dataplane-depth.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { capacityPps } from '../../src/sdn/zodiac-cost-model.js';

/** Turns the benchmark's own measured plan into the verifier's rule type (match fields as the harness sends them). */
function rulesFromDepthPlan(cond: Partial<DepthCondition> & Pick<DepthCondition, 'depth'>): IsolationRule[] {
  const plan = planDepthCondition({
    id: 'fixture',
    match: 'host32',
    priorityOrder: 'quarantine_above',
    installOrder: 'quarantine_first',
    distinctPriorities: false,
    hit: null,
    ...cond,
  });
  return plan.flows.map((f: DepthFlow, i: number) => ({
    id: `${f.kind}-${i}`,
    flowMod: {
      command: FlowModCommand.OFPFC_ADD,
      priority: f.priority,
      outputPorts: f.outputPorts,
      match:
        f.kind === 'forward' ? { inPort: f.inPort } : { srcIp: f.srcIp, srcIpPrefixLen: f.srcPrefixLen },
    },
  }));
}

function dummyRules(n: number, priorityOf: (i: number) => number = () => 100): IsolationRule[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: priorityOf(i), outputPorts: [2], match: { inPort: 1 } },
  }));
}

describe('A7: rule budget', () => {
  it('passes the deployed isolation policy with the default quarantine reserve', () => {
    const rules = buildPort1IsolationPolicy();
    const v = checkRuleBudget(rules);
    expect(v.satisfied).toBe(true);
    expect(v.policyRules).toBe(rules.length);
    expect(v.tableMissEntries).toBe(TABLE_MISS_ENTRIES);
    expect(v.quarantineReserve).toBe(DEFAULT_QUARANTINE_RESERVE);
    expect(v.headroom).toBe(FLOW_TABLE_CAPACITY - TABLE_MISS_ENTRIES - DEFAULT_QUARANTINE_RESERVE - rules.length);
    expect(v.violations).toEqual([]);
  });

  it('accepts exactly the largest policy that leaves the reserve, and rejects one more', () => {
    const reserve = 10;
    const fits = FLOW_TABLE_CAPACITY - TABLE_MISS_ENTRIES - reserve;
    expect(checkRuleBudget(dummyRules(fits), { quarantineReserve: reserve }).satisfied).toBe(true);
    const over = checkRuleBudget(dummyRules(fits + 1), { quarantineReserve: reserve });
    expect(over.satisfied).toBe(false);
    expect(over.headroom).toBe(-1);
    expect(over.violations).toHaveLength(1);
    expect(over.violations[0]?.property).toBe('A7');
    expect(over.violations[0]?.detail).toContain('over the 128-entry table by 1');
  });

  it('names the lowest-priority rules as the ones that do not fit', () => {
    const reserve = 10;
    const fits = FLOW_TABLE_CAPACITY - TABLE_MISS_ENTRIES - reserve;
    // priority descends with index, so the last rules are the lowest priority
    const rules = dummyRules(fits + 3, (i) => 1000 - i);
    const v = checkRuleBudget(rules, { quarantineReserve: reserve });
    expect(v.violations[0]?.ruleIds).toEqual([`r${fits}`, `r${fits + 1}`, `r${fits + 2}`]);
  });

  it('rejects a reserve that alone exceeds the table, naming every rule', () => {
    const v = checkRuleBudget(dummyRules(3), { quarantineReserve: FLOW_TABLE_CAPACITY });
    expect(v.satisfied).toBe(false);
    expect(v.violations[0]?.ruleIds).toEqual(['r0', 'r1', 'r2']);
  });

  it('rejects invalid inputs instead of guessing', () => {
    const rules = dummyRules(1);
    expect(() => checkRuleBudget(rules, { quarantineReserve: -1 })).toThrow(BudgetInputError);
    expect(() => checkRuleBudget(rules, { quarantineReserve: 1.5 })).toThrow(BudgetInputError);
    expect(() => checkRuleBudget(rules, { quarantineReserve: FLOW_TABLE_CAPACITY + 1 })).toThrow(BudgetInputError);
    expect(() => checkRuleBudget(rules, { capacity: FLOW_TABLE_CAPACITY + 1 })).toThrow(BudgetInputError);
    expect(() => checkRuleBudget(rules, { capacity: 0 })).toThrow(BudgetInputError);
  });
});

describe('A8: shape classification against the benchmark layouts', () => {
  const base = { match: 'host32', priorityOrder: 'quarantine_above', installOrder: 'quarantine_first' } as const;

  it('recognises the measured base layout (with and without distinct priorities)', () => {
    for (const distinctPriorities of [false, true]) {
      const r = classifyForCostModel(rulesFromDepthPlan({ ...base, depth: 16, distinctPriorities }));
      expect(r.modelled).toBe(true);
      if (r.modelled) {
        expect(r.shape.layout).toBe('base');
        expect(r.shape.quarantineRuleIds).toHaveLength(16);
      }
    }
  });

  it('recognises the measured forwarding-first layout', () => {
    const r = classifyForCostModel(
      rulesFromDepthPlan({ match: 'host32', priorityOrder: 'forward_above', installOrder: 'forward_first', depth: 16 }),
    );
    expect(r.modelled && r.shape.layout).toBe('forward_first');
  });

  it('does not accept layouts that were measured but are not modelled', () => {
    const cases: Array<[string, Partial<DepthCondition>]> = [
      ['fwdabove (forwarding outranks, installed last)', { match: 'host32', priorityOrder: 'forward_above', installOrder: 'quarantine_first' }],
      ['fwdinstall (forwarding installed first, outranked)', { match: 'host32', priorityOrder: 'quarantine_above', installOrder: 'forward_first' }],
      ['net16 (/16 DROP rules, 2 to 3% off the model)', { match: 'net16', priorityOrder: 'quarantine_above', installOrder: 'quarantine_first' }],
    ];
    for (const [label, cond] of cases) {
      const r = classifyForCostModel(rulesFromDepthPlan({ ...cond, depth: 16 }));
      expect(r.modelled, label).toBe(false);
    }
  });

  it('accepts a depth of zero (two forwarding rules only)', () => {
    const r = classifyForCostModel(rulesFromDepthPlan({ ...base, depth: 0 }));
    expect(r.modelled && r.shape.quarantineRuleIds).toEqual([]);
  });

  it('does not model rules carrying any match field beyond the measured ones', () => {
    const rules = rulesFromDepthPlan({ ...base, depth: 4 });
    const withExtra = (index: number, extra: Record<string, number | string>): IsolationRule[] =>
      rules.map((r, i) => (i === index ? { ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, ...extra } } } : r));
    expect(classifyForCostModel(withExtra(0, { dstIp: '10.0.2.1' })).modelled).toBe(false); // a DROP with a dst match
    expect(classifyForCostModel(withExtra(0, { etherType: 0x0800 })).modelled).toBe(false);
    expect(classifyForCostModel(withExtra(rules.length - 1, { etherType: 0x0800 })).modelled).toBe(false); // a forward rule
    expect(classifyForCostModel(withExtra(rules.length - 1, { srcMac: '02:00:00:00:00:01' })).modelled).toBe(false);
  });

  it('does not model the deployed Port 1 isolation policy', () => {
    const r = classifyForCostModel(buildPort1IsolationPolicy());
    expect(r.modelled).toBe(false);
    if (!r.modelled) expect(r.reason).toContain('matches more than in_port');
  });

  it('does not model a policy with one forwarding rule, or forwarding rules to extra ports', () => {
    const rules = rulesFromDepthPlan({ ...base, depth: 4 });
    const oneForward = rules.filter((r, i) => !(i === rules.length - 1));
    expect(classifyForCostModel(oneForward).modelled).toBe(false);
    const mirrored = rules.map((r, i) =>
      i === rules.length - 2 ? { ...r, flowMod: { ...r.flowMod, outputPorts: [2, 3] } } : r,
    );
    expect(classifyForCostModel(mirrored).modelled).toBe(false);
  });
});

describe('A8: capacity budget', () => {
  const base16 = rulesFromDepthPlan({
    match: 'host32',
    priorityOrder: 'quarantine_above',
    installOrder: 'quarantine_first',
    depth: 16,
  });

  it('passes a target well under modelled capacity at the full reserved depth', () => {
    const modelled = capacityPps('base', 572n, BigInt(16 + 24));
    const v = checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: modelled / 2n, quarantineReserve: 24 });
    expect(v.status).toBe('pass');
    if (v.status !== 'unverifiable') {
      expect(v.quarantineDepth).toBe(40);
      expect(v.modelledPps).toBe(modelled);
      expect(v.violations).toEqual([]);
    }
  });

  it('fails a target the model cannot meet, naming the quarantine rules that drive the cost', () => {
    const modelled = capacityPps('base', 572n, 40n);
    const v = checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: modelled, quarantineReserve: 24 });
    expect(v.status).toBe('fail'); // a target equal to modelled capacity sits inside the tolerance band
    if (v.status === 'fail') {
      expect(v.violations[0]?.property).toBe('A8');
      expect(v.violations[0]?.ruleIds).toHaveLength(16);
      expect(v.violations[0]?.detail).toContain('does not meet');
    }
  });

  it('evaluates at the full depth, so a bigger reserve lowers capacity and can flip a pass to a fail', () => {
    const target = capacityPps('base', 572n, 40n) / 2n;
    expect(checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: target, quarantineReserve: 24 }).status).toBe('pass');
    expect(checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: target, quarantineReserve: 110 }).status).toBe('fail');
  });

  it('uses the forward-first layout where the rules are laid out that way, and it carries more', () => {
    const fwd = rulesFromDepthPlan({ match: 'host32', priorityOrder: 'forward_above', installOrder: 'forward_first', depth: 16 });
    const target = capacityPps('base', 572n, 40n); // too high for base once the tolerance is taken off
    expect(checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: target, quarantineReserve: 24 }).status).toBe('fail');
    expect(checkCapacityBudget(fwd, { payloadBytes: 572n, targetPps: target, quarantineReserve: 24 }).status).toBe('pass');
  });

  it('with no DROP rules yet, requires the target at the lowest modelled layout (forward_first is lower at depth 0)', () => {
    const none = rulesFromDepthPlan({ match: 'host32', priorityOrder: 'quarantine_above', installOrder: 'quarantine_first', depth: 0 });
    const lowest = capacityPps('forward_first', 572n, 0n);
    expect(lowest).toBeLessThan(capacityPps('base', 572n, 0n));
    const v = checkCapacityBudget(none, { payloadBytes: 572n, targetPps: lowest / 2n, quarantineReserve: 0 });
    expect(v.status).toBe('pass');
    if (v.status !== 'unverifiable') {
      expect(v.layout).toBe('forward_first');
      expect(v.modelledPps).toBe(lowest);
    }
    // a target that base could meet but forward_first could not must fail
    const baseOnly = capacityPps('base', 572n, 0n);
    expect(checkCapacityBudget(none, { payloadBytes: 572n, targetPps: baseOnly - baseOnly / 100n, quarantineReserve: 0 }).status).toBe('fail');
  });

  it('with no DROP rules, outside the forward_first payload the base layout alone decides, and outside both it is unverifiable', () => {
    const none = rulesFromDepthPlan({ match: 'host32', priorityOrder: 'quarantine_above', installOrder: 'quarantine_first', depth: 0 });
    const v = checkCapacityBudget(none, { payloadBytes: 64n, targetPps: 1n, quarantineReserve: 0 });
    expect(v.status).toBe('pass');
    if (v.status !== 'unverifiable') expect(v.layout).toBe('base');
    expect(checkCapacityBudget(none, { payloadBytes: 2000n, targetPps: 1n, quarantineReserve: 0 }).status).toBe('unverifiable');
  });

  it('uses the same reserve as A7: A7 total entries = A8 quarantine depth + 2 forwarding + 1 table-miss', () => {
    const reserve = 24;
    const a7 = checkRuleBudget(base16, { quarantineReserve: reserve });
    const a8 = checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: 1n, quarantineReserve: reserve });
    expect(a8.status).toBe('pass');
    if (a8.status !== 'unverifiable') {
      expect(a7.policyRules + a7.tableMissEntries + a7.quarantineReserve).toBe(a8.quarantineDepth + 2 + TABLE_MISS_ENTRIES);
    }
  });

  it('pins the default quarantine reserve to the measured typical working-window depth', () => {
    expect(DEFAULT_QUARANTINE_RESERVE).toBe(24);
  });

  it('is unverifiable, never a pass, for the deployed isolation policy', () => {
    for (const target of [0n, 1n, 1_000_000n]) {
      const v = checkCapacityBudget(buildPort1IsolationPolicy(), { payloadBytes: 572n, targetPps: target });
      expect(v.status).toBe('unverifiable');
    }
  });

  it('is unverifiable outside the measured payload range, and for forward_first off 572 B', () => {
    expect(checkCapacityBudget(base16, { payloadBytes: 2000n, targetPps: 1n }).status).toBe('unverifiable');
    expect(checkCapacityBudget(base16, { payloadBytes: 63n, targetPps: 1n }).status).toBe('unverifiable');
    const fwd = rulesFromDepthPlan({ match: 'host32', priorityOrder: 'forward_above', installOrder: 'forward_first', depth: 16 });
    expect(checkCapacityBudget(fwd, { payloadBytes: 64n, targetPps: 1n }).status).toBe('unverifiable');
  });

  it('is unverifiable when the full depth exceeds the table the model covers', () => {
    const v = checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: 1n, quarantineReserve: 120 });
    expect(v.status).toBe('unverifiable');
  });

  it('rejects invalid inputs instead of guessing', () => {
    expect(() => checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: -1n })).toThrow(BudgetInputError);
    expect(() => checkCapacityBudget(base16, { payloadBytes: 572n, targetPps: 1n, quarantineReserve: -1 })).toThrow(BudgetInputError);
  });
});
