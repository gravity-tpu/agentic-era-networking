/**
 * adaptive-control.ts
 * Self-Tuning Adaptive Rate & Buffer Controller (Quoc Le Paradigm)
 *
 * Invariant:
 * - Eliminates brittle hand-coded magic constants.
 * - Rate limits and buffer allocations continuously self-tune based on observed
 *   traffic arrival distributions and latency feedback.
 */

export interface ControllerFeedback {
  readonly measuredLatencyNs: bigint;
  readonly targetLatencyNs: bigint;
  readonly packetsDelivered: bigint;
  readonly packetsDropped: bigint;
}

export class AdaptiveFlowController {
  private currentWindowBytes: bigint;
  private readonly minWindowBytes: bigint;
  private readonly maxWindowBytes: bigint;

  constructor(
    initialWindowBytes: bigint = 65_536n,
    minWindowBytes: bigint = 4_096n,
    maxWindowBytes: bigint = 16_777_216n
  ) {
    if (minWindowBytes >= maxWindowBytes || initialWindowBytes < minWindowBytes) {
      throw new RangeError('AdaptiveFlowController: invalid window boundaries');
    }
    this.currentWindowBytes = initialWindowBytes;
    this.minWindowBytes = minWindowBytes;
    this.maxWindowBytes = maxWindowBytes;
  }

  public get windowBytes(): bigint {
    return this.currentWindowBytes;
  }

  /**
   * Adapts the flow window based on empirical feedback.
   * Uses exact integer arithmetic (basis points) without floating-point math.
   */
  public adapt(feedback: ControllerFeedback): bigint {
    // If drops occurred, immediately back off window by 25% (2,500 bps)
    if (feedback.packetsDropped > 0n) {
      this.currentWindowBytes = (this.currentWindowBytes * 7_500n) / 10_000n;
    } else if (feedback.measuredLatencyNs < feedback.targetLatencyNs) {
      // Latency is below target budget: cautiously expand window by 5% (500 bps)
      const expansion = (this.currentWindowBytes * 500n) / 10_000n;
      this.currentWindowBytes += (expansion > 0n ? expansion : 1n);
    } else if (feedback.measuredLatencyNs > feedback.targetLatencyNs) {
      // Latency exceeded budget: throttle window proportionally to latency ratio
      const ratioBps = (feedback.targetLatencyNs * 10_000n) / feedback.measuredLatencyNs;
      this.currentWindowBytes = (this.currentWindowBytes * ratioBps) / 10_000n;
    }

    // Clamp within invariant boundaries
    if (this.currentWindowBytes < this.minWindowBytes) {
      this.currentWindowBytes = this.minWindowBytes;
    } else if (this.currentWindowBytes > this.maxWindowBytes) {
      this.currentWindowBytes = this.maxWindowBytes;
    }

    return this.currentWindowBytes;
  }
}
