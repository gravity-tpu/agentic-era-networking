/**
 * install-gate-routes.test.ts
 * The pre-install gate is wired into the bridge: /api/sdn/allow and the quarantine install refuse a rule whose resulting table fails a check,
 * and nothing is sent to the switch when they do. Over a loopback socket against the real routes; no switch is involved, so these show the
 * wiring and the refusal, not what the firmware does.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';

let httpServer: http.Server;
let port = 0;
let bridge: ZodiacBridgeServer;
let controller: ZodiacController;
let sendSpy: ReturnType<typeof vi.spyOn>;

interface Reply { ok?: boolean; code?: string; violations?: Array<{ property: string; ruleIds: string[] }>; error?: string; quarantined?: boolean }

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Reply }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { const t = Buffer.concat(chunks).toString('utf-8'); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
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

beforeEach(() => {
  controller = new ZodiacController();
  bridge = new ZodiacBridgeServer(controller);
  sendSpy = vi.spyOn(controller.openFlow, 'sendFlowModOptions').mockImplementation(() => 1);
  // Pretend a session exists so an admitted rule WOULD be sent (and a refused one provably is not).
  Object.defineProperty(controller.openFlow.metrics, 'state', { value: 'ESTABLISHED', configurable: true });
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  vi.restoreAllMocks();
});

describe('/api/sdn/allow is gated', () => {
  it('refuses the old MAC-only shape (no in_port): a packet arriving on its output port would hairpin. Nothing is sent', async () => {
    const r = await call('POST', '/api/sdn/allow', { srcMac: 'aa:bb:cc:dd:ee:ff', outPort: 2 });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('gate_refused');
    expect(r.json.violations?.map((v) => v.property)).toContain('A2');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('refuses a rule the deployed policy already shadows (A5), and one that would let the workload reach the uplink (A11)', async () => {
    const shadowed = await call('POST', '/api/sdn/allow', { srcMac: 'aa:bb:cc:dd:ee:ff', inPort: 1, outPort: 3, priority: 10 });
    expect(shadowed.status).toBe(422);
    expect(shadowed.json.violations?.map((v) => v.property)).toContain('A5');
    const leak = await call('POST', '/api/sdn/allow', { srcMac: 'aa:bb:cc:dd:ee:ff', inPort: 1, outPort: 2, priority: 300 });
    expect(leak.status).toBe(422);
    expect(leak.json.violations?.map((v) => v.property)).toContain('A11');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('keeps the earlier input checks: bad port, bad priority (65535 is the quarantine band), bad MAC', async () => {
    expect((await call('POST', '/api/sdn/allow', { outPort: 9 })).status).toBe(400);
    expect((await call('POST', '/api/sdn/allow', { outPort: 2, priority: 65535 })).status).toBe(400);
    expect((await call('POST', '/api/sdn/allow', { outPort: 2, inPort: 7 })).status).toBe(400);
    expect((await call('POST', '/api/sdn/allow', { outPort: 2, srcMac: 'nope' })).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('the quarantine install is gated', () => {
  it('a quarantine at the default 65535 passes the gate and is sent', async () => {
    const r = bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true });
    expect(r.status).toBe(200);
    expect(r.body['quarantined']).toBe(true);
  });

  it('a quarantine that would sit below a forwarding rule it overlaps is refused with the property, and nothing is pushed', () => {
    const push = vi.spyOn(controller, 'pushRule').mockImplementation(() => undefined);
    const r = bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true, priority: 100 });
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('gate_refused');
    expect(JSON.stringify(r.body['violations'])).toContain('A4');
    expect(push).not.toHaveBeenCalled();
    expect(bridge.listQuarantineProposals().proposals).toEqual([]);
  });
});

describe('a declared throughput target (A8)', () => {
  it('is advisory for quarantines: containment is never refused for throughput, but the shortfall is logged', async () => {
    vi.stubEnv('ZODIAC_CAPACITY_TARGET_PPS', '12000'); // the deployed table cannot meet this even at k=1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = new ZodiacBridgeServer(new ZodiacController());
    const r = b.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true });
    expect(r.status).toBe(200);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/A8 \(12000 pps at 572 B\): NOT met \(advisory, not refused\)/);
    vi.unstubAllEnvs();
  });

  it('a malformed target is reported and enforces nothing', () => {
    vi.stubEnv('ZODIAC_CAPACITY_TARGET_PPS', 'fast');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = new ZodiacBridgeServer(new ZodiacController());
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/NO throughput target is enforced/);
    expect(b.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true }).status).toBe(200);
    vi.unstubAllEnvs();
  });
});

/** Drives the real route handler with a request that claims a given peer address; the loopback test server cannot produce a remote peer. */
async function asPeer(remoteAddress: string, headers: Record<string, string> = {}, urlPath = '/api/sdn/quarantine', method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  const socket = new net.Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new http.IncomingMessage(socket);
  req.method = method;
  req.url = urlPath;
  req.headers = { 'content-type': 'application/json', host: 'bridge', ...headers };
  const out: { status: number; body: string } = { status: 0, body: '' };
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((r) => { finish = r; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false,
    setHeader: () => undefined,
    end: (b?: string) => { out.status = (res as unknown as { statusCode: number }).statusCode; out.body = b ?? ''; (res as unknown as { headersSent: boolean }).headersSent = true; finish(); },
  });
  const done = bridge['handleRequest'](req, res as unknown as http.ServerResponse);
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify({ targetIp: '10.0.2.50', reason: 'rate' }))); req.emit('end'); });
  await done;
  await finished; // the handler answers exactly once; wait for that, not for a fixed delay
  return { status: out.status, body: out.body === '' ? {} : (JSON.parse(out.body) as Record<string, unknown>) };
}

