/**
 * isolation-recheck.ts
 * Periodic re-verification of the Port 1 isolation policy against the switch's own flow table.
 *
 * The install-time readback (isolation-status.ts) is a point in time. A rule lost, altered or added afterwards, a
 * switch that rebooted into an empty table, or a session that dropped would leave an old `verified` standing. This
 * re-reads the table on a timer and updates the same status, so its age and its content stay honest.
 *
 * What it does: one OFPMP_FLOW request per interval, through the same readback and verifier as the install path.
 * What it does NOT do: change the switch. No FlowMod, no repair, no teardown. It records and surfaces; deciding what
 * should act on a mismatch is a separate, open decision.
 *
 * Damped (Invariant 5), asymmetric on purpose:
 *   - a definitive discrepancy (the switch reported something different) is recorded at once: waiting to confirm a
 *     real finding would only delay the alarm;
 *   - a read that fails (timeout, no session) must fail RECHECK_FAILURES_BEFORE_UNKNOWN times in a row before a
 *     `verified` status becomes `readback_failed`, so one lost reply does not flap the state; failed reads never
 *     replace a recorded `mismatch`, which is the stronger and more specific finding;
 *   - leaving `mismatch` or `readback_failed` for `verified` takes RECHECK_CLEAN_READS_TO_RECOVER clean readbacks in
 *     a row, so a single clean read between bad ones does not read as recovery.
 * Both streaks are CONSECUTIVE: a clean read clears the failure streak and a failure clears the clean streak. So a
 * switch that alternates good and bad reads never reaches either threshold: a mismatch stays a mismatch (the safe
 * direction), and a verified status stays verified while its age and the per-failure warnings show the flakiness.
 *
 * Fail closed (Invariant 3): it only runs once an install readback has produced a verdict, never while the install is
 * pending, and never concurrently with another flow-table read (the shared FlowReadLock), because the switch's MCU
 * is a 120 MHz part and the readback exists to observe it, not to load it.
 *
 * The timer is chained (the next check is scheduled when the last one finishes), so a slow check cannot overlap.
 */

import type { FlowStatsEntry } from './dataplane-benchmark.js';
import {
  describeReadback,
  readbackFailedStatus,
  statusFromReadback,
  type IsolationState,
  type IsolationStatus,
} from './isolation-status.js';
import { verifyIsolationReadback, type IsolationRule } from './port1-isolation.js';

export const DEFAULT_RECHECK_INTERVAL_MS = 60_000;
export const MIN_RECHECK_INTERVAL_MS = 10_000;
export const MAX_RECHECK_INTERVAL_MS = 3_600_000;
/** Consecutive failed reads before the status becomes `readback_failed`. */
export const RECHECK_FAILURES_BEFORE_UNKNOWN = 2;
/**
 * Once a failure streak is past RECHECK_FAILURES_BEFORE_UNKNOWN, repeat the warning only every this many failures, so an
 * unreachable switch is not logged every interval forever. The status itself already says what is known.
 */
export const RECHECK_REPEAT_LOG_EVERY = 10;
/** Consecutive clean readbacks before the status may return to `verified` from `mismatch` or `readback_failed`. */
export const RECHECK_CLEAN_READS_TO_RECOVER = 2;

export class RecheckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecheckConfigError';
  }
}

/**
 * ZODIAC_ISOLATION_RECHECK_INTERVAL_MS: unset gives the default; the exact value 0 disables the re-check; otherwise
 * an integer in MIN..MAX milliseconds. Anything else throws, so a typo cannot silently turn verification off.
 */
