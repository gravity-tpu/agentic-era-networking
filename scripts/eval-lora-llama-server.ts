#!/usr/bin/env node
/**
 * scripts/eval-lora-llama-server.ts
 * =================================
 * Evaluates live inference of Zodiac LoRA adapters running on a local or remote `llama-server`
 * (or OpenAI-compatible /v1/chat/completions endpoint).
 *
 * Capabilities:
 *   1. Reviewer LoRA Mode (--mode reviewer):
 *      Audits sample git diffs against the Zodiac Invariants, checking format compliance via
 *      validateReviewFormat() and verifying detection of violations.
 *   2. Proposer LoRA Mode (--mode proposer):
 *      Generates OpenFlow rules for benchmark intents (e.g., held-out QUARANTINE_PRECEDENCE_INTENT),
 *      evaluates Turn 1 admissibility through triageProposal(), and if rejected, performs Turn 2
 *      with deterministic verifier feedback.
 *   3. Combined Mode (--mode both):
 *      Executes both Reviewer and Proposer evaluations sequentially.
 *
 * Invariant 1: No errors suppressed; typed throughout.
 * Invariant 2: Monotonic nanosecond timing (process.hrtime.bigint()).
 * Invariant 3: Fail-closed triage and validation.
 * Invariant 5: Bounded timeouts and tokens.
 *
 * Usage:
 *   node --experimental-strip-types scripts/eval-lora-llama-server.ts --mode both [--host http://127.0.0.1:11436]
 */

import { QUARANTINE_PRECEDENCE_INTENT, PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, TAP_RETURN_ISOLATION_INTENT, type NetworkIntent } from '../src/sdn/intents.ts';
import { proposerPrompts, type PromptVersion } from '../src/sdn/proposer-prompt.js';
import { parseProposal, triageProposal, type TriageVerdict } from '../src/sdn/proposal-triage.js';
import {
  REVIEWER_TECHNICAL_SYSTEM_PROMPT,
  validateReviewFormat,
  type ReviewValidationResult,
} from '../src/sdn/reviewer-lora-dataset.ts';

export const DEFAULT_HOST = 'http://127.0.0.1:11436';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 2048;

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly max_tokens: number;
}

export interface ChatCompletionResponse {
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly role: string;
      readonly content: string;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

export interface ReviewerTestResult {
  readonly mode: 'reviewer';
  readonly ok: boolean;
  readonly wallNs: bigint;
  readonly response: string;
  readonly valid: boolean;
  readonly error?: string;
}

export interface ProposerTurnResult {
  readonly turn: number;
  readonly wallNs: bigint;
  readonly content: string;
  readonly triage: TriageVerdict | { category: string; categories: readonly string[]; details: readonly string[] };
}

export interface ProposerTestResult {
  readonly mode: 'proposer';
  readonly intentId: string;
  readonly turns: readonly ProposerTurnResult[];
  readonly admissible: boolean;
  readonly turnsUsed: number;
  readonly totalWallNs: bigint;
}

export const FIXTURE_DIFF_VIOLATION = `--- a/src/sdn/packet-counter.ts
+++ b/src/sdn/packet-counter.ts
@@ -10,5 +10,8 @@
+export function calculateRate(bytes: number, elapsedSec: number): number {
+  // Missing fail-closed guard; floats used for accounting
+  const raw = bytes / elapsedSec;
+  return raw * 2.5;
+}`;

export const FIXTURE_DIFF_CLEAN = `--- a/src/sdn/packet-counter.ts
+++ b/src/sdn/packet-counter.ts
@@ -10,5 +10,7 @@
+export function recordRate(bytes: bigint, elapsedNs: bigint): bigint {
+  if (elapsedNs <= 0n) return 0n;
+  return (bytes * 1_000_000_000n) / elapsedNs;
+}`;

export function buildChatRequest(
  model: string,
  messages: readonly ChatMessage[],
  temperature = 0.0,
  maxTokens = DEFAULT_MAX_TOKENS,
): ChatCompletionRequest {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
}

export async function sendChatRequest(
  host: string,
  request: ChatCompletionRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ readonly response: ChatCompletionResponse; readonly wallNs: bigint }> {
  const t0 = process.hrtime.bigint();
  const url = `${host.replace(/\/+$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`llama-server responded ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const response = (await res.json()) as ChatCompletionResponse;
  const wallNs = process.hrtime.bigint() - t0;
  return { response, wallNs };
}

export async function runReviewerEvaluation(
  host: string,
  model = 'qwen3.8-27b-reviewer-lora',
  diffText = FIXTURE_DIFF_VIOLATION,
  expectedVerdict: 'CHANGES_REQUESTED' | 'APPROVED' = 'CHANGES_REQUESTED',
): Promise<ReviewerTestResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: REVIEWER_TECHNICAL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Audit the following git diff against the repository invariants:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
    },
  ];

  const request = buildChatRequest(model, messages, 0.0, DEFAULT_MAX_TOKENS);
  const { response, wallNs } = await sendChatRequest(host, request);
  const content = response.choices[0]?.message.content ?? '';

  let valid = true;
  let error: string | undefined;
  try {
    validateReviewFormat(content, expectedVerdict);
  } catch (err: unknown) {
    valid = false;
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    mode: 'reviewer',
    ok: valid,
    wallNs,
    response: content,
    valid,
    error,
  };
}

