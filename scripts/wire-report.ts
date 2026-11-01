/**
 * scripts/wire-report.ts
 * Turns the session directories of an on-wire conformance run (scripts/conformance-run-v2.ts) into the results tables of plan section 16.6. Every number
 * is read from the sessions' results.json; nothing is typed in. Reads files only.
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/wire-report.ts --runs <campaign dir> --bundle <bundle dir> [--repeats <repeats dir>] [--out <file.md>]
 * A campaign dir holds one subdirectory per session (smoke-references, coverage-references, intent-*), each with results.json; a repeats dir holds repeat-1..n.
 */

import fs from 'node:fs';
import path from 'node:path';
import { aggregate, repeatConsistency, wilson95 } from '../dist/sdn/wire-report.js';
import type { Counts, ReportSet } from '../dist/sdn/wire-report.js';

interface ResultsFile { summary: Record<string, unknown>; results: ReportSet[] }
const readSessions = (dir: string, match: RegExp): Array<{ name: string; file: ResultsFile }> =>
  fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && match.test(e.name)).map((e) => e.name).sort()
    .flatMap((name) => {
      const f = path.join(dir, name, 'results.json');
      return fs.existsSync(f) ? [{ name, file: JSON.parse(fs.readFileSync(f, 'utf8')) as ResultsFile }] : [];
    });

const pct = (k: number, n: number): string => { if (n === 0) return 'n/a'; const w = wilson95(k, n); return `${(w.lo * 100).toFixed(1)}% to ${(w.hi * 100).toFixed(1)}%`; };
const row = (name: string, c: Counts): string => `| ${name} | ${c.sets} | ${c.flowsSent} | ${c.m1Agree} of ${c.flowsSent}: ${pct(c.m1Agree, c.flowsSent)} | ${c.m1Disagree} | ${c.m2Compliant} of ${c.flowsSent} | ${c.m2NonCompliant} | ${c.flowsNotSent} |`;
const HEAD = '| | Rule sets | Flows sent | Agree with the model (M1, 95% Wilson) | Disagree | Intent met (M2) | Intent not met | Not sent |\n| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: |';
const ports = (p: number[]): string => (p.length === 0 ? 'none' : p.join(','));

function main(): void {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const runs = get('--runs');
  const bundle = get('--bundle');
  if (runs === undefined || bundle === undefined) throw new Error('usage: wire-report.ts --runs <campaign dir> --bundle <bundle dir> [--repeats <dir>] [--out <file>]');
  const index = JSON.parse(fs.readFileSync(path.join(bundle, 'index.json'), 'utf8')) as Array<{ intent: string; id: string; arm?: string }>;
  const armOf = (intent: string, id: string): string => index.find((e) => e.intent === intent && e.id === id)?.arm ?? 'unknown';

  const sessions = readSessions(runs, /^(smoke|coverage|intent)-/);
  if (sessions.length === 0) throw new Error(`no sessions with results.json under ${runs}`);
  const report = aggregate(sessions.map((s) => ({ name: s.name, sets: s.file.results })), armOf);
  const lines: string[] = [];
  lines.push('## Sessions\n', HEAD, ...report.sessions.map((s) => row(s.name, s)), row('**All**', report.total), '');
  lines.push('## By kind of rule set\n', HEAD, ...Object.entries(report.byKind).sort().map(([k, c]) => row(k, c)), '');
  lines.push('## By the model that produced the set\n', HEAD, ...Object.entries(report.byArm).sort().map(([k, c]) => row(k, c)), '');
  lines.push(`## Disagreements with the model (${report.disagreements.length})\n`);
  lines.push(report.disagreements.length === 0 ? 'None.\n' : '| Session | Intent | Kind | Set | Flow | Predicted | Observed |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n' + report.disagreements.map((d) => `| ${d.session} | ${d.intent} | ${d.kind} | \`${d.set}\` | \`${d.flow}\` | ${ports(d.predicted)} | ${ports(d.observed)} |`).join('\n') + '\n');
  lines.push(`## Intent not met on the wire (${report.nonCompliant.length})\n`);
  lines.push(report.nonCompliant.length === 0 ? 'None.\n' : '| Session | Intent | Set | Flow | Clause | Leaks | Missing |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n' + report.nonCompliant.map((d) => `| ${d.session} | ${d.intent} | \`${d.set}\` | \`${d.flow}\` | ${d.clause} | ${ports(d.leaks)} | ${ports(d.missing)} |`).join('\n') + '\n');
  lines.push(`## Flows not sent (${report.unsent.length}) and sets skipped (${report.skipped.length})\n`);
  lines.push(report.unsent.length + report.skipped.length === 0 ? 'None.\n' : [...report.unsent.map((u) => `- ${u.session}: \`${u.set}\` / \`${u.flow}\`: ${u.reason}`), ...report.skipped.map((u) => `- ${u.session}: \`${u.set}\` skipped: ${u.reason}`)].join('\n') + '\n');

  const rep = get('--repeats');
  if (rep !== undefined) {
    const rs = readSessions(rep, /^repeat-/);
    if (rs.length >= 2) {
      const c = repeatConsistency(rs.map((s) => s.file.results));
      lines.push(`## Repeats (${rs.length} sessions of the same ${c.sets} sets)\n`, `${c.stable} of ${c.sets} sets were observed identically in every session.\n`);
      if (c.unstable.length > 0) lines.push(c.unstable.map((u) => `- \`${u.set}\` (${u.intent}): differs on ${u.flows.map((f) => `\`${f}\``).join(', ')}`).join('\n') + '\n');
    } else lines.push('## Repeats\n', `Only ${rs.length} repeat session(s) found; nothing to compare.\n`);
  }
  const text = lines.join('\n');
  const out = get('--out');
  if (out !== undefined) fs.writeFileSync(out, text); else process.stdout.write(text);
}

try { main(); } catch (e) { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
