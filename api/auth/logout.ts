/**
 * api/auth/logout.ts
 * Clears operator session cookie and redirects to login / dashboard
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildClearCookieHeader } from '../../src/auth/google-auth.js';

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const clearCookie = buildClearCookieHeader();
  res.setHeader('Set-Cookie', clearCookie);
  res.statusCode = 302;
  res.setHeader('Location', '/');
  res.end();
}
