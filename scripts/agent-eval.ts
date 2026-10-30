/**
 * scripts/agent-eval.ts
 * Protocol A (zero-shot) of the pre-registered agent-proposal evaluation (docs/research/evaluation-plan.md).
 * For one intent and one model: N independent trials with seeds 1..N, temperature 0.2, top-p 0.95. Each trial records
 * the prompt hash, the raw model output, token counts and the deterministic verdict from src/sdn/proposal-triage.ts.
 * Nothing here touches the switch: this is the abstract evaluation (RQ1 to RQ3). On-wire conformance (RQ4) is separate.
 *
 * Invariant 2: counts and durations are integers (BigInt for wall time). Invariant 3: a transport or parse failure is a
 * recorded trial failure, never a skipped trial. Invariant 6: the model name, digest and the git commit are recorded; a
 * dirty working tree is refused (plan section 8).
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/agent-eval.ts --intent port1-isolation/v1 --model gemma4:26b \
 *     --host http://100.112.223.16:11434 --n 5 --think false --out docs/benchmarks/results/agent-evaluation/pilot
 * --think sets the model's reasoning mode (a recorded methodology choice: the plan does not specify it).
 *
 * Frontier arm (--provider gemini): the same prompts, seeds, temperature, top-p, verifier and record format, sent to the Gemini
 * API instead of Ollama. The key is read ONLY from the GEMINI_API_KEY environment variable and is never written to a result,
 * a log or an error message. A run refuses to start without explicit prices and a spend cap (fail closed), counts tokens as
 * integers, and stops after the trial in which the running cost reaches the cap (overshoot is at most one trial).
 *   GEMINI_API_KEY=... node --experimental-strip-types scripts/agent-eval.ts --provider gemini --model gemini-3.8-flash \
 *     --intent dns-confinement/v1 --n 3 --thinking default --num-predict 16384 \
 *     --price-in-cents 75 --price-out-cents 375 --max-cents 50 --price-note "ai.google.dev pricing 2026-10-19" --out <dir>
 * Prices are integer US cents per 1M tokens. --thinking is `default` (model default), an integer budget (2.5 series), or
 * minimal|low|medium|high (3 series); it is recorded in the summary.
 *
 * Anthropic arm (--provider anthropic, official SDK, key from ANTHROPIC_API_KEY, same spend-cap rules): for Claude Fable 5.1
 * thinking is always on, --thinking carries the effort level (default|low|medium|high|xhigh|max), and temperature, top-p and seed are
 * not accepted by the model, so that arm cannot match the 0.2 / 0.95 / seeded setting of the others; see the function comment.
 *   ANTHROPIC_API_KEY=... node --experimental-strip-types scripts/agent-eval.ts --provider anthropic --model claude-fable-5-1 \
 *     --intent dns-confinement/v1 --n 3 --thinking low --num-predict 16000 --price-in-cents 1000 --price-out-cents 5000 \
 *     --max-cents 100 --price-note "<source and date>" --out <dir>
 *
 * Seed shards (--shard i/k, any provider but --batch): run only seeds i, i+k, i+2k, ... of 1..N so that k processes can share one
 * model server; each trial is identical to the unsharded one. Each shard writes its own --out; scripts/merge-eval-shards.ts joins
 * them and refuses unless the shards agree on provenance and cover seeds 1..N exactly once. Every finished trial is also appended to
 * trials.partial.jsonl so a killed run keeps what it finished.
 *
 * Batch mode (--batch, --provider anthropic --protocol A only): this run is offline/non-interactive by construction (no
 * one is waiting on a per-trial answer), so it is submitted as a single Anthropic Message Batch instead of N sequential
 * requests -- same model, same prompt, same sampling; only the transport changes -- at the Message Batches API's lower
 * per-token price (see https://platform.claude.com/docs/en/build-with-claude/batch-processing; pass the batch-rate prices
 * via --price-in-cents/--price-out-cents, this script does not discount them for you). Scoped to protocol A because every
 * trial's request is then independent (no turn depends on a prior turn's reply, and Claude does not accept a seed so
 * every trial's request body is already byte-identical); protocol B's verifier-feedback loop makes a trial's turn 2
 * depend on turn 1's actual output, which the current implementation does not attempt to batch round-by-round. --batch is
 * rejected for --provider gemini or ollama: Gemini has its own batch mode but this script does not implement it yet
 * (undocumented here rather than guessed at), and local Ollama inference has no per-token $ cost to batch against.
 * The spend cap is checked before submission (a conservative upper-bound estimate: N x max_tokens x price-out, plus a
 * character-based estimate of prompt tokens x price-in), not reactively mid-run, because a batch is paid for as a whole
 * once submitted and cannot be stopped partway through the way the sequential loop can.
 *   ANTHROPIC_API_KEY=... node --experimental-strip-types scripts/agent-eval.ts --provider anthropic --model claude-fable-5-1 \
 *     --batch --protocol A --intent dns-confinement/v1 --n 20 --thinking low --num-predict 16000 \
 *     --price-in-cents 500 --price-out-cents 2500 --max-cents 200 --price-note "<batch-rate source and date>" --out <dir>
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { parseProposal, triageProposal, CATEGORY_PRECEDENCE } from '../dist/sdn/proposal-triage.js';
import { samplingRecord } from '../dist/sdn/eval-sampling.js';
import { proposerPrompts, type PromptVersion } from '../dist/sdn/proposer-prompt.js';
import { intentSha256 } from '../dist/sdn/intent-hash.js';
import { parseShardSpec, shardSeeds, type ShardSpec } from '../dist/sdn/eval-shards.js';
import { PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT } from '../dist/sdn/intents.js';

const INTENTS = {
  [PORT1_ISOLATION_INTENT.id]: PORT1_ISOLATION_INTENT,
  [DNS_CONFINEMENT_INTENT.id]: DNS_CONFINEMENT_INTENT,
  [QUARANTINE_PRECEDENCE_INTENT.id]: QUARANTINE_PRECEDENCE_INTENT,
  [TAP_RETURN_ISOLATION_INTENT.id]: TAP_RETURN_ISOLATION_INTENT,
} as const;
const MAX_N = 200;
const MAX_TURNS = 5; // Protocol B: the plan's iteration cap
const MAX_FEEDBACK_LINES = 12; // verifier detail lines returned to the model per turn
const REQUEST_TIMEOUT_MS = 600_000; // model-list and other short requests
const TURN_TIMEOUT_MS = 1_800_000; // one whole streamed chat turn (30 min), bounded
const DEFAULT_NUM_PREDICT = 8192;
const MAX_NUM_PREDICT = 65536;
const TEMPERATURE = 0.2;
const TOP_P = 0.95;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_SPEND_CENTS = 10_000; // upper bound on --max-cents so a typo cannot authorize a large run
/** Thrown between paid turns when the spend cap is reached mid-trial. */
class SpendCapReached extends Error {
  public constructor() { super('spend cap reached'); this.name = 'SpendCapReached'; }
}

