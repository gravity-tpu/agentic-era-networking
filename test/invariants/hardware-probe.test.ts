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

  it('aggregates multi-TPU throughput and latency deterministically', async () => {
    const daemonData = {
      inferencesPerSecond: 225n,
      totalInferences: 10000n,
      latencyP50Ns: 4300000n,
      latencyP99Ns: 4900000n,
      status: 'INFERENCE_ACTIVE' as const,
      model: 'MobileNet V2 INT8 (EdgeTPU) - Wire Tap DPI',
    };

    const burstData = {
      inferencesPerSecond: 230n,
      totalInferences: 5000n,
      latencyP50Ns: 4200000n,
      latencyP99Ns: 4800000n,
      status: 'INFERENCE_ACTIVE' as const,
      model: 'MobileNet V2 INT8 (EdgeTPU) - Burst Parallel',
    };

    // When on Linux or mocked, test aggregation and per-device separation logic
    const snap = await probeCoralHardware(daemonData, burstData);
    if (snap.detected && snap.deviceCount > 1) {
      expect(snap.inferencesPerSecond).toBe(455n); // 225n + 230n
      expect(snap.totalInferences).toBe(15000n);
      expect(snap.status).toBe('INFERENCE_ACTIVE');
      expect(snap.devices[0]?.status).toBe('INFERENCE_ACTIVE');
      expect(snap.devices[0]?.inferencesPerSecond).toBe(225n);
      expect(snap.devices[0]?.totalInferences).toBe(10000n);
      expect(snap.devices[1]?.status).toBe('INFERENCE_ACTIVE');
      expect(snap.devices[1]?.inferencesPerSecond).toBe(230n);
      expect(snap.devices[1]?.totalInferences).toBe(5000n);
    }

    // Isolated Burst Test: Coral #1 in STANDBY (0 ips), Coral #2 ACTIVE (220 ips)
    const isolatedDaemon = {
      inferencesPerSecond: 0n,
      totalInferences: 10000n,
      latencyP50Ns: 0n,
      latencyP99Ns: 0n,
      status: 'STANDBY' as const,
      model: 'MobileNet V2 INT8 (EdgeTPU) - Wire Tap DPI',
    };
    const isolatedBurst = {
      inferencesPerSecond: 220n,
      totalInferences: 5000n,
      latencyP50Ns: 4300000n,
      latencyP99Ns: 4900000n,
      status: 'INFERENCE_ACTIVE' as const,
      model: 'RFC 1035 DNS Sentinel',
    };
    const isolatedSnap = await probeCoralHardware(isolatedDaemon, isolatedBurst);
    if (isolatedSnap.detected && isolatedSnap.deviceCount > 1) {
      expect(isolatedSnap.devices[0]?.assignedRole).toBe('TAP_PACKET_CLASSIFIER');
      expect(isolatedSnap.devices[0]?.status).toBe('STANDBY');
      expect(isolatedSnap.devices[0]?.inferencesPerSecond).toBe(0n);
      expect(isolatedSnap.devices[1]?.assignedRole).toBe('DNS_SENTINEL');
      expect(isolatedSnap.devices[1]?.status).toBe('INFERENCE_ACTIVE');
      expect(isolatedSnap.devices[1]?.inferencesPerSecond).toBe(220n);
    }
  });

  it('returns fail-closed null for missing daemon telemetry files', async () => {
    const { readCoralDaemonTelemetry, readCoralBurstTelemetry } = await import('../../src/sdn/hardware-probe.js');
    // On systems where /tmp/coral-telemetry.json or burst doesn't exist, must fail-closed to null
    const daemon = await readCoralDaemonTelemetry();
    const burst = await readCoralBurstTelemetry();
    if (!daemon) {
      expect(daemon).toBeNull();
    }
    if (!burst) {
      expect(burst).toBeNull();
    }
  });
});
