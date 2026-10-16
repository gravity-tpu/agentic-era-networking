/**
 * relay-handler.test.ts
 * The cloud function's relay handler, driven over real HTTP, for the 2026-10-16 incident: a second bridge with no
 * hardware pushing a `disconnected` snapshot to production next to the real bridge's live one.
 *
 * IMPORTANT (Invariant 6): payloads are fixtures. They carry the shape of a relay push, not a capture.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function start(): Promise<Harness> {
  vi.resetModules(); // each test gets a fresh cloud instance: no shared latestSnapshot or relay authority
  const { default: handler } = await import('../../api/zodiac.js');
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/zodiac`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A relay push. `rate` makes the points distinguishable: the real bridge reports traffic, the stray reports zeros. */
function push(source: 'live_hardware' | 'disconnected', bridgeId: string | undefined, startMs: number, rate: string) {
  return {
    source,
    ...(bridgeId !== undefined ? { bridgeId } : {}),
    timeSeries: [0, 1].map((i) => ({
      timestampMs: startMs + i * 2500,
      rxBytes: '1000', txBytes: '1000', rxPackets: '10', txPackets: '10',
      rxRatePps: rate, txRatePps: rate, rxRateBps: rate, txRateBps: rate,
      cpuTemperatureC: 38, latencyNs: '500000',
    })),
  };
}

const post = (h: Harness, body: unknown) =>
  fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function get(h: Harness): Promise<{ source: string; timeSeries: Array<{ timestampMs: number; rxRatePps: string }> }> {
  const r = await fetch(h.url);
  expect(r.status).toBe(200);
  return (await r.json()) as { source: string; timeSeries: Array<{ timestampMs: number; rxRatePps: string }> };
}

let harness: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (harness) await harness.close();
  harness = null;
});

const T0 = Date.now() - 60_000;

describe('a second bridge with no hardware pushing to the same endpoint', () => {
  it('cannot displace a fresh live snapshot: the push is ignored, with the reason, and nothing is merged', async () => {
    harness = await start();
    expect((await post(harness, push('live_hardware', 'jetson:1', T0, '900'))).status).toBe(200);
    const ignored = await post(harness, push('disconnected', 'mac:2', T0 + 1000, '0'));
    expect(ignored.status).toBe(200);
    expect(ignored.headers.get('x-relay-decision')).toBe('ignored');
    const ack = (await ignored.json()) as { status: string; reason: string };
    expect(ack).toMatchObject({ status: 'ignored', reason: 'non-live-while-live-fresh' });

    const served = await get(harness);
    expect(served.source).toBe('live_hardware');
    // the stray's zero-rate points never reached the series the graphs draw
    expect(served.timeSeries.every((p) => p.rxRatePps === '900')).toBe(true);
    expect(served.timeSeries.some((p) => p.timestampMs === T0 + 1000)).toBe(false);
  });

  it('the served source never flips while the stray keeps pushing between the live bridge\'s pushes', async () => {
    harness = await start();
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      await post(harness, push('live_hardware', 'jetson:1', T0 + round * 5000, '900'));
      seen.add((await get(harness)).source);
      await post(harness, push('disconnected', 'mac:2', T0 + round * 5000 + 1000, '0'));
      seen.add((await get(harness)).source);
      await post(harness, push('disconnected', 'mac:2', T0 + round * 5000 + 3500, '0'));
      seen.add((await get(harness)).source);
    }
    expect([...seen]).toEqual(['live_hardware']);
  });

  it('is believed once the live bridge is silent for longer than the freshness bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 + 60_000 });
    harness = await start();
    await post(harness, push('live_hardware', 'jetson:1', T0, '900'));
    vi.setSystemTime(T0 + 60_000 + 24_000);
    expect((await (await post(harness, push('disconnected', 'mac:2', T0 + 1000, '0'))).json()) as { status: string }).toMatchObject({ status: 'ignored' });
    vi.setSystemTime(T0 + 60_000 + 26_000); // 5 cycles x 5 s = 25 s since the last live push
    const accepted = await (await post(harness, push('disconnected', 'mac:2', T0 + 2000, '0'))).json();
    expect(accepted).toMatchObject({ status: 'ok' });
    expect((await get(harness)).source).toBe('disconnected');
  });
});

