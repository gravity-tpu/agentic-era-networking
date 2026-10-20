/**
 * scripts/conformance-run.ts
 * The one-command on-wire conformance probe (RQ4, docs/ROADMAP.md Track B): for each rule set, install it on the live Zodiac FX through the
 * bridge's guarded experiment endpoint, send real traffic from the real testbed hosts, observe where it appears, compare with what the
 * verifier's own model predicts, and restore the isolation policy. Raw captures and a provenance record are written for every run.
 *
 * What it can and cannot see. Ground truth for "the switch sent it out of port 2" is the O3 capture (a mirror of the Zodiac P2 link, taken by
 * the Jetson, independent of the policy under test). "Out of port 3" is the O2 capture (the Zodiac P3 link; a copy chosen by the rules under
 * test, but a frame appearing there is physical proof the switch sent it). "Out of port 1" is seen only as a datagram arriving at a listener
 * bound to the workload NIC. A probe can show disagreement with the model on its five flows; it is not an exhaustive check, and agreement
 * on five flows is not a proof. UDP and ARP only; small samples (N datagrams per flow); one switch, firmware 0.86.
 *
 * Safety: every install goes through POST /api/experiment/install (bounds, A5/A6/A7 re-checks, table-miss DROP, readback, a time limit and
 * a switch-side hard timeout); the harness restores in a `finally` and refuses to continue unless the bridge reports idle with no attention.
 * Nothing is flooded: DATAGRAMS_PER_FLOW small UDP datagrams per flow.
 *
 * Usage (after `npx tsc`; the SSH tunnel to the bridge must be up: ssh -f -N -L 127.0.0.1:13003:127.0.0.1:3003 jetson):
 *   node --experimental-strip-types scripts/conformance-run.ts --rulesets <dir with index.json> --out <results dir> [--only <substring>] [--limit <n>] [--dry-run]
 * The experiment token is read from ~/.zodiac-experiment-token and is never printed or put on a command line.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchesPacket } from '../dist/sdn/intent-spec.js';
import type { PacketClass } from '../dist/sdn/intent-spec.js';

const execFileP = promisify(execFile);

// ─── Testbed constants (named and bounded; Invariant 5) ──────────────────────
const BRIDGE_URL = process.env['CONFORMANCE_BRIDGE_URL'] ?? 'http://127.0.0.1:13003';
const TOKEN_FILE = path.join(os.homedir(), '.zodiac-experiment-token');
const JETSON = 'jetson';
const O2_IF = 'enx9c69d39dd0a6'; // Zodiac P3 tap NIC
const O3_IF = 'enx9c69d39ddcc0'; // switch #2 P3: mirror of the Zodiac P2 link
const DATAGRAMS_PER_FLOW = 5;
const DATAGRAM_SPACING_S = 0.2;
const CAPTURE_SECONDS = 7;
const FLOW_SETTLE_S = 1;
const MAX_RULESETS = 100;
const SSH_TIMEOUT_MS = 60_000;
const UDP_TAG_BASE = 41_000;
const ARP_PROBE_IP = '10.0.2.200'; // an unused address on the workload subnet: the kernel ARPs for it, no host answers
const WORKLOAD_IF = 'eth0';

interface Host { readonly name: string; readonly ssh: string | null; readonly ip: string }
const NODE01: Host = { name: 'agentic-node-01', ssh: 'agentic-node-01', ip: '10.0.2.50' };
const HAILO: Host = { name: 'rpi-hailo', ssh: 'rpi-hailo', ip: '10.0.2.51' }; // the quarantined address in INTENT-3

interface Flow {
  readonly id: string;
  readonly describe: string;
  readonly kind: 'p1-udp' | 'p1-arp' | 'p2-udp';
  readonly sender: Host | 'mac';
  /** workload-side host the datagram is addressed to (p2-udp only) */
  readonly target?: Host;
  readonly observable: readonly number[];
}

