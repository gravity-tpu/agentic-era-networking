/**
 * scripts/runpod.ts
 * Budget-capped wrapper over the Runpod REST + GraphQL APIs for ephemeral offline jobs
 * (training, bulk local-model evaluation). Pure budget logic lives in src/infra/runpod-budget.ts.
 *
 * Invariant 4: `create` is a dry run unless `--yes` is passed; a person approves each launch.
 * Invariant 3: refuses when the price is unknown, the estimate exceeds the cap or the balance, or the
 *   pod reports a higher hourly price than was planned (it is terminated immediately).
 * Placement (owner policy 2026-10-30): score and sweep run on Community Cloud (on-demand by default: Runpod no longer offers spot; --spot opts in), train on Secure Cloud
 *   on-demand only (src/infra/runpod-budget.ts placementFor); spot runs are capped in length. compile (2026-11-01,
 *   Hailo Dataflow Compiler pipeline) is always a CPU Pod on Secure Cloud: Docker-in-Docker, which the compile
 *   pod needs, is documented as Runpod-CPU-Pod-only, not available on GPU Pods at all.
 * Invariant 5: per-run cap defaults to $5 (RUNPOD_RUN_CAP_USD may lower it; the code ceiling bounds it).
 *
 * The API key is read from RUNPOD_API_KEY and is never printed or passed into a pod. Every pod runs its
 * command under `timeout`, so the container exits (GPU billing stops) even if this tool dies; `sweep`
 * terminates any zodiac-* pod past its deadline.
 *
 * Usage:
 *   node --env-file=.env.local --experimental-strip-types scripts/runpod.ts <command> [flags]
 *   balance | gpus | plan | create | volume-create | status | terminate <podId> | sweep [--dry-run]
 *   plan|create flags: --kind score|sweep|train|compile --minutes <n> --label <s> [--spot] (on-demand is the
 *                      default; --on-demand is accepted; --spot is rejected for train and compile)
 *                      GPU jobs (score|sweep|train): --gpu <id> [--image <ref>] (default: runpod/pytorch CUDA image)
 *                      CPU jobs (compile): --cpu-flavor <id> (e.g. cpu5c) [--vcpu-count <n>] (default 16) --image <ref>
 *                        (required: there is no sensible CPU-Pod default image in this codebase)
 *                      [--cmd <shell>] [--disk-gb <n>] [--cap-usd <n>] [--ssh-pubkey <file>] [--yes]
 *                      [--network-volume-id <id>] [--volume-mount-path <path>] (default /workspace; attaching a
 *                      volume pins the pod to that volume's data center automatically, overriding any GPU/CPU-
 *                      availability assumption -- create may refuse if that data center lacks the requested compute)
 *   volume-create flags: --name <s> --size-gb <n> --datacenter <id> [--yes] -- NOT budget-capped like compute
 *                      time (storage bills separately per GB/month; check current Runpod pricing first) and has
 *                      no `timeout`-enforced end the way a pod does, so a typo here is harder to undo than a
 *                      bad `create`; dry-run by default like every other mutating command, same as `create`.
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
const CATALOG_V2 = 'https://api.runpod.io/v2/catalog';
const DEFAULT_IMAGE = 'runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04';
// CPU Pods (--cpu-flavor) don't take --image at all today: there is no documented CPU-Pod default image in
// this codebase, and the GPU default above bundles CUDA/pytorch a CPU Pod has no use for. --image is required
// when --cpu-flavor is given (see cmdCreate).
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

interface CpuFlavorPrice {
  readonly securePerVcpu: number;
}

/**
 * GET /v2/catalog/cpus/{id} -- a different API version/base than every other call in this file (the v1 REST
 * API this script otherwise uses has no CPU-flavor catalog). Price is per-vCPU, not a flat hourly rate; the
 * caller multiplies by vcpuCount. There is no community-cloud rate for CPU flavors (see runpod-budget.ts's
 * 'compile' JobKind comment), so this is the only rate this script ever reads for a CPU Pod.
 */