export function parseRecheckIntervalMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['ZODIAC_ISOLATION_RECHECK_INTERVAL_MS'];
  if (raw === undefined) return DEFAULT_RECHECK_INTERVAL_MS;
  if (raw === '0') return 0;
  if (!/^\d+$/.test(raw) || Number(raw) < MIN_RECHECK_INTERVAL_MS || Number(raw) > MAX_RECHECK_INTERVAL_MS) {
    throw new RecheckConfigError(
      `ZODIAC_ISOLATION_RECHECK_INTERVAL_MS must be 0 (disabled) or an integer in ${MIN_RECHECK_INTERVAL_MS}..${MAX_RECHECK_INTERVAL_MS}, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

/** One flow-table read at a time, shared by the periodic re-check and the on-demand probe. */
export class FlowReadLock {
  private held = false;
  public tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  public release(): void {
    this.held = false;
  }
  public get isHeld(): boolean {
    return this.held;
  }
}

/** States in which an install readback has produced a verdict, so a re-check means something. */
const ELIGIBLE: ReadonlySet<IsolationState> = new Set<IsolationState>(['verified', 'mismatch', 'readback_failed']);

export type RecheckOutcome = 'skipped' | 'unchanged' | 'changed';

export interface RecheckDeps {
  readonly policy: readonly IsolationRule[];
  /** One OFPMP_FLOW readback. Rejects on timeout, no session, or a malformed reply. */
  readonly read: () => Promise<readonly FlowStatsEntry[]>;
  readonly getStatus: () => IsolationStatus;
  readonly setStatus: (s: IsolationStatus) => void;
  readonly lock: FlowReadLock;
  readonly log: (level: 'info' | 'warn' | 'error', text: string) => void;
  readonly nowMs: () => number;
  readonly nowMonoNs: () => bigint;
  /** 0 disables the timer; runOnce still works (used by tests and on demand). */
  readonly intervalMs: number;
  /** Repeat the unreachable-switch warning every this many failures once past the escalation threshold. Default RECHECK_REPEAT_LOG_EVERY. */
  readonly repeatLogEvery?: number;
}

/** What matters about a status for "did it change": the verdict, not the timestamps. */
function signature(s: IsolationStatus): string {
  return JSON.stringify([
    s.state,
    s.provenForwarding,
    s.confirmed,
    s.mismatches,
    s.switchErrors,
    s.actions?.status ?? null,
    s.actions?.tableMiss ?? null,
    s.actions?.mismatches ?? null,
  ]);
}

export class IsolationRechecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private consecutiveCleanReads = 0;
  /** Bumped by reset(); a read that started in an earlier session is discarded when it finishes. */
  private epoch = 0;

  constructor(private readonly deps: RecheckDeps) {}

  /**
   * Logging is best effort and isolated: a logger that throws is reported on stderr and is never counted as a failed
   * check, so it cannot overwrite a status that was computed and stored correctly.
   */
  private log(level: 'info' | 'warn' | 'error', text: string): void {
    try {
      this.deps.log(level, text);
    } catch (err: unknown) {
      process.stderr.write(`[!] [Bridge Server] Isolation re-check: logger failed (${err instanceof Error ? err.message : String(err)}): ${text}\n`);
    }
  }

  /** Starts the chained timer. Idempotent; a no-op when the interval is 0. */
  public start(): void {
    if (this.deps.intervalMs === 0 || this.running) return;
    this.running = true;
    this.schedule();
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * A new OpenFlow session was installed: forget the previous session's streaks, and discard the result of any read
   * still outstanding from it (success or failure), so an old session cannot move the new session's counters.
   */
  public reset(): void {
    this.epoch += 1;
    this.consecutiveFailures = 0;
    this.consecutiveCleanReads = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // runOnce never rejects, but a timer callback in the controller's process must never be able to produce an
      // unhandled rejection, so this is guarded again.
      void this.runOnce()
        .catch((err: unknown) => {
          process.stderr.write(`[!] [Bridge Server] Isolation re-check: timer callback error: ${err instanceof Error ? err.message : String(err)}\n`);
        })
        .finally(() => this.schedule());
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  /**
   * One check. Never rejects: this runs from a timer in the process that is also the OpenFlow controller, so a fault
   * in this monitoring code (a throwing verifier or callback, say) must be reported and counted, not allowed to
   * become an unhandled rejection that takes the bridge down.
   */
  public async runOnce(): Promise<RecheckOutcome> {
    try {
      return await this.check();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Last resort, written directly so it cannot depend on a callback that may be the thing that threw.
      process.stderr.write(`[!] [Bridge Server] Isolation re-check: internal error, check abandoned: ${message}\n`);
      return 'unchanged';
    }
  }

  /** The log line for a status that changed. Building it is isolated too: it must not be able to fail a check. */
  private logChange(status: IsolationStatus, entryCount: number): void {
    try {
      const line = describeReadback(status, this.deps.policy.length, entryCount);
      if (status.state === 'verified') this.log('info', `Isolation re-check: back to ${line}`);
      else this.log('error', `Isolation re-check: the switch no longer matches the policy. ${line}`);
    } catch (err: unknown) {
      process.stderr.write(`[!] [Bridge Server] Isolation re-check: could not describe the change (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  /**
   * A read, or the interpretation of its reply, failed. Counted; only repeated failures change the status. If the
   * status store or logger is itself what is failing, nothing can be recorded here: the throw reaches runOnce, which
   * reports it on stderr every check rather than hiding it.
   */
  private recordFailure(err: unknown): RecheckOutcome {
    const d = this.deps;
    const message = err instanceof Error ? err.message : String(err);
    this.consecutiveCleanReads = 0;
    this.consecutiveFailures += 1;
    const latest = d.getStatus();
    if (this.consecutiveFailures >= RECHECK_FAILURES_BEFORE_UNKNOWN && latest.state === 'verified') {
      d.setStatus(readbackFailedStatus(latest, message, d.nowMs(), d.nowMonoNs()));
      this.log('error', `Isolation re-check: ${this.consecutiveFailures} failed readbacks in a row (${message}); status is now unknown (readback_failed).`);
      return 'changed';
    }
    const every = d.repeatLogEvery ?? RECHECK_REPEAT_LOG_EVERY;
    if (this.consecutiveFailures <= RECHECK_FAILURES_BEFORE_UNKNOWN || this.consecutiveFailures % every === 0) {
      this.log('warn', `Isolation re-check: readback failed (${message}); ${this.consecutiveFailures} in a row.`);
    }
    return 'unchanged';
  }

  private async check(): Promise<RecheckOutcome> {
    const d = this.deps;
    const current = d.getStatus();
    if (!ELIGIBLE.has(current.state)) return 'skipped';
    if (!d.lock.tryAcquire()) return 'skipped';
    const epoch = this.epoch;

    let entries: readonly FlowStatsEntry[];
    try {
      entries = await d.read();
    } catch (err: unknown) {
      if (epoch !== this.epoch) return 'skipped'; // a new session began while this read was outstanding
      return this.recordFailure(err);
    } finally {
      d.lock.release();
    }

    if (epoch !== this.epoch) return 'skipped';
    let outcome: RecheckOutcome;
    try {
      outcome = this.interpret(entries);
    } catch (err: unknown) {
      // The read succeeded but its reply could not be interpreted or recorded: a failed check, counted and damped.
      return this.recordFailure(err);
    }
    // The ONE place the failure streak is cleared, reached only when the whole interpretation, including recording the
    // status, completed without throwing. Clearing it earlier would let a check that fails after the read (a throwing
    // verifier or store) reset its own count every time and never be noticed; clearing it on several paths invites
    // them drifting apart.
    this.consecutiveFailures = 0;
    return outcome;
  }

  /** Interprets a successful read and records the result. May throw; check() counts a throw as a failed check. */
  private interpret(entries: readonly FlowStatsEntry[]): RecheckOutcome {
    const d = this.deps;
    const latest = d.getStatus();
    // The install path or a switch error may have moved the status while we were reading; judge against the latest.
    if (!ELIGIBLE.has(latest.state)) return 'skipped';
    const candidate = statusFromReadback(latest, verifyIsolationReadback(d.policy, entries), d.nowMs(), d.nowMonoNs());

    // Recovery (mismatch or readback_failed -> verified) needs a streak of clean readbacks; the streak is kept only by
    // the early return below, so every other path starts it over.
    if (candidate.state === 'verified' && latest.state !== 'verified') {
      this.consecutiveCleanReads += 1;
      if (this.consecutiveCleanReads < RECHECK_CLEAN_READS_TO_RECOVER) {
        this.log('info', `Isolation re-check: clean readback ${this.consecutiveCleanReads}/${RECHECK_CLEAN_READS_TO_RECOVER}; staying ${latest.state} until it holds.`);
        return 'unchanged';
      }
    }
    this.consecutiveCleanReads = 0;

    const changed = signature(candidate) !== signature(latest);
    d.setStatus(candidate);
    if (changed) this.logChange(candidate, entries.length);
    return changed ? 'changed' : 'unchanged';
  }
}
