/**
 * isolation-status.ts
 * The bridge's record of what the switch itself reports about the Port 1 isolation policy, and the pure rules that
 * turn a readback into it.
 *
 * Two levels, kept separate on purpose:
 *   match level   every rule is present exactly once with identical match fields, plus a table-miss entry;
 *   action level  each rule's output ports equal the policy's, nothing else is attached, and the table-miss drops.
 *
 * `state` is the verdict the dashboard and operators act on:
 *   verified   match level verified, no switch-side errors, and the switch did NOT report different actions
 *   mismatch   anything the switch reported differs from the policy (match, actions, or an OFPT_ERROR)
 * A switch that reports no actions at all leaves the state `verified` (the match level is what was checkable) but
 * `provenForwarding` false: the status never claims more than was observed. On Zodiac FX firmware 0.86 actions are
 * reported and match the controller's encoding byte for byte (docs/benchmarks/results/flow-probe/, 2026-10-15), so
 * a healthy switch yields provenForwarding true.
 *
 * Nothing here actuates: a mismatch is recorded and surfaced; it does not remove or reinstall rules.
 *
 * The status is a point-in-time record: the readback runs once, at install. Consumers must read it with its age
 * (`checkedAgeMs` in the API form), not as a live fact.
 *
 * Pure functions, no I/O. Statuses are immutable; every change returns a new one. Timestamps are supplied by the
 * caller (monotonic ns from process.hrtime.bigint()).
 */

import type { ActionReadbackVerdict } from './action-readback.js';
import type { IsolationReadbackVerdict } from './port1-isolation.js';

export type IsolationState =
  | 'not_installed'
  | 'verifier_rejected'
  | 'pending_readback'
  | 'verified'
  | 'mismatch'
  | 'readback_failed';

export interface IsolationStatus {
  readonly state: IsolationState;
  /** Policy rule ids confirmed on the switch with an exact field-for-field match. */
  readonly confirmed: readonly string[];
  /** Match-level discrepancies, or the verifier's violations, or the readback failure message. */
  readonly mismatches: readonly string[];
  /** OFPT_ERROR messages the switch returned for isolation FlowMods. Never mutated: see withSwitchError. */
  readonly switchErrors: readonly string[];
  /**
   * When this status was last ESTABLISHED: a completed readback, or the moment it became `readback_failed`. A run of
   * failed reads after that does not re-stamp it, so its age keeps growing while the status stays unknown.
   */
  readonly checkedAtMs: number | null;
  readonly checkedAtMonoNs: bigint | null;
  /** Action level from the same readback; null until a readback has completed. */
  readonly actions: ActionReadbackVerdict | null;
  /**
   * Total flow entries the switch reported in the readback that produced this status (the table's real size, not just
   * the policy's rules); null until a readback has completed, and again after a failed one.
   */
  readonly switchEntryCount: number | null;
  /** True only when the match level verified AND the switch reported exactly the intended output ports. */
  readonly provenForwarding: boolean;
}

export function initialIsolationStatus(): IsolationStatus {
  return {
    state: 'not_installed',
    confirmed: [],
    mismatches: [],
    switchErrors: [],
    checkedAtMs: null,
    checkedAtMonoNs: null,
    actions: null,
    switchEntryCount: null,
    provenForwarding: false,
  };
}

export function verifierRejectedStatus(violations: readonly string[], nowMs: number, nowMonoNs: bigint): IsolationStatus {
  return { ...initialIsolationStatus(), state: 'verifier_rejected', mismatches: violations, checkedAtMs: nowMs, checkedAtMonoNs: nowMonoNs };
}

export function pendingReadbackStatus(): IsolationStatus {
  return { ...initialIsolationStatus(), state: 'pending_readback' };
}

/**
 * The status after a completed readback. `prev.switchErrors` (a copy) are carried over: an OFPT_ERROR for an
 * isolation FlowMod makes the state `mismatch` even if the readback otherwise looks right.
 */
