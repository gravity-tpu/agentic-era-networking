/**
 * experiment-routes.test.ts
 * HTTP-layer tests for the /api/experiment/* routes: absent by default, closed without the token, refusing bad bodies before any
 * FlowMod, and refusing to act without a switch session. The install logic itself is tested in experiment-install.test.ts.
 *
 * IMPORTANT (Invariant 6): the controller here has no switch attached. These tests prove the gate in front of the data plane; they
 * install nothing and say nothing about the physical switch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';

const TOKEN = 'unit-test-token-0123456789abcdef0123456789';
let httpServer: http.Server;
let port = 0;
let bridge: ZodiacBridgeServer;

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  httpServer = http.createServer((req, res) => { void bridge['handleRequest'](req, res); });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('test server has no port');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const validBody = {
  label: 'route-test',
  rules: [{ id: 'arp', priority: 100, outputPorts: [2], match: { inPort: 1, etherType: 2054 } }],
};

describe('disabled by default', () => {
  beforeEach(() => {
    vi.stubEnv('ZODIAC_EXPERIMENT_ENDPOINTS', '');
    vi.stubEnv('ZODIAC_EXPERIMENT_TOKEN', TOKEN);
    bridge = new ZodiacBridgeServer(new ZodiacController());
  });

  it('every experiment route is a 404 when the flag is off, even with a token', async () => {
    for (const [m, p] of [['GET', '/api/experiment/state'], ['POST', '/api/experiment/install'], ['POST', '/api/experiment/restore']] as const) {
      const r = await call(m, p, m === 'POST' ? validBody : undefined, { 'x-experiment-token': TOKEN });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
  });
});

describe('enabled', () => {
  beforeEach(() => {
    vi.stubEnv('ZODIAC_EXPERIMENT_ENDPOINTS', '1');
    vi.stubEnv('ZODIAC_EXPERIMENT_TOKEN', TOKEN);
    bridge = new ZodiacBridgeServer(new ZodiacController());
  });

  it('is also off when the token is too short, so a weak secret cannot enable it', async () => {
    vi.stubEnv('ZODIAC_EXPERIMENT_TOKEN', 'short');
    bridge = new ZodiacBridgeServer(new ZodiacController());
    const r = await call('GET', '/api/experiment/state', undefined, { 'x-experiment-token': 'short' });
    expect(r.status).toBe(404);
  });

  it('refuses a request with no token or the wrong token (401), on every route', async () => {
    for (const [m, p] of [['GET', '/api/experiment/state'], ['POST', '/api/experiment/install'], ['POST', '/api/experiment/restore']] as const) {
      expect((await call(m, p, m === 'POST' ? validBody : undefined)).status, `${m} ${p} no token`).toBe(401);
      expect((await call(m, p, m === 'POST' ? validBody : undefined, { 'x-experiment-token': TOKEN.slice(0, -1) + 'x' })).status, `${m} ${p} wrong token`).toBe(401);
      expect((await call(m, p, m === 'POST' ? validBody : undefined, { 'x-experiment-token': 'x' })).status, `${m} ${p} short token`).toBe(401);
    }
  });

  it('shows an idle state with the right token', async () => {
    const r = await call('GET', '/api/experiment/state', undefined, { 'x-experiment-token': TOKEN });
    expect(r.status).toBe(200);
    expect(r.json['phase']).toBe('idle');
  });

  it('refuses a body that breaks the bounds (422) with the reasons, before any FlowMod', async () => {
    const bad = { rules: [{ id: 'x', priority: 100, outputPorts: [4], match: { inPort: 1 } }] };
    const r = await call('POST', '/api/experiment/install', bad, { 'x-experiment-token': TOKEN });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json['errors'])).toMatch(/outputPorts/);
  });

  it('refuses a body that is not JSON (400) and one that is too large (413)', async () => {
    expect((await call('POST', '/api/experiment/install', 'not json', { 'x-experiment-token': TOKEN })).status).toBe(400);
    const big = JSON.stringify({ rules: [], pad: 'x'.repeat(70 * 1024) });
    expect((await call('POST', '/api/experiment/install', big, { 'x-experiment-token': TOKEN })).status).toBe(413);
  });

  it('a valid request with no switch session is refused (409) and leaves the state idle', async () => {
    const r = await call('POST', '/api/experiment/install', validBody, { 'x-experiment-token': TOKEN });
    expect(r.status).toBe(409);
    expect(String(r.json['error'])).toMatch(/no OpenFlow session/);
    const s = await call('GET', '/api/experiment/state', undefined, { 'x-experiment-token': TOKEN });
    expect(s.json['phase']).toBe('idle');
  });

  it('a restore with no switch session is refused (409), not reported as done', async () => {
    const r = await call('POST', '/api/experiment/restore', undefined, { 'x-experiment-token': TOKEN });
    expect(r.status).toBe(409);
  });
});