describe('/api/sdn/quarantine accepts requests only from the bridge host', () => {
  it('refuses a LAN peer and a tailnet peer with 403 not_local, and records no proposal', async () => {
    for (const peer of ['10.0.0.119', '100.112.223.16', '10.0.2.50']) {
      const r = await asPeer(peer);
      expect(r.status, peer).toBe(403);
      expect(r.body['code'], peer).toBe('not_local');
    }
    expect(bridge.listQuarantineProposals().proposals).toEqual([]);
  });

  it('refuses a loopback request carrying a proxy header', async () => {
    const r = await asPeer('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' });
    expect(r.status).toBe(403);
    expect(bridge.listQuarantineProposals().proposals).toEqual([]);
  });

  it('over a REAL socket: a proxy header is refused, and a plain loopback request is accepted', async () => {
    const withHeader = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ targetIp: '10.0.2.50', reason: 'rate' });
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/sdn/quarantine', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-forwarded-for': '203.0.113.9' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject); req.write(payload); req.end();
    });
    expect(withHeader).toBe(403);
    expect((await call('POST', '/api/sdn/quarantine', { targetIp: '10.0.2.50', reason: 'rate' })).status).toBe(202);
  });

  it('still accepts the bridge host itself (the detectors post from loopback)', async () => {
    const r = await asPeer('127.0.0.1');
    expect(r.status).toBe(202); // propose mode: inside the envelope, recorded as a proposal
    expect(bridge.listQuarantineProposals().proposals.map((p) => p.targetIp)).toEqual(['10.0.2.50']);
  });
});

describe('the gate writes an audit trail', () => {
  const trail = (): Array<Record<string, unknown>> => {
    const f = process.env['ZODIAC_GATE_AUDIT_FILE'] ?? '';
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };

  it('records a refused allow request with the route, the peer, the proposed rule and the failed properties', async () => {
    const r = await call('POST', '/api/sdn/allow', { srcMac: 'aa:bb:cc:dd:ee:ff', outPort: 2 });
    expect(r.status).toBe(422);
    const t = trail();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ event: 'refused', route: 'allow', peer: '127.0.0.1' });
    expect(JSON.stringify(t[0]!['violations'])).toContain('A2');
    expect((t[0]!['proposed'] as Array<{ outputPorts: number[] }>)[0]?.outputPorts).toEqual([2]);
  });

  it('records a refused quarantine (A4) with the peer that approved it', async () => {
    const proposed = await call('POST', '/api/sdn/quarantine', { targetIp: '10.0.2.50', reason: 'rate', priority: 100 });
    expect(proposed.status).toBe(202);
    const approved = await call('POST', '/api/sdn/quarantine/approve', { targetIp: '10.0.2.50' });
    expect(approved.status).toBe(409);
    const t = trail();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ event: 'refused', route: 'quarantine', peer: '127.0.0.1' });
    expect(JSON.stringify(t[0]!['violations'])).toContain('A4');
  });

  it('writes nothing for an install the gate admits', () => {
    expect(bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true }).status).toBe(200);
    expect(trail()).toEqual([]);
  });

  it('records an advisory throughput shortfall as an advisory event, and the quarantine still goes through', () => {
    vi.stubEnv('ZODIAC_CAPACITY_TARGET_PPS', '12000');
    const b = new ZodiacBridgeServer(new ZodiacController());
    expect(b.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true, peer: '127.0.0.1' }).status).toBe(200);
    const t = trail();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ event: 'advisory', route: 'quarantine', peer: '127.0.0.1' });
    expect(JSON.stringify(t[0]!['notes'])).toContain('NOT met');
    vi.unstubAllEnvs();
  });

  it('never changes the outcome when the trail cannot be written: the refusal stands and the failure is reported', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-fail-'));
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    vi.stubEnv('ZODIAC_GATE_AUDIT_FILE', path.join(dir, 'blocker', 'audit.jsonl'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const b = new ZodiacBridgeServer(new ZodiacController());
    const r = b.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true, priority: 100 });
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('gate_refused');
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/the refusal stands, but it is not in the audit trail/);
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says in the journal when a flood passes the per-minute limit (the file alone would not show a flood with no later event)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 62; i++) bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true, priority: 100 });
    expect(trail()).toHaveLength(60);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/gate audit rate limit reached: 1 event\(s\) counted but not written/);
  });
});

