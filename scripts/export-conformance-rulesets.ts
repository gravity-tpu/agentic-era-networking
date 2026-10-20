/**
 * scripts/export-conformance-rulesets.ts
 * Writes the rule sets for the on-wire conformance run (RQ4) as experiment-install request bodies (the format of
 * POST /api/experiment/install: label, ttlSeconds, rules) plus a `meta` block the bridge ignores.
 *   1. each intent's hand-written reference policy (admissible by construction),
 *   2. every mutant of it that the verifier ACCEPTS (a survivor is an equivalent mutant or a gap in the checks; the wire can help tell),
 *   3. optionally, distinct verifier-admissible rule sets a model proposed (--from-trials <results dir> --intent <id> --max N).
 * Nothing here touches the switch. The verdicts come from the same triage the evaluation used (src/sdn/proposal-triage.ts).
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/export-conformance-rulesets.ts <out dir> [--from-trials <dir> --intent <intent id> --max <n>]...
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { BASELINE_TARGETS } from '../dist/sdn/eval-baselines.js';
import { generateMutants } from '../dist/sdn/rule-mutations.js';
import { parseProposal, triageProposal } from '../dist/sdn/proposal-triage.js';
import { ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP } from '../dist/sdn/port1-isolation.js';
import type { IsolationRule } from '../dist/sdn/port1-isolation.js';

const DEFAULT_TTL_SECONDS = 60; // a conformance run holds a rule set for about this long; the bridge restores at the limit
const BRIDGE_MAX_PRIORITY = 65534; // 65535 is reserved for quarantine; the bridge refuses a rule at it

interface WireRule { id: string; priority: number; outputPorts: number[]; match: Record<string, unknown> }

function toWire(rules: readonly IsolationRule[]): WireRule[] {
  return rules.map((r) => ({
    id: r.id,
    priority: r.flowMod.priority,
    outputPorts: [...(r.flowMod.outputPorts ?? [])],
    match: Object.fromEntries(Object.entries(r.flowMod.match ?? {}).filter(([, v]) => v !== undefined)),
  }));
}

/** The bridge reserves 65535 for quarantine DROP rules. A rule raised to 65535 still outranks every other rule at 65534 (no other rule is above 300), so clamping keeps its behaviour. */
function clamp(rules: WireRule[]): { rules: WireRule[]; clamped: boolean } {
  let clamped = false;
  const out = rules.map((r) => { if (r.priority > BRIDGE_MAX_PRIORITY) { clamped = true; return { ...r, priority: BRIDGE_MAX_PRIORITY }; } return r; });
  return { rules: out, clamped };
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);

async function write(dir: string, name: string, body: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(body, null, 1) + '\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const out = argv[0];
  if (out === undefined || out.startsWith('--')) throw new Error('usage: export-conformance-rulesets.ts <out dir> [--from-trials <dir> --intent <id> --max <n>]...');
  const index: Array<Record<string, unknown>> = [];

  for (const { intent, reference } of BASELINE_TARGETS) {
    const dir = path.join(out, safe(intent.id));
    const ref = reference();
    const refVerdict = triageProposal(ref, intent);
    await write(dir, 'reference', { label: `reference ${intent.id}`, ttlSeconds: DEFAULT_TTL_SECONDS, rules: toWire(ref), meta: { intent: intent.id, kind: 'reference', verdict: refVerdict.category } });
    index.push({ intent: intent.id, kind: 'reference', id: 'reference', file: `${safe(intent.id)}/reference.json`, rules: ref.length });
    const mutants = generateMutants(ref, [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP]);
    for (const m of mutants) {
      const v = triageProposal(m.rules, intent);
      if (v.category !== 'ADMISSIBLE') continue; // only survivors: the verifier accepted them
      const { rules: wire, clamped } = clamp(toWire(m.rules));
      const installable = wire.every((r) => r.priority >= 1 && r.priority <= BRIDGE_MAX_PRIORITY && r.outputPorts.every((q) => q >= 1 && q <= 3));
      await write(dir, `mutant-${safe(m.id)}`, { label: `survivor ${intent.id} ${m.id}`, ttlSeconds: DEFAULT_TTL_SECONDS, rules: wire, meta: { intent: intent.id, kind: 'surviving-mutant', id: m.id, operator: m.operator, verdict: v.category, installable, priorityClamped: clamped } });
      index.push({ intent: intent.id, kind: 'surviving-mutant', id: m.id, operator: m.operator, file: `${safe(intent.id)}/mutant-${safe(m.id)}.json`, rules: wire.length, installable, priorityClamped: clamped });
    }
  }

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--from-trials') continue;
    const dir = argv[i + 1];
    const intentId = argv[argv.indexOf('--intent', i) + 1];
    const maxRaw = argv[argv.indexOf('--max', i) + 1];
    const max = maxRaw === undefined ? 5 : Number(maxRaw);
    const target = BASELINE_TARGETS.find((t) => t.intent.id === intentId);
    if (dir === undefined || target === undefined || !Number.isInteger(max) || max < 1) throw new Error(`bad --from-trials arguments for ${String(intentId)}`);
    const seen = new Set<string>();
    const lines = (await fs.readFile(path.join(dir, 'trials.jsonl'), 'utf-8')).split('\n').filter((l) => l.trim() !== '');
    let taken = 0;
    for (const line of lines) {
      if (taken >= max) break;
      const t = JSON.parse(line) as { seed: number; turns?: Array<{ response?: string }> };
      const response = t.turns?.[t.turns.length - 1]?.response;
      if (response === undefined) continue;
      const p = parseProposal(response);
      if (!p.ok) continue;
      if (triageProposal(p.rules, target.intent).category !== 'ADMISSIBLE') continue;
      const { rules: wire, clamped } = clamp(toWire(p.rules));
      const key = JSON.stringify(wire.map((r) => [r.priority, r.outputPorts, r.match]).sort());
      if (seen.has(key)) continue; // distinct behaviour only
      seen.add(key);
      taken++;
      const name = `model-${safe(path.basename(dir))}-seed${t.seed}`;
      const installable = wire.every((r) => r.priority >= 1 && r.priority <= BRIDGE_MAX_PRIORITY && r.outputPorts.every((q) => q >= 1 && q <= 3));
      await write(path.join(out, safe(target.intent.id)), name, { label: `model-admissible ${target.intent.id} ${path.basename(dir)} seed ${t.seed}`, ttlSeconds: DEFAULT_TTL_SECONDS, rules: wire, meta: { intent: target.intent.id, kind: 'model-admissible', source: dir, seed: t.seed, verdict: 'ADMISSIBLE', installable, priorityClamped: clamped } });
      index.push({ intent: target.intent.id, kind: 'model-admissible', id: name, file: `${safe(target.intent.id)}/${name}.json`, rules: wire.length, installable, priorityClamped: clamped });
    }
  }

  await fs.writeFile(path.join(out, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  const byKind: Record<string, number> = {};
  for (const e of index) byKind[String(e['kind'])] = (byKind[String(e['kind'])] ?? 0) + 1;
  process.stdout.write(`wrote ${index.length} rule sets: ${JSON.stringify(byKind)}\n`);
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
