/**
 * wire-session.ts
 * The session runner of the on-wire conformance run (docs/research/evaluation-plan.md section 16). It drives a `Rig` (the bridge, the senders and
 * the captures) over a bundle of rule sets, computes M1 and M2 for every flow, and enforces the safety behaviour: nothing starts unless the
 * bridge is idle with no attention flag; the isolation policy is restored after every set in every path; the session stops, with the restore done,
 * when a flow errors, a restore does not verify, or the bridge is not idle again afterwards; a flow that could not be sent is never counted as
 * agreement; a rule set that matches MAC addresses is refused (the flow MACs are placeholders, so its prediction would be unreliable).
 *
 * No I/O here: the rig is an interface, so every path above is tested offline against a fake rig before the real one touches the switch.
 */

import type { IntentSpec } from './intent-spec.js';
import { predictOutcome } from './wire-flows.js';
import type { WireFlow, WireRule } from './wire-flows.js';
import { intentExpectation, m1Verdict, m2Verdict } from './wire-run.js';
import type { IntentExpectation, M1Verdict, M2Verdict } from './wire-run.js';

/** Unique UDP destination tags: the capture filter keys on the port, so a reused tag could cross-count flows (as scripts/conformance-run.ts). */
export const UDP_TAG_BASE = 41_000;
export const UDP_TAG_LAST = 60_999;
export const MAX_UDP_TAGS = UDP_TAG_LAST - UDP_TAG_BASE + 1;

export interface BridgeState { readonly phase: string; readonly attention: string | null }
export interface InstallResult { readonly ok: boolean; readonly httpStatus: number; readonly report: Record<string, unknown> }
export interface RestoreResult { readonly ok: boolean; readonly report: Record<string, unknown> }
export interface RigFlowResult { readonly sent: boolean; readonly reason?: string; readonly observedPorts: readonly number[]; readonly evidence: Record<string, string> }

export interface Rig {
  bridgeState(): Promise<BridgeState>;
  install(set: SessionSet): Promise<InstallResult>;
  restore(): Promise<RestoreResult>;
  runFlow(flow: WireFlow, tag: number): Promise<RigFlowResult>;
}

export interface SessionSet {
  readonly id: string;
  readonly kind: string;
  readonly intent: IntentSpec;
  readonly rules: readonly WireRule[];
  /** The request body for POST /api/experiment/install. */
  readonly body: unknown;
}

export type FlowResult =
  | { readonly flowId: string; readonly tag: number; readonly sent: false; readonly reason: string }
  | { readonly flowId: string; readonly tag: number; readonly sent: true; readonly predicted: number[]; readonly observed: number[]; readonly m1: M1Verdict; readonly expectation: IntentExpectation; readonly m2: M2Verdict; readonly evidence: Record<string, string> };

export interface SetResult {
  readonly id: string;
  readonly kind: string;
  readonly intent: string;
  readonly installed: boolean;
  readonly restored: boolean;
  readonly skipped?: string;
  readonly installReport?: Record<string, unknown>;
  readonly restoreReport?: Record<string, unknown>;
  readonly flows: FlowResult[];
}

export interface SessionOptions { readonly shouldStop?: () => boolean }
export interface SessionResult { readonly results: SetResult[]; readonly stoppedBecause: string | null }

const MAC_FIELDS = ['srcMac', 'dstMac'] as const;
const matchesMac = (rules: readonly WireRule[]): boolean => rules.some((r) => MAC_FIELDS.some((f) => r.match[f] !== undefined));

function requireIdle(s: BridgeState, when: string): string | null {
  if (s.phase !== 'idle') return `the bridge is not idle ${when} (phase ${s.phase})`;
  if (s.attention !== null) return `the bridge reports attention ${when}: ${s.attention}`;
  return null;
}

export async function runSession(rig: Rig, sets: readonly SessionSet[], flowsByIntent: Readonly<Record<string, readonly WireFlow[]>>, opts: SessionOptions): Promise<SessionResult> {
  const planned = sets.reduce((n, s) => n + (flowsByIntent[s.intent.id]?.length ?? 0), 0);
  if (planned > MAX_UDP_TAGS) throw new RangeError(`${planned} flows exceed the ${MAX_UDP_TAGS} unique UDP tags; split the run`);
  const start = requireIdle(await rig.bridgeState(), 'before the session');
  if (start !== null) throw new Error(start);

  const results: SetResult[] = [];
  let stoppedBecause: string | null = null;
  let tagCounter = 0;

  for (const s of sets) {
    if (opts.shouldStop?.() === true) { stoppedBecause = 'stop requested'; break; }
    if (matchesMac(s.rules)) {
      results.push({ id: s.id, kind: s.kind, intent: s.intent.id, installed: false, restored: false, skipped: 'rule set matches MAC addresses; the flow MACs are placeholders, so its prediction is unreliable', flows: [] });
      continue;
    }
    const flows: FlowResult[] = [];
    let flowError: string | null = null;
    const install = await rig.install(s);
    try {
      if (install.ok) {
        for (const flow of flowsByIntent[s.intent.id] ?? []) {
          const tag = UDP_TAG_BASE + tagCounter++;
          const r = await rig.runFlow(flow, tag);
          if (!r.sent) { flows.push({ flowId: flow.id, tag, sent: false, reason: r.reason ?? 'not sent' }); continue; }
          const predicted = predictOutcome(s.rules, flow);
          const observed = [...new Set(r.observedPorts)].sort((a, b) => a - b);
          const expectation = intentExpectation(s.intent, flow.packet);
          flows.push({ flowId: flow.id, tag, sent: true, predicted, observed, m1: m1Verdict(predicted, observed), expectation, m2: m2Verdict(expectation, observed, flow.observable), evidence: r.evidence });
        }
      }
    } catch (e) {
      flowError = e instanceof Error ? e.message : String(e);
    }
    // The restore runs on every path, including after a failed install (it may have been half-applied) and after a flow error.
    const restore = await rig.restore();
    results.push({ id: s.id, kind: s.kind, intent: s.intent.id, installed: install.ok, restored: restore.ok, ...(install.ok ? {} : { skipped: `install did not verify (HTTP ${install.httpStatus})` }), installReport: install.report, restoreReport: restore.report, flows });
    if (flowError !== null) { stoppedBecause = `flow error in ${s.id}: ${flowError}`; break; }
    if (!restore.ok) { stoppedBecause = `restore did not verify after ${s.id}`; break; }
    const after = requireIdle(await rig.bridgeState(), `after ${s.id}`);
    if (after !== null) { stoppedBecause = after; break; }
  }
  return { results, stoppedBecause };
}
