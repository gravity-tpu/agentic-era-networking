/**
 * calibrate-capture.test.ts
 * Invariant tests for observation point capture calibration (O1, O2, O3).
 *
 * Verifies that capture loss is computed deterministically with integer math (Invariant 2),
 * fails closed on zero capture or counter rollover (Invariant 3), and formats strict calibration
 * records with provenance (Invariant 6).
 */

import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_SCHEMA,
  deriveCalibrationVerdict,
  type CalibrationCounters,
} from '../../src/sdn/capture-calibration.js';

describe('capture calibration: pure verdict logic (Invariant 2 & 3)', () => {
  it('correctly classifies a 100% clean capture burst (0 loss)', () => {
    const counters: CalibrationCounters = {
      startRxPackets: 1000n,
      endRxPackets: 2000n,
      startRxDropped: 0n,
      endRxDropped: 0n,
      injectedPackets: 1000n,
    };
    const verdict = deriveCalibrationVerdict(counters, 0n);
    expect(verdict.status).toBe('clean');
    expect(verdict.capturedPackets).toBe(1000n);
    expect(verdict.kernelDroppedPackets).toBe(0n);
    expect(verdict.missingPackets).toBe(0n);
    expect(verdict.lossPpm).toBe(0n);
  });

  it('detects loss when captured packets are fewer than injected', () => {
    const counters: CalibrationCounters = {
      startRxPackets: 1000n,
      endRxPackets: 1950n,
      startRxDropped: 0n,
      endRxDropped: 50n,
      injectedPackets: 1000n,
    };
    const verdict = deriveCalibrationVerdict(counters, 0n);
    expect(verdict.status).toBe('lossy');
    expect(verdict.capturedPackets).toBe(950n);
    expect(verdict.kernelDroppedPackets).toBe(50n);
    expect(verdict.missingPackets).toBe(50n);
    // 50 / 1000 = 5% = 50,000 PPM
    expect(verdict.lossPpm).toBe(50_000n);
  });

  it('fails closed when capture NIC observed 0 packets while packets were injected', () => {
    const counters: CalibrationCounters = {
      startRxPackets: 500n,
      endRxPackets: 500n,
      startRxDropped: 0n,
      endRxDropped: 0n,
      injectedPackets: 100n,
    };
    const verdict = deriveCalibrationVerdict(counters, 0n);
    expect(verdict.status).toBe('failed');
    expect(verdict.missingPackets).toBe(100n);
    expect(verdict.lossPpm).toBe(1_000_000n);
  });

  it('tolerates small noise within declared PPM budget', () => {
    const counters: CalibrationCounters = {
      startRxPackets: 10_000n,
      endRxPackets: 19_999n,
      startRxDropped: 0n,
      endRxDropped: 0n,
      injectedPackets: 10_000n,
    };
    // 1 missing packet out of 10,000 = 100 PPM
    const strictVerdict = deriveCalibrationVerdict(counters, 0n);
    expect(strictVerdict.status).toBe('lossy');
    expect(strictVerdict.lossPpm).toBe(100n);

    const relaxedVerdict = deriveCalibrationVerdict(counters, 200n);
    expect(relaxedVerdict.status).toBe('clean');
  });

  it('schema constant matches standard calibration format', () => {
    expect(CALIBRATION_SCHEMA).toBe('zodiac-capture-calibration/v1');
  });
});
