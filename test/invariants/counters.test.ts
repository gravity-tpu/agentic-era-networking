import { describe, it, expect } from 'vitest';
import { TelemetryCounter, PacketMetric } from '../../src/core/telemetry.js';

describe('Invariant: Telemetry & Counter Determinism (Dean Scale)', () => {
  it('enforces non-negative BigInt input invariants', () => {
    const counter = new TelemetryCounter('eth0');

    expect(() => counter.recordIngress(-1n, 100n)).toThrow(RangeError);
    expect(() => counter.recordIngress(100n, -1n)).toThrow(RangeError);
    expect(() => counter.recordEgress(-5n, 100n)).toThrow(RangeError);
    expect(() => counter.recordDrop(-1n)).toThrow(RangeError);
  });

  it('guarantees exact BigInt math with zero IEEE-754 precision drift', () => {
    const counter = new TelemetryCounter('eth0');

    // Simulate 100,000 packet arrivals of 1514 bytes each
    const packetCount = 100_000n;
    const packetSize = 1514n;
    const expectedBytes = packetCount * packetSize; // 151,400,000 bytes

    for (let i = 0; i < 1000; i++) {
      counter.recordIngress(100n, 151400n);
    }

    const snap = counter.snapshot();
    expect(snap.packetsIngress).toBe(packetCount);
    expect(snap.bytesIngress).toBe(expectedBytes);

    // Verify type is bigint, not number
    expect(typeof snap.packetsIngress).toBe('bigint');
    expect(typeof snap.bytesIngress).toBe('bigint');
  });

  it('computes throughput using pure integer basis with zero floating point drift', () => {
    const before: PacketMetric = {
      interfaceName: 'eth0',
      packetsIngress: 1_000n,
      packetsEgress: 500n,
      bytesIngress: 1_000_000n,
      bytesEgress: 500_000n,
      droppedPackets: 0n,
      timestampNs: 1_000_000_000n, // t = 1.0s
    };

    const after: PacketMetric = {
      interfaceName: 'eth0',
      packetsIngress: 2_000n,
      packetsEgress: 1_000n,
      bytesIngress: 11_000_000n, // +10,000,000 bytes
      bytesEgress: 5_500_000n,
      droppedPackets: 0n,
      timestampNs: 2_000_000_000n, // t = 2.0s (+1 second)
    };

    const rate = TelemetryCounter.calculateThroughputBytesPerSec(before, after);
    expect(rate).toBe(10_000_000n); // Exactly 10 MB/s
    expect(typeof rate).toBe('bigint');
  });

  it('throws on non-positive time delta', () => {
    const snap: PacketMetric = {
      interfaceName: 'eth0',
      packetsIngress: 0n,
      packetsEgress: 0n,
      bytesIngress: 0n,
      bytesEgress: 0n,
      droppedPackets: 0n,
      timestampNs: 1_000_000n,
    };

    expect(() => TelemetryCounter.calculateThroughputBytesPerSec(snap, snap)).toThrow(RangeError);
  });
});
