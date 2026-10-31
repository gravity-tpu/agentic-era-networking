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
import { generateMutants } from '../dist/sdn/rule-mutations.js';
import { triageProposal } from '../dist/sdn/proposal-triage.js';
import { ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../dist/sdn/port1-isolation.js';
import { FlowMode, addressUniverse, candidateFlows, selectFlows } from '../dist/sdn/wire-flows.js';
import { TARGETS, toSet, recordedSets } from './wire-common.ts';

const DEFAULT_MAX_FLOWS = 24;
const MAX_FLOWS_CEILING = 200; // Invariant 5: bounded
const MODES: ReadonlyArray<readonly [string, FlowMode]> = [['real hosts only', FlowMode.Real], ['+ aliases', FlowMode.Alias], ['+ forged frames', FlowMode.Forged], ['+ injection on port 3', FlowMode.PortThree]];

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
    const recorded = recordedSets(root, intent).map((r) => r.set);
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
