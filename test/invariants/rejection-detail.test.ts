/**
 * test/invariants/rejection-detail.test.ts
 * Track A exit criterion: "every rejection returns the violated property and the offending rules". For every rule set that the install gate refuses
 * (the references' mutants, which include many refused ones, and deliberately broken tables), each violation must name its property, give a reason, and
 * name the rules involved unless it is a table-wide property that has no single offending rule (A7 budget, A8 capacity, a check that could not run).
 * A check that rejects without saying what it rejected is not verification.
 */
import { describe, it, expect } from 'vitest';
import { admitInstall, type GateProperty, type GateViolation } from '../../src/sdn/install-gate.js';
import { generateMutants } from '../../src/sdn/rule-mutations.js';
import { BASELINE_TARGETS } from '../../src/sdn/eval-baselines.js';
import { ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

const KNOWN: readonly GateProperty[] = ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A11', 'prerequisite', 'unmodelled', 'uncheckable'];
/** Properties about the table as a whole: they may legitimately name no single rule. */
const TABLE_WIDE: readonly GateProperty[] = ['A7', 'A8', 'uncheckable'];
/** The gate's wording for an A11 violation that has no rule to blame (src/sdn/install-gate.ts: `${v.kind} in ${v.clauseId}: ${v.detail}`, detail ending 'fell to table-miss'). Keep in step with that template. */
const A11_NO_RULE_DETAIL = /^missing in [A-Za-z0-9._-]+: .*table-miss/;
/** Tripwires measured on 2026-10-31: the mutants of the four original references and how many of them the gate refuses. A change must be made on purpose. */
/** 46 + 42 + 62 + 46 mutants of the references of port1-isolation, dns-confinement, quarantine-precedence and tap-return-isolation, from generateMutants. */
const EXPECTED_MUTANTS = 196;
/** Of those, the gate refuses 151 (A11 147, A5 20, A2 23, A6 19, prerequisite 10, A4 3; a mutant can trip several). generateMutants is deterministic: ids come from the operator and the rule. */
const EXPECTED_REFUSED = 151;
const EXPECTED_PROPERTIES: readonly GateProperty[] = ['A2', 'A4', 'A5', 'A6', 'A11', 'prerequisite'];
const rule = (id: string, priority: number, outputPorts: number[], match: Record<string, unknown>): IsolationRule => ({ id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match } });

/** Pure: what is wrong with a violation's detail, as a list of problems (empty when it is fine). */
function detailProblems(v: GateViolation): string[] {
  const problems: string[] = [];
  if (!KNOWN.includes(v.property)) problems.push(`unknown property ${v.property}`);
  if (typeof v.detail !== 'string' || v.detail.trim().length === 0) problems.push(`empty detail for ${v.property}`);
  if (v.ruleIds.some((id) => id.length === 0)) problems.push(`${v.property} names an empty rule id`);
  if (v.ruleIds.length === 0 && !TABLE_WIDE.includes(v.property)) {
    // No rule to blame: the cause is a rule that is missing (an intent clause whose packets fall to the table-miss). The violation must then name the clause and why.
    if (v.property !== 'A11') problems.push(`${v.property} names no offending rule: ${v.detail}`);
    else if (!A11_NO_RULE_DETAIL.test(v.detail)) problems.push(`an A11 violation with no rule must name the clause: ${v.detail}`);
  }
  return problems;
}
const checkDetail = (v: GateViolation): void => { expect(detailProblems(v)).toEqual([]); };

describe('every refusal names the property, the reason and the offending rules', () => {
  for (const { intent, reference } of BASELINE_TARGETS) {
    const ref = reference();
    const mutants = generateMutants(ref, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]);
    it(`${intent.id}: the ${mutants.length} mutants of the reference`, () => {
      for (const m of mutants) {
        const r = admitInstall({ current: [], proposed: m.rules, intent });
        if (r.admitted) continue;
        expect(r.violations.length, `${m.id} refused with no violation`).toBeGreaterThan(0);
        for (const v of r.violations) checkDetail(v);
      }
    });
  }

  // These tables carry no intent on purpose: A2, A3, A5 and A6 do not depend on one, and the gate takes the intent as optional.
  it('the broken tables below are refused, with the right property and the offending rule named', () => {
    const cases: Array<{ name: string; table: IsolationRule[]; property: GateProperty; offender?: string; mentions?: string }> = [
      { name: 'hairpin', table: [rule('hairpin', 100, [1, 2], { inPort: 1 })], property: 'A2', offender: 'hairpin' },
      { name: 'default allow at the table-miss priority', table: [rule('default-allow', 0, [2], {})], property: 'A3', offender: 'default-allow' },
      { name: 'duplicate id (a table the checks cannot evaluate is refused, naming the id)', table: [rule('dup', 100, [2], { inPort: 1, etherType: 0x0800 }), rule('dup', 90, [3], { inPort: 1, etherType: 0x0806 })], property: 'uncheckable', mentions: 'dup' },
      { name: 'conflicting rules at equal priority', table: [rule('a', 100, [2], { inPort: 1, etherType: 0x0800 }), rule('b', 100, [3], { inPort: 1, etherType: 0x0800 })], property: 'A6', offender: 'a' },
    ];
    for (const c of cases) {
      const r = admitInstall({ current: [], proposed: c.table });
      expect(r.admitted, c.name).toBe(false);
      const hit = r.violations.find((v) => v.property === c.property);
      expect(hit, `${c.name}: expected ${c.property}, got ${JSON.stringify(r.violations.map((v) => v.property))}`).toBeDefined();
      if (c.offender !== undefined) expect(hit?.ruleIds, c.name).toContain(c.offender);
      if (c.mentions !== undefined) expect(hit?.detail, c.name).toContain(c.mentions);
      checkDetail(hit as GateViolation);
    }
  });

  it('can fail: it would catch a violation that names no rule (a mutated violation list is rejected by checkDetail)', () => {
    const silent: GateViolation = { property: 'A5', ruleIds: [], detail: 'shadowed' };
    expect(detailProblems(silent)).not.toEqual([]);
    const blank: GateViolation = { property: 'A5', ruleIds: ['x'], detail: '  ' };
    expect(detailProblems(blank)).not.toEqual([]);
  });

  it('the mutants are all there and, between them, the refusals cover every property they are known to trigger (self-contained: the suite cannot silently shrink)', () => {
    let total = 0;
    let refused = 0;
    const seen = new Set<string>();
    for (const { intent, reference } of BASELINE_TARGETS) {
      for (const m of generateMutants(reference(), [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP])) {
        total++;
        const r = admitInstall({ current: [], proposed: m.rules, intent });
        if (r.admitted) continue;
        refused++;
        for (const v of r.violations) seen.add(v.property);
      }
    }
    expect(total).toBe(EXPECTED_MUTANTS);
    expect(refused).toBe(EXPECTED_REFUSED);
    for (const p of EXPECTED_PROPERTIES) expect(seen.has(p), `no mutant triggered ${p}`).toBe(true);
  });
});