const COST_UNITS_PER_CENT = 1_000_000n; // cost is kept as (tokens x cents per 1M tokens); 1e6 units = 1 cent
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];


interface Spend { priceInCents: number; priceOutCents: number; maxCents: number; note: string }
interface Args {
  intent: string; model: string; host: string; n: number; out: string; think: boolean; numPredict: number; protocol: 'A' | 'B';
  provider: 'ollama' | 'gemini' | 'anthropic'; thinking: string; spend: Spend | null; promptVersion: PromptVersion; batch: boolean; shard: ShardSpec | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (k: string): string => { const v = get(k); if (v === undefined || v === '') throw new Error(`missing ${k}`); return v; };
  const n = Number(need('--n'));
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw new Error(`--n must be an integer 1 to ${MAX_N}`);
  const intent = need('--intent');
  if (!(intent in INTENTS)) throw new Error(`unknown intent ${intent}; known: ${Object.keys(INTENTS).join(', ')}`);
  const thinkArg = get('--think') ?? 'false';
  if (thinkArg !== 'true' && thinkArg !== 'false') throw new Error('--think must be true or false');
  const numPredict = Number(get('--num-predict') ?? DEFAULT_NUM_PREDICT);
  if (!Number.isInteger(numPredict) || numPredict < 256 || numPredict > MAX_NUM_PREDICT) throw new Error(`--num-predict must be an integer 256 to ${MAX_NUM_PREDICT}`);
  const promptVersion = get('--prompt-version') ?? 'v1';
  if (promptVersion !== 'v1' && promptVersion !== 'v2' && promptVersion !== 'v3') throw new Error('--prompt-version must be v1, v2 or v3');
  const protocol = get('--protocol') ?? 'A';
  if (protocol !== 'A' && protocol !== 'B') throw new Error('--protocol must be A or B');
  const provider = get('--provider') ?? 'ollama';
  if (provider !== 'ollama' && provider !== 'gemini' && provider !== 'anthropic') throw new Error('--provider must be ollama, gemini or anthropic');
  const thinking = get('--thinking') ?? 'default';
  if (thinking !== 'default' && !/^\d+$/.test(thinking) && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`--thinking must be default, an integer budget, or one of ${THINKING_LEVELS.join('|')}`);
  }
  if (provider === 'anthropic' && thinking !== 'default' && !ANTHROPIC_EFFORTS.includes(thinking)) {
    throw new Error(`for --provider anthropic, --thinking is the effort level: default or one of ${ANTHROPIC_EFFORTS.join('|')}`);
  }
  let spend: Spend | null = null;
  if (provider === 'gemini' || provider === 'anthropic') {
    const cents = (k: string): number => {
      const v = Number(need(k));
      if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer (US cents)`);
      return v;
    };
    const maxCents = cents('--max-cents');
    if (maxCents < 1 || maxCents > MAX_SPEND_CENTS) throw new Error(`--max-cents must be an integer 1 to ${MAX_SPEND_CENTS}`);
    spend = { priceInCents: cents('--price-in-cents'), priceOutCents: cents('--price-out-cents'), maxCents, note: need('--price-note') };
  }
  const batch = argv.includes('--batch');
  if (batch && provider !== 'anthropic') throw new Error('--batch is only implemented for --provider anthropic (Gemini has its own batch mode, not yet wired here; Ollama has no per-token $ cost to batch against)');
  if (batch && protocol !== 'A') throw new Error('--batch requires --protocol A: protocol B\'s verifier-feedback turns depend on the prior turn\'s actual reply, which this implementation does not batch round-by-round');
  const shardArg = get('--shard');
  if (shardArg !== undefined && batch) throw new Error('--shard cannot be combined with --batch (a batch is one submission)');
  const shard = shardArg === undefined ? null : parseShardSpec(shardArg, n);
  return { promptVersion, protocol, intent, model: need('--model'), host: provider === 'gemini' ? GEMINI_BASE : provider === 'anthropic' ? ANTHROPIC_BASE : need('--host'), n, out: need('--out'), think: thinkArg === 'true', numPredict, provider, thinking, spend, batch, shard };
}

function git(...a: string[]): string { return execFileSync('git', a, { encoding: 'utf-8' }).trim(); }

async function ollama(host: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${host}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${route} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * One chat turn, streamed. A non-streamed request sends no response header until generation ends, and Node's fetch gives up
 * on a missing header after 300 s, which dropped the longest-thinking trials of the 2026-10-19 reasoning-on and Jetson runs
 * (recorded as TRANSPORT_FAILURE, a bias against long generations). Streaming returns the header at once; the whole turn
 * is still bounded by TURN_TIMEOUT_MS. Returns the same fields the non-streamed reply had that the runner reads.
 */
async function ollamaChat(host: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok || res.body === null) throw new Error(`/api/chat answered ${res.status}`);
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let last: Record<string, unknown> = {};
  let finished = false;
  const take = (line: string): void => {
    if (line.trim() === '') return;
    const chunk = JSON.parse(line) as Record<string, unknown>;
    content += String((chunk['message'] as { content?: unknown } | undefined)?.content ?? '');
    if (chunk['done'] === true) { last = chunk; finished = true; }
  };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(part, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) take(line);
  }
  take(pending);
  if (!finished) throw new Error('stream ended before the final chunk');
  return { message: { content }, eval_count: last['eval_count'], done_reason: last['done_reason'] };
}

interface GeminiTurn { content: string; promptTokens: number; outputTokens: number; thoughtTokens: number; finishReason: string | null }

function geminiKey(): string {
  const key = process.env['GEMINI_API_KEY'];
  if (key === undefined || key === '') throw new Error('GEMINI_API_KEY is not set in the environment');
  return key;
}

function geminiThinkingConfig(spec: string): Record<string, unknown> | undefined {
  if (spec === 'default') return undefined;
  if (/^\d+$/.test(spec)) return { thinkingBudget: Number(spec) };
  return { thinkingLevel: spec };
}

/** Error text from the API with the key removed, bounded in length. The key travels in a header and is not echoed, but fail closed. */
function scrub(text: string, key: string): string { return text.split(key).join('[redacted]').slice(0, 300); }

async function geminiModelInfo(model: string): Promise<{ version: string; displayName: string }> {
  const key = geminiKey();
  const res = await fetch(`${GEMINI_BASE}/models/${model}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`model ${model} lookup answered ${res.status}: ${scrub(await res.text(), key)}`);
  const j = (await res.json()) as { version?: string; displayName?: string };
  return { version: j.version ?? 'unknown', displayName: j.displayName ?? model };
}

