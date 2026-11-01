/**
 * isolation-watch.ts
 * A damped state machine that turns the bridge's isolation status into push messages for a person (docs/design/isolation-watch.md).
 *
 * Why it exists: the bridge re-reads the switch's flow table every minute and sets `port1Isolation.state` to `mismatch` for any table-miss problem (absent,
 * forwarding, unrecognised), but that reaches a person only through a dashboard badge, a status endpoint or the journal. Nothing pushes it. This module decides
 * WHEN a person should be told; `isolation-watch-cli.ts` polls the bridge and sends the messages to ntfy.
 *
 * Rules (Invariant 5: every limit named, configurable and bounded, every counter an integer, time monotonic):
 *   - a problem must persist for a number of consecutive polls before anyone is told (a table-miss problem is faster than a generic mismatch), so the stale
 *     `mismatch` that follows every experiment session does not page anybody;
 *   - an unreachable bridge, and a `verified` status whose check is older than the limit (the re-check has stopped, so `verified` is no longer evidence), are
 *     problems too: silence is never read as health;
 *   - one alert per episode, escalation (bad to critical) alerts again, reminders are spaced and bounded, one recovery message after consecutive clean polls;
 *   - a message stays in the outbox until the sender confirms delivery, so a failed push is retried, never lost or duplicated;
 *   - a heartbeat every 24 hours: silence from the watcher itself means it is not running.
 * Pure: no I/O, no clock of its own (the caller passes monotonic nanoseconds).
 */

export type Problem = 'bad' | 'critical' | 'stale' | 'unreachable';
export type Classification = 'ok' | Problem;

/** What the bridge reports about its own auto-repair (src/sdn/isolation-repair.ts): the isolation watcher tells a person when it acts or runs out of budget. */
export interface RepairInfo { readonly enabled: boolean; readonly totalRepairs: number; readonly exhausted: boolean; readonly lastTrigger: string | null }

export type Observation =
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'status'; readonly state: string; readonly tableMiss: string | null; readonly checkedAgeMs: number | null; readonly mismatches: number; readonly repair?: RepairInfo | null };

export interface WatchConfig {
  readonly pollIntervalMs: number;
  readonly badPollsToAlert: number;
  readonly criticalPollsToAlert: number;
  readonly unreachablePollsToAlert: number;
  readonly cleanPollsToRecover: number;
  readonly maxCheckAgeMs: number;
  readonly realertMs: number;
  readonly maxReminders: number;
  readonly heartbeatMs: number;
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  pollIntervalMs: 60_000,
  badPollsToAlert: 5, // outlasts the roughly two-minute stale mismatch after an experiment session
  criticalPollsToAlert: 2, // a lost, forwarding or unrecognised table-miss, or a rejected policy
  unreachablePollsToAlert: 3,
  cleanPollsToRecover: 2,
  maxCheckAgeMs: 300_000, // the bridge re-checks every 60 s by default
  realertMs: 1_800_000,
  maxReminders: 8,
  heartbeatMs: 86_400_000,
};

interface Bound { readonly env: string; readonly key: keyof WatchConfig; readonly min: number; readonly max: number }
const BOUNDS: readonly Bound[] = [
  { env: 'ISOLATION_WATCH_POLL_MS', key: 'pollIntervalMs', min: 10_000, max: 3_600_000 },
  { env: 'ISOLATION_WATCH_BAD_POLLS', key: 'badPollsToAlert', min: 1, max: 100 },
  { env: 'ISOLATION_WATCH_CRITICAL_POLLS', key: 'criticalPollsToAlert', min: 1, max: 100 },
  { env: 'ISOLATION_WATCH_UNREACHABLE_POLLS', key: 'unreachablePollsToAlert', min: 1, max: 100 },
  { env: 'ISOLATION_WATCH_CLEAN_POLLS', key: 'cleanPollsToRecover', min: 1, max: 100 },
  { env: 'ISOLATION_WATCH_MAX_CHECK_AGE_MS', key: 'maxCheckAgeMs', min: 60_000, max: 3_600_000 },
  { env: 'ISOLATION_WATCH_REALERT_MS', key: 'realertMs', min: 60_000, max: 86_400_000 },
  { env: 'ISOLATION_WATCH_MAX_REMINDERS', key: 'maxReminders', min: 0, max: 100 },
  { env: 'ISOLATION_WATCH_HEARTBEAT_MS', key: 'heartbeatMs', min: 3_600_000, max: 604_800_000 },
];

