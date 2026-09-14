/**
 * src/auth/google-auth.ts
 * Google SSO Authentication & Session Security Guard
 *
 * Council Invariants Enforced:
 * - Sanjay Ghemawat & Demis Hassabis: Fail-Closed Isolation & Default-Drop.
 *   Access is strictly denied unless the operator's Google email explicitly matches
 *   the verified allowlist. Zero ambient access.
 * - Sanjay Ghemawat: Radical Simplicity. Pure built-in Node.js crypto; zero bloated auth frameworks.
 * - Jeff Dean: Nanosecond token verification and deterministic HMAC-SHA256 session integrity.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface GoogleUserClaims {
  readonly email: string;
  readonly name?: string | undefined;
  readonly picture?: string | undefined;
  readonly sub: string; // Google User ID
  readonly issuedAt: number;
}

// Approved baseline operator allowlist
export const DEFAULT_ALLOWED_EMAILS: readonly string[] = Object.freeze([
  'sekyereandy@gmail.com',
  'natborks@gmail.com',
]);

/**
 * Checks whether an email address is permitted to access the operator dashboard.
 * Evaluates against DEFAULT_ALLOWED_EMAILS plus ALLOWED_GOOGLE_EMAILS env var.
 * Conforms to Ghemawat & Hassabis Fail-Closed Invariant: Case-insensitive, trims whitespace, defaults to false.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  const normalized = email.trim().toLowerCase();
  if (DEFAULT_ALLOWED_EMAILS.includes(normalized)) {
    return true;
  }

  const envAllowed = process.env['ALLOWED_GOOGLE_EMAILS'];
  if (envAllowed) {
    const customList = envAllowed
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);

    for (const pattern of customList) {
      if (pattern === normalized) return true;
      // Support domain wildcard, e.g. "@google.com" or "*@domain.com"
      if (pattern.startsWith('@') && normalized.endsWith(pattern)) return true;
      if (pattern.startsWith('*@') && normalized.endsWith(pattern.slice(1))) return true;
    }
  }

  return false;
}

const SESSION_COOKIE_NAME = 'agentic_session';
const DEFAULT_SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSessionSecret(): string {
  return process.env['SESSION_SECRET'] || process.env['ZODIAC_BRIDGE_SECRET'] || 'agentic-era-networking-default-secret-salt-2026';
}

/**
 * Creates an HMAC-SHA256 signed session token for authenticated operator claims.
 */
export function createSessionToken(
  user: GoogleUserClaims,
  secret: string = getSessionSecret()
): string {
  const payloadStr = JSON.stringify(user);
  const payloadBase64 = Buffer.from(payloadStr, 'utf-8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadBase64).digest('base64url');
  return `${payloadBase64}.${signature}`;
}

/**
 * Validates the HMAC signature and expiration of a session token.
 * Fail-Closed: returns null on any tampering, signature mismatch, or expiration.
 */
export function verifySessionToken(
  token: string | null | undefined,
  maxAgeSeconds: number = DEFAULT_SESSION_EXPIRY_SECONDS,
  secret: string = getSessionSecret()
): GoogleUserClaims | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const payloadBase64 = parts[0]!;
  const providedSignature = parts[1]!;

  const expectedSignature = createHmac('sha256', secret).update(payloadBase64).digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const providedBuf = Buffer.from(providedSignature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const jsonStr = Buffer.from(payloadBase64, 'base64url').toString('utf-8');
    const parsed = JSON.parse(jsonStr) as GoogleUserClaims;

    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.issuedAt !== 'number') {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - parsed.issuedAt > maxAgeSeconds) {
      return null; // Session expired
    }

    // Re-verify that the user is still on the allowlist
    if (!isEmailAllowed(parsed.email)) {
      return null;
    }

    return parsed;
  } catch (_err: unknown) {
    return null;
  }
}

/**
 * Parses HTTP request Cookie header into key-value map.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieHeader) return map;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key.length > 0) {
      map[key] = decodeURIComponent(val);
    }
  }
  return map;
}

/**
 * Extracts and verifies the current session user from an incoming HTTP request.
 */
export function getAuthenticatedUser(cookieHeader: string | undefined): GoogleUserClaims | null {
  const cookies = parseCookies(cookieHeader);
  const sessionToken = cookies[SESSION_COOKIE_NAME];
  return verifySessionToken(sessionToken);
}

/**
 * Builds the Set-Cookie header for an authenticated session.
 */
export function buildSessionCookieHeader(
  token: string,
  maxAgeSeconds: number = DEFAULT_SESSION_EXPIRY_SECONDS
): string {
  const isProd = process.env['NODE_ENV'] === 'production' || Boolean(process.env['VERCEL']);
  const secureFlag = isProd ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secureFlag}`;
}

/**
 * Builds the Set-Cookie header to clear the session upon logout.
 */
export function buildClearCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * Constructs the Google OAuth 2.0 authorization URL.
 */
export function buildGoogleOAuthUrl(redirectUri: string, state: string): string {
  const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Generates a cryptographically random state token to prevent CSRF.
 */
export function generateOAuthState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Enforces Council Invariant 3 (Fail-Closed Isolation) for Operator API endpoints.
 * Inspects physical network socket provenance (remoteAddress) to distinguish local loopback
 * from remote traffic, preventing Host header spoofing attacks.
 */
export function requireOperatorAuth(
  req: IncomingMessage,
  res: ServerResponse
): GoogleUserClaims | null {
  const remoteIp = req.socket?.remoteAddress ?? '';
  const isLoopback =
    remoteIp === '127.0.0.1' ||
    remoteIp === '::1' ||
    remoteIp === '::ffff:127.0.0.1';
  const hasGoogleOauth = Boolean(process.env['GOOGLE_CLIENT_ID']);

  // Local loopback development without OAuth configured uses default operator identity
  if (isLoopback && !hasGoogleOauth) {
    return {
      sub: 'local-loopback',
      email: 'sekyereandy@gmail.com',
      name: 'Andy Sekyere (Local Operator)',
      issuedAt: Math.floor(Date.now() / 1000),
    };
  }

  const user = getAuthenticatedUser(req.headers.cookie);
  if (!user && hasGoogleOauth) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Unauthorized: Operator Google SSO authentication required',
        loginUrl: '/api/auth/login',
      })
    );
    return null;
  }

  return user ?? (isLoopback ? {
    sub: 'local-loopback',
    email: 'sekyereandy@gmail.com',
    name: 'Andy Sekyere (Local Operator)',
    issuedAt: Math.floor(Date.now() / 1000),
  } : null);
}
