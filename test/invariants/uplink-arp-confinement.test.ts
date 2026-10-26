import { describe, it, expect } from 'vitest';
import {
  buildPort1IsolationPolicy, verifyPort1Isolation, parseUplinkArpPeers, DEFAULT_WORKLOAD_HOSTS,
  ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD, ETH_TYPE_ARP, PRIORITY_ISOLATION_ALLOW, type IsolationRule,
} from '../../src/sdn/port1-isolation.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';
import { PORT1_ISOLATION_INTENT, port1IsolationUplinkArpIntent } from '../../src/sdn/intents.js';
import { triageProposal } from '../../src/sdn/proposal-triage.js';
import { computeBaselinesFor } from '../../src/sdn/eval-baselines.js';
import { admitInstall } from '../../src/sdn/install-gate.js';

const PEERS = ['10.0.2.1', '10.0.2.119'];
/** Absolute vacuity floor for the mutation check, next to the relative one (measured today: 38 of 52, about 73%). */
const MIN_KILLED_PERCENT = 60;
const confined = () => buildPort1IsolationPolicy(undefined, undefined, undefined, PEERS);
const strict = { requireConfinedUplinkArp: true };
const uplinkArp = (rules: readonly IsolationRule[]) => rules.filter((r) => r.flowMod.match?.inPort === ZODIAC_PORT_UPLINK && r.flowMod.match.etherType === ETH_TYPE_ARP);

