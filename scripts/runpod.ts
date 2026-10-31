/**
 * scripts/runpod.ts
 * Budget-capped wrapper over the Runpod REST + GraphQL APIs for ephemeral offline jobs
 * (training, bulk local-model evaluation). Pure budget logic lives in src/infra/runpod-budget.ts.
 *
 * Invariant 4: `create` is a dry run unless `--yes` is passed; a person approves each launch.
 * Invariant 3: refuses when the price is unknown, the estimate exceeds the cap or the balance, or the
 *   pod reports a higher hourly price than was planned (it is terminated immediately).
 * Placement (owner policy 2026-10-30): score and sweep run on Community Cloud (on-demand by default: Runpod no longer offers spot; --spot opts in), train on Secure Cloud
 *   on-demand only (src/infra/runpod-budget.ts placementFor); spot runs are capped in length.
 * Invariant 5: per-run cap defaults to $5 (RUNPOD_RUN_CAP_USD may lower it; the code ceiling bounds it).
 *
 * The API key is read from RUNPOD_API_KEY and is never printed or passed into a pod. Every pod runs its
 * command under `timeout`, so the container exits (GPU billing stops) even if this tool dies; `sweep`
 * terminates any zodiac-* pod past its deadline.
 *
 * Usage:
 *   node --env-file=.env.local --experimental-strip-types scripts/runpod.ts <command> [flags]
 *   balance | gpus | plan | create | status | terminate <podId> | sweep [--dry-run]
 *   plan|create flags: --gpu <id> --kind score|sweep|train --minutes <n> --label <s> [--spot] (on-demand is the default; --on-demand is accepted)
 *                      [--image <ref>] [--cmd <shell>] [--disk-gb <n>] [--cap-usd <n>] [--ssh-pubkey <file>] [--yes]
 */

import { readFile } from 'node:fs/promises';
import {
  DEFAULT_RUN_CAP_MICROS,
  decodePodDeadline,
  encodePodName,
  formatMicros,
  isExpired,
  parseUsdToMicros,
  placementFor,
  checkPlacementDuration,
  planRun,
  type JobKind,
  type Placement,
} from '../src/infra/runpod-budget.ts';

const REST = 'https://rest.runpod.io/v1';
const GRAPHQL = 'https://api.runpod.io/graphql';
const DEFAULT_IMAGE = 'runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04';
const DEFAULT_DISK_GB = 100;
const MAX_DISK_GB = 500;
const KILL_GRACE_SECONDS = 30;

interface Flags {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === 'yes' || name === 'dry-run' || name === 'on-demand' || name === 'spot') {
      switches.add(name);
    } else if (next === undefined || next.startsWith('--')) {
      throw new Error(`ERR_USAGE: --${name} needs a value`);
    } else {
      values.set(name, next);
      i++;
    }
  }
  return { positional, values, switches };
}

function apiKey(): string {
  const key = process.env['RUNPOD_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error('ERR_NO_KEY: RUNPOD_API_KEY is not set (run with --env-file=.env.local)');
  }
  return key;
}

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${REST}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`ERR_BAD_JSON: ${method} ${path} -> ${res.status}: ${String(err)}`);
    }
  }
  return { status: res.status, json };
}

