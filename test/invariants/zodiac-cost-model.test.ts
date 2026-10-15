/**
 * zodiac-cost-model.test.ts
 * Checks the cost model against the stored physical ladder artifacts (docs/benchmarks/results/), plus its
 * domain limits. The artifact comparison is a real check against measurements, not a fixture: the model must
 * stay within MODEL_TOLERANCE_PPM of every saturated ladder step, and a mutated model must fail it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CostModelDomainError,
  MAX_MEASURED_PAYLOAD_BYTES,
  MAX_MODELLED_RULES,
  MODEL_TOLERANCE_PPM,
  PS_PER_SECOND,
  capacityPps,
  meetsCapacityTarget,
  packetTimePs,
  type CostLayout,
} from '../../src/sdn/zodiac-cost-model.js';

// The two result directories the depth analysis was produced from (see docs/benchmarks/zodiac-fx-depth-analysis-2026-10-04.md).
const RESULT_DIRS = ['docs/benchmarks/results/ladder-2026-10-04', 'docs/benchmarks/results/full-2026-10-04'];

type Num = number | { $bigint: string };
interface LadderStep {
  depth: number;
  offeredPps: Num;
  sessionLost: boolean;
  trial: { metrics: { switchPort2TxPps: Num } | null };
}
interface LadderArtifact {
  provenance: { origin: string };
  params: { layout: string; udpPayloadBytes: number };
  steps: LadderStep[];
}

function big(n: Num): bigint {
  return typeof n === 'number' ? BigInt(n) : BigInt(n.$bigint);
}

interface SaturatedPoint {
  file: string;
  layout: CostLayout;
  payload: bigint;
  rules: bigint;
  measuredPps: bigint;
}

/** Same rule as analysis/analyze_depth.py: a step is saturated when forwarded < 90% of offered; highest per (layout, payload, depth). */
function loadSaturatedPoints(): SaturatedPoint[] {
  const best = new Map<string, SaturatedPoint>();
  for (const dir of RESULT_DIRS) {
    for (const name of readdirSync(dir).filter((f) => /^depth-ladder-.*\.json$/.test(f)).sort()) {
      const art = JSON.parse(readFileSync(join(dir, name), 'utf8')) as LadderArtifact;
      if (art.provenance.origin !== 'physical_bench_run') continue;
      const layout = art.params.layout === 'fwdfirst' ? 'forward_first' : art.params.layout;
      if (layout !== 'base' && layout !== 'forward_first') continue;
      for (const s of art.steps) {
        if (s.sessionLost || s.trial.metrics === null) continue;
        const forwarded = big(s.trial.metrics.switchPort2TxPps);
        if (forwarded * 100n >= big(s.offeredPps) * 90n) continue;
        const key = `${layout}/${art.params.udpPayloadBytes}/${s.depth}`;
        const prev = best.get(key);
        if (prev === undefined || forwarded > prev.measuredPps) {
          best.set(key, { file: name, layout, payload: BigInt(art.params.udpPayloadBytes), rules: BigInt(s.depth), measuredPps: forwarded });
        }
      }
    }
  }
  return [...best.values()];
}

function errorPpm(modelPps: bigint, measuredPps: bigint): bigint {
  const diff = modelPps - measuredPps;
  return ((diff < 0n ? -diff : diff) * 1_000_000n) / measuredPps;
}

describe('cost model against stored physical artifacts', () => {
  const points = loadSaturatedPoints();

  it('has enough measured points to be a real check (not vacuous)', () => {
    expect(points.length).toBeGreaterThanOrEqual(10);
    expect(new Set(points.map((p) => p.layout))).toEqual(new Set(['base', 'forward_first']));
    expect(new Set(points.map((p) => p.payload))).toContain(64n);
    expect(new Set(points.map((p) => p.payload))).toContain(572n);
  });

  it('is within MODEL_TOLERANCE_PPM of every saturated measurement', () => {
    for (const p of points) {
      const err = errorPpm(capacityPps(p.layout, p.payload, p.rules), p.measuredPps);
      expect(err, `${p.file} ${p.layout} ${p.payload}B ${p.rules} rules`).toBeLessThanOrEqual(MODEL_TOLERANCE_PPM);
    }
  });

  it('can fail: a model with the per-rule cost off by 5% exceeds the tolerance somewhere', () => {
    let worst = 0n;
    for (const p of points) {
      if (p.rules === 0n) continue;
      const t = packetTimePs(p.layout, p.payload, p.rules);
      const perRule = packetTimePs(p.layout, p.payload, 1n) - packetTimePs(p.layout, p.payload, 0n);
      const mutated = PS_PER_SECOND / (t + (perRule * p.rules * 5n) / 100n);
      const err = errorPpm(mutated, p.measuredPps);
      if (err > worst) worst = err;
    }
    expect(worst).toBeGreaterThan(MODEL_TOLERANCE_PPM);
  });
});

describe('cost model shape and domain', () => {
  it('reproduces the documented anchors', () => {
    // 38.5 us fixed at 64 B; 56.18 us at 572 B (documented 56.2); +4.24 us per rule.
    expect(packetTimePs('base', 64n, 0n)).toBe(38_500_000n);
    expect(packetTimePs('base', 572n, 0n)).toBe(56_178_400n);
    expect(packetTimePs('base', 64n, 10n)).toBe(38_500_000n + 42_400_000n);
    // forward_first: 58.0 us fixed at 572 B, 1.30 us per rule.
    expect(packetTimePs('forward_first', 572n, 0n)).toBe(58_000_000n);
    expect(packetTimePs('forward_first', 572n, 100n)).toBe(58_000_000n + 130_000_000n);
  });

  it('capacity falls as rules grow, and forward_first beats base once there are rules', () => {
    let prev = capacityPps('base', 572n, 0n);
    for (let r = 1n; r <= MAX_MODELLED_RULES; r++) {
      const c = capacityPps('base', 572n, r);
      expect(c).toBeLessThan(prev);
      prev = c;
    }
    expect(capacityPps('forward_first', 572n, 64n)).toBeGreaterThan(capacityPps('base', 572n, 64n));
  });

  it('capacity falls as payload grows', () => {
    expect(capacityPps('base', 1470n, 16n)).toBeLessThan(capacityPps('base', 64n, 16n));
  });

  it('fails closed outside the measured domain', () => {
    expect(() => packetTimePs('base', 63n, 0n)).toThrow(CostModelDomainError);
    expect(() => packetTimePs('base', MAX_MEASURED_PAYLOAD_BYTES + 1n, 0n)).toThrow(CostModelDomainError);
    expect(() => packetTimePs('base', 572n, -1n)).toThrow(CostModelDomainError);
    expect(() => packetTimePs('base', 572n, MAX_MODELLED_RULES + 1n)).toThrow(CostModelDomainError);
    expect(() => capacityPps('hitfirst' as CostLayout, 572n, 0n)).toThrow(CostModelDomainError);
  });

  it('meetsCapacityTarget rejects a target inside the model tolerance of capacity', () => {
    const cap = capacityPps('base', 572n, 24n);
    expect(meetsCapacityTarget('base', 572n, 24n, cap / 2n)).toBe(true);
    expect(meetsCapacityTarget('base', 572n, 24n, cap)).toBe(false);
    expect(meetsCapacityTarget('base', 572n, 24n, cap - cap / 100n)).toBe(false); // 1% below: within the 2% tolerance
    expect(meetsCapacityTarget('base', 572n, 24n, cap - (cap * 3n) / 100n)).toBe(true);
    expect(() => meetsCapacityTarget('base', 572n, 24n, -1n)).toThrow(CostModelDomainError);
  });
});
