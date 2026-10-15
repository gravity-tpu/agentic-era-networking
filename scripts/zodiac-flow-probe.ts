/**
 * zodiac-flow-probe.ts
 * Client for the bridge's read-only flow-table probe (GET /api/zodiac/flows/probe): asks the live Zodiac FX what is
 * in its flow table, keeps the raw bytes as evidence, and reports whether firmware 0.86 includes the instruction
 * block (the output actions) in flow-stats entries. That is the unmeasured fact action-level readback depends on.
 *
 *   npm run build
 *   ssh -L 3003:127.0.0.1:3003 jetson          # in another terminal; see deploy/jetson/README.md
 *   npm run probe:flows -- --firmware 0.86
 *   npm run probe:flows -- --analyze path/to/flow-probe-....json
 *
 * Read-only: this script issues one HTTP GET. The bridge sends one OFPMP_FLOW request to the switch and no FlowMod.
 *
 * Evidence (Invariant 6): the report and a `.meta.json` sidecar are written to --out (default
 * docs/benchmarks/results/flow-probe). Before anything is saved, the report is rebuilt from its own raw bytes with
 * the same code and compared with the summary the bridge sent; a disagreement is an error, not evidence.
 *
 * Exit codes: 0 report saved; 1 usage or request failure; 2 the bridge refused or the switch could not answer;
 * 3 the bridge's summary disagrees with its own raw bytes.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildPort1IsolationPolicy } from '../dist/sdn/port1-isolation.js';
import { analyzeFlowProbe, FLOW_PROBE_ORIGIN, FLOW_PROBE_SCHEMA } from '../dist/sdn/flow-probe.js';
import type { FlowProbeReport } from '../dist/sdn/flow-probe.js';

const execFileP = promisify(execFile);

/** Request deadline. The bridge's own readback deadline defaults to 10 s; this leaves room for the round trip. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUT_DIR = 'docs/benchmarks/results/flow-probe';
/** The bridge's default port (deploy/jetson/zodiac-bridge.service); normally reached through an SSH tunnel. */
const DEFAULT_URL = 'http://127.0.0.1:3003';

interface Cli {
  readonly url: string;
  readonly out: string;
  readonly timeoutMs: number;
  readonly analyze: string | null;
  readonly firmware: string | null;
}

function parseCli(argv: readonly string[]): Cli {
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${a} needs a value`);
    vals.set(a.slice(2), next);
    i++;
  }
  const known = new Set(['url', 'out', 'timeout-ms', 'analyze', 'firmware']);
  for (const k of vals.keys()) if (!known.has(k)) throw new Error(`unknown option --${k}`);
  const timeoutRaw = vals.get('timeout-ms');
  if (timeoutRaw !== undefined && (!/^\d+$/.test(timeoutRaw) || Number(timeoutRaw) < 1_000 || Number(timeoutRaw) > 300_000)) {
    throw new Error('--timeout-ms must be an integer in 1000..300000');
  }
  return {
    url: vals.get('url') ?? process.env['ZODIAC_BRIDGE_URL'] ?? DEFAULT_URL,
    out: vals.get('out') ?? DEFAULT_OUT_DIR,
    timeoutMs: timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw),
    analyze: vals.get('analyze') ?? null,
    firmware: vals.get('firmware') ?? null,
  };
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

async function gitInfo(): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const { stdout: head } = await execFileP('git', ['rev-parse', '--short', 'HEAD']);
    const { stdout: porcelain } = await execFileP('git', ['status', '--porcelain']);
    return { commit: head.trim(), dirty: porcelain.trim().length > 0 };
  } catch (e: unknown) {
    console.error(`git metadata unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return { commit: null, dirty: null };
  }
}

function isReport(x: unknown): x is FlowProbeReport {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o['schema'] === FLOW_PROBE_SCHEMA && o['origin'] === FLOW_PROBE_ORIGIN && Array.isArray(o['rawRepliesHex']);
}

const outputs = (ports: readonly number[]): string => (ports.length === 0 ? '-' : ports.join(','));

