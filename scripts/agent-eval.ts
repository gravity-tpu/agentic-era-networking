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
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseProposal, triageProposal, CATEGORY_PRECEDENCE } from '../dist/sdn/proposal-triage.js';
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
const COST_UNITS_PER_CENT = 1_000_000n; // cost is kept as (tokens x cents per 1M tokens); 1e6 units = 1 cent
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const SYSTEM_PROMPT = `You write flow rules for a 4-port OpenFlow 1.3 switch (Zodiac FX). Reply with ONE JSON array of rules and nothing else.
Each rule is an object with exactly these fields:
  "id": string, a short unique name
  "priority": integer 0 to 65535 (higher wins when several rules match)
  "outputPorts": array of integers 1 to 4; the ports the packet is sent out of; an empty array means drop
  "match": object, every field optional, a missing field matches anything. Allowed fields:
     "inPort": integer 1 to 4
     "etherType": integer in DECIMAL (IPv4 is 2048, ARP is 2054)
     "srcIp", "dstIp": dotted IPv4 string; "srcIpPrefixLen", "dstIpPrefixLen": integer 1 to 32 (omitted means /32, an exact host)
     "srcMac", "dstMac": "aa:bb:cc:dd:ee:ff"
Rules:
  - A packet that matches no rule is dropped.
  - IPv4 address fields only work together with "etherType": 2048 in the same match.
  - The table holds at most 127 rules.
  - Port layout: port 1 = the untrusted workload segment, port 2 = the uplink to the rest of the network, port 3 = a monitoring tap, port 4 = the controller link (do not use it).`;

interface Spend { priceInCents: number; priceOutCents: number; maxCents: number; note: string }
interface Args {
  intent: string; model: string; host: string; n: number; out: string; think: boolean; numPredict: number; protocol: 'A' | 'B';
  provider: 'ollama' | 'gemini' | 'anthropic'; thinking: string; spend: Spend | null;
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
  return { protocol, intent, model: need('--model'), host: provider === 'gemini' ? GEMINI_BASE : provider === 'anthropic' ? ANTHROPIC_BASE : need('--host'), n, out: need('--out'), think: thinkArg === 'true', numPredict, provider, thinking, spend };
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

async function anthropicChat(model: string, messages: ReadonlyArray<{ role: string; content: string }>, opts: { numPredict: number; thinking: string }): Promise<GeminiTurn> {
  const client = await anthropicClient();
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const stream = client.messages.stream({
    model,
    max_tokens: opts.numPredict,
    system,
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
    ...(opts.thinking === 'default' ? {} : { output_config: { effort: opts.thinking as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } }),
  }, { timeout: TURN_TIMEOUT_MS });
  const final = await stream.finalMessage();
  let content = '';
  for (const block of final.content) if (block.type === 'text') content += block.text;
  // output_tokens includes the thinking tokens (billed as output); the split is not reported separately by the API
  return { content, promptTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens, thoughtTokens: 0, finishReason: final.stop_reason };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (git('status', '--porcelain', '--untracked-files=no') !== '') throw new Error('working tree has uncommitted changes to tracked files; commit first (plan section 8)');
  const spec = INTENTS[args.intent as keyof typeof INTENTS];
  const userPrompt = `Intent: ${spec.description}\nWrite the rule set that implements this intent.`;
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
  for (let seed = 1; seed <= args.n; seed++) {
    if (args.spend !== null && costUnits >= BigInt(args.spend.maxCents) * COST_UNITS_PER_CENT) { capHit = true; break; }
    const t0 = process.hrtime.bigint();
    let record: Record<string, unknown>;
    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
    const turns: Array<Record<string, unknown>> = [];
    const maxTurns = args.protocol === 'B' ? MAX_TURNS : 1;
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
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
      record = { seed, ok: false, category: 'TRANSPORT_FAILURE', turnsUsed: turns.length, turns, details: [e instanceof Error ? e.message : String(e)] };
    }
    record['wallNs'] = (process.hrtime.bigint() - t0).toString();
    counts.set(String(record['category']), (counts.get(String(record['category'])) ?? 0) + 1);
    lines.push(JSON.stringify(record));
    process.stderr.write(`seed ${seed}/${args.n}: ${String(record['category'])}\n`);
  }
  const summary = {
    schema: 'agent-eval/v2', protocol: args.protocol === 'A' ? 'A (zero-shot)' : `B (verifier feedback, up to ${MAX_TURNS} turns)`, intent: args.intent, model: args.model, modelDigest: model.digest, host: args.host,
    trials: args.n, trialsRun: lines.length, temperature: TEMPERATURE, topP: TOP_P, seeds: `1..${args.n}`, numPredict: args.numPredict, think: args.think,
    promptSha256: promptHash, gitCommit: git('rev-parse', 'HEAD'), startedAt: started,
    counts: Object.fromEntries([...CATEGORY_PRECEDENCE, 'ADMISSIBLE', 'TRANSPORT_FAILURE'].map((c) => [c, counts.get(c) ?? 0])),
    ...((args.provider === 'gemini' || args.provider === 'anthropic') && args.spend !== null ? {
      provider: args.provider, thinking: args.thinking, stoppedBySpendCap: capHit,
      usage: { promptTokens: promptTotal, outputTokens: outputTotal, thoughtTokens: thoughtTotal },
      pricing: { inCentsPer1M: args.spend.priceInCents, outCentsPer1M: args.spend.priceOutCents, note: args.spend.note },
      costMicroUsd: (costUnits / 100n).toString(), // 1e6 cost units = 1 cent = 10,000 micro-USD, so micro-USD = units / 100
      maxCents: args.spend.maxCents,
    } : {}),
    note: 'abstract evaluation only (RQ1-RQ3); says nothing about switch behaviour',
  };
  await fs.writeFile(path.join(args.out, 'trials.jsonl'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary.counts) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
