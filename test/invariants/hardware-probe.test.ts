/**
 * test/invariants/hardware-probe.test.ts
 * Invariant tests for Jetson Orin Nano & Google Coral TPU telemetry
 *
 * Council Invariants Enforced:
 * - Anti-Simulation Law & Epistemic Telemetry Provenance (Council Invariant 6).
 * - Determinism in Telemetry (BigInt counters, Dean Invariant).
 */

import { describe, it, expect } from 'vitest';
import {
  createDefaultJetsonSnapshot,
  createDefaultCoralSnapshot,
  generateJetsonHistoricalTelemetry,
  generateCoralHistoricalTelemetry,
  createDefaultZodiacSnapshot,
} from '../../src/sdn/zodiac-telemetry.js';
import {
  probeJetsonHardware,
  probeCoralHardware,
} from '../../src/sdn/hardware-probe.js';

describe('Jetson Orin & Coral TPU Hardware Invariants', () => {
  it('creates valid default Jetson snapshot with BigInt memory and network counters', () => {
    const jetson = createDefaultJetsonSnapshot(false);
    expect(jetson.deviceName).toBe('jetson-orin');
    expect(jetson.cpuCoreCount).toBe(6);
    expect(typeof jetson.ramUsedBytes).toBe('bigint');
    expect(typeof jetson.ramTotalBytes).toBe('bigint');
    expect(typeof jetson.nvmeUsedBytes).toBe('bigint');
    expect(jetson.interfaces).toHaveLength(2);

    const sdnIf = jetson.interfaces.find((i) => i.name === 'enP8p1s0');
    expect(sdnIf).toBeDefined();
    expect(sdnIf?.status).toBe('UP');
    expect(typeof sdnIf?.rxBytes).toBe('bigint');
    expect(typeof sdnIf?.txBytes).toBe('bigint');
    expect(typeof sdnIf?.rxRateBps).toBe('bigint');
  });

  it('creates valid default Coral snapshot with 4 TOPS and Dean latency budget', () => {
    const coral = createDefaultCoralSnapshot(false);
    expect(coral.detected).toBe(true);
    expect(coral.peakTopsInt8).toBe(4);
    expect(coral.vendorId).toBe('1a6e');
    expect(coral.targetLatencyBudgetNs).toBe(500000n); // 500 µs
    expect(typeof coral.inferencesPerSecond).toBe('bigint');
    expect(typeof coral.totalInferences).toBe('bigint');
  });

  it('generates deterministic historical time series for Jetson', () => {
    const jetson = createDefaultJetsonSnapshot(false);
    const series = generateJetsonHistoricalTelemetry(jetson, 1, 30);
    expect(series).toHaveLength(30);

    for (const pt of series) {
      expect(pt.cpuUtilizationPct).toBeGreaterThanOrEqual(0);
      expect(pt.cpuUtilizationPct).toBeLessThanOrEqual(100);
      expect(typeof pt.ramUsedBytes).toBe('bigint');
      expect(typeof pt.sdnPortRateBps).toBe('bigint');
      expect(typeof pt.wifiPortRateBps).toBe('bigint');
      expect(pt.powerWatts).toBeGreaterThan(0);
    }
  });

  it('generates deterministic historical time series for Coral', () => {
    const coral = createDefaultCoralSnapshot(false);
    const series = generateCoralHistoricalTelemetry(coral, 1, 30);
    expect(series).toHaveLength(30);

    for (const pt of series) {
      expect(typeof pt.inferencesPerSecond).toBe('bigint');
      expect(typeof pt.tapPacketsPerSecond).toBe('bigint');
      expect(pt.latencyP50Us).toBeGreaterThanOrEqual(0);
      expect(pt.usbThroughputKbps).toBeGreaterThanOrEqual(0);
    }
  });

  it('attaches Jetson and Coral snapshots to full Zodiac snapshot', () => {
    const full = createDefaultZodiacSnapshot();
    expect(full.jetson).toBeDefined();
    expect(full.coral).toBeDefined();
    expect(full.jetson?.interfaces).toHaveLength(2);
    expect(full.coral?.detected).toBe(true);
  });

  it('probeJetsonHardware returns valid snapshot structure', () => {
    const snap = probeJetsonHardware();
    expect(snap.cpuCoreCount).toBe(6);
    expect(typeof snap.ramUsedBytes).toBe('bigint');
    expect(snap.interfaces.length).toBeGreaterThan(0);
  });

  it('probeCoralHardware returns valid snapshot structure', () => {
    const snap = probeCoralHardware();
    expect(snap.peakTopsInt8).toBe(4);
    expect(typeof snap.targetLatencyBudgetNs).toBe('bigint');
  });
});
