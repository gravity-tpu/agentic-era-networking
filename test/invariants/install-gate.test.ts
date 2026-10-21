/**
 * install-gate.test.ts
 * The pre-install gate: the table the switch would hold after an install must pass A2, A4, A5, A6, A7 and A11, and a check that cannot
 * run refuses. Pure checks over rule sets; nothing here is installed on a switch.
 */

import { describe, it, expect } from 'vitest';
import { admitInstall, parseCapacityTarget } from '../../src/sdn/install-gate.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import { MAX_FORWARDING_PRIORITY, QUARANTINE_PRIORITY } from '../../src/sdn/quarantine-precedence.js';
import { DEFAULT_QUARANTINE_MAX_ACTIVE, MAX_QUARANTINE_MAX_ACTIVE } from '../../src/sdn/quarantine-envelope.js';
import { FLOW_TABLE_CAPACITY } from '../../src/sdn/dataplane-benchmark.js';

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

  it('notes, but does not pass, A8 for a table no cost model measured (the policy plus an extra forwarding rule)', () => {
    const extra = rule('extra', 10, [3], { inPort: 2, srcMac: 'aa:bb:cc:dd:ee:ff' });
    const r = admitInstall({ current: [], proposed: [...policy, extra] });
    expect(r.notes.join()).toMatch(/A8 unverifiable/);
  });

  it('says the deployed table is a measured shape when no target is declared, and gives no verdict', () => {
    const r = admitInstall({ current: [], proposed: policy });
    expect(r.notes.join()).toMatch(/shape a cost model measured; no throughput target was declared/);
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

  describe('A8 with a declared throughput target', () => {
    const target = (targetPps: bigint, extra: { advisory?: boolean; payloadBytes?: bigint } = {}) =>
      ({ payloadBytes: extra.payloadBytes ?? 572n, targetPps, ...(extra.advisory !== undefined ? { advisory: extra.advisory } : {}) });
    const withQuarantines = (n: number): IsolationRule[] => [...policy, ...Array.from({ length: n }, (_, i) => quarantine(`quarantine-${i}`, `10.0.2.${101 + i}`))];

    it('passes a target the deployed table meets, and names the model', () => {
      const r = admitInstall({ current: withQuarantines(2), proposed: [], capacityTarget: target(8000n) });
      expect(r.admitted).toBe(true);
      expect(r.notes.join()).toMatch(/A8 \(8000 pps at 572 B\): met.*deployed model/);
    });

    it('refuses a target the deployed table cannot meet (A8), naming the quarantines', () => {
      const r = admitInstall({ current: withQuarantines(8), proposed: [], capacityTarget: target(9000n) });
      expect(r.admitted).toBe(false);
      expect(props(r)).toContain('A8');
    });

    it('counts the reserve: a table that meets the target now but not at full quarantine depth is refused', () => {
      const ok = admitInstall({ current: withQuarantines(0), proposed: [], capacityTarget: target(11000n), capacityReserve: 0 });
      expect(ok.admitted).toBe(true);
      const full = admitInstall({ current: withQuarantines(0), proposed: [], capacityTarget: target(11000n), capacityReserve: 8 });
      expect(full.admitted).toBe(false);
      expect(props(full)).toContain('A8');
    });

    it('refuses when a target is declared but no model covers the table or payload (unverifiable is not a pass)', () => {
      const other = admitInstall({ current: policy, proposed: [rule('extra', 10, [3], { inPort: 2, srcMac: 'aa:bb:cc:dd:ee:ff' })], capacityTarget: target(1000n) });
      expect(props(other)).toContain('A8');
      const payload = admitInstall({ current: policy, proposed: [], capacityTarget: target(1000n, { payloadBytes: 64n }) });
      expect(props(payload)).toContain('A8');
      const depth = admitInstall({ current: withQuarantines(9), proposed: [], capacityTarget: target(1000n) });
      expect(props(depth)).toContain('A8');
    });

    it('advisory mode never refuses for A8 but says what it found', () => {
      const r = admitInstall({ current: withQuarantines(8), proposed: [], capacityTarget: target(9000n, { advisory: true }) });
      expect(r.admitted).toBe(true);
      expect(r.notes.join()).toMatch(/NOT met \(advisory, not refused\)/);
      const u = admitInstall({ current: policy, proposed: [], capacityTarget: target(1000n, { payloadBytes: 64n, advisory: true }) });
      expect(u.admitted).toBe(true);
      expect(u.notes.join()).toMatch(/unverifiable \(advisory, not refused\)/);
    });
  });
});

describe('parseCapacityTarget', () => {
  it('means no target when unset or empty, and reads a target with the measured payload by default', () => {
    expect(parseCapacityTarget({})).toEqual({ target: null, warnings: [] });
    expect(parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: '  ' })).toEqual({ target: null, warnings: [] });
    expect(parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: '8000' }).target).toEqual({ payloadBytes: 572n, targetPps: 8000n });
    expect(parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: '8000', ZODIAC_CAPACITY_PAYLOAD_BYTES: '64' }).target).toEqual({ payloadBytes: 64n, targetPps: 8000n });
  });

  it('turns a malformed value into NO target and a warning, never a half-enforced one', () => {
    for (const bad of ['fast', '0', '-5', '1.5', '1000001', '1e3', '99999999999']) {
      const r = parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: bad });
      expect(r.target, bad).toBeNull();
      expect(r.warnings.join(), bad).toMatch(/NO throughput target is enforced/);
    }
    const other = parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: '8000', ZODIAC_CAPACITY_PAYLOAD_BYTES: '64' });
    expect(other.target).not.toBeNull();
    expect(other.warnings.join()).toMatch(/not 572/); // accepted, but flagged at configuration time
    const p = parseCapacityTarget({ ZODIAC_CAPACITY_TARGET_PPS: '8000', ZODIAC_CAPACITY_PAYLOAD_BYTES: 'big' });
    expect(p.target).toBeNull();
    expect(p.warnings.join()).toMatch(/PAYLOAD_BYTES/);
  });
});

describe('the quarantine constants that must agree across modules', () => {
  it('keeps every forwarding priority below the quarantine band, so A4 is satisfiable by construction', () => {
    expect(MAX_FORWARDING_PRIORITY).toBeLessThan(QUARANTINE_PRIORITY);
    for (const r of policy) expect(r.flowMod.priority).toBeLessThanOrEqual(MAX_FORWARDING_PRIORITY);
  });

  it('fits the deployed policy, the table-miss and the largest allowed quarantine count in the hardware table', () => {
    expect(policy.length + 1 + DEFAULT_QUARANTINE_MAX_ACTIVE).toBeLessThanOrEqual(FLOW_TABLE_CAPACITY);
    expect(policy.length + 1 + MAX_QUARANTINE_MAX_ACTIVE).toBeLessThanOrEqual(FLOW_TABLE_CAPACITY);
  });
});
