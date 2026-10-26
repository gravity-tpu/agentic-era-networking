import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  callOllama, runWithFallback, boundedInt, buildModelFallbacks, flushPendingTelemetry,
  OLLAMA_TIMEOUT_MIN_MS, OLLAMA_TIMEOUT_MAX_MS, OLLAMA_NUM_PREDICT_MAX, OLLAMA_MAX_RESPONSE_CHARS, OLLAMA_MAX_LINE_CHARS, NoAvailableModelsError,
} from '../../scripts/ai-utils.mjs';
import { GATEKEEPER_PREAMBLE, TECHNICAL_SYSTEM_PROMPT, CCIE_SYSTEM_PROMPT, buildGatekeeperPrompt } from '../../scripts/ai-reviewer.mjs';

const METRICS = path.join(os.tmpdir(), `zodiac-ollama-streaming-test-${process.pid}.json`);
/** The part of the request body these tests read back. */
type ChatBody = { stream?: boolean; think?: string; messages: Array<{ role: string; content: string }>; options?: { num_predict?: number } };
type Capture = { body?: ChatBody };
const ND = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

/** A fetch whose body arrives as the given byte chunks, so a line can be split across chunks. */
function streamFetch(chunks: string[], capture?: Capture) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    if (capture) capture.body = JSON.parse(init.body) as ChatBody;
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    }), { status: 200 });
  });
}
const call = (extra: Record<string, unknown> = {}) =>
  callOllama('m', 'sys', 'user', new AbortController().signal, 'http://x', { metricsFile: METRICS, ...extra });
const done = (extra: Record<string, unknown> = {}) => ({ message: { content: '' }, done: true, done_reason: 'stop', eval_count: 5, ...extra });

afterEach(async () => { vi.unstubAllGlobals(); await flushPendingTelemetry(1000); });

describe('callOllama streaming: fail closed on an incomplete or empty answer', () => {
  it('joins content across chunks, including a JSON line split between chunks, and ignores thinking text', async () => {
    const full = ND({ message: { thinking: 'hmm' } }, { message: { content: '## Critical ' } }, { message: { content: 'Issues\nNone.' } }, done());
    const cut = full.indexOf('Issues') + 3;
    vi.stubGlobal('fetch', streamFetch([full.slice(0, cut), full.slice(cut)]));
    expect(await call()).toBe('## Critical Issues\nNone.');
  });

  it('sends stream:true and the think level, and omits think when unset', async () => {
    const cap: Capture = {};
    vi.stubGlobal('fetch', streamFetch([ND({ message: { content: 'ok' } }, done())], cap));
    await call({ think: 'medium', numPredict: 123 });
    expect(cap.body).toMatchObject({ stream: true, think: 'medium', options: { num_predict: 123 } });
    await call();
    expect(Object.keys(cap.body ?? {})).not.toContain('think');
  });

  it('rejects a thinking-only response (the empty answer think=xhigh produced)', async () => {
    vi.stubGlobal('fetch', streamFetch([ND({ message: { thinking: 'x'.repeat(100) } }, done())]));
    await expect(call()).rejects.toThrow(/empty response/);
  });

  it('rejects a response cut off by the token cap, because the verdict may be missing', async () => {
    vi.stubGlobal('fetch', streamFetch([ND({ message: { content: '## Critical Issues\nNo' } }, done({ done_reason: 'length' }))]));
    await expect(call()).rejects.toThrow(/token cap/);
  });

  it('rejects any stop reason other than a normal stop, not only the token cap', async () => {
    for (const reason of ['load', 'unload', undefined]) {
      vi.stubGlobal('fetch', streamFetch([ND({ message: { content: 'looks complete' } }, done({ done_reason: reason }))]));
      await expect(call()).rejects.toThrow(/did not stop normally/);
    }
  });

  it('bounds memory: an answer over the character cap, and a line with no newline, both fail the review', async () => {
    // many short lines (a normal stream), so only the total-answer cap can trip
    const lines = Array.from({ length: 11 }, () => ND({ message: { content: 'x'.repeat(OLLAMA_MAX_RESPONSE_CHARS / 10) } }));
    vi.stubGlobal('fetch', streamFetch([...lines, ND(done())]));
    await expect(call()).rejects.toThrow(/exceeded .* characters/);
    vi.stubGlobal('fetch', streamFetch(['{"message":{"content":"', 'y'.repeat(OLLAMA_MAX_LINE_CHARS + 1)]));
    await expect(call()).rejects.toThrow(/no newline/);
  });

  it('rejects a stream that ends without a done record', async () => {
    vi.stubGlobal('fetch', streamFetch([ND({ message: { content: 'partial' } })]));
    await expect(call()).rejects.toThrow(/ended before completion/);
  });

  it('rejects an error record inside the stream', async () => {
    vi.stubGlobal('fetch', streamFetch([ND({ error: 'model requires more system memory' })]));
    await expect(call()).rejects.toThrow(/stream error.*more system memory/);
  });

  it('rejects an HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(call()).rejects.toThrow(/Ollama 500/);
  });
});

