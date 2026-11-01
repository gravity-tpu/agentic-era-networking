/**
 * isolation-watch-cli.ts
 * Polls the bridge's isolation status and sends the watcher's messages to ntfy (docs/design/isolation-watch.md). Runs as a systemd service on the Jetson
 * (deploy/jetson/zodiac-isolation-watch.service): `node dist/sdn/isolation-watch-cli.js` loops; `--test` sends one test push and exits; `--once` prints one
 * observation and its classification and exits without sending anything.
 *
 * Configuration (environment; never printed): ISOLATION_WATCH_NTFY_URL (required, the secret topic), ISOLATION_WATCH_NTFY_TOKEN (optional),
 * ISOLATION_WATCH_BRIDGE_URL (default http://127.0.0.1:3003), and the bounded settings in isolation-watch.ts.
 */

import { fileURLToPath } from 'node:url';
import { IsolationWatcher, classify, parseObservation, parseWatchConfig, type Observation, type WatchConfig, type WatchMessage } from './isolation-watch.js';
import { ntfyConfig, redactedTarget, sendNtfy } from './ntfy.js';

const BRIDGE_TIMEOUT_MS = 10_000;
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3003';

export interface PollDeps {
  readonly bridgeUrl: string;
  readonly fetchFn: typeof fetch;
  readonly send: (m: WatchMessage) => Promise<void>;
  /** monotonic nanoseconds */
  readonly now: () => bigint;
  readonly log: (s: string) => void;
}

async function observe(d: PollDeps): Promise<Observation> {
  try {
    const res = await d.fetchFn(`${d.bridgeUrl}/api/zodiac/flows`, { signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) });
    if (!res.ok) return { kind: 'unreachable', reason: `the bridge answered HTTP ${res.status}` };
    return parseObservation(await res.json());
  } catch (e) {
    return { kind: 'unreachable', reason: e instanceof Error ? e.message.slice(0, 120) : 'request failed' };
  }
}

/** One poll: read the bridge, update the watcher, send what is pending in order. A failed send stops this round and leaves the rest pending for the next. */
export async function pollOnce(d: PollDeps, w: IsolationWatcher, cfg: WatchConfig): Promise<Observation> {
  const o = await observe(d);
  w.observe(o, d.now());
  d.log(`poll: ${o.kind === 'unreachable' ? `unreachable (${o.reason})` : `state ${o.state}, table-miss ${o.tableMiss ?? 'n/a'}`} -> ${classify(o, cfg)}`);
  for (const m of w.outbox()) {
    try {
      await d.send(m);
      w.delivered(m.id);
      d.log(`sent ${m.kind}: ${m.title}`);
    } catch (e) {
      d.log(`could not send ${m.kind} (${e instanceof Error ? e.message : 'error'}); will retry`);
      break;
    }
  }
  return o;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cfg = parseWatchConfig(process.env);
  const bridgeUrl = (process.env['ISOLATION_WATCH_BRIDGE_URL'] ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
  const log = (s: string): void => { console.log(`${new Date().toISOString()} ${s}`); };

  if (args.includes('--once')) {
    const o = await observe({ bridgeUrl, fetchFn: fetch, send: async () => undefined, now: () => process.hrtime.bigint(), log });
    console.log(JSON.stringify({ observation: o, classification: classify(o, cfg) }));
    return;
  }
  const nc = ntfyConfig(process.env);
  const send = (m: WatchMessage): Promise<void> => sendNtfy(nc, m);
  if (args.includes('--test')) {
    await send({ id: 0, kind: 'started', title: 'Zodiac isolation watcher: test', body: 'If you can read this on your phone, alerts will reach you.', priority: 'default', tags: ['white_check_mark'] });
    log(`test message sent to ${redactedTarget(nc)}`);
    return;
  }
  log(`watching ${bridgeUrl} every ${cfg.pollIntervalMs / 1000} s; alerts go to ${redactedTarget(nc)}`);
  const w = new IsolationWatcher(cfg, process.hrtime.bigint());
  const d: PollDeps = { bridgeUrl, fetchFn: fetch, send, now: () => process.hrtime.bigint(), log };
  const stop = (): never => { log('stopping'); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (;;) {
    await pollOnce(d, w, cfg);
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
