import { describe, it, expect } from 'vitest';
import { SymbolicRouteVerifier, RoutingLoopDetectedError, NetworkHop } from '../../src/core/routing-verifier.js';
import { AdaptiveFlowController, ControllerFeedback } from '../../src/core/adaptive-control.js';
import { EMPTY_STATE_REGEX } from '../../scripts/ai-reviewer.mjs';

describe('Invariant: Hassabis & Vinyals Neuro-Symbolic Route Verification', () => {
  it('approves valid loop-free DAG routing topologies', () => {
    const validHops: NetworkHop[] = [
      { fromNode: 'edge-gateway-1', toNode: 'spine-switch-a', cost: 10 },
      { fromNode: 'edge-gateway-1', toNode: 'spine-switch-b', cost: 15 },
      { fromNode: 'spine-switch-a', toNode: 'leaf-router-core', cost: 5 },
      { fromNode: 'spine-switch-b', toNode: 'leaf-router-core', cost: 5 },
    ];

    expect(SymbolicRouteVerifier.verifyLoopFree(validHops)).toBe(true);
  });

  it('rejects agent-proposed topologies that contain routing cycles (loops)', () => {
    const cyclicHops: NetworkHop[] = [
      { fromNode: 'router-a', toNode: 'router-b', cost: 1 },
      { fromNode: 'router-b', toNode: 'router-c', cost: 1 },
      { fromNode: 'router-c', toNode: 'router-a', cost: 1 }, // Cycle!
    ];

    expect(() => SymbolicRouteVerifier.verifyLoopFree(cyclicHops)).toThrow(RoutingLoopDetectedError);
    expect(() => SymbolicRouteVerifier.verifyLoopFree(cyclicHops)).toThrow(/router-a -> router-b -> router-c -> router-a/);
  });

  it('rejects self-loops immediately', () => {
    const selfLoop: NetworkHop[] = [
      { fromNode: 'router-a', toNode: 'router-a', cost: 1 },
    ];

    expect(() => SymbolicRouteVerifier.verifyLoopFree(selfLoop)).toThrow(RoutingLoopDetectedError);
  });
});

describe('Invariant: Quoc Le Self-Tuning Adaptive Flow Control', () => {
  it('adapts and throttles window upon packet drop without float drift', () => {
    const controller = new AdaptiveFlowController(100_000n, 10_000n, 1_000_000n);

    const feedbackWithDrop: ControllerFeedback = {
      measuredLatencyNs: 500_000n,
      targetLatencyNs: 500_000n,
      packetsDelivered: 1_000n,
      packetsDropped: 5n,
    };

    const newWindow = controller.adapt(feedbackWithDrop);
    // 100,000 * 0.75 = 75,000n
    expect(newWindow).toBe(75_000n);
    expect(typeof newWindow).toBe('bigint');
  });

  it('cautiously expands window when latency is under budget and zero drops occur', () => {
    const controller = new AdaptiveFlowController(100_000n, 10_000n, 1_000_000n);

    const favorableFeedback: ControllerFeedback = {
      measuredLatencyNs: 200_000n, // Under 500µs target
      targetLatencyNs: 500_000n,
      packetsDelivered: 2_000n,
      packetsDropped: 0n,
    };

    const newWindow = controller.adapt(favorableFeedback);
    // 100,000 + 5% = 105,000n
    expect(newWindow).toBe(105_000n);
  });

  it('respects min and max invariant boundaries', () => {
    const controller = new AdaptiveFlowController(10_000n, 8_000n, 20_000n);

    // Force multiple drops
    for (let i = 0; i < 10; i++) {
      controller.adapt({
        measuredLatencyNs: 1_000_000n,
        targetLatencyNs: 500_000n,
        packetsDelivered: 0n,
        packetsDropped: 50n,
      });
    }

    expect(controller.windowBytes).toBe(8_000n); // Clamped at min
  });
});

describe('Invariant: Council Review Fail-Closed Regex & Zero Suppression', () => {
  it('correctly matches valid empty-state warnings responses', () => {
    const validEmptyStates = [
      'None.',
      'None',
      '- None',
      '* None found.',
      'None identified.',
      'None at this time.',
      'No warnings.',
      'No issues found.',
      'n/a',
      'nil',
    ];

    for (const text of validEmptyStates) {
      expect(EMPTY_STATE_REGEX.test(text)).toBe(true);
    }
  });

  it('fails closed on real architectural warnings and prefix attacks', () => {
    const invalidStates = [
      'No rate limiting on bridge UDP port',
      'None of the buffers are checked',
      'No timeout specified for hardware synchronization',
      'Memory leak in handler',
      'None. However, I noticed a critical memory leak in the packet queue...',
      'No warnings for the DNS module, but the SDN controller has a critical memory leak',
      'None. The buffers lack backpressure.',
      'No warnings, except for...',
      'None. Wait, actually...',
      'No packet validation implemented',
    ];

    for (const text of invalidStates) {
      expect(EMPTY_STATE_REGEX.test(text)).toBe(false);
    }
  });
});
