/**
 * proposal-lenient.test.ts
 * The lenient parse is an explicit opt-in used only to re-score a small model's format slips (CIDR strings, numeric strings).
 * The strict parse stays the default and stays strict; lenient applies exactly two named transforms and nothing else.
 */

import { describe, it, expect } from 'vitest';
import { parseProposal, triageProposal, LENIENT_TRANSFORMS } from '../../src/sdn/proposal-triage.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';

const cidrRule = JSON.stringify([
  { id: 'a', priority: 10, outputPorts: ['2'], match: { inPort: '1', etherType: 2048, srcIp: '10.0.2.0/24', dstIp: '10.0.2.0/24' } },
]);

describe('lenient parse', () => {
  it('names its transforms', () => {
    expect(LENIENT_TRANSFORMS).toEqual(['cidr-split', 'numeric-string']);
  });
  it('is off by default: CIDR strings and numeric strings are still ERR_SYNTAX', () => {
    const p = parseProposal(cidrRule);
    expect(p.ok).toBe(false);
  });
  it('splits a CIDR address into address and prefix length, and reads numeric strings as integers', () => {
    const p = parseProposal(cidrRule, { lenient: true });
    expect(p.ok).toBe(true);
    if (p.ok) {
      const m = p.rules[0]!.flowMod.match!;
      expect([m.srcIp, m.srcIpPrefixLen, m.dstIp, m.dstIpPrefixLen, m.inPort]).toEqual(['10.0.2.0', 24, '10.0.2.0', 24, 1]);
      expect(p.rules[0]!.flowMod.outputPorts).toEqual([2]);
    }
  });
  it('does not rescue a conflicting prefix length, a bad prefix, or a non-numeric string', () => {
    const conflict = JSON.stringify([{ id: 'a', priority: 1, outputPorts: [1], match: { inPort: 1, etherType: 2048, srcIp: '10.0.2.0/24', srcIpPrefixLen: 16 } }]);
    const badPrefix = JSON.stringify([{ id: 'a', priority: 1, outputPorts: [1], match: { inPort: 1, etherType: 2048, srcIp: '10.0.2.0/40' } }]);
    const word = JSON.stringify([{ id: 'a', priority: 1, outputPorts: ['one'], match: { inPort: 1 } }]);
    for (const t of [conflict, badPrefix, word]) expect(parseProposal(t, { lenient: true }).ok).toBe(false);
  });
  it('leaves everything else strict: unknown fields and missing fields are still rejected', () => {
    const unknown = JSON.stringify([{ id: 'a', priority: 1, outputPorts: [1], match: { inPort: 1, tcpDst: 53 } }]);
    const missing = JSON.stringify([{ id: 'a', outputPorts: [1], match: { inPort: 1 } }]);
    for (const t of [unknown, missing]) expect(parseProposal(t, { lenient: true }).ok).toBe(false);
  });
  it('gives the same verdict as the strict parse on an already-strict proposal', () => {
    const strict = JSON.stringify([{ id: 'a', priority: 10, outputPorts: [3], match: { inPort: 1 } }]);
    const a = parseProposal(strict);
    const b = parseProposal(strict, { lenient: true });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(triageProposal(a.rules, PORT1_ISOLATION_INTENT)).toEqual(triageProposal(b.rules, PORT1_ISOLATION_INTENT));
  });
});