export async function runProposerEvaluation(
  host: string,
  model = 'qwen3.8-27b-proposer-lora',
  intent: NetworkIntent = QUARANTINE_PRECEDENCE_INTENT,
  promptVersion: PromptVersion = 'v3',
  maxTurns = 2,
): Promise<ProposerTestResult> {
  const t0 = process.hrtime.bigint();
  const { system, user } = proposerPrompts(promptVersion, intent);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const turns: ProposerTurnResult[] = [];
  let admissible = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const request = buildChatRequest(model, messages, 0.0, DEFAULT_MAX_TOKENS);
    const { response, wallNs } = await sendChatRequest(host, request);
    const content = response.choices[0]?.message.content ?? '';

    const parsed = parseProposal(content);
    const triage = parsed.ok
      ? triageProposal(parsed.rules, intent)
      : { category: parsed.category, categories: [parsed.category], details: [parsed.detail] };

    turns.push({
      turn,
      wallNs,
      content,
      triage,
    });

    if (triage.category === 'ADMISSIBLE') {
      admissible = true;
      break;
    }

    if (turn < maxTurns) {
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Verifier rejected the rule set (${triage.category}):\n${triage.details.slice(0, 12).join('\n')}\nFix the rule set and reply with ONE JSON array of rules and nothing else.`,
      });
    }
  }

  const totalWallNs = process.hrtime.bigint() - t0;
  return {
    mode: 'proposer',
    intentId: intent.id,
    turns,
    admissible,
    turnsUsed: turns.length,
    totalWallNs,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const mode = getArg('--mode') ?? 'both';
  const host = getArg('--host') ?? DEFAULT_HOST;
  const reviewerModel = getArg('--reviewer-model') ?? 'qwen3.8-27b-reviewer-lora';
  const proposerModel = getArg('--proposer-model') ?? 'qwen3.8-27b-proposer-lora';

  console.log(`=== Zodiac Live LoRA Evaluator ===`);
  console.log(`Endpoint: ${host}`);
  console.log(`Mode:     ${mode}`);

  if (mode === 'reviewer' || mode === 'both') {
    console.log(`\n--- Running Reviewer LoRA Evaluation (${reviewerModel}) ---`);
    try {
      const res = await runReviewerEvaluation(host, reviewerModel, FIXTURE_DIFF_VIOLATION, 'CHANGES_REQUESTED');
      console.log(`Reviewer Wall Time: ${(res.wallNs / 1_000_000n).toString()} ms`);
      console.log(`Format Valid:       ${res.valid}`);
      if (res.error) console.log(`Format Note:        ${res.error}`);
      if (!res.ok) {
        console.error(`Reviewer Evaluation FAILED format or verdict checks!`);
        process.exitCode = 1;
      } else {
        console.log(`Reviewer Evaluation: PASSED`);
      }
    } catch (err: unknown) {
      console.error(`Reviewer Evaluation Error:`, err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }

  if (mode === 'proposer' || mode === 'both') {
    console.log(`\n--- Running Proposer LoRA Evaluation (${proposerModel}) on held-out INTENT-3 ---`);
    try {
      const res = await runProposerEvaluation(host, proposerModel, QUARANTINE_PRECEDENCE_INTENT, 'v3', 2);
      console.log(`Proposer Total Time: ${(res.totalWallNs / 1_000_000n).toString()} ms`);
      console.log(`Turns Used:          ${res.turnsUsed}`);
      for (const t of res.turns) {
        console.log(`  Turn ${t.turn}: Verdict = ${t.triage.category} (${(t.wallNs / 1_000_000n).toString()} ms)`);
      }
      console.log(`Admissible:          ${res.admissible}`);
      if (!res.admissible) {
        console.error(`Proposer Evaluation did not achieve ADMISSIBLE within allowed turns!`);
        process.exitCode = 1;
      } else {
        console.log(`Proposer Evaluation: PASSED`);
      }
    } catch (err: unknown) {
      console.error(`Proposer Evaluation Error:`, err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}

// Direct execution guard
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('eval-lora-llama-server.ts') || process.argv[1].endsWith('eval-lora-llama-server.js'));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Fatal eval-lora-llama-server error:', err);
    process.exit(1);
  });
}