/** Reads the configuration from the environment. A value outside its bounds, or not a whole number, is an error: nothing is silently clamped. */
export function parseWatchConfig(env: Readonly<Record<string, string | undefined>>): WatchConfig {
  const out: Record<string, number> = { ...DEFAULT_WATCH_CONFIG };
  for (const b of BOUNDS) {
    const raw = env[b.env];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < b.min || n > b.max) throw new RangeError(`${b.env} must be a whole number from ${b.min} to ${b.max}, got ${JSON.stringify(raw)}`);
    out[b.key] = n;
  }
  const cfg = out as unknown as WatchConfig;
  if (cfg.criticalPollsToAlert > cfg.badPollsToAlert) throw new RangeError('ISOLATION_WATCH_CRITICAL_POLLS must not exceed ISOLATION_WATCH_BAD_POLLS: a lost table-miss must never be slower to report than a generic mismatch');
  return cfg;
}

const CRITICAL_TABLE_MISS: ReadonlySet<string> = new Set(['absent', 'forwards', 'unrecognised']);
const OK_TABLE_MISS: ReadonlySet<string> = new Set(['drops', 'unobservable']);

export function classify(o: Observation, cfg: WatchConfig): Classification {
  if (o.kind === 'unreachable') return 'unreachable';
  if (o.state === 'verifier_rejected') return 'critical';
  if (o.repair?.exhausted === true) return 'critical'; // the bridge spent its repair budget and the table-miss is still wrong: a person is needed
  if (o.tableMiss !== null && CRITICAL_TABLE_MISS.has(o.tableMiss)) return 'critical';
  if (o.state !== 'verified') return 'bad'; // mismatch, readback_failed, not_installed and anything unknown: never ok
  if (o.tableMiss !== null && !OK_TABLE_MISS.has(o.tableMiss)) return 'bad';
  if (o.checkedAgeMs === null || o.checkedAgeMs > cfg.maxCheckAgeMs) return 'stale';
  return 'ok';
}

/** Reads the bridge's status payload (`GET /api/zodiac/flows` or `/api/zodiac`). Anything it cannot read is unreachable, never ok. */
export function parseObservation(json: unknown): Observation {
  const bad = (reason: string): Observation => ({ kind: 'unreachable', reason });
  if (typeof json !== 'object' || json === null) return bad('the status payload is not an object');
  const iso = (json as { port1Isolation?: unknown }).port1Isolation;
  if (typeof iso !== 'object' || iso === null) return bad('the status payload has no port1Isolation');
  const p = iso as { state?: unknown; checkedAgeMs?: unknown; mismatches?: unknown; actions?: { tableMiss?: unknown } | null };
  if (typeof p.state !== 'string') return bad('port1Isolation.state is not a string');
  const tm = p.actions?.tableMiss;
  const rp = (iso as { repair?: unknown }).repair;
  let repair: RepairInfo | null = null;
  if (typeof rp === 'object' && rp !== null) {
    const r = rp as { enabled?: unknown; totalRepairs?: unknown; exhausted?: unknown; lastTrigger?: unknown };
    if (typeof r.enabled === 'boolean' && typeof r.exhausted === 'boolean' && typeof r.totalRepairs === 'number' && Number.isSafeInteger(r.totalRepairs) && r.totalRepairs >= 0) {
      repair = { enabled: r.enabled, totalRepairs: r.totalRepairs, exhausted: r.exhausted, lastTrigger: typeof r.lastTrigger === 'string' ? r.lastTrigger : null };
    }
  }
  return {
    kind: 'status',
    state: p.state,
    tableMiss: typeof tm === 'string' ? tm : null,
    checkedAgeMs: typeof p.checkedAgeMs === 'number' && Number.isFinite(p.checkedAgeMs) ? p.checkedAgeMs : null,
    mismatches: Array.isArray(p.mismatches) ? p.mismatches.length : 0,
    repair,
  };
}