const FLOWS: readonly Flow[] = [
  { id: 'F1-p1-udp-from-node01-to-uplink-host', describe: 'node-01 (10.0.2.50) sends UDP out eth0 to the Mac on the uplink side', kind: 'p1-udp', sender: NODE01, observable: [2, 3] },
  { id: 'F2-p1-udp-from-quarantine-candidate', describe: 'rpi-hailo (10.0.2.51) sends UDP out eth0 to the Mac on the uplink side', kind: 'p1-udp', sender: HAILO, observable: [2, 3] },
  { id: 'F3-p1-arp-who-has', describe: 'node-01 ARPs for an unused workload address', kind: 'p1-arp', sender: NODE01, observable: [2, 3] },
  { id: 'F4-p2-udp-to-node01', describe: 'the Mac sends UDP to node-01 (10.0.2.50) from the uplink side', kind: 'p2-udp', sender: 'mac', target: NODE01, observable: [1, 3] },
  { id: 'F5-p2-udp-to-quarantine-candidate', describe: 'the Mac sends UDP to rpi-hailo (10.0.2.51) from the uplink side', kind: 'p2-udp', sender: 'mac', target: HAILO, observable: [1, 3] },
];

// ─── Types ───────────────────────────────────────────────────────────────────
interface WireRule { id: string; priority: number; outputPorts: number[]; match: Record<string, unknown> }
interface RuleSetFile { label: string; ttlSeconds: number; rules: WireRule[]; meta?: Record<string, unknown> }
interface IndexEntry { intent: string; kind: string; id: string; file: string; installable?: boolean; priorityClamped?: boolean }
interface HostFacts { macs: Record<string, string>; macIp: string; macMac: string; neighborOk: Record<string, boolean> }

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));
const sha256 = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');

async function hashDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await fs.readdir(dir)).sort()) if (f.endsWith('.txt') || f.endsWith('.json')) out[f] = sha256(await fs.readFile(path.join(dir, f), 'utf-8'));
  return out;
}

// ─── Shell helpers (argument arrays only; no shell string built from untrusted text) ──
async function ssh(host: string, remote: string, timeoutMs = SSH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, remote], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Runs a Python snippet on a host through base64, so quoting never matters. */
async function py(host: string, code: string, timeoutMs = SSH_TIMEOUT_MS): Promise<string> {
  const b64 = Buffer.from(code, 'utf-8').toString('base64');
  return ssh(host, `echo ${b64} | base64 -d | python3 -`, timeoutMs);
}

async function local(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { timeout: 30_000 });
  return stdout.trim();
}

// ─── The model's prediction, using the verifier's own match function ─────────
function predict(rules: readonly WireRule[], pkt: PacketClass): { ports: number[]; ruleId: string | null; tie: boolean } {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    if (!matchesPacket(r.match as never, pkt)) continue;
    const tie = sorted.some((o) => o !== r && o.priority === r.priority && matchesPacket(o.match as never, pkt));
    return { ports: [...r.outputPorts], ruleId: r.id, tie };
  }
  return { ports: [], ruleId: null, tie: false }; // the table-miss drops
}

function packetClassFor(flow: Flow, facts: HostFacts): PacketClass {
  if (flow.kind === 'p1-arp') {
    return { inPort: 1, etherType: 0x0806, srcMac: facts.macs[(flow.sender as Host).name] ?? '00:00:00:00:00:00', dstMac: 'ff:ff:ff:ff:ff:ff' };
  }
  if (flow.kind === 'p1-udp') {
    const s = flow.sender as Host;
    return { inPort: 1, etherType: 0x0800, srcMac: facts.macs[s.name] ?? '00:00:00:00:00:00', dstMac: facts.macMac, srcIp: s.ip, dstIp: facts.macIp };
  }
  const t = flow.target as Host;
  // A frame entering P2 from the Mac is routed by the lab router, so its L2 source is not the Mac's; only rule sets that match MACs depend on it.
  return { inPort: 2, etherType: 0x0800, srcMac: '00:00:00:00:00:00', dstMac: facts.macs[t.name] ?? '00:00:00:00:00:00', srcIp: facts.macIp, dstIp: t.ip };
}

// ─── Bridge client ───────────────────────────────────────────────────────────
async function token(): Promise<string> { return (await fs.readFile(TOKEN_FILE, 'utf-8')).trim(); }

