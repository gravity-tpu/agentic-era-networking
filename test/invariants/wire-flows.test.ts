/**
 * test/invariants/wire-flows.test.ts
 * Wire-flow selection for the on-wire conformance run (Track A close-out plan, Phase 0): which flows can the testbed send, and which of
 * them tell a reference rule set from its look-alikes. Pure functions; nothing here touches the switch.
 */
import { describe, it, expect } from 'vitest';
import { buildPort1IsolationPolicy, ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../../src/sdn/port1-isolation.js';
import { generateMutants } from '../../src/sdn/rule-mutations.js';
import {
  predictOutcome,
  candidateFlows,
  selectFlows,
  FlowMode,
  type WireFlow,
  type WireRuleSet,
} from '../../src/sdn/wire-flows.js';

const rs = (id: string, rules: ReadonlyArray<{ id: string; priority: number; outputPorts: number[]; match: Record<string, unknown> }>): WireRuleSet => ({ id, rules });
const flow = (id: string, over: Partial<WireFlow['packet']> & { inPort: number }): WireFlow => ({
  id,
  mode: FlowMode.Real,
  observable: over.inPort === 1 ? [2, 3] : [1, 3],
  packet: { etherType: 0x0800, srcMac: '02:00:00:00:00:01', dstMac: '02:00:00:00:00:02', srcIp: '10.0.2.50', dstIp: '10.0.0.119', ...over },
});

describe('predictOutcome', () => {
  const rules = rs('r', [
    { id: 'low', priority: 10, outputPorts: [3], match: { inPort: 1 } },
    { id: 'high', priority: 100, outputPorts: [2], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.50' } },
  ]).rules;
  it('takes the highest-priority matching rule', () => {
    expect(predictOutcome(rules, flow('f', { inPort: 1 }))).toEqual([2]);
  });
  it('falls to the next rule when the higher one does not match', () => {
    expect(predictOutcome(rules, flow('f', { inPort: 1, srcIp: '10.0.2.99' }))).toEqual([3]);
  });
  it('drops on a table miss (fail closed)', () => {
    expect(predictOutcome(rules, flow('f', { inPort: 2 }))).toEqual([]);
  });
  it('reports only the ports the testbed can observe for that flow', () => {
    const r = rs('r', [{ id: 'all', priority: 1, outputPorts: [1, 2, 3, 4], match: {} }]).rules;
    expect(predictOutcome(r, flow('f', { inPort: 1 }))).toEqual([2, 3]);
  });
});

describe('candidateFlows and the modes a flow needs', () => {
  const flows = candidateFlows(['10.0.2.50', '10.0.2.53', '8.8.8.8'], FlowMode.Forged);
  it('a real workload host sending IPv4 to the uplink host needs no alias or forgery', () => {
    const f = flows.find((x) => x.packet.inPort === 1 && x.packet.etherType === 0x0800 && x.packet.srcIp === '10.0.2.50' && x.packet.dstIp === '10.0.0.119');
    expect(f?.mode).toBe(FlowMode.Real);
  });
  it('an address with no host on the workload subnet needs an alias', () => {
    const f = flows.find((x) => x.packet.inPort === 1 && x.packet.etherType === 0x0800 && x.packet.srcIp === '10.0.2.53' && x.packet.dstIp === '10.0.0.119');
    expect(f?.mode).toBe(FlowMode.Alias);
  });
  it('a source outside the workload subnet entering port 1 needs a forged frame', () => {
    const f = flows.find((x) => x.packet.inPort === 1 && x.packet.etherType === 0x0800 && x.packet.srcIp === '8.8.8.8' && x.packet.dstIp === '10.0.0.119');
    expect(f?.mode).toBe(FlowMode.Forged);
  });
  it('an ARP claim from the uplink side for an address the Mac cannot own is not sendable, so it is never a candidate', () => {
    expect(flows.some((x) => x.packet.inPort === 2 && x.packet.etherType === 0x0806 && x.packet.arpSpa === '8.8.8.8')).toBe(false);
  });
  it('an ARP claim from the uplink side for an alias on the workload subnet needs an alias', () => {
    const arp = flows.find((x) => x.packet.inPort === 2 && x.packet.etherType === 0x0806 && x.packet.arpSpa === '10.0.2.53' && x.packet.arpTpa === '10.0.2.50');
    expect(arp?.mode).toBe(FlowMode.Alias);
  });
  it('restricting the allowed mode removes the flows that need more', () => {
    const real = candidateFlows(['10.0.2.50', '10.0.2.53', '8.8.8.8'], FlowMode.Real);
    expect(real.every((x) => x.mode === FlowMode.Real)).toBe(true);
    expect(real.length).toBeLessThan(flows.length);
  });
});

describe('port 3 ingress (frames from the tap)', () => {
  it('is only a candidate when injection on port 3 is allowed', () => {
    expect(candidateFlows(['10.0.2.50'], FlowMode.Forged).some((f) => f.packet.inPort === 3)).toBe(false);
    const withTap = candidateFlows(['10.0.2.50'], FlowMode.PortThree).filter((f) => f.packet.inPort === 3);
    expect(withTap.length).toBeGreaterThan(0);
    expect(withTap.every((f) => f.mode === FlowMode.PortThree)).toBe(true);
  });
  it('separates two sets that differ only in how they treat frames from the tap', () => {
    const reference = rs('ref', [{ id: 'p3-return', priority: 100, outputPorts: [1], match: { inPort: 3 } }]);
    const leaky = rs('leaky', [{ id: 'p3-return', priority: 100, outputPorts: [1, 2], match: { inPort: 3 } }]);
    expect(selectFlows(candidateFlows(['10.0.2.50'], FlowMode.Forged), reference, [leaky], 4).unseparated).toEqual(['leaky']);
    expect(selectFlows(candidateFlows(['10.0.2.50'], FlowMode.PortThree), reference, [leaky], 4).separated).toEqual(['leaky']);
  });
});

describe('selectFlows', () => {
  const reference = rs('ref', [
    { id: 'allow', priority: 200, outputPorts: [2, 3], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.0', srcIpPrefixLen: 24 } },
  ]);
  // differs from the reference only for the source 10.0.2.53, a address with no real host
  const onlyAlias = rs('mutant-53', [
    { id: 'allow', priority: 200, outputPorts: [2, 3], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.0', srcIpPrefixLen: 24 } },
    { id: 'quarantine', priority: 300, outputPorts: [], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.53' } },
  ]);
  // differs for the real host 10.0.2.50
  const realHost = rs('mutant-50', [
    { id: 'allow', priority: 200, outputPorts: [2, 3], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.0', srcIpPrefixLen: 24 } },
    { id: 'quarantine', priority: 300, outputPorts: [], match: { inPort: 1, etherType: 0x0800, srcIp: '10.0.2.50' } },
  ]);
  const twin = rs('twin', reference.rules.map((r) => ({ ...r })));
  const addresses = ['10.0.2.50', '10.0.2.53'];

  it('with real hosts only, a set that differs only for an address with no host cannot be separated', () => {
    const sel = selectFlows(candidateFlows(addresses, FlowMode.Real), reference, [onlyAlias, realHost], 4);
    expect(sel.separated).toContain('mutant-50');
    expect(sel.unseparated).toContain('mutant-53');
  });
  it('allowing aliases separates it', () => {
    const sel = selectFlows(candidateFlows(addresses, FlowMode.Alias), reference, [onlyAlias, realHost], 4);
    expect(sel.unseparated).toEqual([]);
    expect(sel.flows.length).toBeLessThanOrEqual(2);
  });
  it('can fail: an identical rule set is never reported as separated', () => {
    const sel = selectFlows(candidateFlows(addresses, FlowMode.Forged), reference, [twin], 4);
    expect(sel.separated).toEqual([]);
    expect(sel.unseparated).toEqual(['twin']);
  });
  it('every claimed separation is real: the chosen flows predict a different outcome', () => {
    const sel = selectFlows(candidateFlows(addresses, FlowMode.Alias), reference, [onlyAlias, realHost, twin], 4);
    for (const id of sel.separated) {
      const other = [onlyAlias, realHost, twin].find((s) => s.id === id)!;
      const differs = sel.flows.some((f) => JSON.stringify(predictOutcome(reference.rules, f)) !== JSON.stringify(predictOutcome(other.rules, f)));
      expect(differs).toBe(true);
    }
  });
  it('respects the flow budget', () => {
    const sel = selectFlows(candidateFlows(addresses, FlowMode.Alias), reference, [onlyAlias, realHost], 1);
    expect(sel.flows.length).toBe(1);
    expect(sel.unseparated.length).toBe(1);
  });
});

describe('against the real reference policy and its mutants', () => {
  const ref = buildPort1IsolationPolicy();
  const toSet = (id: string, rules: typeof ref): WireRuleSet => rs(id, rules.map((r) => ({ id: r.id, priority: r.flowMod.priority, outputPorts: [...(r.flowMod.outputPorts ?? [])], match: { ...(r.flowMod.match ?? {}) } })));
  const reference = toSet('ref', ref);
  const mutants = generateMutants(ref, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]).map((m) => toSet(m.id, m.rules));
  const addrs = ['10.0.2.50', '10.0.2.51', '10.0.2.52', '10.0.2.53', '10.0.2.200', '10.0.0.119', '8.8.8.8'];

  it('allowing more ways to send a flow never separates fewer sets', () => {
    const real = selectFlows(candidateFlows(addrs, FlowMode.Real), reference, mutants, 40);
    const alias = selectFlows(candidateFlows(addrs, FlowMode.Alias), reference, mutants, 40);
    const forged = selectFlows(candidateFlows(addrs, FlowMode.Forged), reference, mutants, 40);
    expect(alias.separated.length).toBeGreaterThanOrEqual(real.separated.length);
    expect(forged.separated.length).toBeGreaterThanOrEqual(alias.separated.length);
    expect(forged.separated.length).toBeGreaterThan(0);
  });
  it('some mutants stay unseparated by any flow (equivalent mutants), so the selection is not vacuous', () => {
    const forged = selectFlows(candidateFlows(addrs, FlowMode.Forged), reference, mutants, 200);
    expect(forged.unseparated.length).toBeGreaterThan(0);
  });
});