export type MessageKind = 'started' | 'alert' | 'reminder' | 'recovered' | 'heartbeat' | 'repair';
export type Priority = 'low' | 'default' | 'high' | 'urgent';
export interface WatchMessage { readonly id: number; readonly kind: MessageKind; readonly title: string; readonly body: string; readonly priority: Priority; readonly tags: readonly string[] }

const SEVERITY: Readonly<Record<Problem, number>> = { bad: 1, stale: 1, unreachable: 1, critical: 2 };
const NS_PER_MS = 1_000_000n;
const WHERE = 'Look at: the dashboard panel "SDN Boundary Containment", GET /api/zodiac/flows, or journalctl -u zodiac-bridge on the Jetson.';

function describe(o: Observation | null): string {
  if (o === null) return 'no observation yet';
  if (o.kind === 'unreachable') return `the status could not be read: ${o.reason}`;
  const rep = o.repair === undefined || o.repair === null ? '' : `, auto-repair ${o.repair.enabled ? 'on' : 'off'} (${o.repair.totalRepairs} so far${o.repair.exhausted ? ', BUDGET SPENT: a person is needed' : ''})`;
  return `state ${o.state}, table-miss ${o.tableMiss ?? 'not reported'}, ${o.mismatches} mismatch(es), last check ${o.checkedAgeMs === null ? 'unknown' : `${Math.round(o.checkedAgeMs / 1000)} s`} ago${rep}`;
}

function alertFor(c: Problem, last: Observation | null): { title: string; body: string; priority: Priority; tags: string[] } {
  switch (c) {
    case 'critical': return { title: 'Zodiac isolation: CRITICAL', body: `The table-miss DROP or the policy is wrong: ${describe(last)}. The default drop is not confirmed. ${WHERE}`, priority: 'urgent', tags: ['rotating_light'] };
    case 'bad': return { title: 'Zodiac isolation: mismatch', body: `The switch's table differs from the policy: ${describe(last)}. ${WHERE}`, priority: 'high', tags: ['warning'] };
    case 'stale': return { title: 'Zodiac isolation re-check stopped', body: `The bridge reports verified but its isolation re-check is not running (${describe(last)}), so verified is not evidence. ${WHERE}`, priority: 'high', tags: ['warning'] };
    case 'unreachable': return { title: 'Zodiac bridge unreachable', body: `The bridge cannot be reached (${describe(last)}). Nothing is known about the isolation. ${WHERE}`, priority: 'high', tags: ['warning'] };
  }
}

interface Episode { problemClass: Problem; alertedSeverity: number; alertedAtNs: bigint; lastNotifiedNs: bigint; reminders: number }

export class IsolationWatcher {
  private readonly pending: WatchMessage[] = [];
  private nextId = 1;
  private streakClass: Problem | null = null;
  private streak = 0;
  private clean = 0;
  private episode: Episode | null = null;
  private lastObservation: Observation | null = null;
  private lastRepairTotal: number | null = null;
  private lastHeartbeatNs: bigint;

  constructor(private readonly cfg: WatchConfig, startNs: bigint) {
    this.lastHeartbeatNs = startNs;
    this.push('started', 'Zodiac isolation watcher started', `Watching the bridge every ${cfg.pollIntervalMs / 1000} s. A heartbeat follows every ${Math.round(cfg.heartbeatMs / 3_600_000)} h: no heartbeat means this watcher is not running.`, 'default', ['white_check_mark']);
  }

