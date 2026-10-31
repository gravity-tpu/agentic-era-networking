/**
 * scripts/select-wire-bundle.ts
 * Phase 0 of the Track A close-out (docs/research/track-a-closeout-plan.md): choose, by a fixed rule and a fixed seed, which rule sets go on the
 * wire, and write them as experiment-install request bodies in the format scripts/conformance-run.ts reads. Nothing here touches the switch.
 *
 * Per intent: the reference; every surviving mutant (an accepted one) that some chosen flow can tell from the reference; up to MAX_MODEL_SETS recorded
 * model-proposed sets that a chosen flow can tell from the reference, drawn round-robin over the models that produced them with a seeded
 * generator; and EQUIVALENCE_CONTROLS survivors and recorded sets that no flow can tell from the reference (the wire cannot discriminate them;
 * they check only that the switch agrees with the model's equivalence). Flows: forged frames allowed, no injection into port 3 (owner, 2026-10-31).
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/select-wire-bundle.ts <results dir> <out dir> [--seed N]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateMutants } from '../dist/sdn/rule-mutations.js';
import { triageProposal } from '../dist/sdn/proposal-triage.js';
import { ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../dist/sdn/port1-isolation.js';
import { FlowMode, addressUniverse, candidateFlows, selectFlows } from '../dist/sdn/wire-flows.js';
import { coverageFlowsFor } from '../dist/sdn/wire-run.js';
import type { WireRule, WireRuleSet } from '../dist/sdn/wire-flows.js';
import { TARGETS, toSet, recordedSets } from './wire-common.ts';

export const DEFAULT_BUNDLE_SEED = 20_261_031; // the date the selection rule was fixed
const MAX_FLOWS = 24;
const MAX_MODEL_SETS = 8;
const EQUIVALENCE_CONTROLS = 2;
const TTL_SECONDS = 60; // as scripts/export-conformance-rulesets.ts
const BRIDGE_MAX_PRIORITY = 65534; // 65535 is reserved for quarantine
const BRIDGE_PORTS = [1, 2, 3];

/** xorshift32: integer state, no floating point; the same seed gives the same draws on every machine. */
function rng(seed: number): () => number {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/** Draws up to `n` items round-robin over the groups (sorted by name), each group's items shuffled by the seeded generator. */
function drawRoundRobin<T extends { arm: string }>(items: readonly T[], n: number, next: () => number): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) { const g = groups.get(it.arm) ?? []; g.push(it); groups.set(it.arm, g); }
  const names = [...groups.keys()].sort();
  for (const name of names) {
    const g = groups.get(name) as T[];
    for (let i = g.length - 1; i > 0; i--) { const j = next() % (i + 1); [g[i], g[j]] = [g[j] as T, g[i] as T]; }
  }
  const out: T[] = [];
  for (let round = 0; out.length < n; round++) {
    let any = false;
    for (const name of names) {
      const g = groups.get(name) as T[];
      if (round < g.length && out.length < n) { out.push(g[round] as T); any = true; }
    }
    if (!any) break;
  }
  return out;
}

const clamp = (rules: readonly WireRule[]): { rules: WireRule[]; clamped: boolean } => {
  let clamped = false;
  const out = rules.map((r) => { if (r.priority > BRIDGE_MAX_PRIORITY) { clamped = true; return { ...r, priority: BRIDGE_MAX_PRIORITY }; } return r; });
  return { rules: out, clamped };
};
const installable = (rules: readonly WireRule[]): boolean => rules.every((r) => r.priority >= 1 && r.priority <= 65535 && r.outputPorts.every((q) => BRIDGE_PORTS.includes(q)));
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 100);

