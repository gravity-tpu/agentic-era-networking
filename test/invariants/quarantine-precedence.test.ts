/**
 * quarantine-precedence.test.ts
 * A4: every quarantine DROP outranks every forwarding rule that can match the same packet. Pure checks, no switch involved.
 */

import { describe, it, expect } from 'vitest';
import { checkQuarantinePrecedence } from '../../src/sdn/quarantine-precedence.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

const q = (id: string, priority: number, ip: string, extra: Record<string, unknown> = {}): IsolationRule => ({
  id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts: [], match: { etherType: 0x0800, srcIp: ip, srcIpPrefixLen: 32, ...extra } },
});
const policy = buildPort1IsolationPolicy();

describe('checkQuarantinePrecedence (A4)', () => {
  it('holds vacuously with no quarantine rule, and says how many it found', () => {
    const v = checkQuarantinePrecedence(policy);
    expect(v.satisfied).toBe(true);
    expect(v.quarantineRules).toBe(0);
  });

  it('holds for a quarantine at 65535 above the deployed policy', () => {
    const v = checkQuarantinePrecedence([...policy, q('quarantine-a', 65535, '10.0.2.50')]);
    expect(v.satisfied).toBe(true);
    expect(v.quarantineRules).toBe(1);
  });

  it('fails when the quarantine sits below a forwarding rule it overlaps, naming both', () => {
    const v = checkQuarantinePrecedence([...policy, q('quarantine-low', 100, '10.0.2.50')]);
    expect(v.satisfied).toBe(false);
    expect(v.violations[0]?.ruleIds[0]).toBe('quarantine-low');
    expect(v.violations[0]?.ruleIds).toContain('p1-ipv4-intra-segment');
  });

  it('fails on a tie: the winner is undefined, so the source may still be forwarded', () => {
    const v = checkQuarantinePrecedence([...policy, q('quarantine-tie', 200, '10.0.2.50')]);
    expect(v.satisfied).toBe(false);
    expect(v.violations[0]?.ruleIds).toContain('p1-ipv4-intra-segment');
  });

  it('is exact, not a priority comparison: a low quarantine that cannot overlap any forwarding rule is fine', () => {
    const fwd: IsolationRule = { id: 'fwd', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [1], match: { inPort: 2 } } };
    const v = checkQuarantinePrecedence([fwd, q('quarantine-p1', 50, '10.0.2.50', { inPort: 1 })]);
    expect(v.satisfied).toBe(true);
  });

  it('does not treat an ordinary DROP below an allow as an A4 matter (only quarantine-* DROPs are)', () => {
    const allow: IsolationRule = { id: 'allow-dns', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [2], match: { inPort: 1, etherType: 0x0800, dstIp: '10.0.2.53', dstIpPrefixLen: 32 } } };
    const drop: IsolationRule = { id: 'drop-rest', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 50, outputPorts: [], match: { inPort: 1 } } };
    expect(checkQuarantinePrecedence([allow, drop]).satisfied).toBe(true);
  });

  it('a quarantine-named rule that forwards is not a quarantine DROP', () => {
    const fake: IsolationRule = { id: 'quarantine-fake', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 10, outputPorts: [2], match: { inPort: 1 } } };
    expect(checkQuarantinePrecedence([...policy, fake]).quarantineRules).toBe(0);
  });
});