  private push(kind: MessageKind, title: string, body: string, priority: Priority, tags: readonly string[]): void {
    this.pending.push({ id: this.nextId++, kind, title, body, priority, tags });
  }

  private threshold(c: Problem): number {
    return c === 'critical' ? this.cfg.criticalPollsToAlert : c === 'bad' ? this.cfg.badPollsToAlert : this.cfg.unreachablePollsToAlert;
  }

  observe(o: Observation, nowNs: bigint): void {
    this.lastObservation = o;
    this.noteRepairs(o);
    const c = classify(o, this.cfg);
    if (c === 'ok') {
      this.streakClass = null; this.streak = 0; this.clean++;
      if (this.episode !== null && this.clean >= this.cfg.cleanPollsToRecover) {
        this.push('recovered', 'Zodiac isolation recovered', `Back to verified with the table-miss dropping: ${describe(o)}.`, 'default', ['white_check_mark']);
        this.episode = null;
      }
    } else {
      this.clean = 0;
      if (this.streakClass === c) this.streak++; else { this.streakClass = c; this.streak = 1; }
      if (this.streak >= this.threshold(c)) this.problem(c, nowNs);
    }
    if (nowNs - this.lastHeartbeatNs >= BigInt(this.cfg.heartbeatMs) * NS_PER_MS) {
      this.lastHeartbeatNs = nowNs;
      this.push('heartbeat', 'Zodiac isolation watcher: alive', `Still watching. Now: ${describe(o)}${this.episode === null ? '' : ' (a problem is open)'}.`, 'low', ['heart']);
    }
  }

  /** One message each time the bridge's own repair count goes up. The first observation is the baseline (an old repair is not announced), and a count that drops means the bridge restarted. */
  private noteRepairs(o: Observation): void {
    if (o.kind !== 'status' || o.repair === undefined || o.repair === null) return;
    const total = o.repair.totalRepairs;
    if (this.lastRepairTotal !== null && total > this.lastRepairTotal) {
      this.push('repair', 'Zodiac isolation: the bridge repaired itself', `The bridge re-sent the default DROP by itself (the table-miss read "${o.repair.lastTrigger ?? 'wrong'}"); ${total} repair(s) so far. Something changed or removed the default drop: the repair is automatic, the cause is not. ${WHERE}`, 'high', ['wrench']);
    }
    this.lastRepairTotal = total;
  }

  private problem(c: Problem, nowNs: bigint): void {
    const sev = SEVERITY[c];
    const ep = this.episode;
    if (ep === null || sev > ep.alertedSeverity) {
      const a = alertFor(c, this.lastObservation);
      this.push('alert', a.title, a.body, a.priority, a.tags);
      this.episode = { problemClass: c, alertedSeverity: sev, alertedAtNs: nowNs, lastNotifiedNs: nowNs, reminders: 0 };
      return;
    }
    if (ep.reminders < this.cfg.maxReminders && nowNs - ep.lastNotifiedNs >= BigInt(this.cfg.realertMs) * NS_PER_MS) {
      const a = alertFor(ep.problemClass === 'critical' || c === 'critical' ? 'critical' : c, this.lastObservation);
      this.push('reminder', `STILL: ${a.title}`, `${a.body} (reminder ${ep.reminders + 1} of at most ${this.cfg.maxReminders})`, a.priority, a.tags);
      ep.reminders++;
      ep.lastNotifiedNs = nowNs;
    }
  }

  /** Messages waiting to be sent, oldest first. */
  outbox(): WatchMessage[] { return [...this.pending]; }

  /** The sender confirms a message was delivered; only then is it removed. */
  delivered(id: number): void {
    const i = this.pending.findIndex((m) => m.id === id);
    if (i >= 0) this.pending.splice(i, 1);
  }
}