function main(): void {
  const argv = process.argv.slice(2);
  const [root, out] = argv;
  if (root === undefined || out === undefined || root.startsWith('--') || out.startsWith('--')) throw new Error('usage: select-wire-bundle.ts <results dir> <out dir> [--seed N]');
  const si = argv.indexOf('--seed');
  const seed = si < 0 ? DEFAULT_BUNDLE_SEED : Number(argv[si + 1]);
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) throw new Error('--seed must be an integer from 1 to 4294967295');
  const next = rng(seed);
  const index: Array<Record<string, unknown>> = [];
  const flowsOut: Record<string, unknown> = {};
  const coverageOut: Record<string, unknown> = {};
  const counts: Record<string, Record<string, number>> = {};

  for (const { intent, reference } of TARGETS) {
    const ref = reference();
    const refSet = toSet('reference', ref);
    const survivors = generateMutants(ref, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP])
      .filter((m) => triageProposal(m.rules, intent).category === 'ADMISSIBLE')
      .map((m) => ({ ...toSet(m.id, m.rules), arm: 'mutation' }));
    const recorded = recordedSets(root, intent).map((r) => ({ ...r.set, arm: r.arm }));
    const pool: WireRuleSet[] = [...survivors, ...recorded];
    const cands = candidateFlows(addressUniverse([refSet, ...pool]), FlowMode.Forged);
    const sel = selectFlows(cands, refSet, pool, MAX_FLOWS);
    const sep = new Set(sel.separated);
    flowsOut[intent.id] = sel.flows.map((f) => ({ id: f.id, mode: f.mode, packet: f.packet, observable: f.observable }));
    // Clause coverage: one sendable flow per intent clause and for default-deny, run on the reference only, so the wire tests the intent itself in both entry directions.
    const specAsRules: WireRuleSet = { id: 'intent', rules: intent.clauses.map((c) => ({ id: c.id, priority: 0, outputPorts: [...c.mustReach], match: c.match })) };
    const cov = coverageFlowsFor(intent, candidateFlows(addressUniverse([refSet, specAsRules, ...pool]), FlowMode.Forged));
    coverageOut[intent.id] = { flows: cov.flows.map((f) => ({ id: f.id, mode: f.mode, packet: f.packet, observable: f.observable })), uncovered: cov.uncovered };

    const chosen: Array<{ kind: string; set: WireRuleSet; arm: string }> = [{ kind: 'reference', set: refSet, arm: 'reference' }];
    const instOk = <T extends WireRuleSet>(s: T): boolean => installable(s.rules);
    for (const s of survivors.filter((x) => sep.has(x.id) && instOk(x))) chosen.push({ kind: 'surviving-mutant', set: s, arm: s.arm });
    for (const s of drawRoundRobin(recorded.filter((x) => sep.has(x.id) && instOk(x)), MAX_MODEL_SETS, next)) chosen.push({ kind: 'model-admissible', set: s, arm: s.arm });
    for (const s of drawRoundRobin(survivors.filter((x) => !sep.has(x.id) && instOk(x)), EQUIVALENCE_CONTROLS, next)) chosen.push({ kind: 'equivalence-control-mutant', set: s, arm: s.arm });
    for (const s of drawRoundRobin(recorded.filter((x) => !sep.has(x.id) && instOk(x)), EQUIVALENCE_CONTROLS, next)) chosen.push({ kind: 'equivalence-control-model', set: s, arm: s.arm });

    const dir = path.join(out, safe(intent.id));
    fs.mkdirSync(dir, { recursive: true });
    const c: Record<string, number> = {};
    for (const { kind, set, arm } of chosen) {
      c[kind] = (c[kind] ?? 0) + 1;
      const { rules, clamped } = clamp(set.rules);
      const id = kind === 'reference' ? 'reference' : `${kind}-${safe(set.id)}`;
      const file = `${safe(intent.id)}/${id}.json`;
      fs.writeFileSync(path.join(out, file), JSON.stringify({ label: `${kind} ${intent.id} ${set.id}`, ttlSeconds: TTL_SECONDS, rules, meta: { intent: intent.id, kind, id: set.id, arm, seed } }, null, 1) + '\n');
      index.push({ intent: intent.id, kind, id, file, arm, rules: rules.length, installable: true, priorityClamped: clamped });
    }
    counts[intent.id] = { flows: sel.flows.length, poolSurvivors: survivors.length, poolRecorded: recorded.length, ...c };
  }

  const indexText = JSON.stringify(index, null, 1) + '\n';
  fs.writeFileSync(path.join(out, 'index.json'), indexText);
  fs.writeFileSync(path.join(out, 'flows.json'), JSON.stringify(flowsOut, null, 1) + '\n');
  fs.writeFileSync(path.join(out, 'coverage-flows.json'), JSON.stringify(coverageOut, null, 1) + '\n');
  const manifest = { seed, maxFlows: MAX_FLOWS, maxModelSets: MAX_MODEL_SETS, equivalenceControls: EQUIVALENCE_CONTROLS, mode: 'forged frames allowed, no injection into port 3', ruleSets: index.length, indexSha256: crypto.createHash('sha256').update(indexText).digest('hex'), counts };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  process.stdout.write(`${JSON.stringify(manifest, null, 1)}\n`);
}

try { main(); } catch (e) { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