async function restOk(method: string, path: string, body?: unknown): Promise<unknown> {
  const { status, json } = await rest(method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`ERR_HTTP_${status}: ${method} ${path}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function graphql(query: string): Promise<Record<string, unknown>> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const parsed = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (!res.ok || parsed.errors !== undefined || parsed.data === undefined) {
    throw new Error(`ERR_GRAPHQL_${res.status}: ${JSON.stringify(parsed.errors ?? null).slice(0, 300)}`);
  }
  return parsed.data;
}

interface GpuType {
  readonly id: string;
  readonly memoryInGb: number;
  readonly securePrice: number | null;
  readonly communityPrice: number | null;
}

async function gpuTypes(): Promise<readonly GpuType[]> {
  const data = await graphql('{ gpuTypes { id memoryInGb securePrice communityPrice } }');
  return data['gpuTypes'] as GpuType[];
}

async function balanceMicros(): Promise<bigint> {
  const data = await graphql('{ myself { clientBalance } }');
  const me = data['myself'] as { clientBalance: number };
  return parseUsdToMicros(me.clientBalance);
}

function need(flags: Flags, name: string): string {
  const v = flags.values.get(name);
  if (v === undefined) throw new Error(`ERR_USAGE: --${name} is required`);
  return v;
}

function parsePlacement(flags: Flags): { kind: JobKind; placement: Placement } {
  const kind = need(flags, 'kind');
  if (kind !== 'score' && kind !== 'sweep' && kind !== 'train') {
    throw new Error('ERR_USAGE: --kind must be score|sweep|train');
  }
  return { kind, placement: placementFor(kind, { onDemand: flags.switches.has('on-demand'), spot: flags.switches.has('spot') }) };
}

function parsePositiveInt(raw: string, name: string, max: bigint): bigint {
  if (!/^\d+$/.test(raw)) throw new Error(`ERR_USAGE: --${name} must be a positive integer`);
  const n = BigInt(raw);
  if (n <= 0n || n > max) throw new Error(`ERR_USAGE: --${name} must be in 1..${max.toString()}`);
  return n;
}

function capMicros(flags: Flags): bigint {
  const raw = flags.values.get('cap-usd') ?? process.env['RUNPOD_RUN_CAP_USD'];
  return raw === undefined ? DEFAULT_RUN_CAP_MICROS : parseUsdToMicros(raw);
}

async function buildPlan(flags: Flags) {
  const gpu = need(flags, 'gpu');
  const { kind, placement } = parsePlacement(flags);
  const cloud = placement.cloud;
  const minutes = parsePositiveInt(need(flags, 'minutes'), 'minutes', 24n * 60n);
  const types = await gpuTypes();
  const match = types.find((g) => g.id === gpu);
  if (match === undefined) throw new Error(`ERR_UNKNOWN_GPU: ${gpu}`);
  const price = cloud === 'secure' ? match.securePrice : match.communityPrice;
  const ratePerHourMicros = price === null || price === undefined ? 0n : parseUsdToMicros(price);
  const spotCheck = checkPlacementDuration(placement, minutes * 60n);
  if (!spotCheck.ok) throw new Error(`${spotCheck.code}: ${spotCheck.detail}`);
  // The on-demand price of the chosen cloud is the planning price, also for spot: a spot pod costs at most that.
  const plan = planRun({
    capMicros: capMicros(flags),
    ratePerHourMicros,
    balanceMicros: await balanceMicros(),
    requestedSeconds: minutes * 60n,
  });
  return { gpu, kind, placement, cloud, minutes, ratePerHourMicros, plan };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function wrapCommand(cmd: string | undefined, timeoutSeconds: bigint, withSsh: boolean): string[] {
  const inner = cmd === undefined ? `sleep ${timeoutSeconds.toString()}` : cmd;
  // The image's /start.sh brings up sshd (from PUBLIC_KEY) and then blocks; run it beside the bounded command.
  const ssh = withSsh ? '(/start.sh &) ; ' : '';
  const script = `${ssh}timeout -k ${KILL_GRACE_SECONDS} ${timeoutSeconds.toString()} bash -c ${shellQuote(inner)}; exit $?`;
  return ['bash', '-c', script];
}

interface PodInfo {
  readonly id: string;
  readonly name: string;
  readonly desiredStatus?: string;
  readonly costPerHr?: string | number;
  readonly publicIp?: string | null;
  readonly portMappings?: Record<string, number> | null;
}

async function terminateVerified(podId: string): Promise<void> {
  const del = await rest('DELETE', `/pods/${podId}`);
  if (del.status !== 200 && del.status !== 204 && del.status !== 404) {
    throw new Error(`ERR_HTTP_${del.status}: DELETE /pods/${podId}: ${JSON.stringify(del.json).slice(0, 300)}`);
  }
  const after = await rest('GET', `/pods/${podId}`);
  if (after.status !== 404) {
    throw new Error(`ERR_NOT_TERMINATED: GET /pods/${podId} returned ${after.status} after delete`);
  }
  console.log(`terminated ${podId} (verified: GET returns 404)`);
}

async function cmdCreate(flags: Flags): Promise<void> {
  const { gpu, kind, placement, cloud, minutes, ratePerHourMicros, plan } = await buildPlan(flags);
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.detail}`);
  console.log(
    `plan: ${kind} on ${gpu} (${cloud} ${placement.interruptible ? 'spot' : 'on-demand'}) ${minutes.toString()} min @ ${formatMicros(ratePerHourMicros)}/hr -> worst case ${formatMicros(plan.estimatedMicros)} (cap ${formatMicros(capMicros(flags))})`,
  );
  if (!flags.switches.has('yes')) {
    console.log('dry run: pass --yes to launch');
    return;
  }
  const diskGb = parsePositiveInt(flags.values.get('disk-gb') ?? String(DEFAULT_DISK_GB), 'disk-gb', BigInt(MAX_DISK_GB));
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + plan.timeoutSeconds + BigInt(KILL_GRACE_SECONDS) + 60n;
  const pubKeyPath = flags.values.get('ssh-pubkey');
  const env: Record<string, string> = {};
  if (pubKeyPath !== undefined) {
    const key = (await readFile(pubKeyPath, 'utf8')).trim();
    if (!/^ssh-(ed25519|rsa) /.test(key) && !/^sk-ssh-ed25519@openssh\.com /.test(key)) {
      throw new Error(`ERR_USAGE: ${pubKeyPath} is not an SSH public key`);
    }
    env['PUBLIC_KEY'] = key;
  }
  const body = {
    name: encodePodName(need(flags, 'label'), deadline),
    imageName: flags.values.get('image') ?? DEFAULT_IMAGE,
    gpuTypeIds: [gpu],
    gpuCount: 1,
    cloudType: cloud === 'secure' ? 'SECURE' : 'COMMUNITY',
    interruptible: placement.interruptible,
    containerDiskInGb: Number(diskGb),
    volumeInGb: 0,
    ports: ['22/tcp'],
    supportPublicIp: true,
    env,
    dockerStartCmd: wrapCommand(flags.values.get('cmd'), plan.timeoutSeconds, pubKeyPath !== undefined),
  };
  const pod = (await restOk('POST', '/pods', body)) as PodInfo;
  console.log(`created ${pod.id} (${pod.name})`);
  const actual = pod.costPerHr === undefined ? 0n : parseUsdToMicros(pod.costPerHr);
  if (actual === 0n || actual > ratePerHourMicros) {
    console.error(
      `pod reports ${pod.costPerHr ?? 'no price'}/hr against planned ${formatMicros(ratePerHourMicros)}/hr; terminating`,
    );
    await terminateVerified(pod.id);
    throw new Error('ERR_PRICE_MISMATCH: pod terminated');
  }
}

