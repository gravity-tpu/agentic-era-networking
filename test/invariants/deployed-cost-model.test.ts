/**
 * deployed-cost-model.test.ts
 * Checks the deployed-table cost model against the stored 2026-10-20 hardware run (docs/benchmarks/results/layout-capacity/run-2026-10-20),
 * plus its domain limits and the shape classifier. The artifact comparison is a real check: the model must stay within the drift ceiling of
 * every clean saturated step, and a model with the earlier benchmark's slope must fail it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEPLOYED_MAX_QUARANTINES,
  DEPLOYED_PAYLOAD_BYTES,
  DEPLOYED_TOLERANCE_PPM,
  DeployedCostDomainError,
  PS_PER_SECOND,
  classifyDeployedShape,
  deployedCapacityPps,
  deployedPacketTimePs,
  explainDeployedDomain,
  meetsDeployedCapacityTarget,
} from '../../src/sdn/deployed-cost-model.js';
import { buildPort1IsolationPolicy, type IsolationRule } from '../../src/sdn/port1-isolation.js';
import { FlowModCommand } from '../../src/sdn/openflow-types.js';

interface Step { targetPps: number; sentPps?: number; saturated?: boolean; medianBusyDeliveredPps?: number; binsPps?: number[] }
interface Row { round: number; k: number; steps: Step[] }
const RUN = JSON.parse(readFileSync('docs/benchmarks/results/layout-capacity/run-2026-10-20/results.json', 'utf-8')) as Row[];

// Drift guard, tighter than DEPLOYED_TOLERANCE_PPM: the worst clean step is about 13,000 ppm off. If a new artifact pushes past this, look at the
// model before widening the tolerance, because the tolerance is the margin meetsDeployedCapacityTarget relies on.
const OBSERVED_WORST_PPM_CEILING = 15_000n;

/** A saturated step is a transient stall, not capacity, if at least half of its interior seconds still delivered at the offered rate (same rule as scripts/layout-capacity-report.py). */
function isStall(s: Step): boolean {
  const interior = (s.binsPps ?? []).slice(2, -2);
  if (interior.length === 0 || s.sentPps === undefined) return false;
  return interior.filter((b) => b >= 0.97 * s.sentPps! * 0.987).length / interior.length >= 0.5;
}
const clean = RUN.flatMap((r) => {
  const sat = r.steps.find((s) => s.saturated === true);
  return sat !== undefined && !isStall(sat) && sat.medianBusyDeliveredPps !== undefined ? [{ k: r.k, round: r.round, measured: BigInt(sat.medianBusyDeliveredPps) }] : [];
});

const ppm = (modelled: bigint, measured: bigint): bigint => {
  const d = modelled > measured ? modelled - measured : measured - modelled;
  return (d * 1_000_000n) / measured;
};

describe('the deployed cost model against the stored hardware run', () => {
  it('has clean saturated steps at k = 0, 2, 4 and 8 to compare with', () => {
    expect([...new Set(clean.map((c) => c.k))].sort((a, b) => a - b)).toEqual([0, 2, 4, 8]);
    expect(clean.length).toBeGreaterThanOrEqual(7); // one k=2 round was a stall and is excluded
  });

  it('is within the drift ceiling of every clean saturated step, and the ceiling is inside the claimed tolerance', () => {
    expect(OBSERVED_WORST_PPM_CEILING).toBeLessThan(DEPLOYED_TOLERANCE_PPM);
    for (const c of clean) {
      const modelled = deployedCapacityPps(DEPLOYED_PAYLOAD_BYTES, BigInt(c.k));
      expect(ppm(modelled, c.measured), `k=${c.k} round ${c.round}: modelled ${modelled} measured ${c.measured}`).toBeLessThanOrEqual(OBSERVED_WORST_PPM_CEILING);
    }
  });

  it('is NOT satisfied by the earlier benchmark slope (4.24 us per rule): the comparison can fail', () => {
    const wrong = (k: bigint): bigint => PS_PER_SECOND / (80_000_000n + 4_240_000n * k);
    const worst = clean.reduce((m, c) => { const e = ppm(wrong(BigInt(c.k)), c.measured); return e > m ? e : m; }, 0n);
    expect(worst).toBeGreaterThan(OBSERVED_WORST_PPM_CEILING);
  });
});

describe('domain and target checks', () => {
  it('gives the fitted numbers: 80.0 us at k=0, 123.36 us at k=8', () => {
    expect(deployedPacketTimePs(572n, 0n)).toBe(80_000_000n);
    expect(deployedPacketTimePs(572n, 8n)).toBe(123_360_000n);
    expect(deployedCapacityPps(572n, 0n)).toBe(12_500n);
  });

  it('throws outside the measured payload and quarantine range, and explains why without throwing', () => {
    expect(() => deployedPacketTimePs(64n, 0n)).toThrow(DeployedCostDomainError);
    expect(() => deployedPacketTimePs(572n, 9n)).toThrow(DeployedCostDomainError);
    expect(() => deployedPacketTimePs(572n, -1n)).toThrow(DeployedCostDomainError);
    expect(explainDeployedDomain(1470n, 0n)).toMatch(/payload 1470 B/);
    expect(explainDeployedDomain(572n, DEPLOYED_MAX_QUARANTINES + 1n)).toMatch(/0 to 8/);
    expect(explainDeployedDomain(572n, 4n)).toBeNull();
  });

  it('rejects a target inside the tolerance margin (fails closed) and accepts one below it', () => {
    const cap = deployedCapacityPps(572n, 4n);
    expect(meetsDeployedCapacityTarget(572n, 4n, cap)).toBe(false);
    expect(meetsDeployedCapacityTarget(572n, 4n, (cap * (1_000_000n - DEPLOYED_TOLERANCE_PPM)) / 1_000_000n)).toBe(true);
    expect(meetsDeployedCapacityTarget(572n, 4n, (cap * (1_000_000n - DEPLOYED_TOLERANCE_PPM)) / 1_000_000n + 1n)).toBe(false);
    expect(() => meetsDeployedCapacityTarget(572n, 4n, -1n)).toThrow(DeployedCostDomainError);
  });
});

