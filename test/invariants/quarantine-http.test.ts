/**
 * quarantine-http.test.ts
 * The bridge's real HTTP routes for quarantine proposals, over a loopback socket: list, approve, and the refusals.
 * (A caller that is not on loopback cannot be produced from here; that decision is covered by mayApproveQuarantine's tests.)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';

let httpServer: http.Server;
let port = 0;

interface Reply {
  proposed?: boolean;
  quarantined?: boolean;
  expiresInMs?: number;
  mode?: string;
  proposals?: Array<{ targetIp: string; evidence: Record<string, unknown> }>;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Reply }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const json: Reply = text ? JSON.parse(text) : {};
          resolve({ status: res.statusCode ?? 0, json });
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
  vi.stubEnv('ZODIAC_QUARANTINE_MODE', '');
  vi.stubEnv('ZODIAC_QUARANTINE_PROTECTED_IPS', '10.0.2.119');
  const bridge = new ZodiacBridgeServer(new ZodiacController());
  httpServer = http.createServer((req, res) => {
    void bridge['handleRequest'](req, res);
  });
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

describe('quarantine proposal routes', () => {
  it('a detector request inside the envelope is a 202 proposal, listed with its evidence', async () => {
    const r = await call('POST', '/api/sdn/quarantine', { targetIp: '10.0.2.50', reason: 'rate', evidence: { pps: 18, junk: 'x', frac: 1.5 } });
    expect(r.status).toBe(202);
    expect(r.json.proposed).toBe(true);
    const list = await call('GET', '/api/sdn/quarantine/proposals');
    expect(list.status).toBe(200);
    expect(list.json.mode).toBe('propose');
    const proposals = list.json.proposals ?? [];
    expect(proposals.map((p) => p.targetIp)).toEqual(['10.0.2.50']);
    expect(proposals[0]?.evidence).toEqual({ pps: 18 }); // the string and the fraction were dropped
  });

  it('a protected host is refused with 403 and never listed', async () => {
    const r = await call('POST', '/api/sdn/quarantine', { targetIp: '10.0.2.119', reason: 'rate' });
    expect(r.status).toBe(403);
    const list = await call('GET', '/api/sdn/quarantine/proposals');
    expect((list.json.proposals ?? []).map((p) => p.targetIp)).not.toContain('10.0.2.119');
  });

  it('approval carrying a proxy header is refused even from loopback', async () => {
    const r = await call('POST', '/api/sdn/quarantine/approve', { targetIp: '10.0.2.50' }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(r.status).toBe(403);
    const list = await call('GET', '/api/sdn/quarantine/proposals');
    expect((list.json.proposals ?? []).length).toBe(1); // still waiting
  });

  it('approval rejects a body that is not an IPv4, and an IP nobody proposed', async () => {
    expect((await call('POST', '/api/sdn/quarantine/approve', { targetIp: 'not-an-ip' })).status).toBe(400);
    expect((await call('POST', '/api/sdn/quarantine/approve', {})).status).toBe(400);
    expect((await call('POST', '/api/sdn/quarantine/approve', { targetIp: '10.0.2.77' })).status).toBe(404);
  });

  it('a local approval of a current proposal installs it, time-limited', async () => {
    const r = await call('POST', '/api/sdn/quarantine/approve', { targetIp: '10.0.2.50' });
    expect(r.status).toBe(200);
    expect(r.json.quarantined).toBe(true);
    expect(typeof r.json.expiresInMs).toBe('number');
    const list = await call('GET', '/api/sdn/quarantine/proposals');
    expect(list.json.proposals).toEqual([]);
    // Approving again finds nothing.
    expect((await call('POST', '/api/sdn/quarantine/approve', { targetIp: '10.0.2.50' })).status).toBe(404);
  });
});