async function listPods(): Promise<readonly PodInfo[]> {
  return (await restOk('GET', '/pods')) as PodInfo[];
}

async function cmdSweep(flags: Flags): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const pods = await listPods();
  let overdue = 0;
  for (const pod of pods) {
    const deadline = decodePodDeadline(pod.name);
    if (deadline === null) continue;
    if (!isExpired(deadline, now)) continue;
    overdue++;
    console.log(`overdue: ${pod.id} ${pod.name}`);
    if (!flags.switches.has('dry-run')) await terminateVerified(pod.id);
  }
  console.log(`sweep: ${pods.length} pod(s), ${overdue} overdue`);
}

const SSH_WAIT_ATTEMPTS = 60;
const SSH_WAIT_INTERVAL_MS = 10_000;

/** Prints `<ip> <port>` for the pod's SSH port once Runpod has assigned them; fails closed on timeout. */
async function cmdSshTarget(podId: string): Promise<void> {
  for (let attempt = 0; attempt < SSH_WAIT_ATTEMPTS; attempt++) {
    const pod = (await restOk('GET', `/pods/${podId}`)) as PodInfo;
    const port = pod.portMappings?.['22'];
    if (pod.publicIp && port !== undefined) {
      console.log(`${pod.publicIp} ${port}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SSH_WAIT_INTERVAL_MS));
  }
  throw new Error(`ERR_SSH_TARGET_TIMEOUT: pod ${podId} has no public ip/port 22 mapping after ${SSH_WAIT_ATTEMPTS} polls`);
}

async function main(): Promise<void> {
  const [command, ...rest_] = process.argv.slice(2);
  const flags = parseFlags(rest_);
  switch (command) {
    case 'balance':
      console.log(`balance ${formatMicros(await balanceMicros())}`);
      return;
    case 'gpus':
      for (const g of await gpuTypes()) {
        console.log(`${g.id}\t${g.memoryInGb}GB\tsecure ${g.securePrice ?? '-'}\tcommunity ${g.communityPrice ?? '-'}`);
      }
      return;
    case 'plan': {
      const { gpu, kind, placement, cloud, minutes, ratePerHourMicros, plan } = await buildPlan(flags);
      console.log(`${kind} on ${gpu} (${cloud} ${placement.interruptible ? 'spot' : 'on-demand'}) ${minutes.toString()} min @ ${formatMicros(ratePerHourMicros)}/hr`);
      console.log(plan.ok ? `OK worst case ${formatMicros(plan.estimatedMicros)}` : `REFUSED ${plan.code}: ${plan.detail}`);
      process.exitCode = plan.ok ? 0 : 1;
      return;
    }
    case 'create':
      return cmdCreate(flags);
    case 'status':
      for (const p of await listPods()) console.log(`${p.id}\t${p.name}\t${p.desiredStatus ?? '?'}\t${p.costPerHr ?? '?'}/hr`);
      return;
    case 'terminate': {
      const id = flags.positional[0];
      if (id === undefined) throw new Error('ERR_USAGE: terminate <podId>');
      return terminateVerified(id);
    }
    case 'sweep':
      return cmdSweep(flags);
    case 'ssh-target': {
      const id = flags.positional[0];
      if (id === undefined) throw new Error('ERR_USAGE: ssh-target <podId>');
      return cmdSshTarget(id);
    }
    default:
      throw new Error('ERR_USAGE: balance | gpus | plan | create | status | terminate <podId> | sweep | ssh-target <podId>');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