describe('classifyDeployedShape', () => {
  // The table the 2026-10-31 hardware run measured: the live policy, uplink ARP peers `none` (six rules). The builder's default (open uplink ARP, seven rules) was never measured.
  const policy = buildPort1IsolationPolicy(undefined, undefined, undefined, []);
  const drop = (id: string, ip: string, priority = 65535, extra: Record<string, unknown> = {}): IsolationRule => ({
    id, flowMod: { command: FlowModCommand.OFPFC_ADD, priority, outputPorts: [], match: { etherType: 0x0800, srcIp: ip, srcIpPrefixLen: 32, ...extra } },
  });

  it('does not model the builder\'s default policy (open uplink ARP, seven rules): that table was never measured', () => {
    const r = classifyDeployedShape(buildPort1IsolationPolicy());
    expect(r.modelled).toBe(false);
    expect(buildPort1IsolationPolicy().length).toBe(policy.length + 1);
    expect((r as { reason: string }).reason).toMatch(/measured/);
  });

  it('models the deployed policy alone and with quarantine DROPs after it', () => {
    expect(classifyDeployedShape(policy)).toEqual({ modelled: true, quarantineRuleIds: [] });
    expect(classifyDeployedShape([...policy, drop('quarantine-a', '10.0.2.101'), drop('quarantine-b', '10.0.2.102')])).toEqual({ modelled: true, quarantineRuleIds: ['quarantine-a', 'quarantine-b'] });
  });

  it('does not model DROPs installed BEFORE the policy (a different layout, not measured)', () => {
    const r = classifyDeployedShape([drop('quarantine-a', '10.0.2.101'), ...policy]);
    expect(r.modelled).toBe(false);
  });

  it('does not model a changed policy rule, a missing one, or a reordered one', () => {
    const changed = policy.map((r, i) => (i === 0 ? { ...r, flowMod: { ...r.flowMod, priority: r.flowMod.priority + 1 } } : r));
    expect(classifyDeployedShape(changed).modelled).toBe(false);
    expect(classifyDeployedShape(policy.slice(1)).modelled).toBe(false);
    expect(classifyDeployedShape([policy[1]!, policy[0]!, ...policy.slice(2)]).modelled).toBe(false);
  });

  it('does not model an extra forwarding rule, a DROP that is not an exact /32 source, or a DROP that does not outrank the policy', () => {
    const fwd: IsolationRule = { id: 'extra', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 10, outputPorts: [3], match: { inPort: 2 } } };
    expect(classifyDeployedShape([...policy, fwd]).modelled).toBe(false);
    expect(classifyDeployedShape([...policy, drop('quarantine-a', '10.0.2.101', 65535, { dstIp: '10.0.2.5' })]).modelled).toBe(false);
    expect(classifyDeployedShape([...policy, { id: 'quarantine-b', flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 65535, outputPorts: [], match: { etherType: 0x0800, srcIp: '10.0.2.0', srcIpPrefixLen: 24 } } }]).modelled).toBe(false);
    expect(classifyDeployedShape([...policy, drop('quarantine-c', '10.0.2.101', 100)]).modelled).toBe(false);
  });
});

describe('the 2026-10-31 live-policy run (docs/benchmarks/results/layout-capacity/run-2026-10-31-live-policy)', () => {
  interface LiveRow { round: number; k: number; capacityPps: number }
  const LIVE = JSON.parse(readFileSync('docs/benchmarks/results/layout-capacity/run-2026-10-31-live-policy/results.json', 'utf-8')) as LiveRow[];
  const BAND = 0.05; // the pre-registered band (PREREGISTRATION-live-policy-2026-10-31.md, prediction 1)
  const meanTimeUs = (k: number): number => { const rows = LIVE.filter((r) => r.k === k); return rows.reduce((a, r) => a + 1e6 / r.capacityPps, 0) / rows.length; };

  it('has both rounds at every k', () => {
    for (const k of [0, 2, 4, 8]) expect(LIVE.filter((r) => r.k === k)).toHaveLength(2);
  });
  it('the model is within the pre-registered 5% of the measured per-packet time at every k', () => {
    for (const k of [0, 2, 4, 8]) {
      const modelUs = Number(deployedPacketTimePs(DEPLOYED_PAYLOAD_BYTES, BigInt(k))) / 1e6;
      expect(Math.abs(meanTimeUs(k) - modelUs) / modelUs, `k=${k}`).toBeLessThanOrEqual(BAND);
    }
  });
  it('can fail: a model with the earlier benchmark\'s per-quarantine slope (4.24 us) would not pass the same check', () => {
    const worst = [0, 2, 4, 8].map((k) => { const wrong = 80.0 + 4.24 * k; return Math.abs(meanTimeUs(k) - wrong) / wrong; });
    expect(Math.max(...worst)).toBeGreaterThan(BAND);
  });
});
