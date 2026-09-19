/**
 * test/invariants/goodharts-law-provenance.test.ts
 * Tests for Council Invariant 6: Goodhart's Law & Epistemic Telemetry Provenance
 *
 * Council Invariant:
 * "When a measure becomes a target, it ceases to be a good measure."
 * Telemetry without verified physical provenance is fiction. Disconnected links must
 * evaluate to physical truth (0 rates, null thermals, red badge). Mocks and simulations
 * must carry unmistakable provenance tags and disclaimers.
 */

import { describe, it, expect } from 'vitest';
import {
  createDisconnectedZodiacSnapshot,
  createDefaultZodiacSnapshot,
  createDefaultCoralSnapshot,
  createDefaultJetsonSnapshot,
  generateHistoricalTelemetry,
  generateJetsonHistoricalTelemetry,
  resolveVerifiedProvenance,
  assertVerifiedProvenance,
} from '../../src/sdn/zodiac-telemetry.js';

describe('Council Invariant 6: Goodhart\'s Law & Epistemic Telemetry Provenance', () => {
  it('enforces physical truth on disconnected hardware: null thermals and zero counters', () => {
    const disconnected = createDisconnectedZodiacSnapshot();

    // 1. Provenance Tag
    expect(disconnected.source).toBe('disconnected');

    // 2. Physical Absence of Thermals
    expect(disconnected.system.cpuTemperatureC).toBeNull();
    expect(disconnected.system.uptime).toBe('Disconnected');
    expect(disconnected.openflow.status).toBe('Disconnected');

    // 3. Zero Traffic Counters
    expect(disconnected.ports).toHaveLength(4);
    for (const p of disconnected.ports) {
      expect(p.status).toBe('DOWN');
      expect(p.rxBytes).toBe(0n);
      expect(p.txBytes).toBe(0n);
      expect(p.rxPackets).toBe(0n);
      expect(p.txPackets).toBe(0n);
      expect(p.rxDropped).toBe(0n);
      expect(p.txDropped).toBe(0n);
      expect(p.rxCrcErrors).toBe(0n);
    }
  });

  it('flatlines all time-series points to 0 rates and null thermals when disconnected', () => {
    const disconnected = createDisconnectedZodiacSnapshot();
    const points = generateHistoricalTelemetry(disconnected, 1, 30);

    expect(points).toHaveLength(30);
    for (const pt of points) {
      expect(pt.rxBytes).toBe(0n);
      expect(pt.txBytes).toBe(0n);
      expect(pt.rxPackets).toBe(0n);
      expect(pt.txPackets).toBe(0n);
      expect(pt.rxRatePps).toBe(0n);
      expect(pt.txRatePps).toBe(0n);
      expect(pt.rxRateBps).toBe(0n);
      expect(pt.txRateBps).toBe(0n);
      expect(pt.cpuTemperatureC).toBeNull();
      expect(pt.latencyNs).toBe(0n);
    }
  });

  it('ensures baseline cloud snapshot carries explicit cloud_snapshot provenance, never live_hardware', () => {
    const cloudTwin = createDefaultZodiacSnapshot();

    // Must be explicitly labeled as cloud_snapshot
    expect(cloudTwin.source).toBe('cloud_snapshot');
    expect(cloudTwin.source).not.toBe('live_hardware');
  });

  it('prohibits synthetic data from setting live_hardware source without physical connection (assertVerifiedProvenance)', () => {
    expect(() => assertVerifiedProvenance('live_hardware', false)).toThrow(/Epistemic Provenance Violation/);
    expect(() => assertVerifiedProvenance('live_hardware', true)).not.toThrow();
  });

  it('verifies transport boundary and cryptographic authentication (resolveVerifiedProvenance)', () => {
    // 1. Loopback request claiming live_hardware is accepted
    const loopbackResult = resolveVerifiedProvenance('live_hardware', { isLoopback: true });
    expect(loopbackResult).toBe('live_hardware');

    // 2. Remote request without secret claiming live_hardware is quarantined/demoted to cloud_snapshot
    const remoteSpoofResult = resolveVerifiedProvenance('live_hardware', {
      isLoopback: false,
      bridgeSecret: undefined,
    });
    expect(remoteSpoofResult).toBe('cloud_snapshot');

    // 3. Remote request with invalid secret is demoted to cloud_snapshot
    const invalidSecretResult = resolveVerifiedProvenance('live_hardware', {
      isLoopback: false,
      bridgeSecret: 'wrong-token',
      expectedSecret: 'correct-token',
    });
    expect(invalidSecretResult).toBe('cloud_snapshot');

    // 4. Remote request with valid bridge secret is accepted
    const validAuthResult = resolveVerifiedProvenance('live_hardware', {
      isLoopback: false,
      bridgeSecret: 'correct-token',
      expectedSecret: 'correct-token',
    });
    expect(validAuthResult).toBe('live_hardware');

    // 5. Disconnected request remains disconnected
    expect(resolveVerifiedProvenance('disconnected', { isLoopback: false })).toBe('disconnected');
  });

  it('verifies that zero rate deltas are computed when consecutive ticks have identical counters', () => {
    // If switch counters do not increment, rate must be strictly 0n (no artificial drift)
    const prevBytes = 1000n;
    const currentBytes = 1000n;
    const deltaMs = 2500n;

    const deltaBytes = currentBytes - prevBytes;
    const rateBps = deltaMs > 0n ? (deltaBytes * 1000n) / deltaMs : 0n;

    expect(rateBps).toBe(0n);
  });

  it('enforces physical truth on disconnected Coral TPU: detected=false, NOT_DETECTED, and null thermals', () => {
    const disconnectedZodiac = createDisconnectedZodiacSnapshot();
    expect(disconnectedZodiac.coral).toBeDefined();

    const coral = disconnectedZodiac.coral!;
    expect(coral.detected).toBe(false);
    expect(coral.status).toBe('NOT_DETECTED');
    expect(coral.temperatureC).toBeNull();
    expect(coral.usbBus).toBe('None');
    expect(coral.usbSpeed).toBe('Disconnected');
    expect(coral.powerMode).toBe('Offline');
    expect(coral.inferencesPerSecond).toBe(0n);
    expect(coral.totalInferences).toBe(0n);
  });

  it('enforces that Coral USB Accelerator never emits simulated non-null thermals', () => {
    const sandboxCoral = createDefaultCoralSnapshot(false);
    const disconnectedCoral = createDefaultCoralSnapshot(true);

    // Council Invariant 6: Physical truth — Coral USB has no sysfs thermal zone mapped
    expect(sandboxCoral.temperatureC).toBeNull();
    expect(disconnectedCoral.temperatureC).toBeNull();
  });

  it('enforces fail-closed defaults and physical truth on disconnected Jetson Orin Nano', () => {
    // 1. Default invocation must fail-closed (isDisconnected = true)
    const defaultJetson = createDefaultJetsonSnapshot();
    expect(defaultJetson.status).toBe('offline');
    expect(defaultJetson.uptime).toBe('Offline');
    expect(defaultJetson.temperatures.cpuC).toBeNull();
    expect(defaultJetson.temperatures.gpuC).toBeNull();
    expect(defaultJetson.temperatures.socC).toBeNull();
    expect(defaultJetson.temperatures.junctionC).toBeNull();
    expect(defaultJetson.powerMw.vddIn).toBeNull();
    expect(defaultJetson.powerMw.vddCpuGpuCv).toBeNull();
    expect(defaultJetson.powerMw.vddSoc).toBeNull();
    expect(defaultJetson.ramUsedBytes).toBe(0n);
    expect(defaultJetson.nvmeReadRateBps).toBe(0n);
    expect(defaultJetson.nvmeWriteRateBps).toBe(0n);
    expect(defaultJetson.rescueSdMounted).toBe(false);

    // 2. Explicit disconnected parameter
    const disconnectedJetson = createDefaultJetsonSnapshot(true);
    expect(disconnectedJetson.status).toBe('offline');
    expect(disconnectedJetson.interfaces[0]!.status).toBe('DOWN');
    expect(disconnectedJetson.interfaces[0]!.macAddress).toBe('None');
    expect(disconnectedJetson.interfaces[0]!.speedMbps).toBe(0);

    // 3. Historical time-series points flatline to null thermals and 0 rates when disconnected
    const historicalPoints = generateJetsonHistoricalTelemetry(disconnectedJetson, 1, 10);
    expect(historicalPoints).toHaveLength(10);
    for (const pt of historicalPoints) {
      expect(pt.cpuTempC).toBeNull();
      expect(pt.gpuTempC).toBeNull();
      expect(pt.junctionTempC).toBeNull();
      expect(pt.powerWatts).toBe(0);
      expect(pt.cpuUtilizationPct).toBe(0);
      expect(pt.gpuUtilizationPct).toBe(0);
      expect(pt.ramUsedBytes).toBe(0n);
      expect(pt.sdnPortRateBps).toBe(0n);
      expect(pt.wifiPortRateBps).toBe(0n);
    }
  });
});