describe('A10 uplink -> workload ARP confinement (opt-in)', () => {
  it('leaves the deployed policy exactly as it was when no peers are configured', () => {
    const def = buildPort1IsolationPolicy();
    expect(buildPort1IsolationPolicy(undefined, undefined, undefined, undefined)).toEqual(def);
    const arp = uplinkArp(def);
    expect(arp.map((r) => r.id)).toEqual(['p2-arp']);
    expect(arp[0]!.flowMod.match?.arpSpa).toBeUndefined();
    expect(verifyPort1Isolation(def)).toEqual([]);
    // the default policy is NOT claimed confined: the strict verifier must reject it
    expect(verifyPort1Isolation(def, undefined, undefined, strict).join('\n')).toMatch(/p2-arp: uplink → workload ARP without a specific confined arpSpa/);
  });

  it('replaces p2-arp with one exact-address rule per peer, and nothing else from the uplink ARP', () => {
    const arp = uplinkArp(confined());
    expect(arp.map((r) => r.id)).toEqual(PEERS.map((p) => `p2-arp-allow-${p}`));
    for (const r of arp) {
      expect(r.flowMod.command).toBe(FlowModCommand.OFPFC_ADD);
      expect(r.flowMod.priority).toBe(PRIORITY_ISOLATION_ALLOW);
      expect(r.flowMod.outputPorts).toEqual([ZODIAC_PORT_WORKLOAD]);
      expect(r.flowMod.match?.arpSpaPrefixLen).toBeUndefined(); // exact /32
    }
    expect(confined().length).toBe(buildPort1IsolationPolicy().length - 1 + PEERS.length);
  });

  it('passes the strict verifier and the new intent; the empty list (no uplink ARP at all) also passes', () => {
    expect(verifyPort1Isolation(confined(), undefined, undefined, strict)).toEqual([]);
    expect(triageProposal(confined(), port1IsolationUplinkArpIntent(PEERS)).category).toBe('ADMISSIBLE');
    const none = buildPort1IsolationPolicy(undefined, undefined, undefined, []);
    expect(uplinkArp(none)).toEqual([]);
    expect(verifyPort1Isolation(none, undefined, undefined, strict)).toEqual([]);
    expect(triageProposal(none, port1IsolationUplinkArpIntent([])).category).toBe('ADMISSIBLE');
  });

  it('the confined policy is rejected by the ORIGINAL intent, and the unconfined default by the new one (the checks can fail)', () => {
    expect(triageProposal(confined(), PORT1_ISOLATION_INTENT).category).not.toBe('ADMISSIBLE');
    expect(triageProposal(buildPort1IsolationPolicy(), port1IsolationUplinkArpIntent(PEERS)).category).not.toBe('ADMISSIBLE');
  });

  it('the bridge install gate admits the confined policy under the matching intent, and refuses a mismatched pair', () => {
    const peers = port1IsolationUplinkArpIntent(PEERS);
    expect(admitInstall({ current: [], proposed: confined(), intent: peers }).admitted).toBe(true);
    expect(admitInstall({ current: [], proposed: confined(), intent: PORT1_ISOLATION_INTENT }).admitted).toBe(false);
    expect(admitInstall({ current: [], proposed: buildPort1IsolationPolicy(), intent: peers }).admitted).toBe(false);
    expect(admitInstall({ current: [], proposed: buildPort1IsolationPolicy(), intent: PORT1_ISOLATION_INTENT }).admitted).toBe(true);
  });

  it('the strict verifier rejects a wildcard, a prefix and a missing arpSpa on an uplink ARP rule', () => {
    const base = confined();
    const swap = (patch: Record<string, unknown>): IsolationRule[] =>
      base.map((r) => (r.id === 'p2-arp-allow-10.0.2.1' ? { ...r, flowMod: { ...r.flowMod, match: { ...r.flowMod.match, ...patch } } } : r));
    expect(verifyPort1Isolation(swap({ arpSpa: undefined }), undefined, undefined, strict).join('\n')).toMatch(/uplink ARP confinement is required/);
    expect(verifyPort1Isolation(swap({ arpSpaPrefixLen: 24 }), undefined, undefined, strict).join('\n')).toMatch(/uplink ARP confinement is required/);
    expect(verifyPort1Isolation(swap({ arpSpa: '10.0.9.9' }), undefined, undefined, strict).join('\n')).toMatch(/uplink ARP confinement is required/);
  });

  it('refuses a bad peer list at build time: out of subnet, a workload host, a duplicate', () => {
    const build = (peers: string[]) => buildPort1IsolationPolicy(undefined, undefined, undefined, peers);
    expect(() => build(['192.168.1.1'])).toThrow(/not a \/32 address within/);
    expect(() => build([DEFAULT_WORKLOAD_HOSTS[0]!])).toThrow(/workload host address/);
    expect(() => build(['10.0.2.1', '10.0.2.1'])).toThrow(/listed twice/);
  });

  it('parses the environment value fail-closed: unset is off, none is empty, a typo throws', () => {
    expect(parseUplinkArpPeers(undefined)).toBeUndefined();
    expect(parseUplinkArpPeers('  ')).toBeUndefined();
    expect(parseUplinkArpPeers('none')).toEqual([]);
    expect(parseUplinkArpPeers('10.0.2.1, 10.0.2.119')).toEqual(['10.0.2.1', '10.0.2.119']);
    expect(() => parseUplinkArpPeers('10.0.2.1,banana')).toThrow(/not an IPv4 address/);
    expect(() => parseUplinkArpPeers('10.0.2.1,')).toThrow(/not an IPv4 address/);
    expect(() => parseUplinkArpPeers('10.0.2.300')).toThrow(/not an IPv4 address/);
    expect(() => parseUplinkArpPeers('999.0.0.1')).toThrow(/not an IPv4 address/);
  });

  it('mutants of the confined policy are rejected at least as often as the original policy\'s, by integer cross-multiplication', () => {
    const b = computeBaselinesFor(port1IsolationUplinkArpIntent(PEERS), confined());
    const o = computeBaselinesFor(PORT1_ISOLATION_INTENT, buildPort1IsolationPolicy());
    expect(b.mutants.total).toBeGreaterThan(o.mutants.total); // the extra peer rule adds mutants
    expect(b.mutants.killed * o.mutants.total).toBeGreaterThanOrEqual(o.mutants.killed * b.mutants.total);
    expect(b.survivedMutants.length).toBe(b.mutants.survived);
    expect(b.mutants.killed * 100).toBeGreaterThanOrEqual(b.mutants.total * MIN_KILLED_PERCENT);
    // Any mutant of a peer rule other than a priority raise (which changes nothing: no rule overlaps it) must be caught.
    const peerSurvivors = b.survivedMutants.filter((id: string) => id.includes('p2-arp-allow-') && !id.startsWith('raise-priority:'));
    expect(peerSurvivors).toEqual([]);
  });
});
