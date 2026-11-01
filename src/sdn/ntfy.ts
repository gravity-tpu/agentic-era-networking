/**
 * ntfy.ts
 * Sending a push message through ntfy (https://ntfy.sh, or a self-hosted server): one HTTP POST per message, the topic in the URL path.
 * On the public server the topic IS the secret, so it is only ever read from the environment, never written to a log, a file in the repository or a chat;
 * `redactedTarget` is what may be shown. Headers are ASCII (HTTP header values must be), so titles are folded to ASCII.
 */

import type { WatchMessage } from './isolation-watch.js';

export interface NtfyConfig { readonly url: string; readonly token: string | null }

export function ntfyConfig(env: Readonly<Record<string, string | undefined>>): NtfyConfig {
  const raw = env['ISOLATION_WATCH_NTFY_URL'];
  if (raw === undefined || raw.trim() === '') throw new Error('ISOLATION_WATCH_NTFY_URL is required (for example https://ntfy.sh/<a long random topic>)');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('ISOLATION_WATCH_NTFY_URL is not a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('ISOLATION_WATCH_NTFY_URL must be an http or https URL');
  if (u.pathname.replace(/\//g, '') === '') throw new Error('ISOLATION_WATCH_NTFY_URL must include a topic (the path after the host)');
  const token = env['ISOLATION_WATCH_NTFY_TOKEN'];
  return { url: u.toString(), token: token === undefined || token === '' ? null : token };
}

/** What may appear in a log: the host only. */
export function redactedTarget(c: NtfyConfig): string { return new URL(c.url).host; }

const PRIORITY: Readonly<Record<WatchMessage['priority'], string>> = { low: '2', default: '3', high: '4', urgent: '5' };
const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');

export function ntfyRequest(m: WatchMessage, token: string | null): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { Title: ascii(m.title), Priority: PRIORITY[m.priority], Tags: m.tags.map(ascii).join(',') };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  return { headers, body: m.body };
}

export const NTFY_TIMEOUT_MS = 10_000;

/** POSTs one message; throws unless ntfy answers 2xx. The error never contains the URL. */
export async function sendNtfy(c: NtfyConfig, m: WatchMessage, fetchFn: typeof fetch = fetch): Promise<void> {
  const r = ntfyRequest(m, c.token);
  let res: Response;
  try {
    res = await fetchFn(c.url, { method: 'POST', headers: r.headers, body: r.body, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`ntfy request to ${redactedTarget(c)} failed: ${e instanceof Error ? e.name : 'error'}`);
  }
  if (!res.ok) throw new Error(`ntfy at ${redactedTarget(c)} answered HTTP ${res.status}`);
}
