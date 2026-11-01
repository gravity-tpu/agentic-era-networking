/**
 * test/invariants/isolation-watch-io.test.ts
 * The I/O around the isolation watcher: building the ntfy request, validating its configuration without ever echoing the secret topic, and one poll step
 * with an injected fetch and sender (a bridge that is down, a push that fails and is retried, messages sent in order).
 */
import { describe, it, expect } from 'vitest';
import { ntfyConfig, ntfyRequest, redactedTarget } from '../../src/sdn/ntfy.js';
import { pollOnce } from '../../src/sdn/isolation-watch-cli.js';
import { IsolationWatcher, DEFAULT_WATCH_CONFIG, type WatchMessage } from '../../src/sdn/isolation-watch.js';

const msg = (over: Partial<WatchMessage> = {}): WatchMessage => ({ id: 1, kind: 'alert', title: 'Zodiac isolation: CRITICAL', body: 'table-miss forwards', priority: 'urgent', tags: ['rotating_light'], ...over });

describe('ntfyConfig', () => {
  it('requires a URL with a topic path', () => {
    expect(() => ntfyConfig({})).toThrow(/ISOLATION_WATCH_NTFY_URL/);
    expect(() => ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'https://ntfy.sh' })).toThrow(/topic/);
    expect(() => ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'https://ntfy.sh/' })).toThrow(/topic/);
    expect(() => ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'not a url' })).toThrow(/URL/);
    expect(() => ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'ftp://ntfy.sh/abc' })).toThrow(/http/);
  });
  it('accepts an https or http topic URL and an optional token', () => {
    expect(ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'https://ntfy.sh/zodiac-abc123' })).toEqual({ url: 'https://ntfy.sh/zodiac-abc123', token: null });
    expect(ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'http://10.0.0.15:8080/zodiac', ISOLATION_WATCH_NTFY_TOKEN: 'tk_x' }).token).toBe('tk_x');
  });
  it('never puts the secret topic or the token in what it logs: only the host', () => {
    const c = ntfyConfig({ ISOLATION_WATCH_NTFY_URL: 'https://ntfy.sh/zodiac-SECRETTOPIC', ISOLATION_WATCH_NTFY_TOKEN: 'tk_SECRET' });
    const shown = redactedTarget(c);
    expect(shown).toBe('ntfy.sh');
    expect(shown).not.toMatch(/SECRET/);
  });
});

describe('ntfyRequest', () => {
  it('maps priority and tags to ntfy headers and keeps headers ASCII', () => {
    const r = ntfyRequest(msg({ title: 'Zodiac isolation: café — CRITICAL' }), null);
    expect(r.headers['Priority']).toBe('5');
    expect(r.headers['Tags']).toBe('rotating_light');
    expect(/^[\x20-\x7e]*$/.test(r.headers['Title'] ?? '')).toBe(true);
    expect(r.body).toBe('table-miss forwards');
    expect(r.headers['Authorization']).toBeUndefined();
  });
  it('sends the bearer token only when one is configured, and maps every priority', () => {
    expect(ntfyRequest(msg(), 'tk_x').headers['Authorization']).toBe('Bearer tk_x');
    expect(['low', 'default', 'high', 'urgent'].map((p) => ntfyRequest(msg({ priority: p as WatchMessage['priority'] }), null).headers['Priority'])).toEqual(['2', '3', '4', '5']);
  });
});

function deps(over: { fetchFn?: typeof fetch; send?: (m: WatchMessage) => Promise<void> } = {}) {
  const sent: WatchMessage[] = [];
  const logs: string[] = [];
  let t = 1_000_000_000_000n;
  return {
    sent, logs,
    d: {
      bridgeUrl: 'http://127.0.0.1:3003',
      fetchFn: over.fetchFn ?? (async () => new Response(JSON.stringify({ port1Isolation: { state: 'verified', checkedAgeMs: 1000, mismatches: [], actions: { tableMiss: 'drops' } } }), { status: 200 })),
      send: over.send ?? (async (m: WatchMessage) => { sent.push(m); }),
      now: () => { t += 60_000_000_000n; return t; },
      log: (s: string) => { logs.push(s); },
    },
  };
}
const bridgeSays = (state: string, tableMiss: string): typeof fetch => (async () => new Response(JSON.stringify({ port1Isolation: { state, checkedAgeMs: 1000, mismatches: [{}], actions: { tableMiss } } }), { status: 200 })) as typeof fetch;

describe('pollOnce', () => {
  it('sends the started message first, in order, and marks it delivered', async () => {
    const w = new IsolationWatcher(DEFAULT_WATCH_CONFIG, 0n);
    const { d, sent } = deps();
    await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(sent.map((m) => m.kind)).toEqual(['started']);
    expect(w.outbox()).toEqual([]);
  });
  it('a bridge that cannot be reached is observed as unreachable and eventually alerts', async () => {
    const w = new IsolationWatcher(DEFAULT_WATCH_CONFIG, 0n);
    const { d, sent } = deps({ fetchFn: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch });
    for (let i = 0; i < 3; i++) await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(sent.map((m) => m.kind)).toEqual(['started', 'alert']);
    expect(sent[1]?.body).toMatch(/ECONNREFUSED/);
  });
  it('a non-200 answer from the bridge counts as unreachable, not as ok', async () => {
    const w = new IsolationWatcher(DEFAULT_WATCH_CONFIG, 0n);
    const { d, sent } = deps({ fetchFn: (async () => new Response('boom', { status: 500 })) as typeof fetch });
    for (let i = 0; i < 3; i++) await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(sent.map((m) => m.kind)).toEqual(['started', 'alert']);
  });
  it('a push that fails stays pending and is retried on the next poll, then delivered exactly once', async () => {
    const w = new IsolationWatcher(DEFAULT_WATCH_CONFIG, 0n);
    let failing = true;
    const delivered: WatchMessage[] = [];
    const { d, logs } = deps({ fetchFn: bridgeSays('mismatch', 'forwards'), send: async (m) => { if (failing) throw new Error('ntfy HTTP 503'); delivered.push(m); } });
    for (let i = 0; i < 3; i++) await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(delivered).toEqual([]);
    expect(w.outbox().length).toBeGreaterThanOrEqual(2); // started + alert, both still pending
    expect(logs.some((l) => /ntfy HTTP 503/.test(l))).toBe(true);
    failing = false;
    await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(delivered.map((m) => m.kind)).toEqual(['started', 'alert']); // in order, once each
    await pollOnce(d, w, DEFAULT_WATCH_CONFIG);
    expect(delivered.filter((m) => m.kind === 'alert').length).toBe(1);
  });
});
