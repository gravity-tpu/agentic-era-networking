/**
 * proposal-triage.test.ts
 * Maps a model's text onto the pre-registered failure taxonomy (docs/research/evaluation-plan.md section 7).
 * Each category has a proposal that must land in it and the reference policy must come out admissible, so the
 * triage can fail (Invariant 4). Abstract evaluation only: nothing here says how the switch behaves.
 */

import { describe, it, expect } from 'vitest';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { parseProposal, triageProposal, proposalFromRules } from '../../src/sdn/proposal-triage.js';

const reference = buildPort1IsolationPolicy();
const text = (rules: unknown): string => JSON.stringify(rules);
const referenceJson = proposalFromRules(reference);
const edit = (fn: (r: Record<string, unknown>[]) => unknown): string => {
  const copy = JSON.parse(referenceJson) as Record<string, unknown>[];
  return text(fn(copy));
};
const category = (t: string): string => {
  const p = parseProposal(t);
  return p.ok ? triageProposal(p.rules, PORT1_ISOLATION_INTENT).category : p.category;
};

describe('parseProposal', () => {
  it('accepts a fenced JSON array and a {"rules": [...]} object', () => {
    expect(parseProposal('Here:\n```json\n' + referenceJson + '\n```').ok).toBe(true);
    expect(parseProposal(text({ rules: JSON.parse(referenceJson) })).ok).toBe(true);
  });
  it.each([
    ['prose only', 'I would block everything.'],
    ['empty array', '[]'],
    ['a rule without a priority', edit((r) => { delete r[0]!['priority']; return r; })],
    ['a non-integer priority', edit((r) => { r[0]!['priority'] = 'high'; return r; })],
    ['an out-of-range priority', edit((r) => { r[0]!['priority'] = 70000; return r; })],
    ['a bad IPv4 address', edit((r) => { (r[0]!['match'] as Record<string, unknown>)['srcIp'] = '10.0.2.999'; return r; })],
    ['a port outside 1 to 4', edit((r) => { r[0]!['outputPorts'] = [9]; return r; })],
    ['an unknown match field', edit((r) => { (r[0]!['match'] as Record<string, unknown>)['tcpDst'] = 53; return r; })],
  ])('rejects %s as ERR_SYNTAX', (_n, t) => {
    const p = parseProposal(t);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.category).toBe('ERR_SYNTAX');
  });
});

describe('triageProposal', () => {
  it('passes the reference policy', () => {
    expect(category(referenceJson)).toBe('ADMISSIBLE');
  });
  it('flags more than 128 rules as ERR_TABLE_OVERFLOW', () => {
    const many = Array.from({ length: 129 }, (_v, i) => ({ id: `r${i}`, priority: 10 + i, outputPorts: [3], match: { inPort: 1, etherType: 0x0800, dstIp: `10.0.2.${i % 250}`, dstIpPrefixLen: 32 } }));
    expect(category(text(many))).toBe('ERR_TABLE_OVERFLOW');
  });
  it('flags an IPv4 match without eth_type as ERR_PREREQUISITE', () => {
    expect(category(edit((r) => { delete (r[0]!['match'] as Record<string, unknown>)['etherType']; return r; }))).toBe('ERR_PREREQUISITE');
  });
  it('flags a rule that outputs to its own ingress port as ERR_HAIRPIN', () => {
    expect(category(edit((r) => { r[6]!['outputPorts'] = [3]; return r; }))).toBe('ERR_HAIRPIN');
  });
  it('flags equal-priority overlap with different outputs as ERR_AMBIGUITY', () => {
    expect(category(edit((r) => { r.push({ id: 'dup', priority: 200, outputPorts: [3], match: { inPort: 1, etherType: 0x0806 } }); return r; }))).toBe('ERR_AMBIGUITY');
  });
  it('flags a rule covered by a higher-priority rule as ERR_SHADOWED', () => {
    expect(category(edit((r) => { r.push({ id: 'dead', priority: 120, outputPorts: [2], match: { inPort: 3 } }); return r; }))).toBe('ERR_SHADOWED');
  });
  it('flags forwarding all workload traffic to the uplink as ERR_INTENT_LEAK', () => {
    expect(category(edit((r) => { r[3]!['outputPorts'] = [2, 3]; return r; }))).toBe('ERR_INTENT_LEAK');
  });
  it('flags a policy that drops required traffic as ERR_INTENT_MISSING', () => {
    expect(category(edit((r) => r.filter((x) => x['id'] !== 'p2-arp')))).toBe('ERR_INTENT_MISSING');
  });
  it('reports the first category by fixed precedence and keeps every violation', () => {
    const p = parseProposal(edit((r) => { r[6]!['outputPorts'] = [3]; r[3]!['outputPorts'] = [2, 3]; return r; }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      const t = triageProposal(p.rules, PORT1_ISOLATION_INTENT);
      expect(t.category).toBe('ERR_HAIRPIN');
      expect(t.categories).toEqual(expect.arrayContaining(['ERR_HAIRPIN', 'ERR_INTENT_LEAK']));
    }
  });
});
