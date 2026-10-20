/**
 * scripts/rejudge-cross-intent.ts
 * Takes the verifier-admissible rule sets a model produced for one intent and judges each one again under EVERY intent, with the same triage
 * the evaluation used. It makes no model call and touches no switch. "Admissible under intent X" is a statement about X's text; this shows how
 * much of it carries to the other intents, next to the same matrix for the hand-written reference policies.
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/rejudge-cross-intent.ts <out json> <run dir> [<run dir> ...]
 * Each run dir holds trials.jsonl and summary.json (the intent is read from the summary). Only the LAST turn of an admissible trial is judged.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseProposal, triageProposal } from '../dist/sdn/proposal-triage.js';
import { BASELINE_TARGETS } from '../dist/sdn/eval-baselines.js';

interface Cell { total: number; admissible: number; byCategory: Record<string, number> }

async function main(): Promise<void> {
  const [outFile, ...dirs] = process.argv.slice(2);
  if (outFile === undefined || dirs.length === 0) throw new Error('usage: rejudge-cross-intent.ts <out json> <run dir> [<run dir> ...]');
  const intents = BASELINE_TARGETS.map((t) => t.intent);
  const matrix: Record<string, { sets: number; under: Record<string, Cell> }> = {};
  const reference: Record<string, Record<string, string>> = {};
  for (const t of BASELINE_TARGETS) {
    reference[t.intent.id] = {};
    for (const j of intents) reference[t.intent.id]![j.id] = triageProposal(t.reference(), j).category;
  }
  for (const dir of dirs) {
    const summary = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf-8')) as { intent: string };
    const lines = (await fs.readFile(path.join(dir, 'trials.jsonl'), 'utf-8')).split('\n').filter((l) => l.trim() !== '');
    const row = (matrix[summary.intent] ??= { sets: 0, under: Object.fromEntries(intents.map((j) => [j.id, { total: 0, admissible: 0, byCategory: {} as Record<string, number> }])) });
    for (const line of lines) {
      const t = JSON.parse(line) as { category: string; turns?: Array<{ response?: string }> };
      if (t.category !== 'ADMISSIBLE') continue;
      const response = t.turns?.[t.turns.length - 1]?.response;
      if (response === undefined) continue;
      const p = parseProposal(response);
      if (!p.ok) continue;
      row.sets++;
      for (const j of intents) {
        const v = triageProposal(p.rules, j).category;
        const c = row.under[j.id]!;
        c.total++;
        if (v === 'ADMISSIBLE') c.admissible++;
        else c.byCategory[v] = (c.byCategory[v] ?? 0) + 1;
      }
    }
  }
  await fs.writeFile(outFile, JSON.stringify({ schema: 'cross-intent-rejudge/v1', note: 'admissible sets from the run dirs, judged under every intent with the same triage; no model call', matrix, referenceVerdicts: reference }, null, 1) + '\n');
  for (const [from, row] of Object.entries(matrix)) {
    process.stdout.write(`${from} (${row.sets} admissible sets): ` + Object.entries(row.under).map(([to, c]) => `${to.split('/')[0]} ${c.admissible}`).join(', ') + '\n');
  }
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
