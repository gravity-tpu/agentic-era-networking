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
  // These cases are about the envelope and the time limit, which apply once the bridge installs: so mode enforce.
  vi.stubEnv('ZODIAC_QUARANTINE_MODE', 'enforce');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  controller = new ZodiacController();
  server = new ZodiacBridgeServer(controller);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

describe('manual release (carried over from the removed copilot test file)', () => {
  it('does not forget a rule the switch could not be told to delete, and rejects a release with no identifiers', () => {
    // Installed on hardware, but the OpenFlow session is not ESTABLISHED: the delete cannot be sent, so the registry must
    // keep the rule (forgetting it would leave a DROP on the switch that nothing knows about).
    server.registerFlowRule({
      ruleId: 'quarantine-test-hardware',
      priority: 65535,
      action: 'DROP',
      srcCidr: '10.0.2.105/32',
      dstCidr: '0.0.0.0/0',
      protocol: 'ANY',
      installedAtMs: Date.now(),
      openFlowInstalled: true,
    });
    const failed = server.releaseQuarantineRule({ targetIp: '10.0.2.105', reason: 'premature release while OpenFlow is disconnected' });
    expect(failed.released).toBe(false);
    expect(failed.releasedCount).toBe(0);
    expect(server['flowRuleRegistry'].has('quarantine-test-hardware')).toBe(true);

    vi.spyOn(controller, 'liftQuarantine').mockReturnValue({ success: true, timestampNs: process.hrtime.bigint() });
    const ok = server.releaseQuarantineRule({ targetIp: '10.0.2.105', reason: 'verified' });
    expect(ok.released).toBe(true);
    expect(ok.releasedRules).toContain('quarantine-test-hardware');
    expect(server['flowRuleRegistry'].has('quarantine-test-hardware')).toBe(false);

    expect(() => server.releaseQuarantineRule({})).toThrow('targetMac or targetIp required');
  });
});

describe('propose mode (the default): the bridge is the single place that decides', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ZODIAC_QUARANTINE_MODE', '');
    server = new ZodiacBridgeServer(new ZodiacController());
  });

  it('a request inside the envelope is recorded as a proposal and installs nothing', () => {
    const r = server.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate', evidence: { pps: 18, windowFrames: 20 } });
    expect(r.status).toBe(202);
    expect(r.body['proposed']).toBe(true);
    expect(r.body['quarantined']).toBe(false);
    expect(server['flowRuleRegistry'].size).toBe(0);
    expect(server['activeQuarantineIps']()).toEqual([]);
    const listed = server.listQuarantineProposals();
    expect(listed.mode).toBe('propose');
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]).toMatchObject({ targetIp: '10.0.2.50', requests: 1, evidence: { pps: 18, windowFrames: 20 } });
  });

  it('repeat requests update one proposal rather than adding more', () => {
    for (let i = 0; i < 5; i++) server.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    const listed = server.listQuarantineProposals().proposals;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.requests).toBe(5);
  });

  it('the envelope still refuses first: an out-of-scope source never becomes a proposal', () => {
    const r = server.requestQuarantine({ targetIp: '10.0.0.1', reason: 'rate' });
    expect(r.status).toBe(403);
    expect(server.listQuarantineProposals().proposals).toEqual([]);
  });

  it('a protected host never becomes a proposal', () => {
    vi.stubEnv('ZODIAC_QUARANTINE_PROTECTED_IPS', '10.0.2.119, 10.0.2.51, 10.0.2.52');
    const s2 = new ZodiacBridgeServer(new ZodiacController());
    for (const ip of ['10.0.2.119', '10.0.2.51', '10.0.2.52']) {
      expect(s2.requestQuarantine({ targetIp: ip, reason: 'rate' }).status, ip).toBe(403);
    }
    expect(s2.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' }).status).toBe(202);
  });

  it('a person approving a proposal installs it, time-limited, and clears the proposal', () => {
    server.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' });
    const r = server.approveQuarantineProposal('10.0.2.50');
    expect(r.status).toBe(200);
    expect(r.body['quarantined']).toBe(true);
    expect(r.body['expiresInMs']).toBe(DEFAULT_QUARANTINE_TTL_MS);
    expect(server['activeQuarantineIps']()).toEqual(['10.0.2.50']);
    expect(server.listQuarantineProposals().proposals).toEqual([]);
  });

  it('approving something that was never proposed is refused', () => {
    expect(server.approveQuarantineProposal('10.0.2.50').status).toBe(404);
    expect(server['activeQuarantineIps']()).toEqual([]);
  });

  it('approval is still bounded by the envelope: at the cap it is refused and the proposal is kept', () => {
    const ips = Array.from({ length: DEFAULT_QUARANTINE_MAX_ACTIVE + 1 }, (_, i) => `10.0.2.${100 + i}`);
    for (const ip of ips) server.requestQuarantine({ targetIp: ip, reason: 'rate' });
    for (const ip of ips.slice(0, DEFAULT_QUARANTINE_MAX_ACTIVE)) expect(server.approveQuarantineProposal(ip).status).toBe(200);
    const last = ips[DEFAULT_QUARANTINE_MAX_ACTIVE] as string;
    expect(server.approveQuarantineProposal(last).status).toBe(429);
    expect(server.listQuarantineProposals().proposals.map((p) => p.targetIp)).toContain(last);
  });

  it('only the exact value enforce makes the bridge install without a person', () => {
    for (const v of ['ENFORCE', 'true', '1', 'enforce ', 'on']) {
      vi.stubEnv('ZODIAC_QUARANTINE_MODE', v);
      const s = new ZodiacBridgeServer(new ZodiacController());
      expect(s.requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' }).status, v).toBe(202);
    }
    vi.stubEnv('ZODIAC_QUARANTINE_MODE', 'enforce');
    expect(new ZodiacBridgeServer(new ZodiacController()).requestQuarantine({ targetIp: '10.0.2.50', reason: 'rate' }).status).toBe(200);
  });
});
