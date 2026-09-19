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
  compareUsbTopology,
} from '../../src/sdn/hardware-probe.js';

describe('Jetson Orin & Coral TPU Hardware Invariants', () => {
  it('deterministically sorts USB topologies numerically across port expansions (Quoc Le Invariant)', () => {
    const rawPaths = ['2-1.10', '2-1.2', '1-1.1', '2-1.1', '2-1.3'];
    rawPaths.sort(compareUsbTopology);
    expect(rawPaths).toEqual(['1-1.1', '2-1.1', '2-1.2', '2-1.3', '2-1.10']);
  });

  it('strictly rejects non-numeric segments in USB topology comparison', () => {
    // Malformed segments with letters (e.g. '1a') evaluate as -1 vs valid positive integers
    expect(compareUsbTopology('2-1.1a', '2-1.2')).toBeLessThan(0);
    expect(compareUsbTopology('2-1.2', '2-1.1a')).toBeGreaterThan(0);
    expect(compareUsbTopology('2-1.2', '2-1.2')).toBe(0);
  });

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

  it('creates valid default Coral snapshot with 4 TOPS and Dean latency budget in sandbox mode', () => {
    const coral = createDefaultCoralSnapshot(false);
    expect(coral.detected).toBe(true);
    expect(coral.deviceCount).toBe(1);
    expect(coral.devices).toHaveLength(1);
    expect(coral.devices?.[0]?.assignedRole).toBe('TAP_PACKET_CLASSIFIER');
    expect(coral.peakTopsInt8).toBe(4);
    expect(coral.vendorId).toBe('1a6e');
    expect(coral.targetLatencyBudgetNs).toBe(500000n); // 500 µs
    expect(typeof coral.inferencesPerSecond).toBe('bigint');
    expect(typeof coral.totalInferences).toBe('bigint');
    expect(coral.temperatureC).toBeNull();
  });

  it('creates fail-closed disconnected Coral snapshot by default (Council Invariant 6)', () => {
    const coral = createDefaultCoralSnapshot(); // Defaults to isDisconnected = true
    expect(coral.detected).toBe(false);
    expect(coral.deviceCount).toBe(0);
    expect(coral.devices).toHaveLength(0);
    expect(coral.status).toBe('NOT_DETECTED');
    expect(coral.temperatureC).toBeNull();
    expect(coral.vendorId).toBe('None');
    expect(coral.productId).toBe('None');
    expect(coral.usbBus).toBe('None');
    expect(coral.usbSpeed).toBe('Disconnected');
    expect(coral.powerMode).toBe('Offline');
    expect(coral.inferencesPerSecond).toBe(0n);
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

  it('probeJetsonHardware returns valid snapshot structure', async () => {
    const snap = await probeJetsonHardware();
    expect(snap.cpuCoreCount).toBe(6);
    expect(typeof snap.ramUsedBytes).toBe('bigint');
    expect(snap.interfaces.length).toBeGreaterThan(0);
  });

  it('probeCoralHardware returns valid snapshot and fails closed when unlinked', async () => {
    const snap = await probeCoralHardware();
    expect(typeof snap.targetLatencyBudgetNs).toBe('bigint');
    expect(snap.temperatureC).toBeNull();
    if (process.platform !== 'linux') {
      expect(snap.detected).toBe(false);
      expect(snap.status).toBe('NOT_DETECTED');
    }
  });
});
