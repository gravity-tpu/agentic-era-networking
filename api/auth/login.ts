/**
 * api/auth/login.ts
 * Initiates Google OAuth 2.0 OpenID Connect Authentication
 *
 * Council Invariant: Fail-Closed Isolation.
 * Rejects unhandled HTTP methods. Redirects to Google consent screen with secure CSRF state.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildGoogleOAuthUrl, generateOAuthState } from '../../dist/auth/google-auth.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const host = req.headers.host || 'agentic-era-networking.vercel.app';
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;

  if (!clientId) {
    // Helpful diagnostic if Google OAuth is not yet configured in environment variables
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google SSO Setup Required</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0b0f19; color: #f1f5f9; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
          .card { background: #131a2b; border: 1px solid #1e293b; border-radius: 12px; padding: 2rem; max-width: 520px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
          h2 { color: #38bdf8; margin-top: 0; }
          code { background: #080c14; padding: 0.2rem 0.4rem; border-radius: 4px; color: #a5f3fc; }
          .btn { display: inline-block; margin-top: 1.5rem; background: #2563eb; color: #fff; padding: 0.75rem 1.25rem; text-decoration: none; border-radius: 6px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔒 Google SSO Configuration Required</h2>
          <p>The operator portal is guarded by Google Single Sign-On, but <code>GOOGLE_CLIENT_ID</code> is not yet defined in environment variables.</p>
          <p><strong>Required Redirect URI:</strong><br><code>${redirectUri}</code></p>
          <p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your Vercel project settings or local <code>.env</code> file.</p>
          <a class="btn" href="/">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
    return;
  }

  const state = generateOAuthState();
  const authUrl = buildGoogleOAuthUrl(redirectUri, state);

  // Set CSRF state cookie and redirect to Google OAuth
  res.statusCode = 302;
  res.setHeader('Location', authUrl);
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.end();
}