/** One Gemini turn, streamed (server-sent events). Thought parts are not part of the answer and are not recorded as text; their token count is. */
async function geminiChat(model: string, messages: ReadonlyArray<{ role: string; content: string }>, opts: { seed: number; numPredict: number; thinking: string }): Promise<GeminiTurn> {
  const key = geminiKey();
  const generationConfig: Record<string, unknown> = { temperature: TEMPERATURE, topP: TOP_P, seed: opts.seed, maxOutputTokens: opts.numPredict };
  const thinkingConfig = geminiThinkingConfig(opts.thinking);
  if (thinkingConfig !== undefined) generationConfig['thinkingConfig'] = thinkingConfig;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const res = await fetch(`${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig,
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok || res.body === null) throw new Error(`generateContent answered ${res.status}: ${scrub(await res.text(), key)}`);
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let finishReason: string | null = null;
  let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
  let sawData = false;
  const take = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '') return;
    sawData = true;
    const chunk = JSON.parse(payload) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      usageMetadata?: typeof usage;
    };
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (part.thought !== true) content += part.text ?? '';
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    usage = chunk.usageMetadata ?? usage;
  };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(part, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) take(line);
  }
  take(pending);
  if (!sawData || usage === undefined) throw new Error('stream ended without a usage record');
  return { content, promptTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0, thoughtTokens: usage.thoughtsTokenCount ?? 0, finishReason };
}

/**
 * The Anthropic arm, through the official SDK (dynamic import so the Ollama and Gemini paths never need it). The key comes from the
 * ANTHROPIC_API_KEY environment variable only. Claude Fable 5.1 differences that matter for parity with the other arms: thinking is
 * always on (the `thinking` parameter is omitted; `output_config.effort` is the only depth control and --thinking carries it);
 * `temperature`, `top_p` and any seed are not accepted (sending them is a 400), so the recorded sampling for this arm is the model's
 * own; a safety classifier may end a turn with stop_reason "refusal" (recorded as the turn's doneReason, with no text, so the trial
 * scores ERR_SYNTAX and the refusal is visible in the record). Thinking tokens are billed as output tokens and are inside output_tokens.
 */
async function anthropicClient(): Promise<InstanceType<typeof import('@anthropic-ai/sdk').default>> {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (key === undefined || key === '') throw new Error('ANTHROPIC_API_KEY is not set in the environment');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: key, maxRetries: 2 });
}

async function anthropicModelInfo(model: string): Promise<{ version: string; displayName: string }> {
  const client = await anthropicClient();
  const m = await client.models.retrieve(model);
  return { version: m.id, displayName: m.display_name };
}

/** Shared between the sequential (.stream()) and batch (.batches.create()) Anthropic request paths, so the two
 * never drift into sending different request shapes for what is meant to be the same methodology. */
function anthropicMessageParams(model: string, messages: ReadonlyArray<{ role: string; content: string }>, opts: { numPredict: number; thinking: string }): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return {
    model,
    max_tokens: opts.numPredict,
    system,
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
    ...(opts.thinking === 'default' ? {} : { output_config: { effort: opts.thinking as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } }),
  };
}

/** Shared between the two request paths: converts a completed Anthropic Message (streamed finalMessage() or a
 * batch result's .message) into this script's GeminiTurn record shape. */
function anthropicMessageToTurn(final: Anthropic.Messages.Message): GeminiTurn {
  let content = '';
  for (const block of final.content) if (block.type === 'text') content += block.text;
  // output_tokens includes the thinking tokens (billed as output); the split is not reported separately by the API
  // A refusal carries its category (cyber, bio, ...) in stop_details; keep it in the recorded finish reason, e.g. "refusal:cyber".
  const category = final.stop_reason === 'refusal' ? (final.stop_details?.category ?? null) : null;
  const finishReason = category === null ? final.stop_reason : `${final.stop_reason}:${category}`;
  return { content, promptTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens, thoughtTokens: 0, finishReason };
}

async function anthropicChat(model: string, messages: ReadonlyArray<{ role: string; content: string }>, opts: { numPredict: number; thinking: string }): Promise<GeminiTurn> {
  const client = await anthropicClient();
  const stream = client.messages.stream(anthropicMessageParams(model, messages, opts), { timeout: TURN_TIMEOUT_MS });
  const final = await stream.finalMessage();
  return anthropicMessageToTurn(final);
}

// Batch mode (Invariant 5: named, bounded poll budget instead of an unbounded wait loop). Anthropic's Message
// Batches API documents a maximum 24h processing window; this polls at a fixed interval up to that bound.
const BATCH_POLL_INTERVAL_MS = 30_000;
const BATCH_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const BATCH_MAX_POLL_ATTEMPTS = Math.ceil(BATCH_MAX_WAIT_MS / BATCH_POLL_INTERVAL_MS);
/** Rough, deliberately conservative token-count estimate for a pre-flight spend check only (never for billing or
 * scoring): ~4 characters per token is an overestimate for most English/code text, which is the safe direction here.
 * (length + 3) >> 2 is ceil(length / 4) for non-negative length, as a pure integer right-shift with no float
 * division intermediate (unlike the equivalent Math.ceil(length / 4)). */
function roughTokenEstimate(text: string): number { return (text.length + 3) >> 2; }

interface BatchTrialResult { seed: number; turn: GeminiTurn | null; error: string | null }

/**
 * Submits N identical requests (one per seed) as a single Anthropic Message Batch, polls for completion, and
 * returns each seed's result. Valid only for protocol A (parseArgs enforces this): every request is independent
 * (no turn depends on a prior turn's reply) and Claude accepts no seed parameter, so the N requests are already
 * byte-identical except for the custom_id used to match results back to seeds -- this is exactly what batching
 * is for. The spend cap must be checked by the caller BEFORE calling this: once submitted, a batch is billed for
 * whatever it processes and cannot be partially stopped the way the sequential loop's reactive check can.
 */
async function anthropicBatchAll(model: string, messages: ReadonlyArray<{ role: string; content: string }>, opts: { numPredict: number; thinking: string }, n: number): Promise<BatchTrialResult[]> {
  const client = await anthropicClient();
  const params = anthropicMessageParams(model, messages, opts);
  const requests = Array.from({ length: n }, (_, i) => ({ custom_id: `seed-${i + 1}`, params }));
  const created = await client.messages.batches.create({ requests });
  process.stderr.write(`[batch] submitted ${n} requests as batch ${created.id}; polling every ${BATCH_POLL_INTERVAL_MS / 1000}s (bound: ${BATCH_MAX_WAIT_MS / 3_600_000}h)...\n`);

  let batch = created;
  for (let attempt = 1; attempt <= BATCH_MAX_POLL_ATTEMPTS && batch.processing_status !== 'ended'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
    batch = await client.messages.batches.retrieve(batch.id);
    if (attempt % 10 === 0) {
      const c = batch.request_counts;
      process.stderr.write(`[batch] ${created.id}: still ${batch.processing_status} (succeeded=${c.succeeded} errored=${c.errored} canceled=${c.canceled} expired=${c.expired} processing=${c.processing})\n`);
    }
  }
  if (batch.processing_status !== 'ended') {
    throw new Error(`batch ${created.id} did not finish within the ${BATCH_MAX_WAIT_MS / 3_600_000}h poll budget (last status: ${batch.processing_status})`);
  }

  const bySeed = new Map<number, BatchTrialResult>();
  const stream = await client.messages.batches.results(batch.id);
  for await (const line of stream) {
    const seed = Number(line.custom_id.replace(/^seed-/, ''));
    if (line.result.type === 'succeeded') {
      bySeed.set(seed, { seed, turn: anthropicMessageToTurn(line.result.message), error: null });
    } else {
      // errored / canceled / expired: recorded as a transport failure (Invariant 3: a failure is a scored
      // trial, never a silently dropped one), same as the sequential path's catch block does.
      const detail = line.result.type === 'errored' ? line.result.error.error.message : line.result.type;
      bySeed.set(seed, { seed, turn: null, error: detail });
    }
  }
  return Array.from({ length: n }, (_, i) => bySeed.get(i + 1) ?? { seed: i + 1, turn: null, error: 'missing from batch results (no line with this custom_id)' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (git('status', '--porcelain') !== '') throw new Error('working tree is dirty; commit first (plan section 8)');
  const spec = INTENTS[args.intent as keyof typeof INTENTS];
  const { system: SYSTEM_PROMPT, user: userPrompt } = proposerPrompts(args.promptVersion, spec);
  const promptHash = crypto.createHash('sha256').update(SYSTEM_PROMPT + '\n---\n' + userPrompt).digest('hex');
  let model: { digest: string };
  if (args.provider === 'gemini' || args.provider === 'anthropic') {
    const info = args.provider === 'gemini' ? await geminiModelInfo(args.model) : await anthropicModelInfo(args.model);
    model = { digest: `${info.displayName} ${info.version}` };
  } else {
    const tags = (await ollama(args.host, '/api/tags'))['models'] as Array<{ name: string; digest: string }>;
    const found = tags.find((m) => m.name === args.model);
    if (found === undefined) throw new Error(`model ${args.model} not found at ${args.host}`);
    model = found;
  }

  await fs.mkdir(args.out, { recursive: true });
  const lines: string[] = [];
  const counts = new Map<string, number>();
  const started = new Date().toISOString();
  let costUnits = 0n; // frontier arm only: tokens x cents per 1M tokens, integer
  let promptTotal = 0;
  let outputTotal = 0;
  let thoughtTotal = 0;
  let capHit = false;
  const overCap = (): boolean => args.spend !== null && costUnits >= BigInt(args.spend.maxCents) * COST_UNITS_PER_CENT;
  let abandoned: { seed: number; turnsUsed: number } | null = null; // a trial stopped mid-way by the spend cap: not scored, its spend is counted
  if (args.batch) {
    // Batch mode: protocol A + Anthropic only (parseArgs enforces this). See the module docstring's "Batch mode"
    // section for why this is scoped the way it is.
    if (args.spend === null) throw new Error('spend limits missing for batch mode');
    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
    // Pre-flight, fail-closed spend check: a batch is billed for whatever it processes once submitted and cannot
    // be partially stopped, so refuse BEFORE submitting rather than discover an overage after paying for it.
    // Worst case: every one of the n trials uses the full --num-predict output budget, plus a conservative
    // character-based estimate of the (fixed, identical-per-trial) prompt's token count.
    const estimatedPromptTokens = roughTokenEstimate(SYSTEM_PROMPT + userPrompt);
    const estimatedCostUnits = BigInt(args.n) * (BigInt(estimatedPromptTokens) * BigInt(args.spend.priceInCents) + BigInt(args.numPredict) * BigInt(args.spend.priceOutCents));
    if (estimatedCostUnits >= BigInt(args.spend.maxCents) * COST_UNITS_PER_CENT) {
      throw new Error(`refusing to submit: worst-case estimated cost (${(estimatedCostUnits / COST_UNITS_PER_CENT).toString()} cents) would meet or exceed --max-cents (${args.spend.maxCents}); lower --n or --num-predict, or raise --max-cents`);
    }
    const batchT0 = process.hrtime.bigint();
    const results = await anthropicBatchAll(args.model, messages, { numPredict: args.numPredict, thinking: args.thinking }, args.n);
    // All trials in a batch complete together: wallNs is the whole batch's wall time, not an independent
    // per-trial measurement the way the sequential loop's is. batchJob: true discloses this on every record.
    const batchWallNs = (process.hrtime.bigint() - batchT0).toString();
    for (const r of results) {
      let record: Record<string, unknown>;
      if (r.turn !== null) {
        const p = parseProposal(r.turn.content);
        const verdict = p.ok ? triageProposal(p.rules, spec) : { category: p.category, categories: [p.category], details: [p.detail] };
        const usageFields = { evalCount: r.turn.outputTokens + r.turn.thoughtTokens, doneReason: r.turn.finishReason, promptTokens: r.turn.promptTokens, outputTokens: r.turn.outputTokens, thoughtTokens: r.turn.thoughtTokens };
        promptTotal += r.turn.promptTokens;
        outputTotal += r.turn.outputTokens;
        thoughtTotal += r.turn.thoughtTokens;
        costUnits += BigInt(r.turn.promptTokens) * BigInt(args.spend.priceInCents) + BigInt(r.turn.outputTokens + r.turn.thoughtTokens) * BigInt(args.spend.priceOutCents);
        const turnRecord = { turn: 1, category: verdict.category, categories: verdict.categories, details: verdict.details, ruleCount: p.ok ? p.rules.length : null, ...usageFields, response: r.turn.content };
        record = { seed: r.seed, ok: true, category: verdict.category, firstCategory: verdict.category, turnsUsed: 1, admissibleAtTurn: verdict.category === 'ADMISSIBLE' ? 1 : null, turns: [turnRecord], batchJob: true };
      } else {
        record = { seed: r.seed, ok: false, category: 'TRANSPORT_FAILURE', turnsUsed: 0, turns: [], details: [r.error ?? 'unknown batch error'], batchJob: true };
      }
      record['wallNs'] = batchWallNs;
      counts.set(String(record['category']), (counts.get(String(record['category'])) ?? 0) + 1);
      lines.push(JSON.stringify(record));
    }
    process.stderr.write(`[batch] completed: ${results.length} results scored\n`);
  } else {
    const seedsToRun = args.shard === null ? Array.from({ length: args.n }, (_, i) => i + 1) : shardSeeds(args.n, args.shard);
    for (const seed of seedsToRun) {
      if (overCap()) { capHit = true; break; }
      const t0 = process.hrtime.bigint();
      let record: Record<string, unknown>;
      const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
      const turns: Array<Record<string, unknown>> = [];
      const maxTurns = args.protocol === 'B' ? MAX_TURNS : 1;
      try {
        for (let turn = 1; turn <= maxTurns; turn++) {
          // Protocol B pays for up to MAX_TURNS turns per trial, so the cap is checked before every paid turn, not once per trial.
          if (turn > 1 && overCap()) throw new SpendCapReached();
          let content: string;
          let usageFields: Record<string, unknown>;
          if (args.provider === 'gemini' || args.provider === 'anthropic') {
            if (args.spend === null) throw new Error(`spend limits missing for the ${args.provider} provider`);
            const g = args.provider === 'gemini'
              ? await geminiChat(args.model, messages, { seed, numPredict: args.numPredict, thinking: args.thinking })
              : await anthropicChat(args.model, messages, { numPredict: args.numPredict, thinking: args.thinking });
            content = g.content;
            promptTotal += g.promptTokens;
            outputTotal += g.outputTokens;
            thoughtTotal += g.thoughtTokens;
            // the output price includes thinking tokens (ai.google.dev pricing page, recorded in the summary note)
            costUnits += BigInt(g.promptTokens) * BigInt(args.spend.priceInCents) + BigInt(g.outputTokens + g.thoughtTokens) * BigInt(args.spend.priceOutCents);
            usageFields = { evalCount: g.outputTokens + g.thoughtTokens, doneReason: g.finishReason, promptTokens: g.promptTokens, outputTokens: g.outputTokens, thoughtTokens: g.thoughtTokens };
          } else {
            const r = await ollamaChat(args.host, {
              model: args.model, think: args.think, messages,
              options: { temperature: TEMPERATURE, top_p: TOP_P, seed, num_predict: args.numPredict },
            });
            content = String((r['message'] as { content?: unknown } | undefined)?.content ?? '');
            usageFields = { evalCount: r['eval_count'] ?? null, doneReason: r['done_reason'] ?? null };
          }
          const p = parseProposal(content);
          const verdict = p.ok ? triageProposal(p.rules, spec) : { category: p.category, categories: [p.category], details: [p.detail] };
          turns.push({ turn, category: verdict.category, categories: verdict.categories, details: verdict.details, ruleCount: p.ok ? p.rules.length : null,
            ...usageFields, response: content });
          if (verdict.category === 'ADMISSIBLE') break;
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: `The verifier rejected that rule set.\n${verdict.details.slice(0, MAX_FEEDBACK_LINES).join('\n')}\nFix every problem and reply with the complete corrected JSON array only.` });
        }
        const last = turns[turns.length - 1]!;
        record = { seed, ok: true, category: last['category'], firstCategory: turns[0]!['category'], turnsUsed: turns.length,
          admissibleAtTurn: last['category'] === 'ADMISSIBLE' ? turns.length : null, turns };
      } catch (e) {
        if (e instanceof SpendCapReached) { capHit = true; abandoned = { seed, turnsUsed: turns.length }; break; }
        record = { seed, ok: false, category: 'TRANSPORT_FAILURE', turnsUsed: turns.length, turns, details: [e instanceof Error ? e.message : String(e)] };
      }
      record['wallNs'] = (process.hrtime.bigint() - t0).toString();
      counts.set(String(record['category']), (counts.get(String(record['category'])) ?? 0) + 1);
      lines.push(JSON.stringify(record));
      // Salvage log: trials.jsonl is written once at the end, so a run killed by a time limit would otherwise lose every trial.
      await fs.appendFile(path.join(args.out, 'trials.partial.jsonl'), JSON.stringify(record) + '\n');
      process.stderr.write(`seed ${seed}/${args.n}: ${String(record['category'])}\n`);
    }
  }
  const summary = {
    schema: 'agent-eval/v2', protocol: args.protocol === 'A' ? 'A (zero-shot)' : `B (verifier feedback, up to ${MAX_TURNS} turns)`, intent: args.intent, model: args.model, modelDigest: model.digest, host: args.host,
    trials: args.n, trialsRun: lines.length, ...(({ temperature, topP, seeds }) => ({ temperature, topP, seeds }))(samplingRecord(args.provider, TEMPERATURE, TOP_P, args.n)), numPredict: args.numPredict, think: args.think,
    promptSha256: promptHash, promptVersion: args.promptVersion, intentSha256: intentSha256(spec), gitCommit: git('rev-parse', 'HEAD'), startedAt: started,
    counts: Object.fromEntries([...CATEGORY_PRECEDENCE, 'ADMISSIBLE', 'TRANSPORT_FAILURE'].map((c) => [c, counts.get(c) ?? 0])),
    ...((args.provider === 'gemini' || args.provider === 'anthropic') && args.spend !== null ? {
      provider: args.provider, thinking: args.thinking, stoppedBySpendCap: capHit, abandonedTrial: abandoned,
      usage: { promptTokens: promptTotal, outputTokens: outputTotal, thoughtTokens: thoughtTotal },
      pricing: { inCentsPer1M: args.spend.priceInCents, outCentsPer1M: args.spend.priceOutCents, note: args.spend.note },
      costMicroUsd: (costUnits / 100n).toString(), // 1e6 cost units = 1 cent = 10,000 micro-USD, so micro-USD = units / 100
      maxCents: args.spend.maxCents,
    } : {}),
    ...(args.shard === null ? {} : { shard: { index: args.shard.index, count: args.shard.count, seedsRun: shardSeeds(args.n, args.shard) } }),
    note: 'abstract evaluation only (RQ1-RQ3); says nothing about switch behaviour',
  };
  await fs.writeFile(path.join(args.out, 'trials.jsonl'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary.counts) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