async function bridge(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BRIDGE_URL}${route}`, {
    method,
    headers: { 'x-experiment-token': await token(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function requireHealthyBridge(): Promise<void> {
  const s = await bridge('GET', '/api/experiment/state');
  if (s.status !== 200) throw new Error(`experiment state answered ${s.status}; is the tunnel up and the endpoint enabled?`);
  if (s.json['phase'] !== 'idle') throw new Error(`the bridge is not idle (phase ${String(s.json['phase'])}); restore first`);
  if (s.json['attention'] !== null) throw new Error(`the bridge reports attention: ${String(s.json['attention'])}; the isolation policy may not be in place`);
}

// ─── Observation ─────────────────────────────────────────────────────────────
interface Observed { o2: number; o3: number; listener: number; o2Lines: string[]; o3Lines: string[] }

function framesFrom(lines: string[], senderMac: string | null): number {
  let n = 0;
  for (const l of lines) {
    const m = /^\S+\s+([0-9a-f:]{17}) > ([0-9a-f:]{17}),/.exec(l);
    if (m === null) continue;
    if (senderMac === null || m[1] === senderMac) n++;
  }
  return n;
}

async function runFlow(flow: Flow, tag: number, facts: HostFacts, evidenceDir: string): Promise<Observed> {
  const filter = flow.kind === 'p1-arp' ? `arp and host ${ARP_PROBE_IP}` : `udp dst port ${tag}`;
  const stamp = `${process.pid}-${tag}`;
  const cap = (i: string, f: string): string => `rm -f /tmp/conf-${stamp}-${f}.txt; (timeout ${CAPTURE_SECONDS} tcpdump -i ${i} -nn -e -l '${filter}' > /tmp/conf-${stamp}-${f}.txt 2>/tmp/conf-${stamp}-${f}.err &)`;
  await ssh(JETSON, `${cap(O2_IF, 'O2')}; ${cap(O3_IF, 'O3')}; sleep ${FLOW_SETTLE_S}; echo started`);
  let listener = 0;
  if (flow.kind === 'p2-udp') {
    const target = flow.target as Host;
    const listen = py(target.ssh as string, `
import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'${WORKLOAD_IF}')
s.bind(('0.0.0.0',${tag}))
s.settimeout(0.5)
end=time.time()+${CAPTURE_SECONDS - FLOW_SETTLE_S - 0.5}
n=0
while time.time()<end:
    try:
        s.recvfrom(100); n+=1
    except socket.timeout: pass
print(n)
`);
    await sleep(0.6);
    const dst = target.ip;
    const code = `import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
for i in range(${DATAGRAMS_PER_FLOW}):
    s.sendto(b'zodiac-conf-%d'%i,('${dst}',${tag}))
    time.sleep(${DATAGRAM_SPACING_S})
`;
    await execFileP('python3', ['-c', code], { timeout: 30_000 });
    listener = Number((await listen).trim().split('\n').pop() ?? '0');
  } else if (flow.kind === 'p1-udp') {
    const s = flow.sender as Host;
    await py(s.ssh as string, `
import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'${WORKLOAD_IF}')
s.bind(('${s.ip}',0))
for i in range(${DATAGRAMS_PER_FLOW}):
    s.sendto(b'zodiac-conf-%d'%i,('${facts.macIp}',${tag}))
    time.sleep(${DATAGRAM_SPACING_S})
print('sent')
`);
  } else {
    const s = flow.sender as Host;
    await py(s.ssh as string, `
import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'${WORKLOAD_IF}')
s.bind(('${s.ip}',0))
try:
    s.sendto(b'zodiac-conf-arp',('${ARP_PROBE_IP}',9))
except OSError as e:
    print('send error',e)
