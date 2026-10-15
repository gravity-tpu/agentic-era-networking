/**
 * run-review-markers.test.ts
 * scripts/run-review.sh classifies a failed CI review by grepping two messages that scripts/ai-reviewer.mjs
 * prints. If either message is reworded, the runner would silently fall back to the generic "crash" branch and
 * mislabel "no model produced a verdict" or "critical issues". This test fails first.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const runner = readFileSync('scripts/run-review.sh', 'utf8');
const reviewer = readFileSync('scripts/ai-reviewer.mjs', 'utf8');

/** Every `grep -q "..."` pattern the runner uses to classify an exit-1. */
const markers = [...runner.matchAll(/grep -q "([^"]+)"/g)].map((m) => m[1] ?? '');

describe('run-review.sh log markers', () => {
  it('extracts the markers it relies on', () => {
    expect(markers).toEqual(['Fail-closed verification enforced', 'Critical Issues must be resolved']);
  });

  it.each(markers)('ai-reviewer.mjs still prints "%s"', (marker) => {
    expect(reviewer).toContain(marker);
  });

  it('the CI runner does not pass --strict (warnings are advisory in CI)', () => {
    const invocation = runner.split('\n').find((l) => l.startsWith('npm run '));
    expect(invocation).toBeDefined();
    expect(invocation).not.toContain('--strict');
  });

  it('the reviewer emits exit 2 only under --strict, so the CI runner cannot see it today', () => {
    expect(reviewer).toMatch(/isStrict && shouldBlockForWarnings[\s\S]{0,200}process\.exit\(2\)/);
  });
});
