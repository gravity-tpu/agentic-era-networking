/**
 * quarantine-request.test.ts
 * The bridge's quarantine path under the envelope: what is refused, that an accepted quarantine is time-limited and
 * gets removed by the sweep, and that the sweep leaves a rule alone while it cannot be lifted.
 *
 * No switch is connected, so rules are recorded in the bridge's registry with `openFlowInstalled: false`; what the
 * firmware does with the hard timeout is NOT covered here (unmeasured).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZodiacBridgeServer } from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { DEFAULT_QUARANTINE_MAX_ACTIVE, DEFAULT_QUARANTINE_TTL_MS } from '../../src/sdn/quarantine-envelope.js';

let server: ZodiacBridgeServer;
let controller: ZodiacController;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  controller = new ZodiacController();
  server = new ZodiacBridgeServer(controller);
});
afterEach(() => vi.restoreAllMocks());

const ask = (ip: string | undefined, mac?: string) =>
  server.requestQuarantine({ targetIp: ip, targetMac: mac, reason: 'test' });

describe('requestQuarantine refusals', () => {
  it.each([
    ['out-of-scope lab LAN host', '10.0.0.1', 403, 'out_of_scope'],
    ['out-of-scope controller subnet', '10.0.1.8', 403, 'out_of_scope'],
    ['broadcast address', '10.0.2.255', 403, 'protected'],
    ['not an IPv4', '10.0.2.999', 400, 'bad_ip'],
  ])('%s is refused with %i', (_name, ip, status, code) => {
    const r = ask(ip);
    expect(r.status).toBe(status);
    expect(r.body['code']).toBe(code);
    expect(r.body['quarantined']).toBe(false);
  });

  it('refuses a MAC with no IP (it cannot be scope-checked) and installs nothing', () => {
    const r = ask(undefined, 'aa:bb:cc:dd:ee:ff');
    expect(r.status).toBe(400);
    expect(r.body['code']).toBe('no_ip');
    expect(server.sweepExpiredQuarantines()).toBe(0);
  });

  it('refuses a second quarantine for the same source', () => {
    expect(ask('10.0.2.50').status).toBe(200);
    const again = ask('10.0.2.50');
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('already_active');
  });

  it('stops at the cap, so a sweep of sources cannot fill the table', () => {
    for (let i = 0; i < DEFAULT_QUARANTINE_MAX_ACTIVE; i++) expect(ask(`10.0.2.${100 + i}`).status).toBe(200);
    const over = ask('10.0.2.50');
    expect(over.status).toBe(429);
    expect(over.body['code']).toBe('cap_reached');
  });
});

describe('time limit', () => {
  it('an accepted quarantine reports its time limit', () => {
    const r = ask('10.0.2.50');
    expect(r.status).toBe(200);
    expect(r.body['expiresInMs']).toBe(DEFAULT_QUARANTINE_TTL_MS);
  });

  it('is kept before the limit and removed after it, freeing the slot', () => {
    expect(ask('10.0.2.50').status).toBe(200);
    const t0 = process.hrtime.bigint();
    const ttlNs = BigInt(DEFAULT_QUARANTINE_TTL_MS) * 1_000_000n;
    expect(server.sweepExpiredQuarantines(t0 + ttlNs / 2n)).toBe(0);
    expect(ask('10.0.2.50').status).toBe(409); // still quarantined
    expect(server.sweepExpiredQuarantines(t0 + ttlNs + 1_000_000_000n)).toBe(1);
    expect(ask('10.0.2.50').status).toBe(200); // allowed again
  });

  it('a rule that cannot be lifted yet is kept and retried, not dropped from the books', () => {
    expect(ask('10.0.2.50').status).toBe(200);
    // Pretend the switch session is up but the delete cannot be dispatched.
    vi.spyOn(controller, 'liftQuarantine').mockReturnValue({ success: false, timestampNs: 0n, error: 'no socket' });
    // Mark the rule as installed on hardware so release goes through liftQuarantine.
    for (const rule of server['flowRuleRegistry'].values()) server['flowRuleRegistry'].set(rule.ruleId, { ...rule, openFlowInstalled: true });
    const late = process.hrtime.bigint() + BigInt(DEFAULT_QUARANTINE_TTL_MS) * 2_000_000n;
    expect(server.sweepExpiredQuarantines(late)).toBe(0);
    expect(ask('10.0.2.50').status).toBe(409); // still counted as active
    vi.spyOn(controller, 'liftQuarantine').mockReturnValue({ success: true, timestampNs: 0n });
    expect(server.sweepExpiredQuarantines(late)).toBe(1);
  });

  it('a quarantine released by hand is forgotten by the sweep without error', () => {
    expect(ask('10.0.2.50').status).toBe(200);
    expect(server.releaseQuarantineRule({ targetIp: '10.0.2.50' }).releasedCount).toBe(1);
    expect(server.sweepExpiredQuarantines(process.hrtime.bigint() + BigInt(DEFAULT_QUARANTINE_TTL_MS) * 2_000_000n)).toBe(0);
  });
});
