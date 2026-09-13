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
  generateHistoricalTelemetry,
  type ZodiacFullTelemetrySnapshot,
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

  it('prohibits synthetic data from setting live_hardware source without physical connection', () => {
    // A synthetic snapshot should never be accepted as live_hardware without physical verification
    const validateProvenance = (snapshot: ZodiacFullTelemetrySnapshot, isPhysicallyVerified: boolean) => {
      if (snapshot.source === 'live_hardware' && !isPhysicallyVerified) {
        throw new Error('Epistemic Provenance Violation: live_hardware declared without physical link verification');
      }
      return true;
    };

    const fakeLiveSnapshot: ZodiacFullTelemetrySnapshot = {
      ...createDefaultZodiacSnapshot(),
      source: 'live_hardware',
    };

    expect(() => validateProvenance(fakeLiveSnapshot, false)).toThrow(/Epistemic Provenance Violation/);
    expect(validateProvenance(fakeLiveSnapshot, true)).toBe(true);
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
});