print('sent')
`);
  }
  await sleep(CAPTURE_SECONDS - FLOW_SETTLE_S + 0.5);
  const o2Raw = await ssh(JETSON, `cat /tmp/conf-${stamp}-O2.txt`);
  const o3Raw = await ssh(JETSON, `cat /tmp/conf-${stamp}-O3.txt`);
  await ssh(JETSON, `rm -f /tmp/conf-${stamp}-O2.* /tmp/conf-${stamp}-O3.*`).catch(() => undefined);
  const o2Lines = o2Raw.split('\n').filter((l) => l.trim() !== '');
  const o3Lines = o3Raw.split('\n').filter((l) => l.trim() !== '');
  await fs.writeFile(path.join(evidenceDir, `${flow.id}.O2.txt`), o2Raw);
  await fs.writeFile(path.join(evidenceDir, `${flow.id}.O3.txt`), o3Raw);
  // O3 sees both directions of the mirrored link, so for P1-ingress flows count only frames the sender's NIC sourced; O2 shows only what the switch sent out of P3.
  const senderMac = flow.sender === 'mac' ? null : (facts.macs[flow.sender.name] ?? null);
  return { o2: framesFrom(o2Lines, null), o3: flow.kind === 'p2-udp' ? framesFrom(o3Lines, null) : framesFrom(o3Lines, senderMac), listener, o2Lines, o3Lines };
}

function observedPorts(flow: Flow, o: Observed): number[] {
  const ports: number[] = [];
  if (flow.kind !== 'p2-udp' && o.o3 > 0) ports.push(2);
  if (flow.kind === 'p2-udp' && o.listener > 0) ports.push(1);
  if (o.o2 > 0) ports.push(3);
  return ports.sort();
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && (() => { const sa = [...a].sort((x, y) => x - y); const sb = [...b].sort((x, y) => x - y); return sa.every((v, i) => v === sb[i]); })();

// ─── Provenance ──────────────────────────────────────────────────────────────
async function provenance(facts: HostFacts): Promise<Record<string, unknown>> {
  const bridgeRepo = await ssh(JETSON, `cd ~/agentic-era-networking && echo "commit $(git rev-parse HEAD)"; echo "branch $(git rev-parse --abbrev-ref HEAD)"; echo "dirty_files $(git status --short | wc -l)"; echo "dist_sha256 $(sha256sum dist/sdn/zodiac-bridge-server.js | cut -d' ' -f1)"; echo "tcpdump $(tcpdump --version 2>&1 | head -1)"; echo "kernel $(uname -r)"`);
  const harnessCommit = await local('git', ['rev-parse', 'HEAD']).catch(() => 'unknown');
  const harnessDirty = await local('git', ['status', '--porcelain', '--untracked-files=no']).then((s) => s.split('\n').filter(Boolean).length).catch(() => -1);
  return {
    origin: 'physical_capture', switch: 'Zodiac FX firmware 0.86 (ledger value; not re-read by this run)', bridgeRepo: bridgeRepo.trim().split('\n'), harnessCommit, harnessDirtyTrackedFiles: harnessDirty,
    observation: { O2: `${O2_IF} on the Jetson (Zodiac P3 tap; a copy chosen by the rules under test)`, O3: `${O3_IF} on the Jetson (mirror of the Zodiac P2 link; independent of the rules under test)` },
    hosts: facts, datagramsPerFlow: DATAGRAMS_PER_FLOW, startedAtEt: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
  };
}

async function gatherFacts(): Promise<HostFacts> {
  const macs: Record<string, string> = {};
  for (const h of [NODE01, HAILO]) macs[h.name] = (await ssh(h.ssh as string, `cat /sys/class/net/${WORKLOAD_IF}/address`)).trim().toLowerCase();
  const macIp = await local('ipconfig', ['getifaddr', 'en0']);
  const macMac = (await local('sh', ['-c', "ifconfig en0 | awk '/ether/{print $2}'"])).toLowerCase();
  const neighborOk: Record<string, boolean> = {};
  for (const h of [NODE01, HAILO]) {
    const n = await ssh(h.ssh as string, `ip neigh show ${macIp} dev ${WORKLOAD_IF}`).catch(() => '');
    neighborOk[h.name] = /lladdr/.test(n);
  }
  return { macs, macIp, macMac, neighborOk };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const rulesetsDir = get('--rulesets');
  const outDir = get('--out');
  if (rulesetsDir === undefined || outDir === undefined) throw new Error('usage: conformance-run.ts --rulesets <dir> --out <dir> [--only <substring>] [--limit <n>] [--dry-run]');
  const only = get('--only');
  const limitRaw = get('--limit');
  const limit = limitRaw === undefined ? MAX_RULESETS : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RULESETS) throw new Error(`--limit must be an integer 1 to ${MAX_RULESETS}`);
  const dry = argv.includes('--dry-run');

  const index = JSON.parse(await fs.readFile(path.join(rulesetsDir, 'index.json'), 'utf-8')) as IndexEntry[];
  const picked = index.filter((e) => (e.installable ?? true) && (only === undefined || `${e.intent} ${e.kind} ${e.id}`.includes(only))).slice(0, limit);
  if (picked.length === 0) throw new Error('no rule sets matched');
  await fs.mkdir(outDir, { recursive: true });

  const facts: HostFacts = dry
    ? { macs: { [NODE01.name]: 'b8:27:eb:a2:ec:b0', [HAILO.name]: '98:fe:54:52:9d:85' }, macIp: '10.0.0.119', macMac: 'f2:5b:dc:7d:21:d4', neighborOk: {} }
    : await gatherFacts();
  if (!dry) {
    for (const [h, ok] of Object.entries(facts.neighborOk)) if (!ok) throw new Error(`${h} has no neighbor entry for ${facts.macIp} on ${WORKLOAD_IF}; its UDP flows would stall in ARP. Ping the Mac from it first.`);
    await requireHealthyBridge();
    await fs.writeFile(path.join(outDir, 'provenance.json'), JSON.stringify(await provenance(facts), null, 1) + '\n');
  }

  const summary: Array<Record<string, unknown>> = [];
  let tagCounter = 0;
  for (const entry of picked) {
    const file = JSON.parse(await fs.readFile(path.join(rulesetsDir, entry.file), 'utf-8')) as RuleSetFile;
    const setDir = path.join(outDir, entry.file.replace(/\.json$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_'));
    await fs.mkdir(setDir, { recursive: true });
    const flowsSeconds = FLOWS.length * (CAPTURE_SECONDS + 3);
    const ttlSeconds = Math.max(file.ttlSeconds, flowsSeconds + 30);
    const results: Array<Record<string, unknown>> = [];
    let installReport: Record<string, unknown> = { dryRun: true };
    let installed = dry;
    if (!dry) {
      const r = await bridge('POST', '/api/experiment/install', { label: file.label, ttlSeconds, rules: file.rules });
      installReport = { httpStatus: r.status, ...r.json };
      installed = r.status === 200 && r.json['ok'] === true;
      await fs.writeFile(path.join(setDir, 'install.json'), JSON.stringify(installReport, null, 1) + '\n');
    }
    try {
      if (!installed) {
        results.push({ skipped: true, reason: `install did not verify (HTTP ${String(installReport['httpStatus'])})` });
      } else {
        for (const flow of FLOWS) {
          const pkt = packetClassFor(flow, facts);
          const pred = predict(file.rules, pkt);
          const predictedObservable = pred.ports.filter((p) => flow.observable.includes(p)).sort();
          if (dry) { results.push({ flow: flow.id, predictedPorts: pred.ports, predictedObservable, byRule: pred.ruleId, tie: pred.tie }); continue; }
          const tag = UDP_TAG_BASE + (tagCounter++ % 500);
          const obs = await runFlow(flow, tag, facts, setDir);
          const observed = observedPorts(flow, obs);
          results.push({
            flow: flow.id, describe: flow.describe, predictedPorts: pred.ports, predictedObservable, predictedByRule: pred.ruleId, tie: pred.tie,
            observedPorts: observed, counts: { O2: obs.o2, O3: obs.o3, listener: obs.listener }, sent: flow.kind === 'p1-arp' ? 'arp-retries' : DATAGRAMS_PER_FLOW,
            agrees: sameSet(observed, predictedObservable) && !pred.tie,
          });
        }
      }
    } finally {
      if (!dry && installed) {
        const back = await bridge('POST', '/api/experiment/restore');
        await fs.writeFile(path.join(setDir, 'restore.json'), JSON.stringify({ httpStatus: back.status, ...back.json }, null, 1) + '\n');
        if (back.status !== 200 || back.json['ok'] !== true) throw new Error(`restore did not verify after ${entry.id} (HTTP ${back.status}); stopping so a person can look. State: ${JSON.stringify(back.json).slice(0, 300)}`);
      }
    }
    const verdicts = results.filter((r) => 'agrees' in r);
    const row = { intent: entry.intent, kind: entry.kind, id: entry.id, installed, flows: results, agree: verdicts.filter((r) => r['agrees'] === true).length, flowsRun: verdicts.length };
    summary.push(row);
    await fs.writeFile(path.join(setDir, 'result.json'), JSON.stringify(row, null, 1) + '\n');
    await fs.writeFile(path.join(setDir, 'evidence-sha256.json'), JSON.stringify(await hashDir(setDir), null, 1) + '\n');
    process.stderr.write(`${entry.intent} ${entry.kind} ${entry.id}: ${installed ? `${row.agree}/${row.flowsRun} flows agree` : 'not installed'}\n`);
    if (!dry) await requireHealthyBridge();
  }
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ schema: 'conformance-run/v1', dryRun: dry, ruleSets: summary }, null, 1) + '\n');
  const flat = summary.flatMap((s) => (s['flows'] as Array<Record<string, unknown>>).filter((f) => 'agrees' in f));
  process.stdout.write(`${summary.length} rule sets, ${flat.length} flow checks, ${flat.filter((f) => f['agrees'] === true).length} agree with the model, ${flat.filter((f) => f['agrees'] === false).length} disagree${dry ? ' (dry run: predictions only, nothing sent)' : ''}\n`);
}

main().catch((e) => { process.stderr.write(`FATAL: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
