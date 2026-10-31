/**
 * test/invariants/eval-lora-llama-server.test.ts
 *
 * Invariant tests for scripts/eval-lora-llama-server.ts:
 * - Verifies chat completion request structure and default parameters.
 * - Verifies reviewer evaluation format validation against clean and violating diffs.
 * - Verifies proposer multi-turn verifier feedback message construction.
 * - Verifies fail-closed error handling on server transport errors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildChatRequest,
  FIXTURE_DIFF_VIOLATION,
  FIXTURE_DIFF_CLEAN,
  DEFAULT_MAX_TOKENS,
  runReviewerEvaluation,
  runProposerEvaluation,
} from '../../scripts/eval-lora-llama-server.ts';
import { PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.ts';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import { proposalFromRules } from '../../src/sdn/proposal-triage.js';

describe('scripts/eval-lora-llama-server.ts Invariants', () => {
  it('buildChatRequest produces valid OpenAI-compatible payloads with integer token bounds', () => {
    const req = buildChatRequest('test-model', [{ role: 'user', content: 'test' }], 0.0, 1024);
    expect(req.model).toBe('test-model');
    expect(req.temperature).toBe(0.0);
    expect(req.max_tokens).toBe(1024);
    expect(req.messages).toEqual([{ role: 'user', content: 'test' }]);
  });

  it('reviewer evaluation succeeds with CHANGES_REQUESTED when mock returns compliant review', async () => {
    const mockReview = `## 🔴 Critical Issues
- **src/sdn/packet-counter.ts:12** (INV-2): Floating point arithmetic used in packet rate accounting.
- **src/sdn/packet-counter.ts:13** (INV-3): Missing zero-check on elapsedSec fails open.

## 🟠 Warnings
None.

## 🟡 Suggestions
Replace floating point calculation with BigInt integer division.

## ✅ Positives
The function signature and parameter names are clear.

## 📋 Summary
❌ CHANGES REQUESTED — must fix critical issues before merging`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: mockReview } }],
      }),
    } as unknown as Response);

    try {
      const result = await runReviewerEvaluation('http://127.0.0.1:11436', 'test-model', FIXTURE_DIFF_VIOLATION, 'CHANGES_REQUESTED');
      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('proposer evaluation performs turn 1 and turn 2 retry with verifier feedback', async () => {
    const turn1Proposal = '```json\n[{"id": "drop-all", "priority": 100, "outputPorts": [], "match": {"inPort": 1}}]\n```';
    const admissibleRules = proposalFromRules(buildPort1IsolationPolicy());
    const turn2Proposal = '```json\n' + admissibleRules + '\n```';

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const content = callCount === 1 ? turn1Proposal : turn2Proposal;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content } }],
        }),
      } as unknown as Response;
    });

    try {
      const result = await runProposerEvaluation('http://127.0.0.1:11436', 'test-model', PORT1_ISOLATION_INTENT, 'v3', 2);
      expect(callCount).toBe(2);
      expect(result.turns.length).toBe(2);
      expect(result.turns[0]?.triage.category).not.toBe('ADMISSIBLE');
      expect(result.turns[1]?.triage.category).toBe('ADMISSIBLE');
      expect(result.admissible).toBe(true);
      expect(result.turnsUsed).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed when llama-server returns an HTTP error code', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable: model loading in progress',
    } as unknown as Response);

    try {
      await expect(
        runReviewerEvaluation('http://127.0.0.1:11436', 'test-model', FIXTURE_DIFF_CLEAN, 'APPROVED'),
      ).rejects.toThrow(/llama-server responded 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
