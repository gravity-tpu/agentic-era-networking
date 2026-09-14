/**
 * api/auth/callback.ts
 * Google OAuth 2.0 / OpenID Connect Authorization Callback Handler
 *
 * Council Invariant: Fail-Closed Isolation & Default-Drop.
 * Validates Google authorization code, verifies Google token signature,
 * strictly enforces the operator email allowlist, upserts user, and issues
 * a cryptographically signed HMAC-SHA256 session cookie.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isEmailAllowed,
  createSessionToken,
  buildSessionCookieHeader,
  parseCookies,
  type GoogleUserClaims,
} from '../../dist/auth/google-auth.js';
import { upsertUser } from '../../dist/db/telemetry-db.js';

interface GoogleTokenResponse {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GoogleIdTokenPayload {
  readonly email?: string;
  readonly name?: string;
  readonly picture?: string;
  readonly sub?: string;
  readonly aud?: string;
  readonly exp?: number;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const host = req.headers.host || 'agentic-era-networking.vercel.app';
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;

  const url = new URL(req.url || '', `${protocol}://${host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // Verify CSRF state
  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies['oauth_state'];

  if (!code || !state || !expectedState || state !== expectedState) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <h2>❌ Authentication Error: Invalid CSRF State</h2>
      <p>The state parameter did not match. Please return to the <a href="/">portal</a> and try signing in again.</p>
    `);
    return;
  }

  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Server misconfiguration: Google OAuth credentials missing' }));
    return;
  }

  try {
    // 1. Exchange authorization code for tokens
    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      res.statusCode = 401;
      res.end(`Google Token Exchange Failed: ${errText}`);
      return;
    }

    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenData.id_token) {
      res.statusCode = 401;
      res.end('Missing id_token in Google OAuth response');
      return;
    }

    // 2. Verify ID token with Google tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
    if (!verifyRes.ok) {
      res.statusCode = 401;
      res.end('Google ID token verification failed');
      return;
    }

    const claims = (await verifyRes.json()) as GoogleIdTokenPayload;
    const userEmail = claims.email;

    // 3. Fail-Closed Invariant: Strict Email Allowlist Check
    if (!isEmailAllowed(userEmail)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>403 Forbidden - Operator Access Denied</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0b0f19; color: #f1f5f9; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
            .card { background: #1a1012; border: 1px solid #7f1d1d; border-radius: 12px; padding: 2rem; max-width: 520px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
            h2 { color: #f87171; margin-top: 0; }
            code { background: #2a1215; padding: 0.2rem 0.4rem; border-radius: 4px; color: #fca5a5; }
            .btn { display: inline-block; margin-top: 1.5rem; background: #dc2626; color: #fff; padding: 0.75rem 1.25rem; text-decoration: none; border-radius: 6px; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⛔ Access Denied (Fail-Closed Invariant)</h2>
            <p>Signed in as <code>${userEmail || 'Unknown'}</code>.</p>
            <p>This email is not authorized on the operator allowlist for this network appliance. Only authorized operators (e.g. <code>sekyereandy@gmail.com</code>, <code>natborks@gmail.com</code>) may access hardware telemetry.</p>
            <a class="btn" href="/api/auth/logout">Sign Out & Try Another Account</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // 4. Create operator claims & signed session token
    const userClaims: GoogleUserClaims = {
      email: userEmail!,
      sub: claims.sub || userEmail!,
      issuedAt: Math.floor(Date.now() / 1000),
      ...(claims.name !== undefined ? { name: claims.name } : {}),
      ...(claims.picture !== undefined ? { picture: claims.picture } : {}),
    };

    // 5. Asynchronously upsert user into database
    upsertUser(userClaims.email, userClaims.name, userClaims.picture).catch((err: unknown) => {
      console.warn('[!] [Auth DB] Failed to persist authenticated user:', err instanceof Error ? err.message : String(err));
    });

    // 6. Set secure session cookie & redirect to dashboard
    const sessionToken = createSessionToken(userClaims);
    const cookieHeader = buildSessionCookieHeader(sessionToken);

    res.statusCode = 302;
    res.setHeader('Location', '/');
    res.setHeader('Set-Cookie', [
      cookieHeader,
      'oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
    res.end();
  } catch (err: unknown) {
    console.error('[!] Google OAuth callback error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Authentication failed' }));
  }
}