export function statusFromReadback(
  prev: IsolationStatus,
  verdict: IsolationReadbackVerdict,
  nowMs: number,
  nowMonoNs: bigint,
  switchEntryCount: number | null = null,
): IsolationStatus {
  const ok = verdict.verified && prev.switchErrors.length === 0 && verdict.actions.status !== 'mismatch';
  return {
    state: ok ? 'verified' : 'mismatch',
    confirmed: verdict.confirmed,
    mismatches: verdict.mismatches,
    switchErrors: [...prev.switchErrors],
    checkedAtMs: nowMs,
    checkedAtMonoNs: nowMonoNs,
    actions: verdict.actions,
    switchEntryCount,
    provenForwarding: ok && verdict.provenForwarding,
  };
}

/**
 * Records an OFPT_ERROR the switch sent for an isolation FlowMod. Normally it arrives before the readback reply and
 * statusFromReadback accounts for it; if it arrives after a `verified` status, that status is no longer true, so it
 * becomes `mismatch` and forwarding is no longer proven. Returns a new status; `prev` is not changed.
 */
export function withSwitchError(prev: IsolationStatus, line: string): IsolationStatus {
  const wasVerified = prev.state === 'verified';
  return {
    ...prev,
    switchErrors: [...prev.switchErrors, line],
    state: wasVerified ? 'mismatch' : prev.state,
    provenForwarding: wasVerified ? false : prev.provenForwarding,
  };
}

export function readbackFailedStatus(prev: IsolationStatus, message: string, nowMs: number, nowMonoNs: bigint): IsolationStatus {
  return {
    ...prev,
    state: 'readback_failed',
    // A failed readback means nothing is known now: do not leave a previous status's confirmations standing.
    confirmed: [],
    mismatches: [message],
    checkedAtMs: nowMs,
    checkedAtMonoNs: nowMonoNs,
    actions: null,
    switchEntryCount: null,
    provenForwarding: false,
  };
}

/** The log line for a completed readback, saying exactly what was and was not established. */
export function describeReadback(status: IsolationStatus, ruleCount: number, entryCount: number): string {
  if (status.state === 'verified') {
    const head = `Isolation readback VERIFIED: ${status.confirmed.length}/${ruleCount} rules confirmed on switch (${entryCount} total entries)`;
    if (status.provenForwarding) return `${head}; actions confirmed (output ports and table-miss drop).`;
    const why = status.actions === null ? 'no action readback' : `action readback ${status.actions.status}`;
    return `${head}; MATCH LEVEL ONLY (${why}), so forwarding is not proven by readback.`;
  }
  const problems = [...status.mismatches, ...(status.actions?.mismatches ?? []), ...status.switchErrors];
  return `Isolation readback MISMATCH (${entryCount} switch entries):\n  ${problems.join('\n  ')}`;
}

export type IsolationStatusJson = Omit<IsolationStatus, 'checkedAtMonoNs'> & {
  checkedAtMonoNs: string | null;
  /** Milliseconds since the readback, from the monotonic clock; null unless `ageStatus` is `ok`. */
  checkedAgeMs: number | null;
  /**
   * `never_checked`: no readback has completed. `ok`: checkedAgeMs is valid. `clock_error`: a readback exists but
   * the monotonic clock reads earlier than it did then, so no age can be given; treat the status as unverifiable,
   * not as fresh.
   */
  ageStatus: 'never_checked' | 'ok' | 'clock_error';
};

/**
 * JSON-safe form for the API: the monotonic timestamp is a BigInt, which JSON.stringify cannot encode. `checkedAgeMs`
 * says how old the readback is, so a `verified` from hours ago is not mistaken for a live fact.
 */
export function isolationStatusToJson(s: IsolationStatus, nowMonoNs: bigint): IsolationStatusJson {
  const ageNs = s.checkedAtMonoNs !== null ? nowMonoNs - s.checkedAtMonoNs : null;
  const ageStatus = ageNs === null ? 'never_checked' : ageNs >= 0n ? 'ok' : 'clock_error';
  return {
    ...s,
    checkedAtMonoNs: s.checkedAtMonoNs !== null ? s.checkedAtMonoNs.toString() : null,
    checkedAgeMs: ageNs !== null && ageNs >= 0n ? Number(ageNs / 1_000_000n) : null,
    ageStatus,
  };
}
