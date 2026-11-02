/**
 * deployed-allow-floor.test.ts
 * The A8 claim for the deployed table with allow rules: the live policy, then 1 to 8 allow rules of exactly the measured form (in_port 3 and a
 * source MAC, output P1, priority 120), then quarantine DROPs. It rests on a FLOOR over measurements, not a per-rule cost: the 2026-11-01 runs
 * could not resolve a per-count step above their run-to-run spread (docs/benchmarks/results/layout-capacity/run-2026-11-01-allow-sweep/README.md).
 * The artifact test re-reads those runs and fails if the floor is not the lowest capacity they measured.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALLOW_FLOOR_DEPTH,
  ALLOW_FLOOR_PPS,
  ALLOW_FORM_MAX_RULES,
  ALLOW_FORM_PRIORITY,
  MEASURED_UPLINK_ARP_PEERS,
  classifyDeployedAllowShape,
  classifyDeployedShape,
  meetsAllowFloorTarget,
} from '../../src/sdn/deployed-cost-model.js';
import { checkCapacityBudget } from '../../src/sdn/capacity-budget.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

const policy = (): IsolationRule[] => buildPort1IsolationPolicy(undefined, undefined, undefined, MEASURED_UPLINK_ARP_PEERS);
const mac = (n: number): string => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`;
const allow = (n: number, over: Partial<{ priority: number; outputPorts: number[]; match: Record<string, unknown>; command: FlowModCommand }> = {}): IsolationRule => ({
  id: `allow-${n}`,
  flowMod: {
    command: over.command ?? FlowModCommand.OFPFC_ADD,
    priority: over.priority ?? ALLOW_FORM_PRIORITY,
    outputPorts: over.outputPorts ?? [1],
    match: (over.match ?? { inPort: 3, srcMac: mac(n) }) as IsolationRule['flowMod']['match'],
  },
});
const drop = (n: number): IsolationRule => ({
  id: `quarantine-${n}`,
  flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 65535, outputPorts: [], match: { etherType: 0x0800, srcIp: `10.0.2.${100 + n}`, srcIpPrefixLen: 32 } },
});
const table = (j: number, q = 0): IsolationRule[] => [...policy(), ...Array.from({ length: j }, (_, i) => allow(i + 1)), ...Array.from({ length: q }, (_, i) => drop(i + 1))];

describe('classifyDeployedAllowShape', () => {
  it('models the live policy followed by 1 to 8 allow rules of the measured form, with or without quarantine DROPs after them', () => {
    for (let j = 1; j <= Number(ALLOW_FORM_MAX_RULES); j++) {
      const r = classifyDeployedAllowShape(table(j));
      expect(r.modelled, `j=${j}`).toBe(true);
    }
    const mixed = classifyDeployedAllowShape(table(3, 2));
    expect(mixed).toMatchObject({ modelled: true, allowRuleIds: ['allow-1', 'allow-2', 'allow-3'], quarantineRuleIds: ['quarantine-1', 'quarantine-2'] });
  });

  it('does not model no allow rules (that is the quarantine model\'s table), nor more than the measured maximum', () => {
    expect(classifyDeployedAllowShape(table(0)).modelled).toBe(false);
    expect(classifyDeployedAllowShape(table(Number(ALLOW_FORM_MAX_RULES) + 1)).modelled).toBe(false);
  });

  it('does not model another priority, output, match form or command, however close', () => {
    const bad: Array<[string, IsolationRule]> = [
      ['priority above (300)', allow(1, { priority: 300 })],
      ['priority one below', allow(1, { priority: ALLOW_FORM_PRIORITY - 1 })],
      ['priority one above', allow(1, { priority: ALLOW_FORM_PRIORITY + 1 })],
      ['output P3', allow(1, { outputPorts: [3] })],
      ['two outputs', allow(1, { outputPorts: [1, 2] })],
      ['no output (a DROP)', allow(1, { outputPorts: [] })],
      ['in_port 2', allow(1, { match: { inPort: 2, srcMac: mac(1) } })],
      ['in_port only', allow(1, { match: { inPort: 3 } })],
      ['an extra match field', allow(1, { match: { inPort: 3, srcMac: mac(1), etherType: 0x0800 } })],
      ['a destination MAC as well', allow(1, { match: { inPort: 3, srcMac: mac(1), dstMac: mac(2) } })],
      ['a delete', allow(1, { command: FlowModCommand.OFPFC_DELETE })],
    ];
    for (const [what, rule] of bad) {
      const r = classifyDeployedAllowShape([...policy(), rule]);
      expect(r.modelled, what).toBe(false);
    }
  });

  it('does not model one bad rule among good ones', () => {
    const t = [...policy(), allow(1), allow(2, { priority: 300 }), allow(3)];
    expect(classifyDeployedAllowShape(t).modelled).toBe(false);
  });

  it('does not model an allow rule installed AFTER a quarantine DROP (a different install order, not measured), nor a changed policy', () => {
    expect(classifyDeployedAllowShape([...policy(), drop(1), allow(1)]).modelled).toBe(false);
    const changed = policy();
    changed[0] = { ...changed[0]!, id: 'something-else' };
    expect(classifyDeployedAllowShape([...changed, allow(1)]).modelled).toBe(false);
  });

  it('does not model two allow rules with the same id or the same source MAC (the second would never win, and it was never measured)', () => {
    expect(classifyDeployedAllowShape([...policy(), allow(1), { ...allow(2), id: 'allow-1' }]).modelled).toBe(false);
    expect(classifyDeployedAllowShape([...policy(), allow(1), allow(2, { match: { inPort: 3, srcMac: mac(1) } })]).modelled).toBe(false);
  });

  it('leaves the quarantine-only classifier as it was: a table with an allow rule is not that shape', () => {
    expect(classifyDeployedShape(table(1)).modelled).toBe(false);
  });
});

describe('the allow-rule floor', () => {
  it('meets a target the floor clears after the model tolerance, and fails closed on one inside the margin', () => {
    expect(meetsAllowFloorTarget(6000n)).toBe(true);
    expect(meetsAllowFloorTarget(7609n)).toBe(true); // 7765 pps less 2% is 7609.7, floored to 7609 pps
    expect(meetsAllowFloorTarget(7610n)).toBe(false);
  });

  it('is exact about the margin: the floor less the tolerance, rounded down, is the highest target that passes', () => {
    const discounted = (ALLOW_FLOOR_PPS * 980_000n) / 1_000_000n;
    expect(meetsAllowFloorTarget(discounted)).toBe(true);
    expect(meetsAllowFloorTarget(discounted + 1n)).toBe(false);
  });
});

describe('checkCapacityBudget with allow rules', () => {
  const spec = (targetPps: bigint, reserve: number, payloadBytes = 572n) => ({ payloadBytes, targetPps, quarantineReserve: reserve });

  it('passes the 6,000 pps target for the allow form at the measured depth (quarantines present plus reserve = 8)', () => {
    for (const [j, q] of [[1, 0], [8, 0], [4, 3]] as const) {
      const v = checkCapacityBudget(table(j, q), spec(6000n, Number(ALLOW_FLOOR_DEPTH) - q));
      expect(v.status, `j=${j} q=${q}`).toBe('pass');
      if (v.status === 'pass') {
        expect(v.decidingLayout).toBe('deployed_allow');
        expect(v.modelledPps).toBe(ALLOW_FLOOR_PPS);
      }
    }
  });

  it('can fail: a target above the floor is refused with the floor in the message', () => {
    const v = checkCapacityBudget(table(2), spec(7700n, Number(ALLOW_FLOOR_DEPTH)));
    expect(v.status).toBe('fail');
    if (v.status === 'fail') expect(JSON.stringify(v.violations)).toContain(String(ALLOW_FLOOR_PPS));
  });

  it('is unverifiable at any other depth or payload: the floor was measured with 8 quarantines at 572 B only', () => {
    for (const depth of [0, 1, 7, 9]) {
      const v = checkCapacityBudget(table(2), spec(6000n, depth));
      expect(v.status, `depth ${depth}`).toBe('unverifiable');
    }
    expect(checkCapacityBudget(table(2), spec(6000n, Number(ALLOW_FLOOR_DEPTH), 1500n)).status).toBe('unverifiable');
  });

  it('is unverifiable for an allow table outside the measured form', () => {
    const t = [...policy(), allow(1, { priority: 300 })];
    expect(checkCapacityBudget(t, spec(6000n, Number(ALLOW_FLOOR_DEPTH))).status).toBe('unverifiable');
  });
});

interface Row { k: number; quarantines?: number; capacityPps: number | null }
const read = (p: string): Row[] => JSON.parse(readFileSync(`docs/benchmarks/results/layout-capacity/${p}`, 'utf-8')) as Row[];

describe('the floor against the stored 2026-11-01 runs', () => {
  const mix = read('run-2026-11-01-allow-quarantine-mix/below/run/results.json');
  const sweep = read('run-2026-11-01-allow-sweep/sweep/run/results.json');
  // Every measurement of 1 to 8 allow rules below the measured rule with 8 quarantines.
  const withAllow = [...mix, ...sweep].filter((r) => r.k >= 1 && r.k <= 8 && r.quarantines === 8);

  it('covers the counts it claims: ten measurements (counts 4 and 8 in the mix run, 1 to 8 in the sweep), counts 1 to 8', () => {
    expect(withAllow).toHaveLength(10);
    expect([...new Set(withAllow.map((r) => r.k))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(withAllow.every((r) => r.capacityPps !== null)).toBe(true);
  });

  it('the floor is the lowest capacity any of them measured, not a number chosen to pass', () => {
    const lowest = BigInt(Math.min(...withAllow.map((r) => r.capacityPps as number)));
    expect(ALLOW_FLOOR_PPS).toBe(lowest);
  });

  it('can fail: a floor one packet per second higher than the lowest measurement would not hold for every run', () => {
    expect(withAllow.every((r) => BigInt(r.capacityPps as number) >= ALLOW_FLOOR_PPS + 1n)).toBe(false);
  });
});
