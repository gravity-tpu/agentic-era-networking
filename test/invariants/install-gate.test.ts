/**
 * install-gate.test.ts
 * The pre-install gate: the table the switch would hold after an install must pass A2, A4, A5, A6, A7 and A11, and a check that cannot
 * run refuses. Pure checks over rule sets; nothing here is installed on a switch.
 */

import { describe, it, expect } from 'vitest';
import { admitInstall } from '../../src/sdn/install-gate.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

const policy = buildPort1IsolationPolicy();
const rule = (id: string, priority: number, outputPorts: number[], match: Record<string, unknown>): IsolationRule => ({
  id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts, match },
});
const quarantine = (id: string, ip: string): IsolationRule => rule(id, 65535, [], { etherType: 0x0800, srcIp: ip, srcIpPrefixLen: 32 });
const props = (r: ReturnType<typeof admitInstall>): string[] => [...new Set(r.violations.map((v) => v.property))].sort();

describe('admitInstall', () => {
  it('admits the deployed policy on its own, under the port-1 isolation intent', () => {
    const r = admitInstall({ current: [], proposed: policy, intent: PORT1_ISOLATION_INTENT });
    expect(r.violations).toEqual([]);
    expect(r.admitted).toBe(true);
  });

  it('admits a quarantine DROP on top of the deployed policy and says A4 is no longer vacuous', () => {
    const r = admitInstall({ current: policy, proposed: [quarantine('quarantine-1', '10.0.2.50')], intent: PORT1_ISOLATION_INTENT });
    expect(r.admitted).toBe(true);
    expect(r.notes.join()).not.toMatch(/A4 holds vacuously/);
  });

  it('notes, but does not pass, A8 for a table the cost model did not measure', () => {
    const r = admitInstall({ current: [], proposed: policy });
    expect(r.notes.join()).toMatch(/A8 unverifiable/);
  });

  it('refuses a quarantine that does not outrank forwarding (A4)', () => {
    const low = rule('quarantine-low', 100, [], { etherType: 0x0800, srcIp: '10.0.2.50', srcIpPrefixLen: 32 });
    const r = admitInstall({ current: policy, proposed: [low] });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('A4');
  });

  it('refuses the shape /api/sdn/allow builds from a MAC: no in_port, outputs to port 2 (a packet arriving on port 2 would be sent back out)', () => {
    const allow = rule('allow-1', 10, [2], { srcMac: 'aa:bb:cc:dd:ee:ff' });
    const r = admitInstall({ current: policy, proposed: [allow], intent: PORT1_ISOLATION_INTENT });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('A2');
    expect(r.violations.find((v) => v.property === 'A2')?.ruleIds).toEqual(['allow-1']);
  });

  it('refuses an explicit hairpin (A2)', () => {
    const r = admitInstall({ current: policy, proposed: [rule('h', 300, [1], { inPort: 1, srcMac: 'aa:bb:cc:dd:ee:ff' })] });
    expect(props(r)).toContain('A2');
  });

  it('refuses a rule that never wins because the policy already covers its traffic (A5)', () => {
    const r = admitInstall({ current: policy, proposed: [rule('dead', 10, [3], { inPort: 1, srcMac: 'aa:bb:cc:dd:ee:ff' })] });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('A5');
  });

  it('refuses an equal-priority conflict (A6)', () => {
    const r = admitInstall({ current: policy, proposed: [rule('clash', 200, [3], { inPort: 1, etherType: 0x0806 })] });
    expect(props(r)).toContain('A6');
  });

  it('refuses a rule that lets the workload reach the uplink outside the policy (A11)', () => {
    const leak = rule('leak', 300, [2], { inPort: 1, srcMac: 'aa:bb:cc:dd:ee:ff' });
    const r = admitInstall({ current: policy, proposed: [leak], intent: PORT1_ISOLATION_INTENT });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('A11');
  });

  it('refuses when the table cannot fit with the quarantine reserve (A7)', () => {
    const many = Array.from({ length: 125 }, (_, i) => rule(`r${i}`, 10 + i, [3], { inPort: 2, etherType: 0x0800, srcIp: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`, srcIpPrefixLen: 32 }));
    const r = admitInstall({ current: policy, proposed: many });
    expect(props(r)).toContain('A7');
  });

  it('fails closed when the check cannot run: a duplicate id refuses, it does not pass', () => {
    const r = admitInstall({ current: policy, proposed: [rule('p1-arp', 5, [3], { inPort: 2 })] });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('uncheckable');
  });

  it('fails closed when the packet-class budget is exceeded', () => {
    const r = admitInstall({ current: policy, proposed: [], maxPacketClasses: 2 });
    expect(r.admitted).toBe(false);
    expect(props(r)).toContain('uncheckable');
  });
});
