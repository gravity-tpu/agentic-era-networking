/**
 * telemetry.ts
 * Core telemetry engine enforcing Jeff Dean latency and counter determinism invariants.
 *
 * Invariants:
 * - Counter values (packets, bytes) must be BigInt or 64-bit unsigned integers.
 * - Latency is tracked via monotonic high-resolution nanosecond timers.
 * - Floating-point arithmetic on packet/byte quantities is strictly prohibited.
 */

import process from 'node:process';

export interface PacketMetric {
  readonly interfaceName: string;
  readonly packetsIngress: bigint;
  readonly packetsEgress: bigint;
  readonly bytesIngress: bigint;
  readonly bytesEgress: bigint;
  readonly droppedPackets: bigint;
  readonly timestampNs: bigint;
}

export class TelemetryCounter {
  private packetsIngress: bigint = 0n;
  private packetsEgress: bigint = 0n;
  private bytesIngress: bigint = 0n;
  private bytesEgress: bigint = 0n;
  private droppedPackets: bigint = 0n;

  constructor(public readonly interfaceName: string) {
    if (!interfaceName || interfaceName.trim() === '') {
      throw new Error('TelemetryCounter: interfaceName cannot be empty');
    }
  }

  /**
   * Records ingress packets and byte volume.
   * Both inputs must be non-negative BigInts.
   */
  public recordIngress(packets: bigint, bytes: bigint): void {
    if (packets < 0n || bytes < 0n) {
      throw new RangeError('TelemetryCounter: metrics cannot be negative');
    }
    this.packetsIngress += packets;
    this.bytesIngress += bytes;
  }

  /**
   * Records egress packets and byte volume.
   */
  public recordEgress(packets: bigint, bytes: bigint): void {
    if (packets < 0n || bytes < 0n) {
      throw new RangeError('TelemetryCounter: metrics cannot be negative');
    }
    this.packetsEgress += packets;
    this.bytesEgress += bytes;
  }

  /**
   * Records dropped packets (fail-closed security drops or buffer overflows).
   */
  public recordDrop(packets: bigint = 1n): void {
    if (packets < 0n) {
      throw new RangeError('TelemetryCounter: drop count cannot be negative');
    }
    this.droppedPackets += packets;
  }

  /**
   * Captures an immutable snapshot of current counter state with monotonic timestamp.
   */
  public snapshot(): PacketMetric {
    return {
      interfaceName: this.interfaceName,
      packetsIngress: this.packetsIngress,
      packetsEgress: this.packetsEgress,
      bytesIngress: this.bytesIngress,
      bytesEgress: this.bytesEgress,
      droppedPackets: this.droppedPackets,
      timestampNs: process.hrtime.bigint(),
    };
  }

  /**
   * Computes exact byte rate (bytes/sec) between two snapshots using integer basis points.
   * Guaranteed zero IEEE-754 floating-point drift.
   */
  public static calculateThroughputBytesPerSec(
    before: PacketMetric,
    after: PacketMetric
  ): bigint {
    const timeDeltaNs = after.timestampNs - before.timestampNs;
    if (timeDeltaNs <= 0n) {
      throw new RangeError('calculateThroughputBytesPerSec: timeDeltaNs must be positive');
    }

    const bytesDelta = after.bytesIngress - before.bytesIngress;
    const ONE_SECOND_NS = 1_000_000_000n;

    // (bytesDelta * 1_000_000_000) / timeDeltaNs
    return (bytesDelta * ONE_SECOND_NS) / timeDeltaNs;
  }
}
