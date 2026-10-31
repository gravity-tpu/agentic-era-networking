/**
 * scripts/conformance-run-v2.ts
 * The on-wire conformance run of plan section 16 (RQ4): installs each rule set of a bundle on the live Zodiac FX through the bridge's guarded
 * experiment endpoint, sends the bundle's flows from the real testbed, observes where each frame appears, and reports two measures per flow:
 * M1 (agreement with the verifier's model) and M2 (behaviour against the intent's own clause). The orchestration and safety behaviour are in
 * src/sdn/wire-session.ts (tested offline against a fake rig); this file is the I/O around it.
 *
 *   --dry-run     no hardware: a perfect-switch rig that returns the model's own prediction. It checks the whole pipeline on the real bundle (including that
 *                 every admissible set's predicted behaviour satisfies its intent, M2) and lists the flows that cannot be sent and why.
 *   (otherwise)   the real rig. REQUIRES `--approve <sha256 of the bundle's index.json>` (the owner approves each session's bundle by hash, plan 16.4) and
 *                 the SSH tunnel to the bridge (ssh -f -N -L 127.0.0.1:13003:127.0.0.1:3003 jetson).
 *
 * PHASE 1 VALIDATION OWED: the real rig below was written without hardware and has not yet driven the switch. The first bench session runs the four
 * references as a smoke test and amends this file and the sender declarations in src/sdn/wire-flows.ts before any other rule set is installed.
 *
 * Usage (after `npx tsc`):
 *   node --experimental-strip-types scripts/conformance-run-v2.ts --bundle <dir> --out <dir> [--only <substring>] [--limit <n>] --dry-run
 *   node --experimental-strip-types scripts/conformance-run-v2.ts --bundle <dir> --out <dir> --approve <index.json sha256> [--only <substring>] [--limit <n>]
 * The experiment token is read from ~/.zodiac-experiment-token and is never printed or put on a command line.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { predictOutcome } from '../dist/sdn/wire-flows.js';
import type { WireFlow, WireRule } from '../dist/sdn/wire-flows.js';
import { buildArpRequestFrame, buildUdpFrame, captureFilterFor, rawSendPython, sendPlanFor } from '../dist/sdn/wire-run.js';
import { runSession } from '../dist/sdn/wire-session.js';
import type { BridgeState, InstallResult, RestoreResult, Rig, RigFlowResult, SessionSet } from '../dist/sdn/wire-session.js';
import { TARGETS } from './wire-common.ts';

const execFileP = promisify(execFile);

// ─── Testbed constants (named and bounded; Invariant 5) ──────────────────────
const BRIDGE_URL = process.env['CONFORMANCE_BRIDGE_URL'] ?? 'http://127.0.0.1:13003';
const TOKEN_FILE = path.join(os.homedir(), '.zodiac-experiment-token');
const JETSON = 'jetson';
const NODE_SENDER = 'agentic-node-01'; // sends every port 1 frame as a raw frame from its workload NIC
const UPLINK_SENDER = 'agentic-node-01'; // sends every port 2 frame as a raw frame from its USB NIC on the isolated uplink VLAN (owner moved it there 2026-10-31)
const UPLINK_IF = 'eth1';
const LISTENER = process.env['CONFORMANCE_LISTENER_HOST'] ?? 'rpi-hailo'; // sees what the switch sends out of port 1 (passwordless sudo, tcpdump present)
const LISTENER_IF = 'eth0'; // rpi-hailo's workload NIC
const WORKLOAD_IF = 'eth0';
const O2_IF = 'enx9c69d39dd0a6'; // Zodiac P3 tap NIC
const O3_IF = 'enx9c69d39ddcc0'; // switch #2 P3: mirror of the Zodiac P2 link
const DATAGRAMS_PER_FLOW = 5;
const ARP_FRAMES_PER_FLOW = 3;
const FRAME_SPACING_MS = 200;
const CAPTURE_SECONDS = 7;
const FLOW_SETTLE_S = 1;
const CAPTURE_POLL_MS = 100;
const CAPTURE_START_POLLS = Math.ceil((FLOW_SETTLE_S * 1000 + 500) / CAPTURE_POLL_MS);
const MAX_RULESETS = 200;
const SSH_TIMEOUT_MS = 60_000;
const BRIDGE_TIMEOUT_MS = 60_000;

interface IndexEntry { intent: string; kind: string; id: string; file: string; arm?: string; installable?: boolean }
interface RuleSetFile { label: string; ttlSeconds: number; rules: WireRule[] }

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));
const sha256 = (t: string | Buffer): string => crypto.createHash('sha256').update(t).digest('hex');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

async function ssh(host: string, remote: string, timeoutMs = SSH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, remote], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
async function pyRemote(host: string, code: string, sudo: boolean): Promise<string> {
  const b64 = Buffer.from(code, 'utf-8').toString('base64');
  return ssh(host, `echo ${b64} | base64 -d | ${sudo ? 'sudo -n ' : ''}python3 -`);
}

async function token(): Promise<string> { return (await fs.readFile(TOKEN_FILE, 'utf-8')).trim(); }
async function bridge(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BRIDGE_URL}${route}`, {
    method,
    headers: { 'x-experiment-token': await token(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

// ─── Dry-run rig: a perfect switch (the model's own prediction), no hardware ──
class PredictionRig implements Rig {
  private installed: SessionSet | null = null;
  async bridgeState(): Promise<BridgeState> { return { phase: 'idle', attention: null }; }
  async install(set: SessionSet): Promise<InstallResult> { this.installed = set; return { ok: true, httpStatus: 200, report: { dryRun: true } }; }
  async restore(): Promise<RestoreResult> { this.installed = null; return { ok: true, report: { dryRun: true } }; }
  async runFlow(flow: WireFlow): Promise<RigFlowResult> {
    const plan = sendPlanFor(flow);
    if (plan.via === 'unsendable') return { sent: false, reason: plan.reason, observedPorts: [], evidence: {} };
    return { sent: true, observedPorts: this.installed === null ? [] : predictOutcome(this.installed.rules, flow), evidence: { dryRun: 'prediction only' } };
  }
}

// ─── Real rig (PHASE 1 VALIDATION OWED, see the header) ──────────────────────
class RealRig implements Rig {
  private setDir: string;
  constructor(outDir: string) { this.setDir = outDir; }
  setCurrentDir(d: string): void { this.setDir = d; }

  async bridgeState(): Promise<BridgeState> {
    const s = await bridge('GET', '/api/experiment/state');
    if (s.status !== 200) throw new Error(`experiment state answered ${s.status}; is the tunnel up and the endpoint enabled?`);
    return { phase: String(s.json['phase']), attention: s.json['attention'] === null ? null : String(s.json['attention']) };
  }
  async install(set: SessionSet): Promise<InstallResult> {
    const r = await bridge('POST', '/api/experiment/install', set.body);
    const report = { httpStatus: r.status, ...r.json };
    await fs.writeFile(path.join(this.setDir, 'install.json'), JSON.stringify(report, null, 1) + '\n');
    return { ok: r.status === 200 && r.json['ok'] === true, httpStatus: r.status, report };
  }
  async restore(): Promise<RestoreResult> {
    const r = await bridge('POST', '/api/experiment/restore');
    const report = { httpStatus: r.status, ...r.json };
    await fs.writeFile(path.join(this.setDir, 'restore.json'), JSON.stringify(report, null, 1) + '\n');
    return { ok: r.status === 200 && r.json['ok'] === true, report };
  }

  async runFlow(flow: WireFlow, tag: number): Promise<RigFlowResult> {
    const plan = sendPlanFor(flow);
    if (plan.via === 'unsendable') return { sent: false, reason: plan.reason, observedPorts: [], evidence: {} };
    const filter = captureFilterFor(flow, tag);
    const stamp = `${process.pid}-${tag}`;
    // The Jetson's capture NICs are already promiscuous (-p keeps tcpdump from changing that); the workload listener must be promiscuous to see flooded frames not addressed to it.
    const cap = (iface: string, f: string, sudo: boolean): string => `rm -f /tmp/conf-${stamp}-${f}.txt /tmp/conf-${stamp}-${f}.err; (${sudo ? 'sudo -n ' : ''}timeout ${CAPTURE_SECONDS} tcpdump -i ${iface} -nn -e -l ${sudo ? '' : '-p '}'${filter}' > /tmp/conf-${stamp}-${f}.txt 2>/tmp/conf-${stamp}-${f}.err &)`;
    const ready = (f: string): string => `grep -q 'listening on' /tmp/conf-${stamp}-${f}.err`;
    const wait = (names: string[]): string => `for i in $(seq 1 ${CAPTURE_START_POLLS}); do if ${names.map(ready).join(' && ')}; then echo started; exit 0; fi; sleep ${CAPTURE_POLL_MS / 1000}; done; echo timeout`;
    const needListener = flow.packet.inPort === 2;
    const jetsonStarted = await ssh(JETSON, `${cap(O2_IF, 'O2', false)}; ${cap(O3_IF, 'O3', false)}; ${wait(['O2', 'O3'])}`);
    const listenerStarted = needListener ? await ssh(LISTENER, `${cap(LISTENER_IF, 'L', true)}; ${wait(['L'])}`) : 'started';
    if (jetsonStarted.trim() !== 'started' || listenerStarted.trim() !== 'started') throw new Error(`a capture was not listening within ${CAPTURE_START_POLLS * CAPTURE_POLL_MS} ms; refusing to send ${flow.id}`);

    {
      const p = flow.packet;
      const frames = p.etherType === 0x0806
        ? Array.from({ length: ARP_FRAMES_PER_FLOW }, () => hex(buildArpRequestFrame({ srcMac: p.srcMac, spa: p.arpSpa ?? '', tpa: p.arpTpa ?? '' })))
        : Array.from({ length: DATAGRAMS_PER_FLOW }, (_, i) => hex(buildUdpFrame({ srcMac: p.srcMac, dstMac: p.dstMac, srcIp: p.srcIp ?? '', dstIp: p.dstIp ?? '', dstPort: tag, payload: Buffer.from(`zodiac-conf-${tag}-${i}`) })));
      const [host, iface] = plan.via === 'raw-from-node' ? [NODE_SENDER, WORKLOAD_IF] : [UPLINK_SENDER, UPLINK_IF];
      await pyRemote(host, rawSendPython(iface, frames, FRAME_SPACING_MS), true);
    }
    await sleep(CAPTURE_SECONDS - FLOW_SETTLE_S + 0.5);
    const o2 = await ssh(JETSON, `cat /tmp/conf-${stamp}-O2.txt`);
    const o3 = await ssh(JETSON, `cat /tmp/conf-${stamp}-O3.txt`);
    const lst = needListener ? await ssh(LISTENER, `cat /tmp/conf-${stamp}-L.txt`) : '';
    await ssh(JETSON, `rm -f /tmp/conf-${stamp}-O2.* /tmp/conf-${stamp}-O3.*`).catch(() => undefined);
    if (needListener) await ssh(LISTENER, `rm -f /tmp/conf-${stamp}-L.*`).catch(() => undefined);
    const count = (t: string): number => t.split('\n').filter((l) => /^\S+\s+[0-9a-f:]{17} > [0-9a-f:]{17},/.test(l)).length;
    const observed: number[] = [];
    if (flow.packet.inPort === 1 && count(o3) > 0) observed.push(2); // out of port 2: seen on the mirror of the P2 link
    if (flow.packet.inPort === 2 && count(lst) > 0) observed.push(1); // out of port 1: seen on a workload node
    if (count(o2) > 0) observed.push(3); // out of port 3: seen on the tap NIC
    await fs.writeFile(path.join(this.setDir, `${flow.id}.O2.txt`), o2);
    await fs.writeFile(path.join(this.setDir, `${flow.id}.O3.txt`), o3);
    if (needListener) await fs.writeFile(path.join(this.setDir, `${flow.id}.listener.txt`), lst);
    return { sent: true, observedPorts: observed.sort((a, b) => a - b), evidence: { O2: sha256(o2), O3: sha256(o3), ...(needListener ? { listener: sha256(lst) } : {}) } };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const bundleDir = get('--bundle');
  const outDir = get('--out');
  if (bundleDir === undefined || outDir === undefined) throw new Error('usage: conformance-run-v2.ts --bundle <dir> --out <dir> [--only <substring>] [--limit <n>] (--dry-run | --approve <index.json sha256>)');
  const dry = argv.includes('--dry-run');
  const approve = get('--approve');
  const only = get('--only');
  const limitRaw = get('--limit');
  const limit = limitRaw === undefined ? MAX_RULESETS : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RULESETS) throw new Error(`--limit must be an integer 1 to ${MAX_RULESETS}`);

  const indexText = await fs.readFile(path.join(bundleDir, 'index.json'), 'utf-8');
  const indexHash = sha256(indexText);
  if (!dry && approve !== indexHash) throw new Error(`refusing to touch the switch: --approve must be the SHA-256 of this bundle's index.json (${indexHash}); the owner approves each session's bundle by hash`);
  const index = JSON.parse(indexText) as IndexEntry[];
  const flowsByIntent = JSON.parse(await fs.readFile(path.join(bundleDir, 'flows.json'), 'utf-8')) as Record<string, WireFlow[]>;
  // Clause-coverage flows (amendment A2) run on references only: they test the intent itself, in both entry directions.
  const coverage = JSON.parse(await fs.readFile(path.join(bundleDir, 'coverage-flows.json'), 'utf-8').catch(() => '{}')) as Record<string, { flows: WireFlow[] }>;
  const flowsFor = (set: SessionSet): WireFlow[] => {
    const base = flowsByIntent[set.intent.id] ?? [];
    if (set.kind !== 'reference') return base;
    const seen = new Set(base.map((f) => f.id));
    return [...base, ...(coverage[set.intent.id]?.flows ?? []).filter((f) => !seen.has(f.id))];
  };
  const picked = index.filter((e) => (e.installable ?? true) && (only === undefined || `${e.intent} ${e.kind} ${e.id}`.includes(only))).slice(0, limit);
  if (picked.length === 0) throw new Error('no rule sets matched');
  await fs.mkdir(outDir, { recursive: true });

  const sets: SessionSet[] = [];
  for (const e of picked) {
    const target = TARGETS.find((t) => t.intent.id === e.intent);
    if (target === undefined) throw new Error(`unknown intent ${e.intent}`);
    const file = JSON.parse(await fs.readFile(path.join(bundleDir, e.file), 'utf-8')) as RuleSetFile;
    const flowsSeconds = (e.kind === 'reference' ? flowsFor({ kind: 'reference', intent: target.intent } as SessionSet).length : (flowsByIntent[e.intent]?.length ?? 0)) * (CAPTURE_SECONDS + 3);
    const ttlSeconds = Math.max(file.ttlSeconds, flowsSeconds + 30);
    sets.push({ id: e.id, kind: e.kind, intent: target.intent, rules: file.rules, body: { label: file.label, ttlSeconds, rules: file.rules } });
  }

  const rig = dry ? new PredictionRig() : new RealRig(outDir);
  if (!dry) {
    await fs.writeFile(path.join(outDir, 'provenance.json'), JSON.stringify({
      origin: 'physical_capture', plan: 'docs/research/evaluation-plan.md section 16', bundleIndexSha256: indexHash, approvedBy: 'owner, by hash (--approve)',
      harnessCommit: (await execFileP('git', ['rev-parse', 'HEAD'])).stdout.trim(), startedAtEt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
      observation: { O2: O2_IF, O3: O3_IF, listener: `${LISTENER} ${LISTENER_IF}`, port1Sender: `${NODE_SENDER} ${WORKLOAD_IF}`, port2Sender: `${UPLINK_SENDER} ${UPLINK_IF}` }, framesPerFlow: { udp: DATAGRAMS_PER_FLOW, arp: ARP_FRAMES_PER_FLOW },
    }, null, 1) + '\n');
  }

  let stopRequested = false;
  process.on('SIGINT', () => { stopRequested = true; process.stderr.write('stop requested: finishing the current rule set, restoring, then stopping\n'); });
  const result = await runSession(rig, sets, flowsFor, { shouldStop: () => stopRequested });

  const sent = result.results.flatMap((r) => r.flows.filter((f) => f.sent));
  const unsent = result.results.flatMap((r) => r.flows.filter((f) => !f.sent));
  const m1 = sent.filter((f) => f.sent && f.m1.agrees).length;
  const m2 = sent.filter((f) => f.sent && f.m2.compliant).length;
  const reasons: Record<string, number> = {};
  for (const f of unsent) if (!f.sent) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  const byKind: Record<string, { sets: number; flows: number; m1Agree: number; m2Compliant: number }> = {};
  for (const r of result.results) {
    const k = (byKind[r.kind] ??= { sets: 0, flows: 0, m1Agree: 0, m2Compliant: 0 });
    k.sets++;
    for (const f of r.flows) if (f.sent) { k.flows++; if (f.m1.agrees) k.m1Agree++; if (f.m2.compliant) k.m2Compliant++; }
  }
  const summary = { schema: 'conformance-run/v2', dryRun: dry, bundleIndexSha256: indexHash, ruleSets: result.results.length, flowsSent: sent.length, m1Agree: m1, m1Disagree: sent.length - m1, m2Compliant: m2, m2NonCompliant: sent.length - m2, flowsNotSent: unsent.length, notSentReasons: reasons, byKind, stoppedBecause: result.stoppedBecause, skippedSets: result.results.filter((r) => r.skipped !== undefined).map((r) => ({ id: r.id, reason: r.skipped })) };
  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ summary, results: result.results }, null, 1) + '\n');
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  if (result.stoppedBecause !== null) process.exitCode = 3;
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