async function cpuFlavorPricePerVcpu(flavorId: string): Promise<number> {
  const res = await fetch(`${CATALOG_V2}/cpus/${encodeURIComponent(flavorId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    throw new Error(`ERR_HTTP_${res.status}: GET /v2/catalog/cpus/${flavorId}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { price?: CpuFlavorPrice };
  const price = data.price?.securePerVcpu;
  if (price === undefined) throw new Error(`ERR_UNKNOWN_CPU_FLAVOR: ${flavorId} (no price.securePerVcpu in response)`);
  return price;
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
  if (kind !== 'score' && kind !== 'sweep' && kind !== 'train' && kind !== 'compile') {
    throw new Error('ERR_USAGE: --kind must be score|sweep|train|compile');
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

type ComputeSpec = { readonly computeType: 'GPU'; readonly gpu: string } | { readonly computeType: 'CPU'; readonly cpuFlavor: string; readonly vcpuCount: bigint };

function formatComputeLabel(compute: ComputeSpec): string {
  return compute.computeType === 'GPU' ? compute.gpu : `${compute.cpuFlavor} x${compute.vcpuCount.toString()} vCPU`;
}

const DEFAULT_MAX_VCPU_COUNT = 64; // Runpod's CPU Pod catalog does not document a ceiling; this is an invented,
// disclosed bound (Invariant 5: named, configurable, bounded), not a verified platform limit.
const DEFAULT_VCPU_COUNT = 16n; // DFC needs >=32GB RAM (Hailo's own system-requirements check); most CPU flavor
// groups are ~2GB/vCPU, so 16 vCPUs is a reasonable default -- always confirm against the chosen flavor's
// ramGbPerVcpu (GET /v2/catalog/cpus/{id}) before relying on this for a real run.

/** RUNPOD_MAX_VCPU_COUNT overrides the invented ceiling above if a real flavor turns out to offer more. Checked
 * lazily (not at module load) so a malformed env var surfaces through the normal main().catch error path. */
function maxVcpuCount(): number {
  const raw = process.env['RUNPOD_MAX_VCPU_COUNT'];
  if (raw === undefined) return DEFAULT_MAX_VCPU_COUNT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`ERR_USAGE: RUNPOD_MAX_VCPU_COUNT must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

async function buildPlan(flags: Flags) {
  const { kind, placement } = parsePlacement(flags);
  const cloud = placement.cloud;
  const minutes = parsePositiveInt(need(flags, 'minutes'), 'minutes', 24n * 60n);
  const spotCheck = checkPlacementDuration(placement, minutes * 60n);
  if (!spotCheck.ok) throw new Error(`${spotCheck.code}: ${spotCheck.detail}`);

  const cpuFlavor = flags.values.get('cpu-flavor');
  if (kind === 'compile' && cpuFlavor === undefined) throw new Error('ERR_USAGE: --kind compile requires --cpu-flavor');
  if (kind !== 'compile' && cpuFlavor !== undefined) throw new Error('ERR_USAGE: --cpu-flavor is only valid with --kind compile');
  if (cpuFlavor !== undefined && flags.values.get('gpu') !== undefined) {
    throw new Error('ERR_USAGE: --gpu is not valid with --cpu-flavor (a CPU Pod has no GPU; --gpu would be silently ignored otherwise)');
  }

  let ratePerHourMicros: bigint;
  let compute: ComputeSpec;
  if (cpuFlavor !== undefined) {
    const vcpuCount = parsePositiveInt(flags.values.get('vcpu-count') ?? DEFAULT_VCPU_COUNT.toString(), 'vcpu-count', BigInt(maxVcpuCount()));
    const pricePerVcpu = await cpuFlavorPricePerVcpu(cpuFlavor);
    if (!Number.isFinite(pricePerVcpu) || pricePerVcpu <= 0) {
      throw new Error(`ERR_NO_PRICE: CPU flavor ${cpuFlavor} returned a non-positive or non-finite per-vCPU price (${String(pricePerVcpu)})`);
    }
    // Integer accounting (Invariant 2): convert the per-vCPU price to micros FIRST, then multiply by the
    // (already-BigInt) vCPU count in integer space -- multiplying the two as floats before converting would
    // compound floating-point rounding error into a cost figure that feeds the budget cap. Verified
    // parseUsdToMicros itself is float-free (string/BigInt decimal parsing, no `usd * 1_000_000` anywhere) by
    // reading its implementation above, not assumed -- a pre-push review flagged this as unverifiable "from
    // the diff alone" without checking the function it was reviewing in the same commit.
    ratePerHourMicros = parseUsdToMicros(pricePerVcpu) * vcpuCount;
    compute = { computeType: 'CPU', cpuFlavor, vcpuCount };
  } else {
    const gpu = need(flags, 'gpu');
    const types = await gpuTypes();
    const match = types.find((g) => g.id === gpu);
    if (match === undefined) throw new Error(`ERR_UNKNOWN_GPU: ${gpu}`);
    const price = cloud === 'secure' ? match.securePrice : match.communityPrice;
    ratePerHourMicros = price === null || price === undefined ? 0n : parseUsdToMicros(price);
    compute = { computeType: 'GPU', gpu };
  }

  // The on-demand price of the chosen cloud is the planning price, also for spot: a spot pod costs at most that.
  const plan = planRun({
    capMicros: capMicros(flags),
    ratePerHourMicros,
    balanceMicros: await balanceMicros(),
    requestedSeconds: minutes * 60n,
  });
  return { compute, kind, placement, cloud, minutes, ratePerHourMicros, plan };
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

interface NetworkVolumeInfo {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly dataCenterId: string;
}

// Confirmed 2026-11-01 from Runpod's POST /v1/networkvolumes API reference ("size (integer, required): Size
// in GB, from 0 to 4000") -- a verified platform limit, not an invented bound like DEFAULT_MAX_VCPU_COUNT
// below. If Runpod raises this ceiling later, this constant will go stale; no code here detects that.
const MAX_VOLUME_GB = 4000;

/**
 * Creates a Runpod Network Volume: persistent storage that survives pod termination, unlike the
 * ephemeral container disk every other command here uses. Not budget-capped the way compute time is
 * (src/infra/runpod-budget.ts only models hourly compute spend) -- storage bills separately per GB per
 * month; check the current rate in the Runpod Console before creating a large one. Dry-run by default,
 * like every other mutating command here: a volume has no `timeout`-enforced end the way a pod does, so
 * a mistyped --size-gb or --datacenter here is harder to undo than a bad `create`, not easier.
 */
async function cmdVolumeCreate(flags: Flags): Promise<void> {
  const name = need(flags, 'name');
  const sizeGb = parsePositiveInt(need(flags, 'size-gb'), 'size-gb', BigInt(MAX_VOLUME_GB));
  const dataCenterId = need(flags, 'datacenter');
  console.log(`plan: network volume "${name}", ${sizeGb.toString()}GB, ${dataCenterId} -- billed separately per GB/month (check the Runpod Console for the current rate) and has no automatic end`);
  if (!flags.switches.has('yes')) {
    console.log('dry run: pass --yes to create. A typo here creates a real, persistent, billable resource with no timeout to stop it.');
    return;
  }
  const vol = (await restOk('POST', '/networkvolumes', { name, size: Number(sizeGb), dataCenterId })) as NetworkVolumeInfo;
  console.log(`created network volume ${vol.id} (${vol.name}, ${vol.size}GB, ${vol.dataCenterId})`);
  console.log(`pass --network-volume-id ${vol.id} to 'create' to attach it to a pod (the pod is placed in ${vol.dataCenterId} automatically).`);
}

async function networkVolume(id: string): Promise<NetworkVolumeInfo> {
  return (await restOk('GET', `/networkvolumes/${id}`)) as NetworkVolumeInfo;
}

async function cmdCreate(flags: Flags): Promise<void> {
  const { compute, kind, placement, cloud, minutes, ratePerHourMicros, plan } = await buildPlan(flags);
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.detail}`);
  const computeLabel = formatComputeLabel(compute);
  console.log(
    `plan: ${kind} on ${computeLabel} (${cloud} ${placement.interruptible ? 'spot' : 'on-demand'}) ${minutes.toString()} min @ ${formatMicros(ratePerHourMicros)}/hr -> worst case ${formatMicros(plan.estimatedMicros)} (cap ${formatMicros(capMicros(flags))})`,
  );
  // A network volume is pinned to one data center at creation; the pod must land in that same data
  // center or the attachment is meaningless (an unattached pod would silently get a fresh, empty
  // ephemeral disk instead). Looked up here, not just trusted from a --datacenter flag, so a stale or
  // mistyped flag can't silently create a pod that never actually reaches the cached data.
  // Deliberately runs during dry-run too (before the --yes gate below), same as buildPlan's own GPU-pricing
  // and balance lookups above: "dry run" means no mutation, not zero network calls -- a dry run should
  // surface a bad volume ID before the operator ever commits with --yes, not just a bad GPU/CPU choice.
  const networkVolumeId = flags.values.get('network-volume-id');
  let dataCenterId: string | undefined;
  if (networkVolumeId !== undefined) {
    const vol = await networkVolume(networkVolumeId);
    dataCenterId = vol.dataCenterId;
    console.log(`network volume ${vol.id} is in ${dataCenterId}; pod will be placed there`);
  }
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
  // DEFAULT_IMAGE bundles CUDA/pytorch, which a CPU Pod has no use for and may not even be compatible with;
  // there is no sensible CPU-Pod default in this codebase, so --image is required for --kind compile.
  const imageName = flags.values.get('image') ?? (compute.computeType === 'CPU' ? undefined : DEFAULT_IMAGE);
  if (imageName === undefined) throw new Error('ERR_USAGE: --image is required for --kind compile (no CPU-Pod default image)');
  const body = {
    name: encodePodName(need(flags, 'label'), deadline),
    imageName,
    ...(compute.computeType === 'GPU'
      ? { gpuTypeIds: [compute.gpu], gpuCount: 1 }
      : { computeType: 'CPU', cpuFlavorIds: [compute.cpuFlavor], vcpuCount: Number(compute.vcpuCount) }),
    cloudType: cloud === 'secure' ? 'SECURE' : 'COMMUNITY',
    interruptible: placement.interruptible,
    containerDiskInGb: Number(diskGb),
    volumeInGb: 0,
    ...(networkVolumeId !== undefined ? { networkVolumeId, volumeMountPath: flags.values.get('volume-mount-path') ?? '/workspace' } : {}),
    ...(dataCenterId !== undefined ? { dataCenterIds: [dataCenterId] } : {}),
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
      const { compute, kind, placement, cloud, minutes, ratePerHourMicros, plan } = await buildPlan(flags);
      const computeLabel = formatComputeLabel(compute);
      console.log(`${kind} on ${computeLabel} (${cloud} ${placement.interruptible ? 'spot' : 'on-demand'}) ${minutes.toString()} min @ ${formatMicros(ratePerHourMicros)}/hr`);
      console.log(plan.ok ? `OK worst case ${formatMicros(plan.estimatedMicros)}` : `REFUSED ${plan.code}: ${plan.detail}`);
      process.exitCode = plan.ok ? 0 : 1;
      return;
    }
    case 'create':
      return cmdCreate(flags);
    case 'volume-create':
      return cmdVolumeCreate(flags);
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
      throw new Error('ERR_USAGE: balance | gpus | plan | create | volume-create | status | terminate <podId> | sweep | ssh-target <podId>');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
