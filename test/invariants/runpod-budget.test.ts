import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RUN_CAP_MICROS,
  MAX_RUN_CAP_MICROS,
  parseUsdToMicros,
  planRun,
  encodePodName,
  decodePodDeadline,
  isExpired,
  placementFor,
  checkPlacementDuration,
  MAX_SPOT_SECONDS,
  type JobKind,
  type RunRequest,
} from '../../src/infra/runpod-budget.js';

const USD = 1_000_000n;

describe('parseUsdToMicros (Invariant 2: integer accounting)', () => {
  it('parses decimal prices exactly', () => {
    expect(parseUsdToMicros('1.79')).toBe(1_790_000n);
    expect(parseUsdToMicros(1.79)).toBe(1_790_000n);
    expect(parseUsdToMicros('0.000001')).toBe(1n);
    expect(parseUsdToMicros(16.4691638723)).toBe(16_469_163n);
  });
  it('rejects negatives, NaN, exponent form and junk (fail closed)', () => {
    for (const bad of ['-1', 'abc', '', '1e-7', NaN, Infinity, -0.5, '1.2.3']) {
      expect(() => parseUsdToMicros(bad as string | number)).toThrow();
    }
  });
});

describe('planRun (Invariant 3/4: refuses what it cannot afford)', () => {
  const base: RunRequest = {
    capMicros: 5n * USD,
    ratePerHourMicros: 1_790_000n,
    balanceMicros: 16n * USD,
    requestedSeconds: 3600n,
  };

  it('accepts a run inside the cap and prices it with integer ceil rounding', () => {
    const plan = planRun(base);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.estimatedMicros).toBe(1_790_000n);
      expect(plan.timeoutSeconds).toBe(3600n);
    }
  });
  it('rounds the estimate up, never down', () => {
    const plan = planRun({ ...base, ratePerHourMicros: 1n, requestedSeconds: 1n });
    expect(plan.ok && plan.estimatedMicros).toBe(1n);
  });
  it('rejects a run whose estimate exceeds the cap', () => {
    const plan = planRun({ ...base, requestedSeconds: 3n * 3600n });
    expect(plan).toMatchObject({ ok: false, code: 'ERR_OVER_CAP' });
  });
  it('rejects when the balance cannot cover the estimate', () => {
    const plan = planRun({ ...base, balanceMicros: 1n * USD });
    expect(plan).toMatchObject({ ok: false, code: 'ERR_INSUFFICIENT_BALANCE' });
  });
  it('rejects zero or missing price and non-positive duration', () => {
    expect(planRun({ ...base, ratePerHourMicros: 0n })).toMatchObject({ ok: false, code: 'ERR_NO_PRICE' });
    expect(planRun({ ...base, requestedSeconds: 0n })).toMatchObject({ ok: false, code: 'ERR_BAD_DURATION' });
  });
  it('rejects a cap above the hard ceiling', () => {
    const plan = planRun({ ...base, capMicros: MAX_RUN_CAP_MICROS + 1n });
    expect(plan).toMatchObject({ ok: false, code: 'ERR_CAP_ABOVE_CEILING' });
  });
  it('default cap is the $5 the owner approved and is under the ceiling', () => {
    expect(DEFAULT_RUN_CAP_MICROS).toBe(5n * USD);
    expect(DEFAULT_RUN_CAP_MICROS <= MAX_RUN_CAP_MICROS).toBe(true);
  });
});

describe('pod name deadline encoding (sweep terminates overdue pods)', () => {
  it('round-trips the deadline', () => {
    const name = encodePodName('lora-eval', 1_800_000_000n);
    expect(decodePodDeadline(name)).toBe(1_800_000_000n);
  });
  it('returns null for pods this tool did not create, so sweep never touches them', () => {
    expect(decodePodDeadline('someone-elses-pod')).toBeNull();
    expect(decodePodDeadline('zodiac-notanumber-x')).toBeNull();
  });
  it('sanitises labels', () => {
    expect(encodePodName('a b/c', 10n)).toBe('zodiac-10-a-b-c');
  });
  it('isExpired compares epoch seconds', () => {
    expect(isExpired(100n, 100n)).toBe(true);
    expect(isExpired(100n, 99n)).toBe(false);
    expect(isExpired(99n, 100n)).toBe(true);
  });
});

describe('placementFor (Secure on-demand is reserved for training)', () => {
  it('training is Secure Cloud on-demand and cannot be moved', () => {
    expect(placementFor('train')).toEqual({ cloud: 'secure', interruptible: false });
    expect(() => placementFor('train', { onDemand: true })).toThrow(/ERR_PLACEMENT/);
  });
  it('scoring and sweeps default to Community Cloud spot', () => {
    for (const kind of ['score', 'sweep'] as const) {
      expect(placementFor(kind)).toEqual({ cloud: 'community', interruptible: true });
    }
  });
  it('an explicit on-demand override stays on Community Cloud, never Secure', () => {
    expect(placementFor('score', { onDemand: true })).toEqual({ cloud: 'community', interruptible: false });
  });
  it('rejects unknown kinds (fail closed)', () => {
    expect(() => placementFor('whatever' as JobKind)).toThrow(/ERR_PLACEMENT/);
  });
});

describe('spot duration bound (preemption risk grows with run length)', () => {
  it('refuses a spot run longer than the named ceiling', () => {
    const over = MAX_SPOT_SECONDS + 1n;
    expect(checkPlacementDuration({ cloud: 'community', interruptible: true }, over)).toMatchObject({
      ok: false,
      code: 'ERR_SPOT_TOO_LONG',
    });
    expect(checkPlacementDuration({ cloud: 'community', interruptible: true }, MAX_SPOT_SECONDS).ok).toBe(true);
  });
  it('does not bound on-demand runs here (the cap bounds them)', () => {
    expect(checkPlacementDuration({ cloud: 'secure', interruptible: false }, 24n * 3600n).ok).toBe(true);
  });
});