describe('runWithFallback with the local tier', () => {
  it('an empty local answer is a failed review, not a verdict (the chain moves on and ends in a refusal)', async () => {
    vi.stubGlobal('fetch', streamFetch([ND({ message: { thinking: 'only thinking' } }, done())]));
    const items = [
      { model: 'local', provider: 'ollama', baseUrl: 'http://x', timeoutMs: 5000, metricsFile: METRICS },
      { model: 'cloud', provider: 'nope' },
    ];
    await expect(runWithFallback(items, 'sys', 'user', { globalTimeoutMs: 10_000 })).rejects.toBeInstanceOf(NoAvailableModelsError);
  });

  it('uses the per-provider system prompt for that provider only, and reports the provider that answered', async () => {
    const cap: Capture = {};
    vi.stubGlobal('fetch', streamFetch([ND({ message: { content: 'ok' } }, done())], cap));
    const out = await runWithFallback(
      [{ model: 'local', provider: 'ollama', baseUrl: 'http://x', timeoutMs: 5000 }],
      'BASE', 'user', { globalTimeoutMs: 10_000, systemPromptByProvider: { ollama: 'LOCAL' } },
    );
    expect(cap.body?.messages[0]?.content).toBe('LOCAL');
    expect(out).toMatchObject({ result: 'ok', model: 'local', provider: 'ollama' });
  });
});

describe('Ollama limits are bounded (Invariant 5)', () => {
  it('clamps and falls back', () => {
    expect(boundedInt(1, 100, OLLAMA_TIMEOUT_MIN_MS, OLLAMA_TIMEOUT_MAX_MS)).toBe(OLLAMA_TIMEOUT_MIN_MS);
    expect(boundedInt(10 ** 12, 100, 1, OLLAMA_NUM_PREDICT_MAX)).toBe(OLLAMA_NUM_PREDICT_MAX);
    for (const bad of ['5', 1.5, NaN, undefined, null]) expect(boundedInt(bad, 7, 1, 10)).toBe(7);
  });

  it('the configured local tier streams long enough for a reasoning model and carries the think level', () => {
    const local = buildModelFallbacks().find((f: { provider: string }) => f.provider === 'ollama');
    if (!local) return; // CI or SKIP_OLLAMA: the local tier is not built
    expect(local.model).toBe('qwen3.8:27b');
    expect(local.timeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(local.timeoutMs).toBeLessThanOrEqual(OLLAMA_TIMEOUT_MAX_MS);
    expect(local.think).toBe('medium');
  });
});

describe('gatekeeper prompt for the local tier', () => {
  it('replaces only the opening role paragraph and keeps the invariants and the output format', () => {
    const p = buildGatekeeperPrompt(TECHNICAL_SYSTEM_PROMPT);
    expect(p.startsWith(GATEKEEPER_PREAMBLE)).toBe(true);
    expect(p).toContain('Review standards (the repository invariants)');
    expect(p).toContain('## 🔴 Critical Issues');
    expect(p).not.toContain('You are a Principal / Senior Staff Systems');
  });

  it('requires an integer-accounting violation to be Critical and CHANGES REQUESTED', () => {
    expect(GATEKEEPER_PREAMBLE).toMatch(/Integer accounting/);
    expect(GATEKEEPER_PREAMBLE).toMatch(/❌ CHANGES REQUESTED/);
    expect(GATEKEEPER_PREAMBLE).toMatch(/is NOT a suggestion/);
  });

  it('the systems prompt still carries the marker the swap depends on (a reword must fail here, not silently drop the gatekeeper)', () => {
    expect(TECHNICAL_SYSTEM_PROMPT).toContain('The repository is a real-hardware');
    expect(buildGatekeeperPrompt(TECHNICAL_SYSTEM_PROMPT)).not.toBe(TECHNICAL_SYSTEM_PROMPT);
  });

  it('leaves a prompt without the marker unchanged instead of dropping the rubric', () => {
    expect(buildGatekeeperPrompt(CCIE_SYSTEM_PROMPT)).toBe(CCIE_SYSTEM_PROMPT);
  });
});
