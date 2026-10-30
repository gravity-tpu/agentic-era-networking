import { describe, it, expect } from 'vitest';
import {
  REVIEWER_INVARIANTS,
  buildReviewerLoraDataset,
  validateReviewFormat,
} from '../../src/sdn/reviewer-lora-dataset.js';

describe('reviewer-lora-dataset invariants (format compliance, strict-mode safety, and invariant coverage)', () => {
  it('the review format validator can fail: rejects inconsistent verdicts, non-empty warnings on approved diffs, and missing sections', () => {
    expect(() => validateReviewFormat('not a valid review', 'APPROVED')).toThrow(/Critical Issues/i);

    const contradictonReview = `## 🔴 Critical Issues
- \`src/sdn/meter.ts:12\`: Uses floating-point division \`bytes / elapsed\` to gate rate limit (Invariant 2).

## 🟠 Warnings
None.

## 🟡 Suggestions
None.

## ✅ Positives
- Clean module boundary.

## 📋 Summary
Violates Invariant 2.
- ✅ APPROVED — safe to merge`;
    expect(() => validateReviewFormat(contradictonReview, 'APPROVED')).toThrow(/Critical Issues/i);

    const strictBlockingWarningOnApproved = `## 🔴 Critical Issues
None.

## 🟠 Warnings
- Consider renaming variable x.

## 🟡 Suggestions
None.

## ✅ Positives
- Uses BigInt counters.

## 📋 Summary
Safe to merge.
- ✅ APPROVED — safe to merge`;
    expect(() => validateReviewFormat(strictBlockingWarningOnApproved, 'APPROVED')).toThrow(/Warnings/i);
  });

  it('covers all 6 repository invariants and all 7 network invariants with both violation and clean-fix examples', () => {
    const dataset = buildReviewerLoraDataset();
    expect(dataset.sftExamples.length).toBeGreaterThanOrEqual(26);
    expect(dataset.dpoPairs.length).toBe(dataset.sftExamples.length);

    for (const inv of REVIEWER_INVARIANTS) {
      const counts = dataset.summary.invariantCounts[inv];
      expect(counts, `missing coverage for ${inv}`).toBeDefined();
      expect(counts!.changesRequested).toBeGreaterThanOrEqual(1);
      expect(counts!.approved).toBeGreaterThanOrEqual(1);
    }

    for (const ex of dataset.sftExamples) {
      const assistantReply = ex.messages[ex.messages.length - 1]!.content;
      expect(() => validateReviewFormat(assistantReply, ex.expectedVerdict)).not.toThrow();
    }

    for (const pair of dataset.dpoPairs) {
      expect(() => validateReviewFormat(pair.chosen, pair.expectedVerdict)).not.toThrow();
      const oppositeVerdict = pair.expectedVerdict === 'APPROVED' ? 'CHANGES_REQUESTED' : 'APPROVED';
      expect(() => validateReviewFormat(pair.rejected, oppositeVerdict)).not.toThrow();
    }
  });

  it('is purely deterministic across repeated invocations', () => {
    const a = buildReviewerLoraDataset();
    const b = buildReviewerLoraDataset();
    expect(a.summary).toEqual(b.summary);
    expect(a.dpoPairs).toEqual(b.dpoPairs);
  });
});

