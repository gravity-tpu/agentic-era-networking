/**
 * quarantine-envelope.test.ts
 * The bounds an automated quarantine must stay inside (Invariants 3, 4, 5): scope, protected hosts, a cap on
 * concurrent quarantines, a time limit, and refusal when the bounds themselves are misconfigured. Each check can
 * reject; negative cases are tested as carefully as the accepting one.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUARANTINE_MAX_ACTIVE,
  DEFAULT_QUARANTINE_TTL_MS,
  decideQuarantine,
  readQuarantineEnvelopeConfig,
} from '../../src/sdn/quarantine-envelope.js';

const cfg = readQuarantineEnvelopeConfig({});

describe('readQuarantineEnvelopeConfig', () => {
  it('uses named, bounded defaults', () => {
    expect(cfg.config.ttlMs).toBe(DEFAULT_QUARANTINE_TTL_MS);
    expect(cfg.config.maxActive).toBe(DEFAULT_QUARANTINE_MAX_ACTIVE);
    expect(cfg.warnings).toEqual([]);
  });

  it('falls back to the default (never clamps) for an out-of-range or malformed limit, and says so', () => {
    for (const v of ['0', '-5', '9999999999', 'abc', '1.5', '']) {
      const r = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_TTL_MS: v });
      if (v === '') {
        expect(r.config.ttlMs).toBe(DEFAULT_QUARANTINE_TTL_MS);
        continue;
      }
      expect(r.config.ttlMs, v).toBe(DEFAULT_QUARANTINE_TTL_MS);
      expect(r.warnings.length, v).toBe(1);
    }
    const cap = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_MAX_ACTIVE: '500' });
    expect(cap.config.maxActive).toBe(DEFAULT_QUARANTINE_MAX_ACTIVE);
    expect(cap.warnings).toHaveLength(1);
  });

  it('accepts in-range values', () => {
    const r = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_TTL_MS: '60000', ZODIAC_QUARANTINE_MAX_ACTIVE: '4' });
    expect(r.config.ttlMs).toBe(60_000);
    expect(r.config.maxActive).toBe(4);
  });

  it('a malformed protected-host entry makes the whole envelope refuse (protection cannot be verified)', () => {
    const r = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_PROTECTED_IPS: '10.0.2.119, not-an-ip' });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, [], r.config)).toMatchObject({ allow: false, code: 'config_invalid' });
  });
});

describe('decideQuarantine', () => {
  it('allows an in-scope, unprotected source and returns the time limit', () => {
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, [], cfg.config)).toEqual({ allow: true, ttlMs: DEFAULT_QUARANTINE_TTL_MS });
  });

  it('refuses a request with no IP (a MAC alone cannot be scope-checked)', () => {
    expect(decideQuarantine({ targetMac: 'aa:bb:cc:dd:ee:ff' }, [], cfg.config)).toMatchObject({ allow: false, code: 'no_ip' });
    expect(decideQuarantine({}, [], cfg.config)).toMatchObject({ allow: false, code: 'no_ip' });
  });

  it('refuses an address that is not a valid IPv4', () => {
    for (const ip of ['10.0.2.256', '10.0.2', '10.0.2.1.1', 'abc', '10.0.2.050x', ' 10.0.2.5']) {
      expect(decideQuarantine({ targetIp: ip }, [], cfg.config), ip).toMatchObject({ allow: false, code: 'bad_ip' });
    }
  });

  it('refuses anything outside the workload segment: the lab LAN, the controller subnet, the whole internet', () => {
    for (const ip of ['10.0.0.1', '10.0.1.8', '192.168.0.239', '8.8.8.8', '10.0.3.5', '0.0.0.0', '255.255.255.255']) {
      expect(decideQuarantine({ targetIp: ip }, [], cfg.config), ip).toMatchObject({ allow: false, code: 'out_of_scope' });
    }
  });

  it('refuses the segment network and broadcast addresses', () => {
    for (const ip of ['10.0.2.0', '10.0.2.255']) {
      expect(decideQuarantine({ targetIp: ip }, [], cfg.config), ip).toMatchObject({ allow: false, code: 'protected' });
    }
  });

  it('refuses a configured protected host', () => {
    const c = readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_PROTECTED_IPS: '10.0.2.119, 10.0.2.52' }).config;
    expect(decideQuarantine({ targetIp: '10.0.2.119' }, [], c)).toMatchObject({ allow: false, code: 'protected' });
    expect(decideQuarantine({ targetIp: '10.0.2.52' }, [], c)).toMatchObject({ allow: false, code: 'protected' });
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, [], c)).toMatchObject({ allow: true });
  });

  it('does not install a second rule for a source that is already quarantined', () => {
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, ['10.0.2.50'], cfg.config)).toMatchObject({ allow: false, code: 'already_active' });
  });

  it('refuses at the cap, so a spoofed-source sweep cannot fill the table', () => {
    const active = Array.from({ length: DEFAULT_QUARANTINE_MAX_ACTIVE }, (_, i) => `10.0.2.${100 + i}`);
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, active, cfg.config)).toMatchObject({ allow: false, code: 'cap_reached' });
    expect(decideQuarantine({ targetIp: '10.0.2.50' }, active.slice(1), cfg.config)).toMatchObject({ allow: true });
  });

  it('the default cap leaves most of the 128-entry table untouched', () => {
    expect(DEFAULT_QUARANTINE_MAX_ACTIVE).toBeLessThanOrEqual(16);
  });
});
