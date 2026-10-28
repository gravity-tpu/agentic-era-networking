import { describe, it, expect, vi } from 'vitest';
import { toTimeoutBigInt, readErrorBody, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT, trackTelemetryTask, flushPendingTelemetry, MAX_PENDING_TELEMETRY_TASKS, getPendingTelemetryTaskCount, buildModelFallbacks, loadStaticNetworkContext, buildAnthropicSystemWithCache, ANTHROPIC_CACHE_MIN_CHARS } from '../../scripts/ai-utils.mjs';



function createMockResponse(bodyBytes: Uint8Array | null, contentType = 'text/plain; charset=utf-8'): Response {
  if (!bodyBytes) {
    return new Response(null, {
      status: 500,
      headers: { 'content-type': contentType },
    });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bodyBytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 500,
    headers: { 'content-type': contentType },
  });
}

describe('AI Reviewer Utils: toTimeoutBigInt Invariants', () => {
  it('returns default BigInt when value is undefined or null', () => {
    expect(toTimeoutBigInt(undefined, 180_000n)).toBe(180_000n);
    expect(toTimeoutBigInt(null, 90_000n)).toBe(90_000n);
  });

  it('converts positive integer number to BigInt', () => {
    expect(toTimeoutBigInt(150_000, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toBe(150_000n);
  });

  it('passes through positive BigInt', () => {
    expect(toTimeoutBigInt(60_000n, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toBe(60_000n);
  });

  it('rejects floating-point numbers fail-closed', () => {
    expect(() => toTimeoutBigInt(150_000.5, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
  });

  it('rejects zero and negative numbers fail-closed', () => {
    expect(() => toTimeoutBigInt(0, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
    expect(() => toTimeoutBigInt(-10, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
    expect(() => toTimeoutBigInt(0n, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(RangeError);
    expect(() => toTimeoutBigInt(-100n, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(RangeError);
  });

  it('rejects strings, booleans, and non-numeric types fail-closed', () => {
    const rawFn = toTimeoutBigInt as (val: unknown, def: bigint) => bigint;
    expect(() => rawFn('150000', DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
    expect(() => rawFn(true, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
    expect(() => rawFn({}, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT)).toThrow(TypeError);
  });
});

describe('AI Reviewer Utils: readErrorBody Invariants', () => {
  it('returns (empty body) when response has no body', async () => {
    const res = createMockResponse(null);
    const result = await readErrorBody(res);
    expect(result).toBe('(empty body)');
  });

  it('rejects non-text content-types', async () => {
    const res = createMockResponse(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    const result = await readErrorBody(res);
    expect(result).toContain('[non-text content-type');
  });

  it('reads full error message within budget', async () => {
    const text = 'Model unavailable: internal server error';
    const bytes = new TextEncoder().encode(text);
    const res = createMockResponse(bytes);
    const result = await readErrorBody(res, 1024);
    expect(result).toBe(text);
  });

  it('truncates gracefully and rewinds incomplete multi-byte UTF-8 sequences', async () => {
    // Chinese characters are 3 bytes each:
    // '中' = [0xE4, 0xB8, 0xAD]
    // '国' = [0xE5, 0x9B, 0xBD]
    const text = '中国';
    const bytes = new TextEncoder().encode(text); // 6 bytes total

    // Slicing at 4 bytes would cut '国' after its first byte (0xE5)
    // readErrorBody must rewind to 3 bytes ('中') and not produce replacement character ''
    const res = createMockResponse(bytes);
    const result = await readErrorBody(res, 4);

    expect(result.startsWith('中')).toBe(true);
    expect(result.includes('\uFFFD')).toBe(false);
    expect(result).toContain('...[truncated at 4 bytes]');
  });

  it('truncates gracefully and rewinds incomplete 4-byte UTF-8 emoji sequences', async () => {
    // '🚀' = [0xF0, 0x9F, 0x99, 0x80] (4 bytes)
    const text = 'A🚀B';
    const bytes = new TextEncoder().encode(text); // 1 + 4 + 1 = 6 bytes

    // Slicing at 3 bytes cuts '🚀' in half (1 ASCII byte 'A' + 2 bytes of emoji)
    // readErrorBody must rewind to 1 byte ('A')
    const res = createMockResponse(bytes);
    const result = await readErrorBody(res, 3);

    expect(result.startsWith('A')).toBe(true);
    expect(result.includes('\uFFFD')).toBe(false);
    expect(result).toContain('...[truncated at 3 bytes]');
  });

  it('fails closed on genuinely corrupted UTF-8 byte stream', async () => {
    // 0xFF and 0xC0 are invalid UTF-8 byte sequences
    const corruptBytes = new Uint8Array([0x48, 0x65, 0xff, 0xc0, 0x6f]);
    const res = createMockResponse(corruptBytes);
    const result = await readErrorBody(res);

    expect(result).toContain('[stream read error:');
  });
});

describe('AI Reviewer Utils: Asynchronous Telemetry Task Registry', () => {
  it('handles non-promises or null gracefully without throwing', () => {
    expect(() => trackTelemetryTask(null)).not.toThrow();
    expect(() => trackTelemetryTask(undefined)).not.toThrow();
    expect(() => trackTelemetryTask('not a promise')).not.toThrow();
  });

  it('drains tracked background telemetry tasks upon flushPendingTelemetry', async () => {
    let completed = false;
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        completed = true;
        resolve();
      }, 20);
    });

    trackTelemetryTask(task);
    expect(completed).toBe(false);

    await flushPendingTelemetry(1000);
    expect(completed).toBe(true);
  });

  it('handles rejected background telemetry tasks without crashing flushPendingTelemetry', async () => {
    // This deliberately exercises the real stderr.write warning path (not a mock of the production
    // code), so it emits a genuine "[ai-utils] Pending telemetry task rejected: ..." line on every
    // run. Spying on stderr here only silences the expected, asserted-on noise from polluting every
    // test run's output (and anything, human or model, that reads it); production behavior is untouched.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const failingTask = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Simulated telemetry failure'));
        }, 10);
      });

      trackTelemetryTask(failingTask);
      await expect(flushPendingTelemetry(500)).resolves.not.toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Simulated telemetry failure'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('enforces maximum in-flight capacity and prunes settled tasks to zero', async () => {
    // Pushing MAX_PENDING_TELEMETRY_TASKS + 5 tasks deliberately triggers the real backpressure
    // warning 5 times; spied for the same reason as above (expected noise, asserted on, not printed).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const resolvers: (() => void)[] = [];
      for (let i = 0; i < MAX_PENDING_TELEMETRY_TASKS + 5; i++) {
        const p = new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        trackTelemetryTask(p);
      }

      expect(getPendingTelemetryTaskCount()).toBe(MAX_PENDING_TELEMETRY_TASKS);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('telemetry queue saturated'));

      // Resolving all pending tasks
      for (const r of resolvers) {
        r();
      }
      await flushPendingTelemetry(1000);
      // Invariant: all settled tasks MUST be pruned from registry to prevent monotonic memory leaks
      expect(getPendingTelemetryTaskCount()).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('AI Reviewer Utils: buildModelFallbacks Invariants', () => {
  it('skips local Ollama and falls back to Gemini when SKIP_OLLAMA is set', () => {
    const orig = process.env.SKIP_OLLAMA;
    try {
      process.env.SKIP_OLLAMA = '1';
      const fallbacks = buildModelFallbacks();
      expect(fallbacks.length).toBeGreaterThan(0);
      // Cost control: the cheap 'fast' tier is tried before the expensive 'pro' tier (see
      // buildModelFallbacks' tiers comment) -- gemini-3.8-flash, not gemini-pro-latest, leads.
      expect(fallbacks[0].provider).toBe('google');
      expect(fallbacks[0].model).toBe('gemini-3.8-flash');
    } finally {
      if (orig !== undefined) {
        process.env.SKIP_OLLAMA = orig;
      } else {
        delete process.env.SKIP_OLLAMA;
      }
    }
  });

  it('skips local Ollama when PREFER_GEMINI is set', () => {
    const orig = process.env.PREFER_GEMINI;
    try {
      process.env.PREFER_GEMINI = 'true';
      const fallbacks = buildModelFallbacks();
      expect(fallbacks.length).toBeGreaterThan(0);
      expect(fallbacks[0].provider).toBe('google');
    } finally {
      if (orig !== undefined) {
        process.env.PREFER_GEMINI = orig;
      } else {
        delete process.env.PREFER_GEMINI;
      }
    }
  });
});

describe('AI Reviewer Utils: static review context (prompt-caching prefix)', () => {
  it('loads both network-context.md and network-engineering-principles.md from disk', () => {
    const context = loadStaticNetworkContext();
    expect(context).toContain('network-context.md');
    expect(context).toContain('network-engineering-principles.md');
    // Real file content, not a placeholder -- both files are tens of KB (see repo root .agents/).
    expect(context.length).toBeGreaterThan(ANTHROPIC_CACHE_MIN_CHARS);
  });

  it('is read once and memoized across repeated calls (no repeat disk I/O per review)', () => {
    const first = loadStaticNetworkContext();
    const second = loadStaticNetworkContext();
    expect(second).toBe(first);
  });
});

describe('AI Reviewer Utils: buildAnthropicSystemWithCache', () => {
  it('returns a cache_control-marked content-block array when the prefix is large enough', () => {
    const prefix = 'x'.repeat(ANTHROPIC_CACHE_MIN_CHARS);
    const result = buildAnthropicSystemWithCache(prefix, 'rest of the prompt');
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toEqual({ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } });
    expect(result[1]).toEqual({ type: 'text', text: 'rest of the prompt' });
  });

  it('falls back to a plain string when the prefix is empty (no caching overhead for nothing)', () => {
    const result = buildAnthropicSystemWithCache('', 'rest of the prompt');
    expect(result).toBe('rest of the prompt');
  });

  it('falls back to a plain string when the prefix is below the minimum cacheable size', () => {
    const tinyPrefix = 'x'.repeat(ANTHROPIC_CACHE_MIN_CHARS - 1);
    const result = buildAnthropicSystemWithCache(tinyPrefix, 'rest of the prompt');
    expect(result).toBe('rest of the prompt');
  });
});
