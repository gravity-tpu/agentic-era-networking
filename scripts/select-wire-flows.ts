/**
 * scripts/select-wire-flows.ts
 * Phase 0 of the Track A close-out (docs/research/track-a-closeout-plan.md): for each of the eight intents, how many flows does the testbed
 * need to tell the reference from (a) its surviving mutants and (b) the distinct verifier-admissible rule sets the evaluation recorded, and how
 * much does that depend on whether aliases and forged frames are allowed. Prediction only: nothing here touches the switch.
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/select-wire-flows.ts <results dir with agent-evaluation cells> [--max-flows 24] [--json <out file>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_TARGETS } from '../dist/sdn/eval-baselines.js';
import { HARD_INTENTS } from '../dist/sdn/intents-hard.js';
import { buildQuarantineSetPolicy, buildDnsQuarantinePolicy, buildUplinkArpConfinementPolicy, buildPerHostAllowlistPolicy } from '../dist/sdn/intent-references-hard.js';
import { generateMutants } from '../dist/sdn/rule-mutations.js';
import { parseProposal, triageProposal } from '../dist/sdn/proposal-triage.js';
import { ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../dist/sdn/port1-isolation.js';
import type { IsolationRule } from '../dist/sdn/port1-isolation.js';
import type { IntentSpec } from '../dist/sdn/intent-spec.js';
import { FlowMode, addressUniverse, candidateFlows, selectFlows } from '../dist/sdn/wire-flows.js';
import type { WireRuleSet } from '../dist/sdn/wire-flows.js';

const DEFAULT_MAX_FLOWS = 24;
const MAX_FLOWS_CEILING = 200; // Invariant 5: bounded
const MODES: ReadonlyArray<readonly [string, FlowMode]> = [['real hosts only', FlowMode.Real], ['+ aliases', FlowMode.Alias], ['+ forged frames', FlowMode.Forged], ['+ injection on port 3', FlowMode.PortThree]];

const HARD_REFERENCES: Record<string, () => readonly IsolationRule[]> = {
  'quarantine-set/v1': () => buildQuarantineSetPolicy(),
  'dns-quarantine/v1': () => buildDnsQuarantinePolicy(),
  'uplink-arp-confinement/v1': () => buildUplinkArpConfinementPolicy(),
  'per-host-allowlist/v1': () => buildPerHostAllowlistPolicy(),
};
const TARGETS: ReadonlyArray<{ intent: IntentSpec; reference: () => readonly IsolationRule[] }> = [
  ...BASELINE_TARGETS,
  ...HARD_INTENTS.map((intent) => ({ intent, reference: HARD_REFERENCES[intent.id] ?? (() => { throw new Error(`no reference for ${intent.id}`); }) })),
];

const toSet = (id: string, rules: readonly IsolationRule[]): WireRuleSet => ({
  id,
  rules: rules.map((r) => ({ id: r.id, priority: r.flowMod.priority, outputPorts: [...(r.flowMod.outputPorts ?? [])], match: Object.fromEntries(Object.entries(r.flowMod.match ?? {}).filter(([, v]) => v !== undefined)) })),
});
const canonical = (s: WireRuleSet): string => JSON.stringify(s.rules.map((r) => [r.priority, [...r.outputPorts].sort(), Object.entries(r.match).sort()]).sort());

/** Distinct admissible rule sets the evaluation recorded for this intent (the turn at which each trial became admissible). */
function recordedSets(root: string, intent: IntentSpec): WireRuleSet[] {
  const seen = new Map<string, WireRuleSet>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'trials.jsonl') continue;
      let summary: { intent?: string };
      try { summary = JSON.parse(fs.readFileSync(path.join(d, 'summary.json'), 'utf8')) as { intent?: string }; } catch { continue; }
      if (summary.intent !== intent.id) continue;
      for (const line of fs.readFileSync(p, 'utf8').trim().split('\n')) {
        let t: { admissibleAtTurn?: number | null; turns?: Array<{ response?: string }>; seed?: number };
        try { t = JSON.parse(line) as typeof t; } catch { continue; }
        const at = t.admissibleAtTurn; if (!at || !t.turns) continue;
        const response = t.turns[at - 1]?.response; if (response === undefined) continue;
        const pr = parseProposal(response); if (!pr.ok) continue;
        if (triageProposal(pr.rules, intent).category !== 'ADMISSIBLE') continue;
        const s = toSet(`${path.basename(d)}#${t.seed ?? '?'}`, pr.rules);
        const k = canonical(s);
        if (!seen.has(k)) seen.set(k, s);
      }
    }
  };
  walk(root);
  return [...seen.values()];
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = argv[0];
  if (root === undefined || root.startsWith('--')) throw new Error('usage: select-wire-flows.ts <results dir> [--max-flows N] [--json <out>]');
  const mf = argv.indexOf('--max-flows');
  const maxFlows = mf < 0 ? DEFAULT_MAX_FLOWS : Number(argv[mf + 1]);
  if (!Number.isInteger(maxFlows) || maxFlows < 1 || maxFlows > MAX_FLOWS_CEILING) throw new Error(`--max-flows must be an integer from 1 to ${MAX_FLOWS_CEILING}`);
  const jf = argv.indexOf('--json');
  const report: Record<string, unknown> = {};
  process.stdout.write(`| Intent | Survivors | Recorded sets | Flows allowed | Survivors told from the reference | Recorded sets told | Flows chosen |\n| :--- | ---: | ---: | :--- | ---: | ---: | ---: |\n`);
  for (const { intent, reference } of TARGETS) {
    const ref = reference();
    const refSet = toSet('reference', ref);
    const survivors = generateMutants(ref, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP])
      .filter((m) => triageProposal(m.rules, intent).category === 'ADMISSIBLE')
      .map((m) => toSet(m.id, m.rules));
    const recorded = recordedSets(root, intent);
    const addresses = addressUniverse([refSet, ...survivors, ...recorded]);
    const perMode: Record<string, unknown> = {};
    for (const [label, mode] of MODES) {
      const cands = candidateFlows(addresses, mode);
      const selS = selectFlows(cands, refSet, survivors, maxFlows);
      const selR = selectFlows(cands, refSet, recorded, maxFlows);
      const both = selectFlows(cands, refSet, [...survivors, ...recorded], maxFlows);
      process.stdout.write(`| ${intent.id} | ${survivors.length} | ${recorded.length} | ${label} | ${selS.separated.length} | ${selR.separated.length} | ${both.flows.length} |\n`);
      perMode[label] = { candidates: cands.length, survivorsSeparated: selS.separated.length, recordedSeparated: selR.separated.length, flows: both.flows.map((f) => ({ id: f.id, mode: f.mode })), unseparatedSurvivors: selS.unseparated };
    }
    report[intent.id] = { survivors: survivors.length, recorded: recorded.length, addresses: addresses.length, perMode };
  }
  if (jf >= 0 && argv[jf + 1] !== undefined) fs.writeFileSync(argv[jf + 1] as string, JSON.stringify(report, null, 1) + '\n');
}

try { main(); } catch (e) { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
