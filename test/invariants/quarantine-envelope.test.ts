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
  MAX_EVIDENCE_SAMPLES,
  isLoopbackAddress,
  mayApproveQuarantine,
  readQuarantineEnvelopeConfig,
  sanitizeEvidence,
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

describe('quarantine mode', () => {
  it('defaults to propose', () => {
    expect(readQuarantineEnvelopeConfig({}).config.mode).toBe('propose');
  });
  it('only the exact value enforce selects enforce', () => {
    expect(readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_MODE: 'enforce' }).config.mode).toBe('enforce');
    for (const v of ['', 'ENFORCE', 'Enforce', 'true', '1', 'on', 'enforce ', 'propose', 'enforce;']) {
      expect(readQuarantineEnvelopeConfig({ ZODIAC_QUARANTINE_MODE: v }).config.mode, JSON.stringify(v)).toBe('propose');
    }
  });
});

describe('sanitizeEvidence', () => {
  it('keeps finite numbers and short number lists under plain keys', () => {
    expect(sanitizeEvidence({ pps: 18, windowFrames: 20, gaps: [1, 2, 3] })).toEqual({ pps: 18, windowFrames: 20, gaps: [1, 2, 3] });
  });
  it('keeps integers only: a fractional value is dropped, as is anything past 2^53', () => {
    expect(sanitizeEvidence({ a: 1.5, b: 2 ** 53, c: -3, d: [1, 2.5], e: [4, 5] })).toEqual({ c: -3, e: [4, 5] });
  });
  it('drops everything else: strings, nested objects, non-finite numbers, odd keys, long or mixed lists', () => {
    const long = Array.from({ length: MAX_EVIDENCE_SAMPLES + 1 }, (_, i) => i);
    const out = sanitizeEvidence({
      s: 'x', o: { a: 1 }, n: null, nan: NaN, inf: Infinity, 'bad key': 1, '1abc': 2, long, mixed: [1, 'a'], ok: 5,
    });
    expect(out).toEqual({ ok: 5 });
  });
  it('returns nothing for a non-object', () => {
    for (const v of [null, undefined, 3, 'x', [1, 2]]) expect(sanitizeEvidence(v)).toEqual({});
  });
  it('caps the number of keys', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeEvidence(many)).length).toBeLessThanOrEqual(12);
  });
});

describe('isLoopbackAddress', () => {
  it('accepts only the machine itself', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true);
  });
  it('refuses everything else, including look-alikes and no address', () => {
    for (const a of ['10.0.0.15', '10.0.2.119', '100.118.64.16', '127.0.0.2', '127.0.0.1.evil', '::ffff:10.0.0.1', '', 'localhost']) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('mayApproveQuarantine', () => {
  it('allows a local caller with no proxy headers', () => {
    expect(mayApproveQuarantine('127.0.0.1', {})).toBe(true);
    expect(mayApproveQuarantine('::1', { 'content-type': 'application/json' })).toBe(true);
  });
  it('refuses a remote caller whatever its headers', () => {
    expect(mayApproveQuarantine('10.0.0.15', {})).toBe(false);
    expect(mayApproveQuarantine(undefined, {})).toBe(false);
  });
  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via'])(
    'refuses a local caller carrying %s',
    (header) => {
      expect(mayApproveQuarantine('127.0.0.1', { [header]: '203.0.113.9' })).toBe(false);
      expect(mayApproveQuarantine('127.0.0.1', { [header]: [] })).toBe(false);
    },
  );
});
