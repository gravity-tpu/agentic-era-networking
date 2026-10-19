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

interface Args { intent: string; model: string; host: string; n: number; out: string; think: boolean; numPredict: number; protocol: 'A' | 'B' }

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
  return { protocol, intent, model: need('--model'), host: need('--host'), n, out: need('--out'), think: thinkArg === 'true', numPredict };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (git('status', '--porcelain', '--untracked-files=no') !== '') throw new Error('working tree has uncommitted changes to tracked files; commit first (plan section 8)');
  const spec = INTENTS[args.intent as keyof typeof INTENTS];
  const userPrompt = `Intent: ${spec.description}\nWrite the rule set that implements this intent.`;
  const promptHash = crypto.createHash('sha256').update(SYSTEM_PROMPT + '\n---\n' + userPrompt).digest('hex');
  const tags = (await ollama(args.host, '/api/tags'))['models'] as Array<{ name: string; digest: string }>;
  const model = tags.find((m) => m.name === args.model);
  if (model === undefined) throw new Error(`model ${args.model} not found at ${args.host}`);

  await fs.mkdir(args.out, { recursive: true });
  const lines: string[] = [];
  const counts = new Map<string, number>();
  const started = new Date().toISOString();
  for (let seed = 1; seed <= args.n; seed++) {
    const t0 = process.hrtime.bigint();
    let record: Record<string, unknown>;
    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
    const turns: Array<Record<string, unknown>> = [];
    const maxTurns = args.protocol === 'B' ? MAX_TURNS : 1;
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const r = await ollamaChat(args.host, {
          model: args.model, think: args.think, messages,
          options: { temperature: TEMPERATURE, top_p: TOP_P, seed, num_predict: args.numPredict },
        });
        const content = String((r['message'] as { content?: unknown } | undefined)?.content ?? '');
        const p = parseProposal(content);
        const verdict = p.ok ? triageProposal(p.rules, spec) : { category: p.category, categories: [p.category], details: [p.detail] };
        turns.push({ turn, category: verdict.category, categories: verdict.categories, details: verdict.details, ruleCount: p.ok ? p.rules.length : null,
          evalCount: r['eval_count'] ?? null, doneReason: r['done_reason'] ?? null, response: content });
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
    trials: args.n, temperature: TEMPERATURE, topP: TOP_P, seeds: `1..${args.n}`, numPredict: args.numPredict, think: args.think,
    promptSha256: promptHash, gitCommit: git('rev-parse', 'HEAD'), startedAt: started,
    counts: Object.fromEntries([...CATEGORY_PRECEDENCE, 'ADMISSIBLE', 'TRANSPORT_FAILURE'].map((c) => [c, counts.get(c) ?? 0])),
    note: 'abstract evaluation only (RQ1-RQ3); says nothing about switch behaviour',
  };
  await fs.writeFile(path.join(args.out, 'trials.jsonl'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary.counts) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