describe('the real bridge is still believed about its own hardware', () => {
  it('a disconnect from the same bridge that reported live is accepted at once', async () => {
    harness = await start();
    await post(harness, push('live_hardware', 'jetson:1', T0, '900'));
    const r = await post(harness, push('disconnected', 'jetson:1', T0 + 2500, '0'));
    expect(await r.json()).toMatchObject({ status: 'ok' });
    expect((await get(harness)).source).toBe('disconnected');
  });

  it('with nothing live yet, a non-live push is accepted: the cloud never claims live without evidence', async () => {
    harness = await start();
    expect(await (await post(harness, push('disconnected', 'mac:2', T0, '0'))).json()).toMatchObject({ status: 'ok' });
    expect((await get(harness)).source).not.toBe('live_hardware');
  });

  it('a bridge that predates sender identity is still accepted when live, and a later disconnect waits out the bound', async () => {
    harness = await start();
    expect(await (await post(harness, push('live_hardware', undefined, T0, '900'))).json()).toMatchObject({ status: 'ok' });
    expect(await (await post(harness, push('disconnected', undefined, T0 + 1000, '0'))).json()).toMatchObject({ status: 'ignored' });
    expect((await get(harness)).source).toBe('live_hardware');
  });
});

describe('sender identity is untrusted input', () => {
  it('an oversized or malformed bridgeId is treated as no identity, not rejected', async () => {
    harness = await start();
    await post(harness, push('live_hardware', 'jetson:1', T0, '900'));
    for (const bad of ['x'.repeat(500), 'has space', '../../x']) {
      const r = await post(harness, push('disconnected', bad, T0 + 1000, '0'));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: 'ignored' });
    }
  });

  it('claiming the live bridge\'s id from outside is not enough to be believed without the attested live push first', async () => {
    harness = await start();
    // no live push has happened, so an id match cannot exist; the push is accepted only because nothing live is fresh
    expect(await (await post(harness, push('disconnected', 'jetson:1', T0, '0'))).json()).toMatchObject({ status: 'ok' });
  });
});

describe('attestation covers the sender identity', () => {
  /** Signs a body the way the bridge does (src/security/request-attestation.ts). */
  async function signedPost(h: Harness, body: unknown, secret: string) {
    const { signBridgePayload } = await import('../../src/security/request-attestation.js');
    const payload = JSON.stringify(body);
    const { timestampNs, signature } = signBridgePayload(payload, secret);
    return fetch(h.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zodiac-Bridge-Secret': secret,
        'X-Timestamp-Ns': timestampNs,
        'X-Zodiac-Signature': signature,
      },
      body: payload,
    });
  }

  it('an unsigned push, or one signed with the wrong secret, is rejected, so a forged id cannot inject a disconnect', async () => {
    vi.stubEnv('ZODIAC_BRIDGE_SECRET', 'correct-horse-battery-staple');
    harness = await start();
    expect((await signedPost(harness, push('live_hardware', 'jetson:1', T0, '900'), 'correct-horse-battery-staple')).status).toBe(200);

    // an attacker who knows the live bridge's id, but not the secret
    const forged = push('disconnected', 'jetson:1', T0 + 1000, '0');
    expect((await post(harness, forged)).status).toBe(401); // no attestation headers
    expect((await signedPost(harness, forged, 'a-guess')).status).toBe(401); // wrong secret

    const served = await get(harness);
    expect(served.source).toBe('live_hardware');
    vi.unstubAllEnvs();
  });

  it('tampering with the id after signing breaks the signature', async () => {
    vi.stubEnv('ZODIAC_BRIDGE_SECRET', 'correct-horse-battery-staple');
    harness = await start();
    await signedPost(harness, push('live_hardware', 'jetson:1', T0, '900'), 'correct-horse-battery-staple');
    const { signBridgePayload } = await import('../../src/security/request-attestation.js');
    const signedFor = JSON.stringify(push('disconnected', 'mac:2', T0 + 1000, '0'));
    const { timestampNs, signature } = signBridgePayload(signedFor, 'correct-horse-battery-staple');
    const tampered = JSON.stringify(push('disconnected', 'jetson:1', T0 + 1000, '0')); // id swapped, signature kept
    const r = await fetch(harness.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zodiac-Bridge-Secret': 'correct-horse-battery-staple', 'X-Timestamp-Ns': timestampNs, 'X-Zodiac-Signature': signature },
      body: tampered,
    });
    expect(r.status).toBe(401);
    expect((await get(harness)).source).toBe('live_hardware');
    vi.unstubAllEnvs();
  });

  it('with the secret, the real bridge own signed disconnect is still believed at once', async () => {
    vi.stubEnv('ZODIAC_BRIDGE_SECRET', 'correct-horse-battery-staple');
    harness = await start();
    await signedPost(harness, push('live_hardware', 'jetson:1', T0, '900'), 'correct-horse-battery-staple');
    const r = await signedPost(harness, push('disconnected', 'jetson:1', T0 + 2500, '0'), 'correct-horse-battery-staple');
    expect(await r.json()).toMatchObject({ status: 'ok' });
    expect((await get(harness)).source).toBe('disconnected');
    vi.unstubAllEnvs();
  });
});
