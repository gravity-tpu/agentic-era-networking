/**
 * scripts/wire-common.ts
 * Shared by select-wire-flows.ts and select-wire-bundle.ts (Track A close-out, Phase 0): the eight intents with their reference policies, the
 * conversion to wire rule sets, and the distinct verifier-admissible sets the evaluation recorded. Reads files; never touches the switch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_TARGETS } from '../dist/sdn/eval-baselines.js';
import { HARD_INTENTS } from '../dist/sdn/intents-hard.js';
import { buildQuarantineSetPolicy, buildDnsQuarantinePolicy, buildUplinkArpConfinementPolicy, buildPerHostAllowlistPolicy } from '../dist/sdn/intent-references-hard.js';
import { parseProposal, triageProposal } from '../dist/sdn/proposal-triage.js';
import type { IsolationRule } from '../dist/sdn/port1-isolation.js';
import type { IntentSpec } from '../dist/sdn/intent-spec.js';
import type { WireRuleSet } from '../dist/sdn/wire-flows.js';

const HARD_REFERENCES: Record<string, () => readonly IsolationRule[]> = {
  'quarantine-set/v1': () => buildQuarantineSetPolicy(),
  'dns-quarantine/v1': () => buildDnsQuarantinePolicy(),
  'uplink-arp-confinement/v1': () => buildUplinkArpConfinementPolicy(),
  'per-host-allowlist/v1': () => buildPerHostAllowlistPolicy(),
};

export const TARGETS: ReadonlyArray<{ intent: IntentSpec; reference: () => readonly IsolationRule[] }> = [
  ...BASELINE_TARGETS,
  ...HARD_INTENTS.map((intent) => ({ intent, reference: HARD_REFERENCES[intent.id] ?? (() => { throw new Error(`no reference for ${intent.id}`); }) })),
];

export const toSet = (id: string, rules: readonly IsolationRule[]): WireRuleSet => ({
  id,
  rules: rules.map((r) => ({ id: r.id, priority: r.flowMod.priority, outputPorts: [...(r.flowMod.outputPorts ?? [])], match: { ...(r.flowMod.match ?? {}) } })),
});

/** Behaviour-only key: priority, outputs and match, ignoring rule ids and order. */
export const canonical = (s: WireRuleSet): string => JSON.stringify(s.rules.map((r) => [r.priority, [...r.outputPorts].sort(), Object.entries(r.match).sort()]).sort());

export interface RecordedSet { readonly set: WireRuleSet; /** the model that produced it, from the cell's summary.json */ readonly arm: string }

/** Distinct admissible rule sets the evaluation recorded for this intent (the turn at which each trial became admissible), in a stable order. */
export function recordedSets(root: string, intent: IntentSpec): RecordedSet[] {
  const seen = new Map<string, RecordedSet>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'trials.jsonl') continue;
      let summary: { intent?: string; model?: string };
      try { summary = JSON.parse(fs.readFileSync(path.join(d, 'summary.json'), 'utf8')) as { intent?: string; model?: string }; } catch (err) { process.stderr.write(`skipped ${d}: no readable summary.json (${err instanceof Error ? err.message : String(err)})\n`); continue; }
      if (summary.intent !== intent.id) continue;
      for (const line of fs.readFileSync(p, 'utf8').trim().split('\n')) {
        let t: { admissibleAtTurn?: number | null; turns?: Array<{ response?: string }>; seed?: number };
        try { t = JSON.parse(line) as typeof t; } catch (err) { process.stderr.write(`skipped a malformed line in ${p}: ${err instanceof Error ? err.message : String(err)}\n`); continue; }
        const at = t.admissibleAtTurn; if (!at || !t.turns) continue; // admissibleAtTurn is 1-based: turn 1 is turns[0]
        const response = t.turns[at - 1]?.response; if (response === undefined) continue;
        const pr = parseProposal(response); if (!pr.ok) continue;
        if (triageProposal(pr.rules, intent).category !== 'ADMISSIBLE') continue;
        const s = toSet(`${path.basename(d)}#${t.seed ?? '?'}`, pr.rules);
        const k = canonical(s);
        if (!seen.has(k)) seen.set(k, { set: s, arm: summary.model ?? path.basename(d) });
      }
    }
  };
  walk(root);
  return [...seen.values()];
}
