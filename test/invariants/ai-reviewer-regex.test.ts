import { describe, it, expect } from 'vitest';
import { EMPTY_STATE_REGEX } from '../../scripts/ai-reviewer.mjs';

describe('Invariant: AI review fail-closed empty-state parsing & zero suppression', () => {
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
