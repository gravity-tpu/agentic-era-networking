/**
 * scripts/rejudge-recorded-runs.ts
 * Judges the FIRST turn of every recorded trial again with the current verifier (src/sdn/proposal-triage.ts) and compares it with the
 * verdict recorded when the run was made. It makes no model call and touches no switch. Runs of different models were judged at different
 * commits, so this shows how many first-turn verdicts would change if they were all judged by today's code, which is what decides whether
 * their admissible counts can be put side by side.
 *
 * Not every intent is the same question it was when the runs were made. The A10 policy work (commit 992f3ca) rewrote INTENT-1's ARP clause to
 * per-host, and INTENT-3 and INTENT-4 are built from `...PORT1_ISOLATION_INTENT.clauses`, so they changed with it. Rows for those intents are
 * flagged `intentChangedSinceRuns`: a verdict that changes there says the specification moved, not that the verifier drifted. Only INTENT-2
 * (dns-confinement) is an unchanged question, so only its rows measure verifier drift.
 *
 * Usage (after `npx tsc`): node --experimental-strip-types scripts/rejudge-recorded-runs.ts <out json> <run dir> [<run dir> ...]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseProposal, triageProposal } from '../dist/sdn/proposal-triage.js';
import { PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT } from '../dist/sdn/intents.js';

const INTENTS = {
  [PORT1_ISOLATION_INTENT.id]: PORT1_ISOLATION_INTENT,
  [DNS_CONFINEMENT_INTENT.id]: DNS_CONFINEMENT_INTENT,
  [QUARANTINE_PRECEDENCE_INTENT.id]: QUARANTINE_PRECEDENCE_INTENT,
  [TAP_RETURN_ISOLATION_INTENT.id]: TAP_RETURN_ISOLATION_INTENT,
} as const;
/** Intents whose specification differs from the one the recorded runs were judged against (see the header). */
const CHANGED_SINCE_RUNS: ReadonlySet<string> = new Set([PORT1_ISOLATION_INTENT.id, QUARANTINE_PRECEDENCE_INTENT.id, TAP_RETURN_ISOLATION_INTENT.id]);

interface Row {
  run: string; intent: string; intentChangedSinceRuns: boolean; trials: number; recordedAdmissible: number; rejudgedAdmissible: number;
  changed: number; changes: Record<string, number>; unparsable: number;
}

async function main(): Promise<void> {
  const [outFile, ...dirs] = process.argv.slice(2);
  if (outFile === undefined || dirs.length === 0) throw new Error('usage: rejudge-recorded-runs.ts <out json> <run dir> [<run dir> ...]');
  const rows: Row[] = [];
  const skipped: string[] = [];
  for (const dir of dirs) {
    const summary = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf-8')) as { intent: string };
    const spec = (INTENTS as Record<string, (typeof INTENTS)[keyof typeof INTENTS]>)[summary.intent];
    if (spec === undefined) { skipped.push(`${path.basename(dir)} (${summary.intent})`); continue; }
    const lines = (await fs.readFile(path.join(dir, 'trials.jsonl'), 'utf-8')).split('\n').filter((l) => l.trim() !== '');
    const row: Row = { run: path.basename(dir), intent: summary.intent, intentChangedSinceRuns: CHANGED_SINCE_RUNS.has(summary.intent), trials: 0, recordedAdmissible: 0, rejudgedAdmissible: 0, changed: 0, changes: {}, unparsable: 0 };
    for (const line of lines) {
      const t = JSON.parse(line) as { category: string; firstCategory?: string; turns?: Array<{ response?: string; category?: string }> };
      const first = t.turns?.[0];
      // A trial with no recorded first turn (a transport failure) has nothing to judge again; it is counted and left out.
      if (first?.response === undefined) { row.unparsable++; continue; }
      const recorded = first.category ?? t.firstCategory ?? t.category;
      const p = parseProposal(first.response);
      const now = p.ok ? triageProposal(p.rules, spec).category : p.category;
      row.trials++;
      if (recorded === 'ADMISSIBLE') row.recordedAdmissible++;
      if (now === 'ADMISSIBLE') row.rejudgedAdmissible++;
      if (now !== recorded) { row.changed++; const k = `${recorded} -> ${now}`; row.changes[k] = (row.changes[k] ?? 0) + 1; }
    }
    rows.push(row);
  }
  await fs.writeFile(outFile, JSON.stringify({ schema: 'rejudge-recorded-runs/v1', note: 'first turn of each recorded trial judged again by the current triage; no model call', rows, skipped }, null, 2) + '\n');
  for (const r of rows) {
    process.stdout.write(`${r.run}: ${r.trials} first turns, admissible ${r.recordedAdmissible} recorded -> ${r.rejudgedAdmissible} now, ${r.changed} verdicts changed${r.unparsable ? `, ${r.unparsable} without a first turn` : ''}${r.intentChangedSinceRuns ? ' [intent specification changed since the run]' : ''}\n`);
  }
  if (skipped.length > 0) process.stdout.write(`skipped (unknown intent): ${skipped.join(', ')}\n`);
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
