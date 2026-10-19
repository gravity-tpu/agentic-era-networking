/**
 * scripts/rescore-lenient.ts
 * Re-scores saved agent-evaluation trials with the lenient parse (src/sdn/proposal-triage.ts: CIDR strings split, numeric strings
 * read as integers), to separate "the model cannot do the task" from "the model cannot follow the output format". It makes no model
 * call and does not touch the original trials; it reads each run's last-turn response and writes one summary file.
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/rescore-lenient.ts <results dir> <out file> <run dir>=<intent id> [<run dir>=<intent id> ...]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseProposal, triageProposal, LENIENT_TRANSFORMS } from '../dist/sdn/proposal-triage.js';
import { PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT } from '../dist/sdn/intents.js';

const INTENTS = new Map([PORT1_ISOLATION_INTENT, DNS_CONFINEMENT_INTENT, QUARANTINE_PRECEDENCE_INTENT, TAP_RETURN_ISOLATION_INTENT].map((i) => [i.id, i] as const));

interface Trial { seed: number; category: string; turns?: Array<{ response?: string }>; response?: string | null }

function lastResponse(t: Trial): string | null {
  if (t.turns !== undefined) return t.turns.length === 0 ? null : (t.turns[t.turns.length - 1]?.response ?? null);
  return t.response ?? null;
}

async function main(): Promise<void> {
  const [resultsDir, outFile, ...pairs] = process.argv.slice(2);
  if (resultsDir === undefined || outFile === undefined || pairs.length === 0) throw new Error('usage: rescore-lenient.ts <results dir> <out file> <run dir>=<intent id> ...');
  const runs: Array<Record<string, unknown>> = [];
  for (const pair of pairs) {
    const [dir, intentId] = pair.split('=');
    const spec = intentId === undefined ? undefined : INTENTS.get(intentId);
    if (dir === undefined || spec === undefined) throw new Error(`bad pair ${pair}; known intents: ${[...INTENTS.keys()].join(', ')}`);
    const trials = (await fs.readFile(path.join(resultsDir, dir, 'trials.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l) as Trial);
    const strict: Record<string, number> = {};
    const lenient: Record<string, number> = {};
    let changed = 0;
    for (const t of trials) {
      strict[t.category] = (strict[t.category] ?? 0) + 1;
      const text = lastResponse(t);
      let category = t.category;
      if (t.category !== 'TRANSPORT_FAILURE' && text !== null) {
        const p = parseProposal(text, { lenient: true });
        category = p.ok ? triageProposal(p.rules, spec).category : p.category;
      }
      lenient[category] = (lenient[category] ?? 0) + 1;
      if (category !== t.category) changed++;
    }
    runs.push({ dir, intent: intentId, trials: trials.length, strict, lenient, trialsWhoseCategoryChanged: changed });
    process.stdout.write(`${dir}: strict ${JSON.stringify(strict)} -> lenient ${JSON.stringify(lenient)}\n`);
  }
  const summary = {
    schema: 'rescore-lenient/v1',
    transforms: LENIENT_TRANSFORMS,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    note: 'post-hoc re-parse of saved responses; the strict parse remains the pre-registered scoring, this only shows how much of a failure was format',
    runs,
  };
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(summary, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
