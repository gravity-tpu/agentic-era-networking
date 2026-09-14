/**
 * test/auth/google-auth.test.ts
 * Tests for Google SSO Authentication Guard (Council Invariant 3: Fail-Closed Isolation)
 *
 * Council Invariants:
 * - Fail-Closed Isolation: Unrecognized or non-allowlisted emails MUST be rejected with zero ambient trust.
 * - Deterministic Security: Cryptographic HMAC-SHA256 tokens detect tampering with constant-time verification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isEmailAllowed,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  buildSessionCookieHeader,
  buildClearCookieHeader,
  generateOAuthState,
  requireOperatorAuth,
  DEFAULT_ALLOWED_EMAILS,
  type GoogleUserClaims,
} from '../../src/auth/google-auth.js';

describe('Google SSO Authentication Guard (Council Invariant 3)', () => {
  const originalEnv = process.env['ALLOWED_GOOGLE_EMAILS'];

  const testUser: GoogleUserClaims = {
    email: 'sekyereandy@gmail.com',
    name: 'Andy Sekyere',
    sub: 'google-sub-123456789',
    issuedAt: Math.floor(Date.now() / 1000),
  };

  beforeEach(() => {
    delete process.env['ALLOWED_GOOGLE_EMAILS'];
  });

  afterEach(() => {
    if (originalEnv) {
      process.env['ALLOWED_GOOGLE_EMAILS'] = originalEnv;
    } else {
      delete process.env['ALLOWED_GOOGLE_EMAILS'];
    }
  });

  describe('isEmailAllowed', () => {
    it('approves operators on the default approved list (sekyereandy and natborks)', () => {
      expect(isEmailAllowed('sekyereandy@gmail.com')).toBe(true);
      expect(isEmailAllowed('SEKYEREANDY@GMAIL.COM')).toBe(true); // Case-insensitive
      expect(isEmailAllowed('  sekyereandy@gmail.com  ')).toBe(true); // Trims whitespace
      expect(isEmailAllowed('natborks@gmail.com')).toBe(true);
      expect(isEmailAllowed('NATBORKS@GMAIL.COM')).toBe(true);
    });

    it('rejects unauthorized emails by default (Fail-Closed Invariant)', () => {
      expect(isEmailAllowed('intruder@gmail.com')).toBe(false);
      expect(isEmailAllowed('admin@example.com')).toBe(false);
      expect(isEmailAllowed(null)).toBe(false);
      expect(isEmailAllowed(undefined)).toBe(false);
      expect(isEmailAllowed('')).toBe(false);
      expect(isEmailAllowed('   ')).toBe(false);
    });

    it('supports custom allowlist and domain wildcards via ALLOWED_GOOGLE_EMAILS', () => {
      process.env['ALLOWED_GOOGLE_EMAILS'] = 'operator@corp.internal, @deepmind.com, *@google.com';

      expect(isEmailAllowed('operator@corp.internal')).toBe(true);
      expect(isEmailAllowed('researcher@deepmind.com')).toBe(true);
      expect(isEmailAllowed('engineer@google.com')).toBe(true);
      expect(isEmailAllowed('attacker@othercorp.com')).toBe(false);
    });
  });

  describe('Session Token Cryptographic Integrity', () => {
    it('creates and verifies a valid HMAC-SHA256 session token', () => {
      const token = createSessionToken(testUser);
      expect(token).toContain('.');

      const verified = verifySessionToken(token);
      expect(verified).not.toBeNull();
      expect(verified?.email).toBe('sekyereandy@gmail.com');
      expect(verified?.name).toBe('Andy Sekyere');
    });

    it('rejects tampered token payload (Fail-Closed)', () => {
      const token = createSessionToken(testUser);
      const parts = token.split('.');
      // Tamper with payload by changing base64 string
      const tamperedPayload = Buffer.from(JSON.stringify({ ...testUser, email: 'hacker@evil.com' })).toString('base64url');
      const tamperedToken = `${tamperedPayload}.${parts[1]}`;

      const verified = verifySessionToken(tamperedToken);
      expect(verified).toBeNull();
    });

    it('rejects tampered signature (Fail-Closed)', () => {
      const token = createSessionToken(testUser);
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.bad_signature_here`;

      const verified = verifySessionToken(tamperedToken);
      expect(verified).toBeNull();
    });

    it('rejects expired session tokens', () => {
      const expiredUser: GoogleUserClaims = {
        ...testUser,
        issuedAt: Math.floor(Date.now() / 1000) - 1000, // 1000 seconds ago
      };
      const token = createSessionToken(expiredUser);

      // Max age 500 seconds
      const verified = verifySessionToken(token, 500);
      expect(verified).toBeNull();
    });

    it('rejects valid tokens if user has been removed from allowlist', () => {
      const revokedUser: GoogleUserClaims = {
        email: 'revoked.operator@example.com',
        sub: 'google-sub-999',
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const token = createSessionToken(revokedUser);

      // Since revoked.operator@example.com is not on the allowlist, verify fails closed
      const verified = verifySessionToken(token);
      expect(verified).toBeNull();
    });
  });

  describe('Cookie Parsing and Construction', () => {
    it('parses cookies from Cookie header accurately', () => {
      const header = 'agentic_session=abc.123; other_cookie=xyz; empty_cookie=';
      const parsed = parseCookies(header);
      expect(parsed['agentic_session']).toBe('abc.123');
      expect(parsed['other_cookie']).toBe('xyz');
      expect(parsed['empty_cookie']).toBe('');
    });

    it('constructs HttpOnly SameSite=Lax session cookie header with Secure by default (Fail-Closed Invariant)', () => {
      const defaultCookie = buildSessionCookieHeader('sample.jwt.token');
      expect(defaultCookie).toContain('agentic_session=sample.jwt.token');
      expect(defaultCookie).toContain('HttpOnly');
      expect(defaultCookie).toContain('SameSite=Lax');
      expect(defaultCookie).toContain('Path=/');
      expect(defaultCookie).toContain('; Secure'); // Fail-Closed: defaults to Secure even without env flags

      // Strips Secure only when explicitly proven to be local loopback
      const localReq = {
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as import('node:http').IncomingMessage;
      const localCookie = buildSessionCookieHeader('sample.jwt.token', 600, localReq);
      expect(localCookie).not.toContain('; Secure');

      // Preserves Secure for remote requests
      const remoteReq = {
        socket: { remoteAddress: '203.0.113.42' },
      } as unknown as import('node:http').IncomingMessage;
      const remoteCookie = buildSessionCookieHeader('sample.jwt.token', 600, remoteReq);
      expect(remoteCookie).toContain('; Secure');
    });

    it('constructs clear cookie header with Max-Age=0', () => {
      const clearCookie = buildClearCookieHeader();
      expect(clearCookie).toContain('agentic_session=;');
      expect(clearCookie).toContain('Max-Age=0');
    });

    it('generates random hex states of 32 characters (16 bytes)', () => {
      const state1 = generateOAuthState();
      const state2 = generateOAuthState();
      expect(state1).toHaveLength(32);
      expect(state2).toHaveLength(32);
      expect(state1).not.toBe(state2);
    });
  });

  describe('requireOperatorAuth (Anti-Host-Spoofing & Fail-Closed Isolation)', () => {
    const origClientId = process.env['GOOGLE_CLIENT_ID'];

    afterEach(() => {
      if (origClientId) {
        process.env['GOOGLE_CLIENT_ID'] = origClientId;
      } else {
        delete process.env['GOOGLE_CLIENT_ID'];
      }
    });

    it('rejects remote request attempting Host header spoofing (Fail-Closed)', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'mock-client-id';

      const mockReq = {
        headers: { host: 'localhost:3000' }, // Spoofed host header
        socket: { remoteAddress: '203.0.113.42' }, // Remote attacker IP
      } as unknown as import('node:http').IncomingMessage;

      let statusCode = 200;
      let body = '';
      const mockRes = {
        setHeader: () => {},
        set statusCode(code: number) { statusCode = code; },
        end: (data?: string) => { if (data) body = data; },
      } as unknown as import('node:http').ServerResponse;

      const user = requireOperatorAuth(mockReq, mockRes);
      expect(user).toBeNull();
      expect(statusCode).toBe(401);
      expect(body).toContain('Unauthorized');
    });

    it('allows loopback requests when OAuth is not configured', () => {
      delete process.env['GOOGLE_CLIENT_ID'];

      const mockReq = {
        headers: { host: 'localhost:3000' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as import('node:http').IncomingMessage;

      const mockRes = {
        setHeader: () => {},
        end: () => {},
      } as unknown as import('node:http').ServerResponse;

      const user = requireOperatorAuth(mockReq, mockRes);
      expect(user).not.toBeNull();
      expect(user?.email).toBe('sekyereandy@gmail.com');
    });

    it('authenticates valid operator session token from remote IP', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'mock-client-id';
      const token = createSessionToken(testUser);

      const mockReq = {
        headers: {
          host: 'agentic-era-networking.vercel.app',
          cookie: `agentic_session=${token}`,
        },
        socket: { remoteAddress: '198.51.100.25' },
      } as unknown as import('node:http').IncomingMessage;

      const mockRes = {
        setHeader: () => {},
        end: () => {},
      } as unknown as import('node:http').ServerResponse;

      const user = requireOperatorAuth(mockReq, mockRes);
      expect(user).not.toBeNull();
      expect(user?.email).toBe('sekyereandy@gmail.com');
    });
  });
});