function printSummary(r: FlowProbeReport): void {
  console.log(`\nfinding: ${r.finding}`);
  console.log(`  ${r.findingDetail}\n`);
  console.log(`entries (${r.entryCount}):`);
  console.log('  prio  in_port eth_type src                 dst                  instr  outputs  other');
  for (const e of r.entries) {
    const a = e.actions;
    const other = [...a.otherInstructionTypes.map((t) => `i${t}`), ...a.otherActionTypes.map((t) => `a${t}`)].join(',') || '-';
    const instr = !a.hasInstructions ? 'none' : a.complete ? 'yes' : 'BAD';
    console.log(
      `  ${String(e.priority).padEnd(5)} ${String(e.inPort ?? '*').padEnd(7)} ${(e.ethType === undefined ? '*' : '0x' + e.ethType.toString(16)).padEnd(8)} ` +
        `${(e.srcIp === undefined ? '*' : e.srcIp + (e.srcMask ? '/' + e.srcMask : '')).padEnd(20)} ${(e.dstIp === undefined ? '*' : e.dstIp + (e.dstMask ? '/' + e.dstMask : '')).padEnd(20)} ` +
        `${instr.padEnd(6)} ${outputs(a.outputPorts).padEnd(8)} ${other}`,
    );
  }
  const rb = r.readback;
  console.log(`\nmatch level verified: ${rb.verified}${rb.mismatches.length ? '\n  ' + rb.mismatches.join('\n  ') : ''}`);
  console.log(`action level: ${rb.actions.status} (table-miss: ${rb.actions.tableMiss}, switch reports actions: ${rb.actions.switchReportsActions})`);
  if (rb.actions.mismatches.length) console.log('  ' + rb.actions.mismatches.join('\n  '));
  if (rb.actions.unconfirmed.length) console.log(`  unconfirmed: ${rb.actions.unconfirmed.join(', ')}`);
  console.log(`proven forwarding intent: ${rb.provenForwarding}\n`);
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const policy = buildPort1IsolationPolicy();

  let report: unknown;
  let httpStatus: number | null = null;
  let source: string;
  if (cli.analyze !== null) {
    source = `file ${cli.analyze}`;
    report = JSON.parse(await fs.readFile(cli.analyze, 'utf8'));
  } else {
    const endpoint = new URL('/api/zodiac/flows/probe', cli.url).toString();
    source = `GET ${endpoint}`;
    console.log(`probing ${endpoint} (read-only) ...`);
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(cli.timeoutMs) });
    httpStatus = res.status;
    const text = await res.text();
    if (res.status !== 200) {
      console.error(`bridge answered ${res.status}: ${text.slice(0, 400)}`);
      return 2;
    }
    report = JSON.parse(text);
  }

  if (!isReport(report)) {
    console.error(`response is not a ${FLOW_PROBE_SCHEMA} report with origin ${FLOW_PROBE_ORIGIN}; nothing saved.`);
    return 1;
  }

  const { disagreements } = analyzeFlowProbe(report, policy);
  const stamp = report.capturedAtIso.replace(/[:.]/g, '-');
  await fs.mkdir(cli.out, { recursive: true });
  if (disagreements.length > 0) {
    const bad = path.join(cli.out, `flow-probe-${stamp}.DISAGREES.json`);
    await fs.writeFile(bad, JSON.stringify(report, null, 2));
    console.error('The bridge summary disagrees with its own raw bytes. Not saved as evidence; kept at ' + bad);
    for (const d of disagreements) console.error(`  ${d.field}: reported ${d.reported.slice(0, 120)} vs re-derived ${d.rederived.slice(0, 120)}`);
    return 3;
  }

  printSummary(report);
  if (cli.analyze !== null) {
    console.log('re-derived from raw bytes: summary matches. (Offline analysis; nothing written.)');
    return 0;
  }

  const body = JSON.stringify(report, null, 2);
  const file = path.join(cli.out, `flow-probe-${stamp}.json`);
  await fs.writeFile(file, body);
  const git = await gitInfo();
  const scriptPath = new URL(import.meta.url).pathname;
  const meta = {
    origin: FLOW_PROBE_ORIGIN,
    source,
    httpStatus,
    savedFile: path.basename(file),
    reportSha256: sha256(body),
    rawRepliesSha256: report.rawRepliesSha256,
    finding: report.finding,
    rederivedFromRawBytes: 'summary matches',
    // Declared by the operator, not measured by this probe.
    firmwareDeclaredByOperator: cli.firmware,
    tool: { scriptSha256: sha256(await fs.readFile(scriptPath)), gitCommit: git.commit, gitDirty: git.dirty },
  };
  await fs.writeFile(file.replace(/\.json$/, '.meta.json'), JSON.stringify(meta, null, 2));
  console.log(`saved ${file} (+ .meta.json sidecar)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`flow probe failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
