/**
 * api/auth/me.ts
 * Returns current authenticated operator identity from session cookie
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAuthenticatedUser } from '../../dist/auth/google-auth.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const remoteIp = req.socket?.remoteAddress ?? '';
  const isLocal =
    remoteIp === '127.0.0.1' ||
    remoteIp === '::1' ||
    remoteIp === '::ffff:127.0.0.1';

  // Verify session cookie
  const user = getAuthenticatedUser(req.headers.cookie);

  if (user) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      authenticated: true,
      user: {
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    }));
    return;
  }

  // If local development without Google SSO configured, offer local dev session
  const hasGoogleOauth = Boolean(process.env['GOOGLE_CLIENT_ID']);
  if (isLocal && !hasGoogleOauth) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      authenticated: true,
      isLocalDev: true,
      user: {
        email: 'sekyereandy@gmail.com',
        name: 'Local Operator (Dev Mode)',
        picture: null,
      },
    }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    authenticated: false,
    loginUrl: '/api/auth/login',
  }));
}