describe('caller refusals are audited too', () => {
  const trail = (): Array<Record<string, unknown>> => {
    const f = process.env['ZODIAC_CALLER_AUDIT_FILE'] ?? '';
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };

  it('records a quarantine request from a remote peer: route, peer, the reason, no rule, and the method and path', async () => {
    const r = await asPeer('100.112.223.16');
    expect(r.status).toBe(403);
    const t = trail();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ event: 'caller_refused', route: 'quarantine', peer: '100.112.223.16', what: 'POST /api/sdn/quarantine', proposed: [] });
    expect(JSON.stringify(t[0]!['violations'])).toContain('"property":"caller"');
  });

  it('records the proxy headers a loopback peer sent, names and values, so an attempt to pass as local is visible', async () => {
    await asPeer('127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', authorization: 'Bearer should-never-be-copied' });
    const line = JSON.stringify(trail()[0]);
    expect(line).toContain('x-forwarded-for=203.0.113.9');
    expect(line).toContain('x-real-ip=203.0.113.9');
    expect(line).not.toContain('should-never-be-copied'); // only the proxy headers are copied, never anything else
  });

  it('records a refused approval, and an allow request from a peer that is not an operator', async () => {
    expect((await asPeer('100.112.223.16', {}, '/api/sdn/quarantine/approve')).status).toBe(403);
    expect((await asPeer('203.0.113.9', {}, '/api/sdn/allow')).status).toBe(401);
    expect(trail().map((t) => [t['event'], t['route'], t['peer']])).toEqual([['caller_refused', 'approve', '100.112.223.16'], ['caller_refused', 'allow', '203.0.113.9']]);
  });

  it('records a wrong experiment token without the token, and a non-operator separately', async () => {
    vi.stubEnv('ZODIAC_EXPERIMENT_ENDPOINTS', '1');
    const real = 'real-token-'.padEnd(40, 'r');
    vi.stubEnv('ZODIAC_EXPERIMENT_TOKEN', real);
    const b = new ZodiacBridgeServer(new ZodiacController());
    const wrong = 'wrong-token-'.padEnd(40, 'w');
    const peer = async (addr: string, token: string): Promise<number> => {
      const socket = new net.Socket();
      Object.defineProperty(socket, 'remoteAddress', { value: addr });
      const req = new http.IncomingMessage(socket);
      req.method = 'GET'; req.url = '/api/experiment/state'; req.headers = { host: 'bridge', 'x-experiment-token': token };
      let status = 0; let finish: () => void = () => undefined;
      const finished = new Promise<void>((r) => { finish = r; });
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, setHeader: () => undefined, end: () => { status = (res as unknown as { statusCode: number }).statusCode; finish(); } });
      await b['handleRequest'](req, res as unknown as http.ServerResponse);
      await finished;
      return status;
    };
    expect(await peer('127.0.0.1', wrong)).toBe(401);
    expect(await peer('203.0.113.9', real)).toBe(401);
    const raw = fs.readFileSync(process.env['ZODIAC_CALLER_AUDIT_FILE'] ?? '', 'utf-8');
    expect(raw).not.toContain(wrong);
    expect(raw).not.toContain(real);
    const t = trail();
    expect(t.map((x) => [x['route'], x['peer']])).toEqual([['experiment', '127.0.0.1'], ['experiment', '203.0.113.9']]);
    expect(JSON.stringify(t[0]!['violations'])).toContain('token is missing or wrong');
    expect(JSON.stringify(t[1]!['violations'])).toContain('not a LAN operator');
    vi.unstubAllEnvs();
  });

  it('writes nothing for a caller that is accepted', async () => {
    expect((await asPeer('127.0.0.1')).status).toBe(202);
    expect(trail()).toEqual([]);
  });

  it('keeps caller refusals out of the gate trail, and a flood of them cannot evict or starve a gate refusal', async () => {
    const gateTrail = (): number => {
      const f = process.env['ZODIAC_GATE_AUDIT_FILE'] ?? '';
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter((l) => l !== '').length : 0;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 30; i++) await asPeer('100.112.223.16');
    expect(trail()).toHaveLength(20); // its own, smaller budget; the rest are counted and logged
    expect(gateTrail()).toBe(0);
    // A real gate refusal right after the flood is still recorded, in the other file.
    const r = bridge.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', approved: true, priority: 100 });
    expect(r.status).toBe(409);
    expect(gateTrail()).toBe(1);
    expect(trail()).toHaveLength(20);
  });

  it('bounds and sanitizes header values from an untrusted peer: huge, multi-line and repeated headers', async () => {
    await asPeer('127.0.0.1', { 'x-forwarded-for': `${'9'.repeat(100_000)}\nINJECTED {"event":"refused"}`, via: 'a\u0001b' });
    const raw = fs.readFileSync(process.env['ZODIAC_CALLER_AUDIT_FILE'] ?? '', 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(1); // one line, whatever the header contained
    expect(raw.length).toBeLessThan(5_000);
    expect(raw).not.toContain('\u0001');
    const note = String((trail()[0]!['notes'] as string[])[0]);
    expect(note).not.toMatch(/[\u0000-\u001f]/); // control characters were replaced at the source
    expect(note.length).toBeLessThan(400);
    expect(JSON.parse(raw.trim())['event']).toBe('caller_refused');
  });
});

