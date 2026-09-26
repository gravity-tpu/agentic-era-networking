import { describe, it, expect } from 'vitest';
import { toTimeoutBigInt, readErrorBody, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT } from '../../scripts/ai-utils.mjs';

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
});
