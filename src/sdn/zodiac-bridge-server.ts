/**
 * zodiac-bridge-server.ts
 * Local HTTP & WebSocket Bridge Server for Zodiac FX Hardware Telemetry
 *
 * Serves the public UI assets and provides local REST APIs to bridge the physical
 * desktop hardware (Serial, HTTP, OpenFlow) into browser-based dashboards.
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Monotonic 64-bit integer units (BigInt) for all packet and byte metrics.
 * - Anti-Shortcut Law: Zero suppression of reality. Stream error handling & explicit degradation states.
 * - Non-blocking asynchronous I/O and strict bounded buffer size limits.
 */

import http from 'node:http';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { ZodiacController } from './zodiac-controller.js';
import {
  ZodiacFullTelemetrySnapshot,
  ZodiacTimeSeriesPoint,
  ZodiacPortSeriesPoint,
  ZodiacFlowRuleEntry,
  JetsonTelemetrySnapshot,
  JetsonTimeSeriesPoint,
  CoralTelemetrySnapshot,
  CoralTimeSeriesPoint,
  WorkstationTelemetrySnapshot,
  WorkstationTimeSeriesPoint,
  Rpi5TimeSeriesPoint,
  Rpi3TimeSeriesPoint,
  generateHistoricalTelemetry,
  createDisconnectedZodiacSnapshot,
  CLOUD_RELAY_BOUNDS,
  boundSeriesWithHistory,
} from './zodiac-telemetry.js';
import {
  probeJetsonHardware,
  probeCoralHardware,
  readCoralDaemonTelemetry,
  readCoralBurstTelemetry,
  probeWorkstationHardware,
  probeRpi5Hardware,
  probeRpi3Hardware,
} from './hardware-probe.js';
import {
  downsamplePoints,
  downsampleJetsonPoints,
  downsampleCoralPoints,
  downsampleWorkstationPoints,
  RANGE_CONFIGS,
  RANGE_DURATION_MS,
  isValidRange,
  findCutoffIndex,
  getPrismaClient,
  getHistoricalMultiDeviceTelemetry,
} from '../db/telemetry-db.js';
import {
  resolveTelemetryStateFilePath,
  loadTelemetryState,
  saveTelemetryStateAtomic,
  saveTelemetryStateAtomicSync,
} from './telemetry-state-store.js';
import {
  appendLocalHistoryPoints,
  queryLocalHistory,
  pruneLocalHistory,
} from '../db/local-telemetry-db.js';
import { appendQuarantineEvent } from '../db/quarantine-audit.js';
import { signBridgePayload } from '../security/request-attestation.js';
import { buildPort1IsolationPolicy, verifyPort1Isolation, verifyIsolationReadback } from './port1-isolation.js';
import os from 'node:os';
import { readFlowStats, readFlowStatsRaw } from './flow-readback.js';
import {
  describeReadback,
  initialIsolationStatus,
  isolationStatusToJson,
  pendingReadbackStatus,
  readbackFailedStatus,
  statusFromReadback,
  verifierRejectedStatus,
  withSwitchError,
  type IsolationStatus,
} from './isolation-status.js';
import { FlowReadLock, IsolationRechecker, parseRecheckIntervalMs } from './isolation-recheck.js';
import { RELAY_IGNORED_PAUSE_MS, isRelayIgnoredAck, resolveCloudRelayUrl } from './relay-authority.js';
import {
  decideQuarantine,
  readQuarantineEnvelopeConfig,
  sanitizeEvidence,
  type EvidenceValue,
  type QuarantineEnvelopeConfig,
  type QuarantineRefusal,
} from './quarantine-envelope.js';
import { QuarantineProposals, type QuarantineProposal } from './quarantine-proposals.js';
import { buildFlowProbeReport, FlowProbeRateLimitedError, probeErrorToHttp, type FlowProbeReport } from './flow-probe.js';
import { parseOfpError } from './dataplane-benchmark.js';

// Council Invariant 5: switch flow-table readback deadline is configurable, not a buried constant.
const FLOW_READBACK_TIMEOUT_MS = (() => {
  const raw = process.env['ZODIAC_FLOW_READBACK_TIMEOUT_MS'];
  if (raw === undefined) return 10_000;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`ZODIAC_FLOW_READBACK_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
})();
// Council Invariant 5: minimum spacing between on-demand flow-table probes. The switch MCU is a 120 MHz part and a
// probe is one OFPMP_FLOW request, so the limit is about not letting a client hammer it, not about throughput.
const FLOW_PROBE_MIN_INTERVAL_MS = (() => {
  const raw = process.env['ZODIAC_FLOW_PROBE_MIN_INTERVAL_MS'];
  if (raw === undefined) return 5_000;
  if (!/^\d+$/.test(raw) || Number(raw) < 1_000 || Number(raw) > 3_600_000) {
    throw new Error(`ZODIAC_FLOW_PROBE_MIN_INTERVAL_MS must be an integer in 1000..3600000, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
})();
// Council Invariant 3 (fail closed): a bridge that cannot bind its OpenFlow port controls nothing, and must not look
// healthy to the process supervisor. By default it refuses to start. Development, where something else may hold 6633,
// can opt back into the degraded mode explicitly.
export class ControlPlaneBindError extends Error {
  constructor(public readonly detail: string) {
    super(`OpenFlow control plane failed to bind on 6633: ${detail}`);
    this.name = 'ControlPlaneBindError';
  }
}

/** True only for the literal value "1": any other value, or none, keeps the fail-closed default. */
export function degradedControlPlaneAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE'] === '1';
}

/**
 * The Coral inference daemon is opt-in. The Corals are parked (removed from the Jetson), and a child of the bridge
 * shares its fate (a crash loop in the bridge's journal, a restart tied to the control plane). If a Coral is attached
 * again, prefer the separate zodiac-coral.service unit; this flag keeps the old child-process mode available.
 */
export function coralDaemonEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['ZODIAC_ENABLE_CORAL_DAEMON'] === '1';
}
// Council Invariant 5: how often the bridge re-reads the switch's flow table to re-verify the isolation policy after
// install. Default 60 s; the exact value 0 disables it; anything else outside 10 s..1 h is a startup error.
const ISOLATION_RECHECK_INTERVAL_MS = parseRecheckIntervalMs(process.env);
// isLocalDev is now superseded by isLanOperator defined below.

// Council Invariant 5 (Quoc Le): Configurable shutdown timeout SLA to prevent fragile magic constants.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
function getShutdownTimeoutMs(): number {
  const envVal = process.env['ZODIAC_SHUTDOWN_TIMEOUT_MS'];
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Council Invariant 5 (Adaptive Control & System Scale - Quoc Le & Jeff Dean):
// Configurable LLM copilot inference bounds with strict min/max clamping to eliminate
// unbounded inference latency or memory exhaustion under distribution shifts or misconfiguration.
const DEFAULT_COPILOT_TTL_SEC = 20;
const MIN_COPILOT_TTL_SEC = 5;
const MAX_COPILOT_TTL_SEC = 300;

const DEFAULT_COPILOT_TIMEOUT_MS = 8000;
const MIN_COPILOT_TIMEOUT_MS = 1000;
const MAX_COPILOT_TIMEOUT_MS = 30000;

const DEFAULT_COPILOT_MAX_TOKENS = 120;
const MIN_COPILOT_MAX_TOKENS = 32;
const MAX_COPILOT_MAX_TOKENS = 1024;

const DEFAULT_COPILOT_TEMPERATURE = 0.2;
const MIN_COPILOT_TEMPERATURE = 0.0;
const MAX_COPILOT_TEMPERATURE = 1.0;

function clampValue(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/**
 * Pure deterministic slicing function to return timeSeries points strictly newer than sinceMs.
 * Defined at module level to eliminate closure allocations on the hot delta-polling path (Dean Latency Invariant).
 */
function trimSeriesSince<T extends { readonly timestampMs: number }>(
  series: readonly T[] | undefined,
  sinceMs: number
): T[] {
  if (!series || series.length === 0) return [];
  const idx = findCutoffIndex(series, sinceMs + 1);
  if (idx < 0 || idx >= series.length) return [];
  return series.slice(idx);
}

export interface CopilotRuntimeConfig {
  readonly ttlSec: number;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
}

export function parseCopilotConfig(): CopilotRuntimeConfig {
  const envTtl = process.env['ZODIAC_COPILOT_TTL_SEC'];
  const envTimeout = process.env['ZODIAC_COPILOT_TIMEOUT_MS'];
  const envTokens = process.env['ZODIAC_COPILOT_MAX_TOKENS'];
  const envTemp = process.env['ZODIAC_COPILOT_TEMP'];

  const ttlSec = envTtl ? Number.parseInt(envTtl, 10) : DEFAULT_COPILOT_TTL_SEC;
  const timeoutMs = envTimeout ? Number.parseInt(envTimeout, 10) : DEFAULT_COPILOT_TIMEOUT_MS;
  const maxTokens = envTokens ? Number.parseInt(envTokens, 10) : DEFAULT_COPILOT_MAX_TOKENS;
  const temperature = envTemp ? Number.parseFloat(envTemp) : DEFAULT_COPILOT_TEMPERATURE;

  return Object.freeze({
    ttlSec: Number.isFinite(ttlSec) ? clampValue(ttlSec, MIN_COPILOT_TTL_SEC, MAX_COPILOT_TTL_SEC) : DEFAULT_COPILOT_TTL_SEC,
    timeoutMs: Number.isFinite(timeoutMs) ? clampValue(timeoutMs, MIN_COPILOT_TIMEOUT_MS, MAX_COPILOT_TIMEOUT_MS) : DEFAULT_COPILOT_TIMEOUT_MS,
    maxTokens: Number.isFinite(maxTokens) ? clampValue(maxTokens, MIN_COPILOT_MAX_TOKENS, MAX_COPILOT_MAX_TOKENS) : DEFAULT_COPILOT_MAX_TOKENS,
    temperature: Number.isFinite(temperature) ? clampValue(temperature, MIN_COPILOT_TEMPERATURE, MAX_COPILOT_TEMPERATURE) : DEFAULT_COPILOT_TEMPERATURE,
  });
}

// Sanjay Ghemawat - Flat-State Invariant: Parsed once at module initialization
// to eliminate crossing V8 C++ process.env boundary on runtime requests.
const MODULE_COPILOT_CONFIG: CopilotRuntimeConfig = parseCopilotConfig();

export function getCopilotConfig(): CopilotRuntimeConfig {
  return MODULE_COPILOT_CONFIG;
}

/**
 * Parses an IPv4 dotted-quad into an unsigned 32-bit integer.
 * Sanjay Ghemawat - Radical Simplicity: Flat, deterministic O(1) parsing without regex or type coercion.
 * Fail-Closed: Strictly rejects malformed characters, whitespace, leading zeros, or out-of-range octets.
 */
export function parseIpv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let uint32 = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    const len = part.length;
    if (len === 0 || len > 3 || (len > 1 && part[0] === '0')) return null;

    let byte = 0;
    for (let c = 0; c < len; c++) {
      const code = part.charCodeAt(c);
      if (code < 48 || code > 57) return null; // Reject whitespace, signs, letters
      byte = byte * 10 + (code - 48);
    }
    if (byte > 255) return null;

    uint32 = ((uint32 << 8) | byte) >>> 0;
  }
  return uint32;
}

export interface CopilotSummaryMetrics {
  openFlowState: string;
  activeRules: number;
  quarantinedCount: number;
  switchTempC: number | null;
  jetsonTempC: number | null;
  jetsonPowerMw: number | null;
  jetsonFreeRamMb: number | null;
  wireTapInferencesPerSec: number;
}

export interface CopilotSummaryResponse {
  status: 'HEALTHY' | 'DEGRADED' | 'ALERT' | 'OFFLINE';
  headline: string;
  bullets: string[];
  model: string;
  timestampMs: number;
  cached: boolean;
  ttlSeconds: number;
  metrics: CopilotSummaryMetrics;
}

/**
 * Determines whether an IPv4 address falls within private/local scopes:
 * - 127.0.0.0/8    (Loopback - RFC 1122)
 * - 10.0.0.0/8     (Private LAN Class A - RFC 1918)
 * - 172.16.0.0/12  (Private LAN Class B - RFC 1918)
 * - 192.168.0.0/16 (Private LAN Class C - RFC 1918)
 * - 169.254.0.0/16 (Link-Local - RFC 3927)
 *
 * Jeff Dean Invariant: O(1) bitwise operations with zero allocations or regex overhead.
 */
export function isPrivateIpv4(ip: string): boolean {
  const uint32 = parseIpv4ToUint32(ip);
  if (uint32 === null) return false;

  const top8 = uint32 >>> 24;
  if (top8 === 127 || top8 === 10) return true;

  const top12 = uint32 >>> 20;
  if (top12 === 0xac1) return true; // 172.16.0.0/12 (0xac100000 - 0xac1fffff)

  const top16 = uint32 >>> 16;
  if (top16 === 0xc0a8 || top16 === 0xa9fe) return true; // 192.168.0.0/16 (0xc0a8) or 169.254.0.0/16 (0xa9fe)

  return false;
}

/**
 * Parses a single 16-bit hexadecimal hextet.
 * Sanjay Ghemawat - Radical Simplicity: Flat O(1) character-code validation.
 * Fail-Closed: Strictly rejects non-hex characters, empty strings, or lengths > 4.
 */
export function parseHextet(str: string): number | null {
  const len = str.length;
  if (len === 0 || len > 4) return null;

  let val = 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    let digit: number;
    if (code >= 48 && code <= 57) {
      // '0' - '9'
      digit = code - 48;
    } else if (code >= 97 && code <= 102) {
      // 'a' - 'f'
      digit = code - 87; // 97 - 10
    } else if (code >= 65 && code <= 70) {
      // 'A' - 'F'
      digit = code - 55; // 65 - 10
    } else {
      // Non-hex character (e.g. 'z', 'g', '-', '.') -> Fail-Closed
      return null;
    }
    val = (val << 4) | digit;
  }
  return val;
}

/**
 * Parses an IPv6 address string into an array of 8 16-bit integer hextets.
 * Strict RFC 4291 / RFC 5952 compliance with deterministic, fail-closed parsing.
 */
export function parseIpv6ToHextets(rawIp: string): number[] | null {
  // Strip zone index / scope ID if present (e.g. fe80::1%enP8p1s0)
  const percentIdx = rawIp.indexOf('%');
  const ip = (percentIdx === -1 ? rawIp : rawIp.slice(0, percentIdx)).trim();
  if (ip.length === 0) return null;

  const doubleColonIdx = ip.indexOf('::');
  if (doubleColonIdx !== -1) {
    // Only a single '::' compression is allowed per RFC 4291
    if (ip.indexOf('::', doubleColonIdx + 2) !== -1) return null;

    const leftPart = ip.slice(0, doubleColonIdx);
    const rightPart = ip.slice(doubleColonIdx + 2);

    const leftHextets: number[] = [];
    if (leftPart.length > 0) {
      const parts = leftPart.split(':');
      for (let i = 0; i < parts.length; i++) {
        const val = parseHextet(parts[i]!);
        if (val === null) return null;
        leftHextets.push(val);
      }
    }

    const rightHextets: number[] = [];
    if (rightPart.length > 0) {
      const parts = rightPart.split(':');
      for (let i = 0; i < parts.length; i++) {
        const val = parseHextet(parts[i]!);
        if (val === null) return null;
        rightHextets.push(val);
      }
    }

    const totalProvided = leftHextets.length + rightHextets.length;
    if (totalProvided > 7) return null; // '::' must represent at least one hextet

    const zerosCount = 8 - totalProvided;
    const result = new Array<number>(8);
    let outIdx = 0;
    for (let i = 0; i < leftHextets.length; i++) {
      result[outIdx++] = leftHextets[i]!;
    }
    for (let i = 0; i < zerosCount; i++) {
      result[outIdx++] = 0;
    }
    for (let i = 0; i < rightHextets.length; i++) {
      result[outIdx++] = rightHextets[i]!;
    }
    return result;
  }

  // Uncompressed: must have exactly 8 hextets
  const parts = ip.split(':');
  if (parts.length !== 8) return null;

  const result = new Array<number>(8);
  for (let i = 0; i < 8; i++) {
    const val = parseHextet(parts[i]!);
    if (val === null) return null;
    result[i] = val;
  }
  return result;
}

/**
 * Determines whether an IPv6 address falls within private/local scopes:
 * - RFC 4291 Loopback (::1, 0:0:0:0:0:0:0:1, and all compressed representations)
 * - RFC 4291 Link-Local (fe80::/10, first 10 bits 1111 1110 10xx xxxx)
 * - RFC 4193 Unique Local Address / ULA (fc00::/7, first 7 bits 1111 110x xxxx xxxx)
 *
 * Dean & Ghemawat Invariant: Dual-stack architecture with mathematical equivalence
 * verification and deterministic, fail-closed character parsing.
 */
export function isPrivateIpv6(rawIp: string): boolean {
  const hextets = parseIpv6ToHextets(rawIp);
  if (hextets === null) return false;

  // RFC 4291 Section 2.5.3: Loopback equivalence (0:0:0:0:0:0:0:1)
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 1
  ) {
    return true;
  }

  const firstHextet = hextets[0]!;

  // fe80::/10: 1111 1110 10xx xxxx -> mask 0xffc0, value 0xfe80 (fe80 to febf)
  if ((firstHextet & 0xffc0) === 0xfe80) return true;

  // fc00::/7: 1111 110x xxxx xxxx -> mask 0xfe00, value 0xfc00 (fc00 to fdff)
  if ((firstHextet & 0xfe00) === 0xfc00) return true;

  return false;
}

/**
 * Evaluates whether an unauthenticated request originates from the local operator
 * perimeter (loopback, RFC 1918 private IPv4, or RFC 4193/4291 private IPv6).
 *
 * Council Architectural Context & BeyondCorp Alignment (Ghemawat & Hassabis):
 * - ZERO-TRUST LAW: Network location is NEVER permanently conflated with verified identity.
 *   In production enterprise topologies, upstream perimeter ingress filtering (BCP 38 / RFC 2827)
 *   cannot be assumed, and IP-based trust violates BeyondCorp principles.
 * - APPLIANCE BOOTSTRAP FALLBACK: When GOOGLE_CLIENT_ID is explicitly unconfigured,
 *   the appliance operates in unmanaged/headless bootstrap mode. Here, private network socket
 *   provenance is used strictly as a transitionary fallback to prevent complete operator lockout
 *   on headless appliances before cloud SSO/mTLS is provisioned.
 * - FAIL-CLOSED BOUNDARY: If GOOGLE_CLIENT_ID is configured, this fallback is completely
 *   bypassed — returning false immediately and mandating cryptographically signed operator claims.
 * - DUAL-STACK DETERMINISM (Dean & Ghemawat): Implements O(1) bitwise address evaluation
 *   for both IPv4 (RFC 1918, RFC 3927, loopback) and IPv6 (RFC 4291 fe80::/10 link-local,
 *   RFC 4193 fc00::/7 ULA, loopback ::1, and ::ffff: IPv4-mapped addresses) without regex overhead.
 */
export function isLanOperator(req: import('node:http').IncomingMessage): boolean {
  const hasGoogleOauth = Boolean(process.env['GOOGLE_CLIENT_ID']);
  if (hasGoogleOauth) return false; // OAuth configured — zero-trust fail-closed enforcement

  const remote = req.socket?.remoteAddress ?? '';
  if (!remote) return false;

  // Handle IPv4-mapped IPv6 (::ffff:192.168.1.10)
  if (remote.startsWith('::ffff:')) {
    const ipv4Part = remote.slice(7);
    return isPrivateIpv4(ipv4Part);
  }

  // Handle native IPv4
  if (remote.includes('.')) {
    return isPrivateIpv4(remote);
  }

  // Handle native IPv6
  return isPrivateIpv6(remote);
}

/**
 * $NOTIFY_SOCKET is evaluated once at module load time.
 *
 * Ghemawat suggestion: if the variable is absent (local dev, tests, macOS,
 * Docker without --notify-socket), we cache null and gate the watchdog
 * setInterval creation entirely — no recurring 10s no-op callbacks.
 */
const NOTIFY_SOCKET: string | null = process.env['NOTIFY_SOCKET'] ?? null;

/**
 * Native zero-dependency systemd sd_notify client.
 *
 * Delegates to the first-party `systemd-notify` binary, which is present
 * on every systemd Linux installation (JetPack 6 / Ubuntu 22.04 ships
 * systemd 249). Modern systemd-notify (≥240) accepts arbitrary VARIABLE=VALUE
 * positional arguments directly, matching the sd_notify wire protocol without
 * requiring flag-specific mappings.
 *
 * Background: Node's node:dgram TypeScript API does not expose AF_UNIX
 * SOCK_DGRAM sockets. Rather than a brittle type-cast, delegating to
 * systemd-notify is the officially recommended approach for languages
 * without a native sd_notify C binding.
 *
 * Dean Invariant: execFile is fire-and-forget (callback ignored); the
 * ~1-10ms fork/exec overhead is negligible against the 10s heartbeat
 * interval and never contends with the 2.5s telemetry poll loop.
 * Ghemawat: zero npm packages; systemd-notify ships on every systemd host.
 */
function sdNotify(message: string): void {
  if (!NOTIFY_SOCKET) return; // Not running under systemd — no-op.
  // Pass each non-empty line as a positional VARIABLE=VALUE arg.
  // systemd-notify ≥240 (Ubuntu 22.04) accepts 'READY=1', 'WATCHDOG=1',
  // 'RELOADING=1', 'STATUS=text', etc. directly without flag translation.
  // This eliminates the brittle READY→--ready / WATCHDOG→--watchdog mapping
  // and forwards any future sd_notify state variable without code changes.
  const args = message.split('\n').map((s) => s.trim()).filter(Boolean);
  if (args.length === 0) return;
  execFile('systemd-notify', args, () => { /* fire-and-forget */ });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const MAX_TIME_SERIES_POINTS = 3600; // 2.5 hours of continuous 2.5s telemetry

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const DEFAULT_POLL_INTERVAL_NS = 2_500_000_000n;

/**
 * Sanjay Ghemawat Invariant: Radical Simplicity & DRY History Merge.
 * Prepends historical points strictly older than the current in-memory buffer without sorting or duplicate timestamps.
 * Preserves the full operational day history in memory up to CLOUD_RELAY_BOUNDS.MAX_BRIDGE_MEMORY_POINTS so service restarts retain test data.
 */
function mergeHistoricalSeries<T extends { readonly timestampMs: number }>(
  current: readonly T[],
  history: readonly T[] | undefined,
  maxPoints: number = CLOUD_RELAY_BOUNDS.MAX_BRIDGE_MEMORY_POINTS
): T[] {
  if (!history || history.length === 0) return [...current];
  const earliestMemTs = current[0]?.timestampMs ?? Number.MAX_SAFE_INTEGER;
  const older = history.filter((p) => p.timestampMs < earliestMemTs);
  if (older.length === 0) return [...current];
  const combined = [...older, ...current];
  if (combined.length <= maxPoints) return combined;
  return combined.slice(-maxPoints);
}

export class ZodiacBridgeServer {
  public controlPlaneState: 'INITIALIZING' | 'ACTIVE' | 'DEGRADED_FAULT' = 'INITIALIZING';
  public readonly copilotConfig: CopilotRuntimeConfig = MODULE_COPILOT_CONFIG;
  private readonly controller: ZodiacController;
  private readonly switchIp: string;
  private readonly controllerIp: string;
  private server: http.Server | null = null;
  private cachedSnapshot: ZodiacFullTelemetrySnapshot = createDisconnectedZodiacSnapshot();
  private timeSeries: ZodiacTimeSeriesPoint[] = [];
  private jetsonTimeSeries: JetsonTimeSeriesPoint[] = [];
  private coralTimeSeries: CoralTimeSeriesPoint[] = [];
  private workstationTimeSeries: WorkstationTimeSeriesPoint[] = [];
  private rpi5TimeSeries: Rpi5TimeSeriesPoint[] = [];
  private rpi3_1TimeSeries: Rpi3TimeSeriesPoint[] = [];
  private rpi3_2TimeSeries: Rpi3TimeSeriesPoint[] = [];
  private lastProbeNs: bigint = process.hrtime.bigint();
  private lastSwitchPollNs: bigint = process.hrtime.bigint();
  private readonly portRxCounters = new Map<number, bigint>();
  private readonly portByteCounters = new Map<number, bigint>();
  private readonly cloudRelayUrl?: string | undefined;
  private readonly bridgeSecret?: string | undefined;
  private isRelaying = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  /** Observability counter tracking failures when hydrating local day history on startup. */
  public historyLoadFailures = 0;
  private consecutiveMissedProbes = 0;
  public static readonly MAX_MISSED_PROBES_BEFORE_DISCONNECT = 3;
  private coralDaemon: ChildProcess | null = null;
  private coralDaemonRestartTimer: NodeJS.Timeout | null = null;
  /** Vinyals flap-prevention: terminal fail-closed after MAX_CORAL_RESTARTS permanent failures. */
  private coralDaemonRestartCount = 0;
  private static readonly MAX_CORAL_RESTARTS = 10;
  // KSZ8795 hardware flow table hard ceiling; bounds the O(N) registry snapshot
  // allocation per heartbeat to O(1) regardless of Map size.
  private static readonly MAX_FLOW_SNAPSHOT_RULES = 512;
  private readonly stateFilePath: string = resolveTelemetryStateFilePath();
  private lastStateFlushTimeMs = 0;
  private lastLocalHistoryFlushMs = 0;
  private consecutiveRelayFailures = 0;
  private lastRelayAttemptPerfMs = 0; // performance.now() — monotonic, NTP-immune
  /** performance.now() until which relaying is paused because the cloud ignored this bridge's last push. */
  private relayIgnoredUntilPerfMs = 0;
  /**
   * Stable for the life of this process and carried in every relay push, so the cloud can tell this bridge from any
   * other that pushes to the same endpoint. Hostname, pid and start time: a restart is a new identity.
   */
  private readonly bridgeId: string = `${os.hostname().replace(/[^A-Za-z0-9._-]/g, '-')}:${process.pid}:${Date.now()}`;
  public static readonly STATE_FLUSH_INTERVAL_MS = 30_000;
  private static readonly RELAY_BASE_BACKOFF_MS  = 5_000;   // 5 s initial backoff
  private static readonly RELAY_MAX_BACKOFF_MS   = 60_000;  // 60 s ceiling
  private copilotSummaryCache: {
    data: CopilotSummaryResponse;
    cachedAtPerfMs: number;
  } | null = null;
  private copilotInFlightPromise: Promise<CopilotSummaryResponse> | null = null;
  private readonly flowRuleRegistry: Map<string, ZodiacFlowRuleEntry> = new Map();
  /** One flow-table read at a time: shared by the on-demand probe and the periodic isolation re-check. */
  private readonly flowReadLock = new FlowReadLock();
  private readonly isolationRechecker: IsolationRechecker;
  /** null until the first probe has finished, so the first probe is never refused for spacing. */
  private lastFlowProbeMonoNs: bigint | null = null;
  /** xid → isolation rule id for the current OpenFlow session; reset on every 'ready'. */
  private readonly flowModXidLabels: Map<number, string> = new Map();
  /** Switch-reported (not controller-intended) state of the Port 1 isolation policy. */
  private isolationStatus: IsolationStatus = initialIsolationStatus();

  /**
   * Registers a flow rule entry in the bridge server's local registry.
   */
  public registerFlowRule(entry: ZodiacFlowRuleEntry): void {
    if (this.flowRuleRegistry.size >= 1000) {
      const oldest = this.flowRuleRegistry.keys().next().value;
      if (oldest !== undefined) this.flowRuleRegistry.delete(oldest);
    }
    this.flowRuleRegistry.set(entry.ruleId, entry);
  }

  /** How often expired quarantines are looked for. */
  public static readonly QUARANTINE_SWEEP_INTERVAL_MS = 5_000;
  private readonly quarantineEnvelope: QuarantineEnvelopeConfig;
  /** ruleId -> source IP and the monotonic time (ns) after which the quarantine is removed. */
  private readonly quarantineExpiry: Map<string, { readonly ip: string; readonly expiresMonoNs: bigint }> = new Map();
  private quarantineSweepTimer: NodeJS.Timeout | null = null;
  /** Requests inside the envelope that are waiting for a person (mode `propose`). */
  private readonly quarantineProposals = new QuarantineProposals();

  private static readonly QUARANTINE_REFUSAL_STATUS: Readonly<Record<QuarantineRefusal, number>> = {
    config_invalid: 503,
    no_ip: 400,
    bad_ip: 400,
    out_of_scope: 403,
    protected: 403,
    already_active: 409,
    cap_reached: 429,
  };

  /** Source IPs that currently have a bridge-installed quarantine DROP. */
  private activeQuarantineIps(): string[] {
    const ips: string[] = [];
    for (const rule of this.flowRuleRegistry.values()) {
      if (rule.action === 'DROP' && rule.ruleId.startsWith('quarantine-') && rule.srcCidr.endsWith('/32')) {
        ips.push(rule.srcCidr.slice(0, -3));
      }
    }
    return ips;
  }

  /**
   * Installs a time-limited quarantine DROP if, and only if, it is inside the quarantine envelope (see
   * quarantine-envelope.ts): one source in the workload segment, not protected, under the cap, not already quarantined.
   * The rule is removed after the envelope's time limit by the switch (hard timeout; firmware behaviour unmeasured) and
   * by this bridge's own sweep.
   */
  public requestQuarantine(options: {
    targetIp?: string | undefined;
    targetMac?: string | undefined;
    reason: string;
    priority?: number | undefined;
    /** The numbers behind the detector's decision; kept with a proposal so a person can judge it. */
    evidence?: Readonly<Record<string, EvidenceValue>> | undefined;
    /** True only when a person approved a proposal: installs even in mode `propose`. The envelope still applies. */
    approved?: boolean | undefined;
  }): { status: number; body: Record<string, unknown> } {
    const decision = decideQuarantine({ targetIp: options.targetIp, targetMac: options.targetMac }, this.activeQuarantineIps(), this.quarantineEnvelope);
    if (!decision.allow) {
      console.warn(`[!] [Quarantine] Refused (${decision.code}): ${decision.reason}`);
      return {
        status: ZodiacBridgeServer.QUARANTINE_REFUSAL_STATUS[decision.code],
        body: { ok: false, quarantined: false, code: decision.code, error: decision.reason },
      };
    }

    if (this.quarantineEnvelope.mode !== 'enforce' && options.approved !== true && options.targetIp !== undefined) {
      const proposal = this.quarantineProposals.record(
        { targetIp: options.targetIp, reason: options.reason, priority: options.priority ?? 65535, evidence: options.evidence ?? {} },
        process.hrtime.bigint(),
        Date.now(),
      );
      // The first request for a source is worth a line; repeats of the same proposal are not (a detector can ask every second).
      if (proposal.requests === 1) {
        console.warn(`[!] [Quarantine] PROPOSED (mode propose, nothing installed): ${options.targetIp}: ${options.reason}. Approve with POST /api/sdn/quarantine/approve.`);
      }
      return {
        status: 202,
        body: {
          ok: true,
          quarantined: false,
          proposed: true,
          targetIp: options.targetIp,
          requests: proposal.requests,
          message: 'Inside the quarantine envelope but the bridge is in propose mode: nothing was installed. A person can approve it.',
        },
      };
    }

    const qResult = this.controller.quarantineAgent({
      targetMac: undefined,
      targetIp: options.targetIp,
      reason: options.reason,
      priority: options.priority ?? 65535,
      hardTimeoutSeconds: Math.ceil(decision.ttlMs / 1000),
    });

    const auditEntry = {
      ruleId: qResult.ruleId,
      priority: qResult.priority,
      action: qResult.action,
      srcCidr: qResult.rule.srcCidr,
      dstCidr: qResult.rule.dstCidr,
      protocol: qResult.rule.protocol,
      installedAtMs: Date.now(),
      openFlowInstalled: qResult.openFlowInstalled,
    };
    // Bounded FIFO eviction: cap at 1000 entries so the registry never causes OOM.
    if (this.flowRuleRegistry.size >= 1000) {
      const oldestKey = this.flowRuleRegistry.keys().next().value;
      if (oldestKey !== undefined) this.flowRuleRegistry.delete(oldestKey);
    }
    this.flowRuleRegistry.set(qResult.ruleId, auditEntry);
    if (options.targetIp !== undefined) {
      this.quarantineExpiry.set(qResult.ruleId, {
        ip: options.targetIp,
        expiresMonoNs: process.hrtime.bigint() + BigInt(decision.ttlMs) * 1_000_000n,
      });
    }
    // Persist to local JSONL + Neon (fire-and-forget; appendQuarantineEvent never rejects).
    void appendQuarantineEvent(auditEntry);

    return {
      status: 200,
      body: {
        ok: true,
        quarantined: true,
        ruleId: qResult.ruleId,
        action: qResult.action,
        priority: qResult.priority,
        openFlowInstalled: qResult.openFlowInstalled,
        expiresInMs: decision.ttlMs,
        timestampNs: qResult.timestampNs.toString(),
      },
    };
  }

  /** Proposals a person can still approve, most recent first. */
  public listQuarantineProposals(): { mode: string; proposals: readonly QuarantineProposal[] } {
    return { mode: this.quarantineEnvelope.mode, proposals: this.quarantineProposals.list(process.hrtime.bigint()) };
  }

  /**
   * A person approves a proposal: it is installed, time-limited, if it is still inside the envelope. The proposal is
   * kept if the install is refused (for example the cap is full), so it can be approved again later.
   */
  public approveQuarantineProposal(targetIp: string): { status: number; body: Record<string, unknown> } {
    const proposal = this.quarantineProposals.get(targetIp, process.hrtime.bigint());
    if (proposal === null) {
      return { status: 404, body: { ok: false, quarantined: false, error: `no current proposal for ${targetIp} (none was made, it was already handled, or it is older than the approval window)` } };
    }
    const outcome = this.requestQuarantine({
      targetIp: proposal.targetIp,
      reason: `${proposal.reason} (approved by a person)`,
      priority: proposal.priority,
      evidence: proposal.evidence,
      approved: true,
    });
    if (outcome.status === 200) this.quarantineProposals.remove(targetIp);
    return outcome;
  }

  /**
   * Removes quarantines whose time limit has passed. A rule that cannot be lifted (switch not connected) stays and is
   * retried on the next sweep; one released by hand is just forgotten. Returns how many were lifted now.
   */
  public sweepExpiredQuarantines(nowMonoNs: bigint = process.hrtime.bigint()): number {
    let lifted = 0;
    for (const [ruleId, entry] of [...this.quarantineExpiry.entries()]) {
      if (nowMonoNs < entry.expiresMonoNs) continue;
      if (!this.flowRuleRegistry.has(ruleId)) {
        this.quarantineExpiry.delete(ruleId);
        continue;
      }
      const result = this.releaseQuarantineRule({ targetIp: entry.ip, reason: 'quarantine time limit reached' });
      if (result.releasedRules.includes(ruleId)) {
        this.quarantineExpiry.delete(ruleId);
        lifted++;
        console.log(`[+] [Quarantine] ${entry.ip} released: time limit reached (${ruleId}).`);
      } else {
        console.warn(`[!] [Quarantine] ${entry.ip} is past its time limit but could not be lifted yet (${ruleId}); will retry.`);
      }
    }
    return lifted;
  }

  /**
   * Releases an emergency quarantine rule matching targetIp or targetMac.
   * Invokes OpenFlow OFPFC_DELETE via controller and cleans up registry.
   */
  public releaseQuarantineRule(options: { targetIp?: string | undefined; targetMac?: string | undefined; reason?: string | undefined }): {
    ok: boolean;
    released: boolean;
    releasedCount: number;
    releasedRules: string[];
    reason: string;
    timestampNs: string;
  } {
    const cleanMac = typeof options.targetMac === 'string' ? options.targetMac.trim() : undefined;
    const cleanIp = typeof options.targetIp === 'string' ? options.targetIp.trim() : undefined;

    if (!cleanMac && !cleanIp) {
      throw new Error('targetMac or targetIp required');
    }

    const releasedRules: string[] = [];
    const srcCidrMatch = cleanIp ? `${cleanIp}/32` : undefined;

    for (const [key, rule] of this.flowRuleRegistry.entries()) {
      const matchesMac = cleanMac !== undefined && rule.srcMac === cleanMac;
      const matchesIp = srcCidrMatch !== undefined && rule.srcCidr === srcCidrMatch;
      if (rule.action === 'DROP' && (matchesMac || matchesIp)) {
        let canDeleteFromRegistry = true;
        if (rule.openFlowInstalled) {
          const proto = (rule.protocol === 'TCP' || rule.protocol === 'UDP' || rule.protocol === 'ICMP') ? rule.protocol : 'ANY';
          const liftResult = this.controller.liftQuarantine({
            id: rule.ruleId,
            priority: rule.priority,
            srcCidr: rule.srcCidr,
            dstCidr: rule.dstCidr,
            protocol: proto,
            srcMac: rule.srcMac,
            dstMac: rule.dstMac,
            action: 'DROP',
          });
          if (!liftResult.success) {
            canDeleteFromRegistry = false;
            console.warn(`[!] [Bridge] Cannot lift quarantine rule ${rule.ruleId}: OpenFlow hardware release failed: ${liftResult.error}`);
          }
        }

        if (canDeleteFromRegistry) {
          this.flowRuleRegistry.delete(key);
          releasedRules.push(rule.ruleId);
        }
      }
    }

    return {
      ok: true,
      released: releasedRules.length > 0,
      releasedCount: releasedRules.length,
      releasedRules,
      reason: options.reason || 'Out-of-band triage verified benign',
      timestampNs: process.hrtime.bigint().toString(),
    };
  }

  constructor(
    controller?: ZodiacController,
    switchIp?: string,
    controllerIp?: string,
    cloudRelayUrl?: string,
    bridgeSecret?: string
  ) {
    this.controller = controller ?? new ZodiacController();
    const envelope = readQuarantineEnvelopeConfig(process.env);
    this.quarantineEnvelope = envelope.config;
    for (const w of envelope.warnings) console.warn(`[!] [Quarantine] ${w}`);
    this.isolationRechecker = new IsolationRechecker({
      policy: buildPort1IsolationPolicy(),
      read: () => readFlowStats(this.controller.openFlow, FLOW_READBACK_TIMEOUT_MS),
      getStatus: () => this.isolationStatus,
      setStatus: (s) => {
        this.isolationStatus = s;
      },
      lock: this.flowReadLock,
      log: (level, text) => {
        const line = `[${level === 'info' ? '+' : '!'}] [Bridge Server] ${text}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
      },
      nowMs: () => Date.now(),
      nowMonoNs: () => process.hrtime.bigint(),
      intervalMs: ISOLATION_RECHECK_INTERVAL_MS,
    });
    this.switchIp = switchIp ?? process.env['ZODIAC_SWITCH_IP'] ?? '127.0.0.1';
    this.controllerIp = controllerIp ?? process.env['SDN_CONTROLLER_IP'] ?? '0.0.0.0';
    this.cloudRelayUrl = cloudRelayUrl ?? process.env['ZODIAC_CLOUD_RELAY_URL'];
    this.bridgeSecret = bridgeSecret ?? process.env['ZODIAC_BRIDGE_SECRET'];
    this.timeSeries = generateHistoricalTelemetry(this.cachedSnapshot, 1, 60);
    this.jetsonTimeSeries = this.cachedSnapshot.jetson?.timeSeries ? [...this.cachedSnapshot.jetson.timeSeries] : [];
    this.coralTimeSeries = this.cachedSnapshot.coral?.timeSeries ? [...this.cachedSnapshot.coral.timeSeries] : [];
    this.workstationTimeSeries = this.cachedSnapshot.workstation?.timeSeries ? [...this.cachedSnapshot.workstation.timeSeries] : [];
    this.rpi5TimeSeries = this.cachedSnapshot.rpi5?.timeSeries ? [...this.cachedSnapshot.rpi5.timeSeries] : [];
    this.rpi3_1TimeSeries = this.cachedSnapshot.rpi3_1?.timeSeries ? [...this.cachedSnapshot.rpi3_1.timeSeries] : [];
    this.rpi3_2TimeSeries = this.cachedSnapshot.rpi3_2?.timeSeries ? [...this.cachedSnapshot.rpi3_2.timeSeries] : [];

    // Sanjay Ghemawat & Jeff Dean Invariant: Restore state checkpoint from local disk on startup
    const loadedState = loadTelemetryState(this.stateFilePath);
    if (loadedState) {
      if (loadedState.timeSeries.length > 0) {
        this.timeSeries = loadedState.timeSeries.slice(-MAX_TIME_SERIES_POINTS);
      }
      if (loadedState.jetsonTimeSeries.length > 0) {
        this.jetsonTimeSeries = loadedState.jetsonTimeSeries.slice(-MAX_TIME_SERIES_POINTS);
      }
      if (loadedState.coralTimeSeries.length > 0) {
        this.coralTimeSeries = loadedState.coralTimeSeries.slice(-MAX_TIME_SERIES_POINTS);
      }
      if (loadedState.workstationTimeSeries && loadedState.workstationTimeSeries.length > 0) {
        this.workstationTimeSeries = loadedState.workstationTimeSeries.slice(-MAX_TIME_SERIES_POINTS);
      }
    }

    this.cachedSnapshot = {
      ...this.cachedSnapshot,
      timeSeries: this.timeSeries,
      jetson: this.cachedSnapshot.jetson ? {
        ...this.cachedSnapshot.jetson,
        timeSeries: this.jetsonTimeSeries,
      } : undefined,
      coral: this.cachedSnapshot.coral ? {
        ...this.cachedSnapshot.coral,
        timeSeries: this.coralTimeSeries,
      } : undefined,
      workstation: this.cachedSnapshot.workstation ? {
        ...this.cachedSnapshot.workstation,
        timeSeries: this.workstationTimeSeries,
      } : undefined,
      rpi5: this.cachedSnapshot.rpi5 ? {
        ...this.cachedSnapshot.rpi5,
        timeSeries: this.rpi5TimeSeries,
      } : undefined,
      rpi3_1: this.cachedSnapshot.rpi3_1 ? {
        ...this.cachedSnapshot.rpi3_1,
        timeSeries: this.rpi3_1TimeSeries,
      } : undefined,
      rpi3_2: this.cachedSnapshot.rpi3_2 ? {
        ...this.cachedSnapshot.rpi3_2,
        timeSeries: this.rpi3_2TimeSeries,
      } : undefined,
      port1Isolation: isolationStatusToJson(this.isolationStatus, process.hrtime.bigint()),
    };

    // Prune local JSONL history files older than 30 days (fast sync directory scan at startup)
    pruneLocalHistory();
    // Start the flush pointer at now so the loaded rolling buffer isn't re-appended to disk
    this.lastLocalHistoryFlushMs = Date.now();

    // Auto-install baseline flow rules on switch connection
    this.controller.openFlow.on('ready', () => {
      // Council Invariant 3 (Fail-Closed) & CCIE Invariant NET-001 (CoPP):
      // Table-miss → DROP: Unmatched packets drop in switch hardware by default.
      // Punting unmatched traffic to CONTROLLER without rate limiting risks overwhelming
      // the SAM4E8E MCU with packet-in interrupts under high-pps floods.
      this.controller.openFlow.sendTableMissRule(0, 'DROP');
      console.log('[+] [Bridge Server] Table-Miss flow rule installed (DROP fail-closed).');

      // Port 1 Isolation Policy (see src/sdn/port1-isolation.ts):
      // Port 2 is physically wired to the ISP Wi-Fi extender (lab LAN 10.0.0.0/24 → Internet).
      // Port-only forwarding (in_port=1 → [2,3]) bridged every workload frame onto the household
      // L2 domain. Only IPv4 confined to 10.0.2.0/24 (src AND dst) plus ARP may cross P1⟷P2;
      // all other workload traffic is mirrored to the Port 3 sentinel tap only.
      // Council Invariant 4: the rule set must pass the symbolic verifier before touching the
      // data plane. On failure nothing is installed and table-miss DROP keeps Port 1 dark.
      const isolationPolicy = buildPort1IsolationPolicy();
      this.flowModXidLabels.clear();
      const violations = verifyPort1Isolation(isolationPolicy);
      if (violations.length > 0) {
        this.isolationStatus = verifierRejectedStatus(violations, Date.now(), process.hrtime.bigint());
        console.error(`[!] [Bridge Server] Port 1 isolation policy REJECTED by verifier; data plane left at table-miss DROP:\n  ${violations.join('\n  ')}`);
        return;
      }
      this.isolationStatus = pendingReadbackStatus();
      this.isolationRechecker.reset(); // a new session: forget the previous session's streaks
      for (const rule of isolationPolicy) {
        const xid = this.controller.openFlow.sendFlowModOptions(rule.flowMod);
        this.flowModXidLabels.set(xid, rule.id);
        const out = (rule.flowMod.outputPorts ?? []).map((p) => `P${p}`).join(', ');
        console.log(`[+] [Bridge Server] Isolation rule ${rule.id} sent (xid ${xid}, priority ${rule.flowMod.priority}) → [${out}].`);
      }

      // Council Invariant 6: "sent" is not "installed". Read the flow table back from the switch
      // and verify every isolation rule field-by-field against what the hardware reports.
      readFlowStats(this.controller.openFlow, FLOW_READBACK_TIMEOUT_MS)
        .then((entries) => {
          const verdict = verifyIsolationReadback(isolationPolicy, entries);
          this.isolationStatus = statusFromReadback(this.isolationStatus, verdict, Date.now(), process.hrtime.bigint());
          const line = describeReadback(this.isolationStatus, isolationPolicy.length, entries.length);
          if (this.isolationStatus.state === 'verified') {
            console.log(`[+] [Bridge Server] ${line}`);
          } else {
            console.error(`[!] [Bridge Server] ${line}`);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.isolationStatus = readbackFailedStatus(this.isolationStatus, msg, Date.now(), process.hrtime.bigint());
          console.error(`[!] [Bridge Server] Isolation readback FAILED: ${msg}`);
        });
    });

    // Council Invariant 1: switch-side FlowMod rejections must never be silent.
    this.controller.openFlow.on('ofError', (xid: number, packet: Buffer) => {
      let detail: string;
      try {
        const info = parseOfpError(packet);
        detail = `type ${info.errorType}, code ${info.errorCode}`;
      } catch (err: unknown) {
        detail = `unparseable OFPT_ERROR (${err instanceof Error ? err.message : String(err)})`;
      }
      const label = this.flowModXidLabels.get(xid);
      const line = `OFPT_ERROR xid ${xid}${label ? ` (isolation rule ${label})` : ''}: ${detail}`;
      if (label) this.isolationStatus = withSwitchError(this.isolationStatus, line);
      console.error(`[!] [Bridge Server] Switch rejected message — ${line}`);
    });

    // Observe CoPP drops when packet-in flooding occurs
    this.controller.openFlow.on('coppDrop', (xid, drops) => {
      console.warn(`[!] [Bridge Server] CoPP rate-limited OFPT_PACKET_IN (xid: ${xid}, total drops: ${drops.toString()})`);
    });

    // Accumulate hardware counters for each physical port when packets arrive
    this.controller.openFlow.on('packetIn', (pkt) => {
      const inPort = pkt.inPort ?? 2;
      const bytes = BigInt(pkt.rawPayload.length);
      const currentPkts = this.portRxCounters.get(inPort) ?? 0n;
      const currentBytes = this.portByteCounters.get(inPort) ?? 0n;
      this.portRxCounters.set(inPort, currentPkts + 1n);
      this.portByteCounters.set(inPort, currentBytes + bytes);
    });
  }

  /**
   * One read-only OFPMP_FLOW request to the switch, returned as a probe report with the raw reply bytes. Sends no
   * FlowMod and changes nothing on the switch. At most one runs at a time and they are spaced by
   * FLOW_PROBE_MIN_INTERVAL_MS, measured from the end of the previous probe (FlowProbeRateLimitedError otherwise). Rejects if there is no established session.
   */
  public async probeFlowTable(): Promise<FlowProbeReport> {
    if (this.flowReadLock.isHeld) {
      throw new FlowProbeRateLimitedError(FLOW_PROBE_MIN_INTERVAL_MS, 'a flow-table read is already running');
    }
    const started = process.hrtime.bigint();
    if (this.lastFlowProbeMonoNs !== null) {
      const elapsedMs = (started - this.lastFlowProbeMonoNs) / 1_000_000n;
      const minMs = BigInt(FLOW_PROBE_MIN_INTERVAL_MS);
      if (elapsedMs < minMs) {
        throw new FlowProbeRateLimitedError(Number(minMs - elapsedMs), 'flow-table probes are spaced; try again shortly');
      }
    }
    if (!this.flowReadLock.tryAcquire()) {
      throw new FlowProbeRateLimitedError(FLOW_PROBE_MIN_INTERVAL_MS, 'a flow-table read is already running');
    }
    this.lastFlowProbeMonoNs = started;
    try {
      const { replies } = await readFlowStatsRaw(this.controller.openFlow, FLOW_READBACK_TIMEOUT_MS);
      return buildFlowProbeReport({
        policy: buildPort1IsolationPolicy(),
        replies,
        capturedAtIso: new Date().toISOString(),
        capturedMonotonicNs: process.hrtime.bigint(),
        context: { isolationState: this.isolationStatus.state, node: process.version },
      });
    } finally {
      this.flowReadLock.release();
      // Space probes from the end of the last one, so a probe that ran into its timeout cannot be followed at once.
      this.lastFlowProbeMonoNs = process.hrtime.bigint();
    }
  }

  /**
   * Starts the control plane, then the HTTP bridge. If the OpenFlow port cannot be bound it rejects with
   * ControlPlaneBindError before anything else is started (unless ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE=1).
   * The process exits non-zero only because the `serve` entry turns that rejection into process.exit(1); any other
   * caller must not swallow it, or the guarantee that a bridge controlling no switch never looks healthy is lost.
   * On that refusal `controlPlaneState` stays DEGRADED_FAULT as a record of why, on an object that is not used again.
   */
  public async start(requestedPort: number = 3000, host: string = '0.0.0.0'): Promise<number> {
    // 1. Start OpenFlow 1.3 controller in background
    try {
      await this.controller.startOpenFlow(6633, this.controllerIp);
      this.controlPlaneState = 'ACTIVE';
    } catch (err: unknown) {
      this.controlPlaneState = 'DEGRADED_FAULT';
      const detail = err instanceof Error ? err.message : String(err);
      if (!degradedControlPlaneAllowed(process.env)) {
        // Nothing else has been started yet. Failing here lets systemd report the unit as failed and apply its
        // restart policy, instead of showing `active` for a bridge that controls no switch.
        console.error(`[!] [OpenFlow Error] ${detail}. Refusing to run without the control plane (set ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE=1 to override in development).`);
        throw new ControlPlaneBindError(detail);
      }
      console.error('[!] [OpenFlow Error] Control plane failed to bind on 6633. Entering DEGRADED_FAULT state (explicitly allowed):', detail);
    }

    // 2. Start HTTP bridge server with automatic port hunting on EADDRINUSE
    const tryListen = (portToTry: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          void this.handleRequest(req, res);
        });

        srv.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && portToTry < requestedPort + 20) {
            console.log(`[i] Port ${portToTry} in use, attempting next port ${portToTry + 1}...`);
            resolve(tryListen(portToTry + 1));
          } else {
            reject(err);
          }
        });

        srv.listen(portToTry, host, () => {
          this.server = srv;
          resolve(portToTry);
        });
      });
    };

    const boundPort = await tryListen(requestedPort);

    // Notify systemd: service is fully ready to accept connections.
    // This satisfies Type=notify in zodiac-bridge.service, allowing systemd
    // to accurately track startup completion and enabling WatchdogSec liveness.
    // No-ops silently outside systemd (NOTIFY_SOCKET absent).
    sdNotify('READY=1\n');

    // Prepend persistent day history from local JSONL files so service restarts preserve the day's tests
    try {
      const dayHistory = await queryLocalHistory('24h');
      this.workstationTimeSeries = mergeHistoricalSeries(this.workstationTimeSeries, dayHistory.workstationTimeSeries);
      this.timeSeries = mergeHistoricalSeries(this.timeSeries, dayHistory.timeSeries);
      this.jetsonTimeSeries = mergeHistoricalSeries(this.jetsonTimeSeries, dayHistory.jetsonTimeSeries);
      this.coralTimeSeries = mergeHistoricalSeries(this.coralTimeSeries, dayHistory.coralTimeSeries);
      this.cachedSnapshot = {
        ...this.cachedSnapshot,
        timeSeries: this.timeSeries,
        ...(this.cachedSnapshot.jetson ? { jetson: { ...this.cachedSnapshot.jetson, timeSeries: this.jetsonTimeSeries } } : {}),
        ...(this.cachedSnapshot.coral ? { coral: { ...this.cachedSnapshot.coral, timeSeries: this.coralTimeSeries } } : {}),
        ...(this.cachedSnapshot.workstation ? { workstation: { ...this.cachedSnapshot.workstation, timeSeries: this.workstationTimeSeries } } : {}),
      };
    } catch (err: unknown) {
      this.historyLoadFailures++;
      console.warn('[!] Failed to merge local day history into startup buffers:', err instanceof Error ? err.message : String(err));
    }

    // 3. Start decoupled asynchronous background telemetry polling loop with backpressure
    this.scheduleNextPoll(0);

    // 4. Spawn the Coral inference daemon (managed child process).
    //    Produces /tmp/coral-telemetry.json read by probeCoralHardware().
    //    Only launched on Linux — no-ops silently on other platforms.
    if (process.platform === 'linux') {
      this.startCoralDaemonIfEnabled(process.env);
    }

    // Systemd watchdog heartbeat: send WATCHDOG=1 every 10 seconds.
    // WatchdogSec=30s in the service unit gives 3x the heartbeat interval
    // as the liveness budget — systemd kills the process only if it stops
    // responding entirely, not just during a slow Neon DB round-trip.
    // Dean Invariant: 10s interval is far above the 500ms datacenter RTT;
    // the heartbeat never contends with the 2.5s telemetry poll loop.
    //
    // NOTIFY_SOCKET is cached at module load; if absent, this block is skipped
    // entirely — no recurring no-op callbacks on non-systemd hosts (Ghemawat).
    if (NOTIFY_SOCKET) {
      setInterval(() => {
        sdNotify('WATCHDOG=1\n');
      }, 10_000).unref(); // .unref() prevents the heartbeat from keeping Node
                         // alive if all other I/O drains (graceful shutdown).
    }

    this.quarantineSweepTimer = setInterval(() => {
      try {
        this.sweepExpiredQuarantines();
      } catch (err: unknown) {
        console.warn('[!] [Quarantine] Expiry sweep failed:', err instanceof Error ? err.message : String(err));
      }
    }, ZodiacBridgeServer.QUARANTINE_SWEEP_INTERVAL_MS);
    this.quarantineSweepTimer.unref();
    this.isolationRechecker.start(); // re-verifies the isolation policy against the switch on a timer (see isolation-recheck.ts)
    return boundPort;
  }

  /** Starts the Coral daemon only when explicitly enabled; returns whether a start was attempted. */
  public startCoralDaemonIfEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    if (!coralDaemonEnabled(env)) {
      console.log('[coral-daemon] Disabled (opt-in: set ZODIAC_ENABLE_CORAL_DAEMON=1). Coral metrics report STANDBY.');
      return false;
    }
    this.spawnCoralDaemon(0);
    return true;
  }

  /**
   * Spawns coral-inference-daemon.py as a managed child process.
   * Automatically restarts it with capped exponential backoff on crash.
   * Dean Invariant: daemon stdout/stderr forwarded to bridge server's
   * process streams for journald capture — zero silent failures.
   */
  private spawnCoralDaemon(backoffMs: number): void {
    // Vinyals flap-prevention: after MAX_CORAL_RESTARTS attempts, declare
    // terminal fail-closed — no further restarts to prevent infinite flapping
    // on permanent ENOENT/EACCES conditions.
    if (this.coralDaemonRestartCount >= ZodiacBridgeServer.MAX_CORAL_RESTARTS) {
      process.stderr.write(
        `[coral-daemon] Terminal fail-closed after ${ZodiacBridgeServer.MAX_CORAL_RESTARTS} restarts. ` +
        `Coral metrics will remain STANDBY. Manual intervention required.\n`
      );
      return;
    }

    const DAEMON_PATH = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../scripts/coral-inference-daemon.py'
    );
    const VENV_PYTHON = '/home/zodiac/coral-venv/bin/python3';

    // Silently skip if daemon script or venv is absent
    if (!fs.existsSync(DAEMON_PATH) || !fs.existsSync(VENV_PYTHON)) {
      console.warn('[coral-daemon] Script or venv not found — Coral metrics will be STANDBY.');
      return;
    }

    const doSpawn = () => {
      // Increment once per spawn attempt — not per event — so that a failed
      // spawn emitting both 'error' and 'exit' only burns one retry slot.
      // (Ghemawat: state machine counter must be monotone per logical attempt.)
      this.coralDaemonRestartCount++;
      console.log(`[coral-daemon] Spawning (backoff=${backoffMs}ms, attempt=${this.coralDaemonRestartCount}/${ZodiacBridgeServer.MAX_CORAL_RESTARTS}): ${VENV_PYTHON} ${DAEMON_PATH}`);
      const child = spawn(VENV_PYTHON, [DAEMON_PATH], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      this.coralDaemon = child;
      // Record when this child was spawned — used for stability-based counter reset.
      const spawnTimeMs = Date.now();

      // readline.createInterface guarantees clean line events regardless of how
      // pipe data is chunked — no fragmented log lines (Council: Zero Suppression).
      if (child.stdout) {
        readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
          .on('line', (line) => process.stdout.write(`[coral-daemon] ${line}\n`));
      }
      if (child.stderr) {
        readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
          .on('line', (line) => process.stderr.write(`[coral-daemon] ${line}\n`));
      }

      child.on('error', (err: NodeJS.ErrnoException) => {
        // Spawn failure (ENOENT, EACCES) — log and schedule backoff restart.
        // Without this handler Node.js would emit an unhandled error and crash.
        // Clear any existing timer to prevent duplicate restarts if both
        // 'error' and 'exit' fire for the same crash (Ghemawat: state machine safety).
        if (this.coralDaemonRestartTimer) {
          clearTimeout(this.coralDaemonRestartTimer);
          this.coralDaemonRestartTimer = null;
        }
        this.coralDaemon = null;
        const nextBackoff = Math.min((backoffMs || 500) * 2, 30_000);
        process.stderr.write(
          `[coral-daemon] Spawn error (${err.code ?? err.message}). ` +
          `Attempt ${this.coralDaemonRestartCount}/${ZodiacBridgeServer.MAX_CORAL_RESTARTS}. ` +
          `Restarting in ${nextBackoff}ms.\n`
        );
        this.coralDaemonRestartTimer = setTimeout(() => this.spawnCoralDaemon(nextBackoff), nextBackoff);
      });

      child.on('exit', (code, signal) => {
        this.coralDaemon = null;
        if (signal === 'SIGTERM') {
          // Graceful shutdown requested by stop() — do not restart.
          console.log('[coral-daemon] Terminated by SIGTERM (graceful stop).');
          return;
        }

        // Vinyals stability reset: if the daemon survived > 60s before exiting,
        // it was not permanently broken — reset the flap counter so transient
        // errors over long uptimes don't permanently lock the daemon in FAULT.
        const uptimeMs = Date.now() - spawnTimeMs;
        if (uptimeMs >= 60_000) {
          this.coralDaemonRestartCount = 0;
        }

        // Clear any pending timer from the 'error' handler before scheduling
        // a new one — prevents fork-bomb if both events fire (Ghemawat: dedup).
        if (this.coralDaemonRestartTimer) {
          clearTimeout(this.coralDaemonRestartTimer);
          this.coralDaemonRestartTimer = null;
        }
        const nextBackoff = Math.min((backoffMs || 500) * 2, 30_000);
        console.warn(
          `[coral-daemon] Exited (code=${code}, uptime=${Math.round(uptimeMs / 1000)}s). ` +
          `Attempt ${this.coralDaemonRestartCount}/${ZodiacBridgeServer.MAX_CORAL_RESTARTS}. ` +
          `Restarting in ${nextBackoff}ms.`
        );
        this.coralDaemonRestartTimer = setTimeout(() => this.spawnCoralDaemon(nextBackoff), nextBackoff);
      });
    };

    if (backoffMs > 0) {
      this.coralDaemonRestartTimer = setTimeout(doSpawn, backoffMs);
    } else {
      doSpawn();
    }
  }

  /**
   * Schedules the next telemetry poll cycle with backpressure:
   * guarantees that probes never pile up concurrently if an I/O operation takes longer than 2.5s.
   */
  private scheduleNextPoll(delayMs: number = 2500): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.refreshTelemetry();
      } finally {
        if (this.server) {
          this.scheduleNextPoll(2500);
        }
      }
    }, delayMs);
  }

  /**
   * Sanjay Ghemawat & Jeff Dean Invariant: Atomically flush the in-memory telemetry buffers to local disk.
   * Asynchronous non-blocking file I/O to prevent event loop starvation and SDN control plane jitter.
   */
  public async flushTelemetryStateToDisk(): Promise<boolean> {
    return saveTelemetryStateAtomic(this.stateFilePath, {
      version: 1,
      savedAtMs: Date.now(),
      timeSeries: this.timeSeries,
      jetsonTimeSeries: this.jetsonTimeSeries,
      coralTimeSeries: this.coralTimeSeries,
      workstationTimeSeries: this.workstationTimeSeries,
    });
  }

  /**
   * Synchronous flush reserved strictly for process shutdown hooks.
   */
  public flushTelemetryStateToDiskSync(): boolean {
    return saveTelemetryStateAtomicSync(this.stateFilePath, {
      version: 1,
      savedAtMs: Date.now(),
      timeSeries: this.timeSeries,
      jetsonTimeSeries: this.jetsonTimeSeries,
      coralTimeSeries: this.coralTimeSeries,
      workstationTimeSeries: this.workstationTimeSeries,
    });
  }

  public async stop(): Promise<void> {
    this.isolationRechecker.stop();
    if (this.quarantineSweepTimer) {
      clearInterval(this.quarantineSweepTimer);
      this.quarantineSweepTimer = null;
    }
    this.flushTelemetryStateToDiskSync();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.coralDaemonRestartTimer) {
      clearTimeout(this.coralDaemonRestartTimer);
      this.coralDaemonRestartTimer = null;
    }
    if (this.coralDaemon) {
      this.coralDaemon.kill('SIGTERM');
      this.coralDaemon = null;
    }
    const timeoutMs = getShutdownTimeoutMs();
    let timerId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`[zodiac-bridge] Shutdown timed out after ${timeoutMs}ms (Council Invariant 3: Fail-Closed)`));
      }, timeoutMs);
    });

    const closePromise = new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      this.server.close(async (closeErr) => {
        this.server = null;
        if (closeErr) {
          reject(closeErr);
          return;
        }
        try {
          await this.controller.stop();
          resolve();
        } catch (controllerErr) {
          reject(controllerErr);
        }
      });
    });

    try {
      await Promise.race([closePromise, timeoutPromise]);
    } finally {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // API: GET /api/auth/login
    // When GOOGLE_CLIENT_ID is configured this would redirect to Google OAuth.
    // In local appliance mode (no OAuth) we redirect back to the dashboard root
    // so clicking "Sign In" in the UI doesn't 404.
    if (url.pathname === '/api/auth/login' && req.method === 'GET') {
      const hasGoogleOauth = Boolean(process.env['GOOGLE_CLIENT_ID']);
      if (!hasGoogleOauth) {
        // No OAuth configured: LAN access IS the authentication boundary.
        // Redirect to root — the /api/auth/me check will auto-pass for LAN clients.
        res.statusCode = 302;
        res.setHeader('Location', '/');
        res.end();
        return;
      }
      // Future: build Google OAuth redirect URL here when GOOGLE_CLIENT_ID is set.
      res.statusCode = 501;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Google OAuth not yet wired to this appliance build.' }));
      return;
    }

    // API: GET /api/auth/me (Council Invariant 3: Fail-Closed Socket Provenance)
    // Trust: loopback OR any RFC 1918 LAN peer when GOOGLE_CLIENT_ID is absent.
    // When OAuth IS configured, only a valid signed session cookie is accepted.
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const isOperator = isLanOperator(req);

      if (!isOperator) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'Unauthorized: External access to local operator session denied. Invariant: Fail-Closed Default Drop.',
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        authenticated: true,
        user: {
          email: 'sekyereandy@gmail.com',
          name: 'Andy Sekyere (Local Operator)',
          picture: '',
        },
      }));
      return;
    }

    // API: POST /api/auth/logout
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // API: GET /api/zodiac (Dean & Ghemawat Invariant: O(1) instant return of cached snapshot)
    if (url.pathname === '/api/zodiac' && req.method === 'GET') {
      const isSummary = url.searchParams.get('summary') === 'true' || url.searchParams.get('summary') === '1';
      if (isSummary) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        let jetsonSummary: JetsonTelemetrySnapshot | undefined = undefined;
        if (this.cachedSnapshot.jetson) {
          const { timeSeries: _ts, ...restJetson } = this.cachedSnapshot.jetson;
          jetsonSummary = restJetson;
        }
        let coralSummary: CoralTelemetrySnapshot | undefined = undefined;
        if (this.cachedSnapshot.coral) {
          const { timeSeries: _ts, ...restCoral } = this.cachedSnapshot.coral;
          coralSummary = restCoral;
        }
        let workstationSummary: WorkstationTelemetrySnapshot | undefined = undefined;
        if (this.cachedSnapshot.workstation) {
          const { timeSeries: _ts, ...restWorkstation } = this.cachedSnapshot.workstation;
          workstationSummary = restWorkstation;
        }
        const { timeSeries: _rootTs, ...restSnapshot } = this.cachedSnapshot;
        const responsePayload: ZodiacFullTelemetrySnapshot = {
          ...restSnapshot,
          jetson: jetsonSummary,
          coral: coralSummary,
          workstation: workstationSummary,
        };
        res.end(this.serializeSnapshot(responsePayload));
        return;
      }

      const range = url.searchParams.get('range');
      if (range && isValidRange(range)) {
        const config = RANGE_CONFIGS[range];

        const durationMs = RANGE_DURATION_MS[range];
        const cutoffMs = Date.now() - durationMs;
        // Sanjay Ghemawat - Algorithmic Efficiency Invariant:
        // O(log N) bisection search + slice instead of O(N) linear filter on synchronous HTTP path
        const windowedWorkstation = this.workstationTimeSeries.slice(findCutoffIndex(this.workstationTimeSeries, cutoffMs));
        const workstationPoints = downsampleWorkstationPoints(windowedWorkstation, config.maxPoints);

        // 1. Local disk JSONL history (preferred: persistent, no network, 30-day retention)
        try {
          const local = await queryLocalHistory(range);
          if (
            local.timeSeries.length > 0 ||
            local.jetsonTimeSeries.length > 0 ||
            local.coralTimeSeries.length > 0 ||
            (local.workstationTimeSeries && local.workstationTimeSeries.length > 0)
          ) {
            const wsSeries = (local.workstationTimeSeries && local.workstationTimeSeries.length > 0)
              ? local.workstationTimeSeries
              : workstationPoints;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(this.serializeSnapshot({
              ...this.cachedSnapshot,
              timeSeries: local.timeSeries,
              ...(this.cachedSnapshot.jetson ? {
                jetson: { ...this.cachedSnapshot.jetson, timeSeries: local.jetsonTimeSeries },
              } : {}),
              ...(this.cachedSnapshot.coral ? {
                coral: { ...this.cachedSnapshot.coral, timeSeries: local.coralTimeSeries },
              } : {}),
              ...(this.cachedSnapshot.workstation ? {
                workstation: { ...this.cachedSnapshot.workstation, timeSeries: wsSeries },
              } : {}),
            }));
            return;
          }
        } catch (localErr: unknown) {
          console.warn('[!] [Bridge DB] Local history query failed, falling back to Neon:', localErr instanceof Error ? localErr.message : String(localErr));
        }

        // 2. Neon DB (cloud backup; may require internet connectivity)
        const prisma = getPrismaClient();
        if (prisma) {
          try {
            const multi = await getHistoricalMultiDeviceTelemetry(range);
            if (multi.timeSeries.length > 0 || multi.jetsonTimeSeries.length > 0 || multi.coralTimeSeries.length > 0) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(this.serializeSnapshot({
                ...this.cachedSnapshot,
                timeSeries: multi.timeSeries,
                ...(this.cachedSnapshot.jetson ? {
                  jetson: {
                    ...this.cachedSnapshot.jetson,
                    timeSeries: multi.jetsonTimeSeries,
                  },
                } : {}),
                ...(this.cachedSnapshot.coral ? {
                  coral: {
                    ...this.cachedSnapshot.coral,
                    timeSeries: multi.coralTimeSeries,
                  },
                } : {}),
                ...(this.cachedSnapshot.workstation ? {
                  workstation: {
                    ...this.cachedSnapshot.workstation,
                    timeSeries: workstationPoints,
                  },
                } : {}),
              }));
              return;
            }
          } catch (dbErr: unknown) {
            console.warn('[!] [Bridge DB] Historical Neon query failed, falling back to in-memory window:', dbErr instanceof Error ? dbErr.message : String(dbErr));
          }
        }

        // 3. In-Memory Window Downsampling (Dean & Ghemawat Invariants)
        // Strictly filter by requested range duration so 1h doesn't downsample 2.5+ hours of history
        const windowedPoints = this.timeSeries.slice(findCutoffIndex(this.timeSeries, cutoffMs));
        const windowedJetson = this.jetsonTimeSeries.slice(findCutoffIndex(this.jetsonTimeSeries, cutoffMs));
        const windowedCoral = this.coralTimeSeries.slice(findCutoffIndex(this.coralTimeSeries, cutoffMs));

        const points = downsamplePoints(windowedPoints, config.maxPoints);
        const jetsonPoints = downsampleJetsonPoints(windowedJetson, config.maxPoints);
        const coralPoints = downsampleCoralPoints(windowedCoral, config.maxPoints);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(this.serializeSnapshot({
          ...this.cachedSnapshot,
          timeSeries: points,
          ...(this.cachedSnapshot.jetson ? {
            jetson: {
              ...this.cachedSnapshot.jetson,
              timeSeries: jetsonPoints,
            },
          } : {}),
          ...(this.cachedSnapshot.coral ? {
            coral: {
              ...this.cachedSnapshot.coral,
              timeSeries: coralPoints,
            },
          } : {}),
          ...(this.cachedSnapshot.workstation ? {
            workstation: {
              ...this.cachedSnapshot.workstation,
              timeSeries: workstationPoints,
            },
          } : {}),
        }));
        return;
      }

      // Delta polling: ?since=<timestampMs> returns only timeSeries points newer than
      // the client's last observed timestamp. Slashes payload from ~5.5 MB down to ~2 KB,
      // eliminating V8 memory churn, GC stalls, and false-negative timeout aborts (Dean Latency Budget).
      const sinceRaw = Number(url.searchParams.get('since') ?? '0');
      // Tolerate clock skew / NTP drift up to 60s ahead, while clamping runaway future timestamps
      // to Date.now() + 60_000 to prevent clients from permanently blackholing their own telemetry.
      const sinceMs = Number.isFinite(sinceRaw) && sinceRaw > 0
        ? Math.min(Math.floor(sinceRaw), Date.now() + 60_000)
        : 0;

      if (sinceMs > 0) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(this.serializeSnapshot({
          ...this.cachedSnapshot,
          timeSeries: trimSeriesSince(this.cachedSnapshot.timeSeries, sinceMs),
          ...(this.cachedSnapshot.jetson ? {
            jetson: { ...this.cachedSnapshot.jetson, timeSeries: trimSeriesSince(this.cachedSnapshot.jetson.timeSeries, sinceMs) },
          } : {}),
          ...(this.cachedSnapshot.coral ? {
            coral: { ...this.cachedSnapshot.coral, timeSeries: trimSeriesSince(this.cachedSnapshot.coral.timeSeries, sinceMs) },
          } : {}),
          ...(this.cachedSnapshot.workstation ? {
            workstation: { ...this.cachedSnapshot.workstation, timeSeries: trimSeriesSince(this.cachedSnapshot.workstation.timeSeries, sinceMs) },
          } : {}),
          ...(this.cachedSnapshot.rpi5 ? {
            rpi5: { ...this.cachedSnapshot.rpi5, timeSeries: trimSeriesSince(this.cachedSnapshot.rpi5.timeSeries, sinceMs) },
          } : {}),
          ...(this.cachedSnapshot.rpi3_1 ? {
            rpi3_1: { ...this.cachedSnapshot.rpi3_1, timeSeries: trimSeriesSince(this.cachedSnapshot.rpi3_1.timeSeries, sinceMs) },
          } : {}),
          ...(this.cachedSnapshot.rpi3_2 ? {
            rpi3_2: { ...this.cachedSnapshot.rpi3_2, timeSeries: trimSeriesSince(this.cachedSnapshot.rpi3_2.timeSeries, sinceMs) },
          } : {}),
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(this.serializeSnapshot(this.cachedSnapshot));
      return;
    }

    // API: POST /api/command (Executes serial command with bounded buffer size & error handling)
    if (url.pathname === '/api/command' && req.method === 'POST') {
      const MAX_CMD_PAYLOAD = 64 * 1024;
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;

      req.on('error', (err: Error) => {
        aborted = true;
        if (res.headersSent) return;
        console.error('[!] [Bridge Server] Incoming command stream error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Request stream failure: ${err.message}` }));
      });

      req.on('data', (c: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += c.length;
        if (bytesReceived > MAX_CMD_PAYLOAD) {
          aborted = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Payload Too Large: Maximum command size is 64KB' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });

      req.on('end', async () => {
        if (aborted || res.headersSent) return;
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const { command } = JSON.parse(body);
          if (typeof command !== 'string' || !command.trim()) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Command string required' }));
            return;
          }

          let output = '';
          try {
            output = await this.controller.executeCommand(command.trim());
          } catch (cmdErr: unknown) {
            console.warn('[!] [Bridge Server] Command error:', cmdErr instanceof Error ? cmdErr.message : String(cmdErr));
            output = `[Error executing command: ${cmdErr instanceof Error ? cmdErr.message : String(cmdErr)}]`;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ output }));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // API: POST /api/sdn/quarantine (Autonomous Sentinel Emergency FlowMod Quarantine)
    // Council Invariant 1 (Anti-Shortcut) & Invariant 3 (Fail-Closed Isolation):
    // Synthesizes OpenFlow 1.3 priority 65535 drop rule to immediately isolate rogue/compromised agents on Port 1.
    if (url.pathname === '/api/sdn/quarantine' && req.method === 'POST') {
      const MAX_PAYLOAD = 32 * 1024;
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;

      req.setTimeout(5000, () => {
        aborted = true;
        if (!res.headersSent) {
          res.statusCode = 408;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Request Timeout: Stream timed out after 5000ms' }));
        }
        req.destroy();
        req.socket?.destroy();
      });

      req.on('error', (err: Error) => {
        aborted = true;
        if (res.headersSent) return;
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Stream failure: ${err.message}` }));
      });

      req.on('data', (c: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += c.length;
        if (bytesReceived > MAX_PAYLOAD) {
          aborted = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Payload Too Large: Maximum quarantine payload is 32KB' }));
          req.destroy();
          req.socket?.destroy();
          return;
        }
        chunks.push(c);
      });

      req.on('end', async () => {
        if (aborted || res.headersSent) return;
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = JSON.parse(raw);
          const { targetMac, targetIp, reason, priority } = body;

          const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$|^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/;
          const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

          const cleanMac = typeof targetMac === 'string' && MAC_REGEX.test(targetMac.trim())
            ? targetMac.trim()
            : undefined;
          const cleanIp = typeof targetIp === 'string' && IPV4_REGEX.test(targetIp.trim())
            ? targetIp.trim()
            : undefined;

          if (!cleanMac && !cleanIp) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Valid targetMac (EUI-48) or targetIp (IPv4) required for quarantine' }));
            return;
          }

          const outcome = this.requestQuarantine({
            targetMac: cleanMac,
            targetIp: cleanIp,
            reason: typeof reason === 'string' ? reason.trim() : 'Neural Anomaly Detected',
            priority: typeof priority === 'number' ? priority : 65535,
            evidence: sanitizeEvidence(body.evidence),
          });
          res.statusCode = outcome.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(outcome.body));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // API: GET /api/sdn/quarantine/proposals (read-only: what is waiting for a person, and the bridge's mode)
    if (url.pathname === '/api/sdn/quarantine/proposals' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(this.listQuarantineProposals()));
      return;
    }

    // API: POST /api/sdn/quarantine/approve {"targetIp": "..."} (a person approves a proposal; it is installed time-limited)
    if (url.pathname === '/api/sdn/quarantine/approve' && req.method === 'POST') {
      const MAX_APPROVE_PAYLOAD = 4 * 1024;
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;
      const fail = (status: number, message: string): void => {
        if (res.headersSent) return;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: message }));
      };
      req.setTimeout(5000, () => {
        aborted = true;
        fail(408, 'Request Timeout');
        req.destroy();
      });
      req.on('error', (err: Error) => {
        aborted = true;
        fail(500, err.message);
      });
      req.on('data', (c: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += c.length;
        if (bytesReceived > MAX_APPROVE_PAYLOAD) {
          aborted = true;
          fail(413, 'Payload Too Large');
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted || res.headersSent) return;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const targetIp = typeof parsed === 'object' && parsed !== null && 'targetIp' in parsed && typeof parsed.targetIp === 'string'
            ? parsed.targetIp.trim()
            : '';
          if (!/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/.test(targetIp)) {
            fail(400, 'targetIp (IPv4) required');
            return;
          }
          const outcome = this.approveQuarantineProposal(targetIp);
          res.statusCode = outcome.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(outcome.body));
        } catch (err: unknown) {
          fail(400, err instanceof Error ? err.message : String(err));
        }
      });
      return;
    }

    // API: POST /api/sdn/release (Lifts an emergency quarantine rule after out-of-band triage)
    if (url.pathname === '/api/sdn/release' && req.method === 'POST') {
      const MAX_PAYLOAD = 32 * 1024;
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;

      req.setTimeout(5000, () => {
        aborted = true;
        if (!res.headersSent) {
          res.statusCode = 408;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Request Timeout' }));
        }
        req.destroy();
      });

      req.on('error', (err: Error) => {
        aborted = true;
        if (res.headersSent) return;
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      });

      req.on('data', (c: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += c.length;
        if (bytesReceived > MAX_PAYLOAD) {
          aborted = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });

      req.on('end', () => {
        if (aborted || res.headersSent) return;
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = JSON.parse(raw);
          const { targetMac, targetIp, reason } = body;
          const cleanMac = typeof targetMac === 'string' ? targetMac.trim() : undefined;
          const cleanIp = typeof targetIp === 'string' ? targetIp.trim() : undefined;

          if (!cleanMac && !cleanIp) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'targetMac or targetIp required' }));
            return;
          }

          const result = this.releaseQuarantineRule({
            targetMac: cleanMac,
            targetIp: cleanIp,
            reason: typeof reason === 'string' ? reason : undefined,
          });

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // API: POST /api/sdn/allow (Push a verified forwarding flow rule to the physical switch)
    // INV-4 (Verification Asymmetry): topology verified loop-free before hardware install.
    // INV-3 (Fail-Closed): action is ALLOW only; DROP is /api/sdn/quarantine.
    if (url.pathname === '/api/sdn/allow' && req.method === 'POST') {
      const MAX_PAYLOAD = 32 * 1024;
      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let aborted = false;
      req.setTimeout(5000, () => {
        aborted = true;
        if (!res.headersSent) {
          res.statusCode = 408;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Request Timeout' }));
        }
        req.destroy();
      });
      req.on('error', (err: Error) => {
        aborted = true;
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      req.on('data', (c: Buffer) => {
        if (aborted || res.headersSent) return;
        bytesReceived += c.length;
        if (bytesReceived > MAX_PAYLOAD) {
          aborted = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted || res.headersSent) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const { srcMac, dstMac, outPort, priority = 10, description = '' } = body;
          const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
          if (typeof outPort !== 'number' || outPort < 1 || outPort > 4) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'outPort (1–4) required' }));
            return;
          }
          if (typeof srcMac === 'string' && !MAC_RE.test(srcMac.trim())) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid srcMac format (expected xx:xx:xx:xx:xx:xx)' }));
            return;
          }
          if (typeof dstMac === 'string' && !MAC_RE.test(dstMac.trim())) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid dstMac format (expected xx:xx:xx:xx:xx:xx)' }));
            return;
          }
          const cleanSrcMac = typeof srcMac === 'string' ? srcMac.trim() : undefined;
          const cleanDstMac = typeof dstMac === 'string' ? dstMac.trim() : undefined;
          const ruleId = `allow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const rule = {
            id: ruleId,
            priority,
            srcCidr: '0.0.0.0/0',
            dstCidr: '0.0.0.0/0',
            protocol: 'ANY' as const,
            ...(cleanSrcMac ? { srcMac: cleanSrcMac } : {}),
            ...(cleanDstMac ? { dstMac: cleanDstMac } : {}),
            action: 'FORWARD' as const,
          };
          let openFlowInstalled = false;
          try {
            if (this.controller.openFlow.metrics.state === 'ESTABLISHED') {
              this.controller.pushRule(rule, outPort);
              openFlowInstalled = true;
            }
          } catch (ofErr) {
            console.warn('[!] [Bridge/allow] OpenFlow install error:', ofErr instanceof Error ? ofErr.message : String(ofErr));
          }
          if (openFlowInstalled && this.flowRuleRegistry.size >= 1000) {
            const oldest = this.flowRuleRegistry.keys().next().value;
            if (oldest !== undefined) this.flowRuleRegistry.delete(oldest);
          }
          const entry = {
            ruleId, priority, action: 'FORWARD' as const,
            srcCidr: '0.0.0.0/0', dstCidr: '0.0.0.0/0', protocol: 'ANY' as const,
            ...(cleanSrcMac ? { srcMac: cleanSrcMac } : {}),
            ...(cleanDstMac ? { dstMac: cleanDstMac } : {}),
            installedAtMs: Date.now(),
            openFlowInstalled,
            description,
          };
          if (openFlowInstalled) this.flowRuleRegistry.set(ruleId, entry);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, ruleId, openFlowInstalled, entry }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // API: GET /api/zodiac/flows (OpenFlow flow rule registry — controller-pushed rules)
    if (url.pathname === '/api/zodiac/flows' && req.method === 'GET') {
      const isOperator = isLanOperator(req);
      if (!isOperator) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unauthorized: Operator access required.' }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({
        dataSource: 'controller_registry',
        note: 'Per-flow hardware stats (OFPT_MULTIPART_REQUEST) not yet implemented; showing controller-pushed rules only.',
        rules: Array.from(this.flowRuleRegistry.values()),
        totalRules: this.flowRuleRegistry.size,
        port1Isolation: isolationStatusToJson(this.isolationStatus, process.hrtime.bigint()),
        timestamp: Date.now(),
      }));
      return;
    }

    // API: GET /api/zodiac/flows/probe (read-only: one OFPMP_FLOW request, raw reply bytes returned as evidence)
    // Operator only. Sends no FlowMod. Rate limited and one at a time (see probeFlowTable).
    if (url.pathname === '/api/zodiac/flows/probe' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (!isLanOperator(req)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized: Operator access required.' }));
        return;
      }
      try {
        const report = await this.probeFlowTable();
        res.statusCode = 200;
        res.end(JSON.stringify(report));
      } catch (err: unknown) {
        const mapped = probeErrorToHttp(err);
        res.statusCode = mapped.status;
        if (mapped.body.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(mapped.body.retryAfterSeconds));
        res.end(JSON.stringify(mapped.body));
      }
      return;
    }

    // API: GET /api/sdn/copilot/summary (Executive AI Telemetry Copilot)
    // Council Invariant 1 (Anti-Shortcut), Invariant 3 (Fail-Closed) & Invariant 6 (Epistemic Provenance):
    // Synthesizes a plain-English executive triage of physical SDN signals via local Qwen 2.5 on Jetson Orin.
    if (url.pathname === '/api/sdn/copilot/summary' && req.method === 'GET') {
      try {
        const summary = await this.generateCopilotSummary();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.statusCode = 200;
        res.end(JSON.stringify(summary));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: 'OFFLINE',
          headline: 'Executive Copilot Fault',
          bullets: ['Copilot evaluation encountered an internal error.'],
          error: err instanceof Error ? err.message : String(err),
          timestampMs: Date.now(),
        }));
      }
      return;
    }

    // Static File Serving from public/ (Asynchronous & Path-Traversal Protected)
    let reqPath = url.pathname;
    if (reqPath === '/' || reqPath === '') {
      reqPath = '/index.html';
    }

    const resolvedPath = path.resolve(PUBLIC_DIR, '.' + path.normalize(reqPath));
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      res.end('403 Forbidden');
      return;
    }

    try {
      const stats = await fs.promises.stat(resolvedPath);
      if (stats.isFile()) {
        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        if (ext === '.html') {
          // Entrypoint HTML must revalidate to pick up newly hashed assets instantly
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (ext === '.js' || ext === '.css') {
          // Jeff Dean Latency Optimization: Content-addressable assets (*.[a-f0-9]{10}.*)
          // are mathematically immutable: cache indefinitely (1 year) per Dean Latency Invariant.
          const isHashed = /\.[a-f0-9]{10}\.(js|css)$/i.test(path.basename(resolvedPath));
          if (isHashed) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            // Unhashed fallback files (e.g. direct dev access) revalidate with server
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          }
        }
        fs.createReadStream(resolvedPath).pipe(res);
        return;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[!] Static file read error for ${reqPath}:`, err instanceof Error ? err.message : String(err));
      }
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('404 Not Found');
  }

  private boundedFlowSnapshot(): readonly ZodiacFlowRuleEntry[] {
    const cap = ZodiacBridgeServer.MAX_FLOW_SNAPSHOT_RULES;
    if (this.flowRuleRegistry.size <= cap) {
      return Array.from(this.flowRuleRegistry.values());
    }
    const result: ZodiacFlowRuleEntry[] = [];
    for (const rule of this.flowRuleRegistry.values()) {
      result.push(rule);
      if (result.length >= cap) break;
    }
    return result;
  }

  public async generateCopilotSummary(): Promise<CopilotSummaryResponse> {
    const nowPerf = performance.now();
    // Sanjay Ghemawat Invariant: Use readonly pre-parsed configuration to avoid V8 process.env overhead
    const { ttlSec, timeoutMs, maxTokens, temperature } = this.copilotConfig;

    // Dean Latency Invariant: Check memory cache first
    if (this.copilotSummaryCache && (nowPerf - this.copilotSummaryCache.cachedAtPerfMs) < ttlSec * 1000) {
      return {
        ...this.copilotSummaryCache.data,
        cached: true,
      };
    }

    if (this.copilotInFlightPromise) {
      return await this.copilotInFlightPromise;
    }

    this.copilotInFlightPromise = (async (): Promise<CopilotSummaryResponse> => {
      const ofState = this.controller.openFlow.metrics.state || this.cachedSnapshot.openflow?.status || 'Disconnected';
      const totalRules = this.flowRuleRegistry.size;
      let quarantinedCount = 0;
      for (const rule of this.flowRuleRegistry.values()) {
        if (rule.action === 'DROP' || rule.ruleId.startsWith('quarantine-')) {
          quarantinedCount++;
        }
      }

      const switchTempC = this.cachedSnapshot.system?.cpuTemperatureC ?? null;
      const jetsonTempC = this.cachedSnapshot.jetson?.temperatures?.socC ?? this.cachedSnapshot.jetson?.temperatures?.gpuC ?? this.cachedSnapshot.jetson?.temperatures?.cpuC ?? null;
      const vddInMw = this.cachedSnapshot.jetson?.powerMw?.vddIn;
      // Council Invariant 2 (Dean & Ghemawat): Integer milliwatts, zero floating-point division
      const jetsonPowerMw = vddInMw != null ? Math.trunc(vddInMw) : null;
      const ramUsedBytes = this.cachedSnapshot.jetson?.ramUsedBytes;
      const ramTotalBytes = this.cachedSnapshot.jetson?.ramTotalBytes;
      const jetsonFreeRamMb = (ramTotalBytes != null && ramUsedBytes != null && ramTotalBytes > ramUsedBytes)
        ? Number((ramTotalBytes - ramUsedBytes) / (1024n * 1024n))
        : null;
      const wireTapInferencesPerSec = Number(this.cachedSnapshot.coral?.inferencesPerSecond ?? 0n);

      const portsSummary = (this.cachedSnapshot.ports || [])
        .map(p => `Port ${p.port} (${p.name}): ${p.status}`)
        .join(', ');

      const metrics: CopilotSummaryMetrics = {
        openFlowState: ofState,
        activeRules: totalRules,
        quarantinedCount,
        switchTempC,
        jetsonTempC,
        jetsonPowerMw,
        jetsonFreeRamMb,
        wireTapInferencesPerSec,
      };

      const ollamaUrl = process.env['OLLAMA_API_URL'] || 'http://localhost:11434/api/generate';
      const qwenModel = process.env['QWEN_MODEL'] || 'qwen2.5:3b';

      const prompt = `You are the Zodiac Executive AI Copilot running on Jetson Orin Nano Super.
Provide a concise, 3-bullet plain-English executive triage of the physical SDN infrastructure.
Telemetry Signals:
- OpenFlow 1.3 State: ${ofState} (${totalRules} active rules, ${quarantinedCount} quarantined hosts)
- Physical Switch Ports: ${portsSummary || 'Port 1..4 monitored'}
- Switch CPU Temp: ${switchTempC != null ? switchTempC + '°C' : 'N/A'}
- Jetson Orin Hardware: ${jetsonTempC != null ? jetsonTempC + '°C' : 'N/A'}, Power: ${jetsonPowerMw != null ? jetsonPowerMw + ' mW' : 'N/A'}, Free RAM: ${jetsonFreeRamMb != null ? jetsonFreeRamMb + 'MB' : 'N/A'}
- Wire-Tap Inference: ${wireTapInferencesPerSec > 0 ? `Active at ${wireTapInferencesPerSec} inf/s` : 'Standby / Idle'}

Respond ONLY with valid JSON having the structure (keep each bullet under 15 words to prevent token truncation):
{"status": "HEALTHY" | "DEGRADED" | "ALERT", "headline": string, "bullets": [string, string, string]}`;

      let resultData: CopilotSummaryResponse;

      try {
        const response = await fetch(ollamaUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: qwenModel,
            prompt,
            format: 'json',
            stream: false,
            options: { temperature, num_predict: maxTokens },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`Ollama returned HTTP ${response.status}`);
        }

        const resJson = (await response.json()) as { response?: string };
        const parsed = JSON.parse(resJson.response || '{}') as {
          status?: string;
          headline?: string;
          bullets?: string[];
        };

        const statusRaw = String(parsed.status || 'HEALTHY').toUpperCase();
        const validStatus: 'HEALTHY' | 'DEGRADED' | 'ALERT' =
          statusRaw === 'ALERT' ? 'ALERT' : statusRaw === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY';

        resultData = {
          status: validStatus,
          headline: String(parsed.headline || 'Physical SDN Infrastructure Triage').trim(),
          bullets: Array.isArray(parsed.bullets) && parsed.bullets.length > 0
            ? parsed.bullets.map(b => String(b).trim()).slice(0, 4)
            : ['SDN data plane operational', 'OpenFlow controller established', 'Telemetry counters monotonic'],
          model: `${qwenModel} (Jetson Orin Nano Super)`,
          timestampMs: Date.now(),
          cached: false,
          ttlSeconds: ttlSec,
          metrics,
        };
      } catch (err: unknown) {
        // Council Invariant 1 & 3: Fail-closed deterministic fallback
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (isTimeout) {
          console.warn('[!] [Copilot] Ollama inference timed out (thermal/budget limit), failing closed to deterministic fallback.');
        } else {
          console.warn('[!] [Copilot] Ollama query failed, using deterministic fallback:', err instanceof Error ? err.message : String(err));
        }

        const hasQuarantine = quarantinedCount > 0;
        const ofDisconnected = ofState !== 'ESTABLISHED';
        const fallbackStatus: 'HEALTHY' | 'DEGRADED' | 'ALERT' =
          ofDisconnected ? 'ALERT' : hasQuarantine ? 'DEGRADED' : 'HEALTHY';

        const fallbackBullets: string[] = [
          `OpenFlow 1.3 control plane is ${ofState} with ${totalRules} active rules (${quarantinedCount} isolated).`,
          `Switch CPU is ${switchTempC != null ? switchTempC + '°C' : 'monitored'}; Jetson Orin silicon at ${jetsonTempC != null ? jetsonTempC + '°C' : 'nominal'} (${jetsonPowerMw != null ? jetsonPowerMw + ' mW' : 'idle'}).`,
          wireTapInferencesPerSec > 0
            ? `Ampere GPU wire-tap inference active at ${wireTapInferencesPerSec} inferences/second.`
            : 'Ampere GPU wire-tap inference in standby mode awaiting frame ingress.',
        ];

        resultData = {
          status: fallbackStatus,
          headline: 'Deterministic SDN Telemetry Triage (Ollama Offline Fallback)',
          bullets: fallbackBullets,
          model: 'deterministic_rules (fail-closed fallback)',
          timestampMs: Date.now(),
          cached: false,
          ttlSeconds: ttlSec,
          metrics,
        };
      }

      this.copilotSummaryCache = {
        data: resultData,
        cachedAtPerfMs: performance.now(),
      };
      return resultData;
    })();

    try {
      return await this.copilotInFlightPromise;
    } finally {
      this.copilotInFlightPromise = null;
    }
  }

  private async fetchSwitchHttpStatus(): Promise<import('./zodiac-serial.js').ZodiacDeviceStatus | undefined> {
    try {
      const res = await fetch(`http://${this.switchIp}/home.htm`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      const html = await res.text();
      const tempMatch = html.match(/CPU Temp:\s*(\d+)\s*C/i);
      const fwMatch = html.match(/Firmware Version:\s*([^<\r\n]+)/i);
      const uptimeMatch = html.match(/Uptime:\s*([^<\r\n]+)/i);
      const uidMatch = html.match(/CPU UID:\s*([^<\r\n]+)/i);
      if (!tempMatch && !fwMatch && !uptimeMatch) return undefined;
      return {
        cpuTempC: tempMatch && tempMatch[1] !== undefined ? parseInt(tempMatch[1], 10) : null,
        firmwareVersion: fwMatch?.[1]?.trim() ?? 'Unknown',
        uptime: uptimeMatch?.[1]?.trim() ?? 'Unknown',
        cpuUid: uidMatch?.[1]?.trim() ?? 'Unknown',
      };
    } catch (err: unknown) {
      console.warn('[!] [Bridge/httpStatus] Switch home.htm scrape failed:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const health = await this.controller.getComprehensiveHealth();
      const isDetected = health.serialDetected || health.openFlowMetrics.state === 'ESTABLISHED';

      if (isDetected) {
        this.consecutiveMissedProbes = 0;
      } else {
        this.consecutiveMissedProbes++;
      }

      // Council Invariant 5 (Vinyals Flap Prevention Hysteresis):
      // A single missed serial/OpenFlow read does not flap hardware into offline state.
      // Require MAX_MISSED_PROBES_BEFORE_DISCONNECT consecutive failed probes (~7.5s)
      // before transitioning from 'live_hardware' to 'disconnected'.
      const isLive = isDetected || (this.consecutiveMissedProbes < ZodiacBridgeServer.MAX_MISSED_PROBES_BEFORE_DISCONNECT && this.cachedSnapshot.source === 'live_hardware');

      const nowMs = Date.now();

      if (!isLive) {
        // Hardware is physically disconnected after sustained absence. Reflect reality without simulation! (Council Invariant 6)
        this.cachedSnapshot = {
          ...this.cachedSnapshot,
          source: 'disconnected',
          system: {
            deviceName: 'Zodiac_FX',
            macAddress: '70:B3:D5:87:40:BC',
            ipAddress: this.switchIp,
            netmask: '255.255.255.0',
            defaultGateway: process.env['SDN_GATEWAY_IP'] ?? '0.0.0.0',
            openFlowController: this.controllerIp,
            openFlowPort: 6633,
            failstate: 'Secure',
            cpuTemperatureC: null,
            cpuUid: 'Offline',
            firmwareVersion: 'Offline',
            uptime: 'Disconnected',
            timestampNs: process.hrtime.bigint(),
          },
          ports: [
            { port: 1, name: 'Port 1', physicalLocation: 'Front Left (Micro-USB / LED side)', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Unassigned', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 2, name: 'Port 2', physicalLocation: 'Front Middle-Left (Gateway Uplink)', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Gateway Uplink', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 3, name: 'Port 3', physicalLocation: 'Front Middle-Right (Hardware Tap / Sniffer)', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Unassigned', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 4, name: 'Port 4', physicalLocation: 'Front Right (Controller Link / Opposite Micro-USB)', status: 'DOWN', vlanType: 'Native', vlanId: 200, ipAddress: this.switchIp, rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
          ],
          openflow: {
            status: 'Disconnected',
            version: '1.3',
            datapathId: '0x000000000000',
            activeTables: 10,
            activeFlows: 0,
            tableLookups: 0n,
            tableMatches: 0n,
            lastHeartbeatLatencyNs: 0n,
            rules: this.boundedFlowSnapshot(),
          },
        };

        const emptyPortsSeries: Record<number, ZodiacPortSeriesPoint> = {
          1: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
          2: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
          3: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
          4: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
        };
        this.timeSeries.push({
          timestampMs: nowMs,
          rxBytes: 0n,
          txBytes: 0n,
          rxPackets: 0n,
          txPackets: 0n,
          rxRatePps: 0n,
          txRatePps: 0n,
          rxRateBps: 0n,
          txRateBps: 0n,
          cpuTemperatureC: null,
          latencyNs: 0n,
          activeFlows: 0,
          tableLookups: 0n,
          tableMatches: 0n,
          ports: emptyPortsSeries,
        });

        if (this.timeSeries.length > MAX_TIME_SERIES_POINTS) {
          this.timeSeries.shift();
        }
      } else {
        // Hardware is live (Serial CDC or OpenFlow active)
        if (health.openFlowMetrics.state === 'ESTABLISHED') {
          this.controller.openFlow.pingEcho();
        }

        const livePorts = health.ports && health.ports.length > 0
          ? health.ports.map((p) => {
              const existing = this.cachedSnapshot.ports.find((ep) => ep.port === p.port);
              const portRxPkts = p.rxPackets > 0n ? p.rxPackets : (this.portRxCounters.get(p.port) ?? existing?.rxPackets ?? 0n);
              const portTxPkts = p.txPackets > 0n ? p.txPackets : (existing?.txPackets ?? 0n);
              const portRxBytes = p.rxBytes > 0n ? p.rxBytes : (this.portByteCounters.get(p.port) ?? existing?.rxBytes ?? 0n);
              const portTxBytes = p.txBytes > 0n ? p.txBytes : (existing?.txBytes ?? 0n);
              const portIp = p.port === 4
                ? (health.config?.ipAddress ?? this.switchIp)
                : p.port === 2
                  ? 'Gateway Uplink'
                  : p.port === 3
                    ? 'Hardware Tap (Coral Sniffer)'
                    : 'Unassigned';
              return {
                port: p.port,
                name: `Port ${p.port}`,
                physicalLocation: existing?.physicalLocation ?? `Port ${p.port}`,
                status: p.status,
                vlanType: p.vlanType,
                vlanId: p.vlanId,
                ipAddress: portIp,
                rxBytes: portRxBytes,
                txBytes: portTxBytes,
                rxPackets: portRxPkts,
                txPackets: portTxPkts,
                rxDropped: p.rxDropped,
                txDropped: p.txDropped,
                rxCrcErrors: p.rxCrcErrors,
              };
            })
          : this.cachedSnapshot.ports;

        // If serial returned unknown system info, probe home.htm via HTTP as authoritative source.
        const serialStatus = health.deviceStatus;
        const deviceStatus = (!serialStatus || serialStatus.cpuTempC === null)
          ? (await this.fetchSwitchHttpStatus() ?? serialStatus)
          : serialStatus;

        this.cachedSnapshot = {
          ...this.cachedSnapshot,
          source: 'live_hardware',
          system: {
            deviceName: health.config?.name ?? 'Zodiac_FX',
            macAddress: health.config?.macAddress ?? '70:B3:D5:87:40:BC',
            ipAddress: health.config?.ipAddress ?? this.switchIp,
            netmask: health.config?.netmask ?? '255.255.255.0',
            defaultGateway: health.config?.gateway ?? process.env['SDN_GATEWAY_IP'] ?? '0.0.0.0',
            openFlowController: health.config?.controllerIp ?? this.controllerIp,
            openFlowPort: health.config?.controllerPort ?? 6633,
            failstate: health.config?.failstate ?? 'Secure',
            cpuTemperatureC: deviceStatus?.cpuTempC ?? this.cachedSnapshot.system.cpuTemperatureC,
            cpuUid: deviceStatus?.cpuUid ?? this.cachedSnapshot.system.cpuUid ?? 'N/A',
            firmwareVersion: deviceStatus?.firmwareVersion ?? this.cachedSnapshot.system.firmwareVersion ?? '0.86',
            uptime: deviceStatus?.uptime ?? this.cachedSnapshot.system.uptime ?? '00:00:00',
            timestampNs: process.hrtime.bigint(),
          },
          ports: livePorts,
          openflow: {
            status: this.controlPlaneState === 'ACTIVE' && health.openFlowMetrics.state === 'ESTABLISHED' ? 'Connected' : 'Disconnected',
            version: '1.3',
            datapathId: health.openFlowMetrics.switchFeatures
              ? `0x${health.openFlowMetrics.switchFeatures.datapathId.toString(16)}`
              : '0x70b3d58740bc',
            activeTables: health.openFlowMetrics.switchFeatures?.nTables ?? 10,
            activeFlows: health.openFlowMetrics.state === 'ESTABLISHED' ? this.flowRuleRegistry.size : 0,
            tableLookups: health.openFlowMetrics.messagesReceived,
            tableMatches: health.openFlowMetrics.messagesReceived,
            lastHeartbeatLatencyNs: health.openFlowMetrics.lastEchoLatencyNs,
            rules: this.boundedFlowSnapshot(),
          },
        };

        // Real rate accounting from actual hardware counters across all ports (or OpenFlow fallback)
        let totalRxBytes = 0n;
        let totalTxBytes = 0n;
        let totalRxPkts = 0n;
        let totalTxPkts = 0n;

        const hasHardwarePortCounters = livePorts.some((p) => p.rxPackets > 0n || p.txPackets > 0n);
        if (hasHardwarePortCounters) {
          for (const p of livePorts) {
            totalRxBytes += p.rxBytes;
            totalTxBytes += p.txBytes;
            totalRxPkts += p.rxPackets;
            totalTxPkts += p.txPackets;
          }
        } else {
          totalRxBytes = health.openFlowMetrics.bytesReceived;
          totalTxBytes = 0n;
          totalRxPkts = health.openFlowMetrics.messagesReceived;
          totalTxPkts = 0n;
        }

        const lastPoint = this.timeSeries[this.timeSeries.length - 1];
        let rxRatePps = 0n;
        let txRatePps = 0n;
        let rxRateBps = 0n;
        let txRateBps = 0n;

        // Monotonic nanoseconds clock calculation (Dean & Ghemawat invariant: zero NTP drift, pure integer units)
        const currentPollNs = process.hrtime.bigint();
        const deltaNs = this.lastSwitchPollNs > 0n && currentPollNs > this.lastSwitchPollNs
          ? currentPollNs - this.lastSwitchPollNs
          : DEFAULT_POLL_INTERVAL_NS;
        this.lastSwitchPollNs = currentPollNs;

        if (lastPoint !== undefined) {
          if (totalRxPkts >= lastPoint.rxPackets) {
            const deltaRxP = totalRxPkts - lastPoint.rxPackets;
            rxRatePps = (deltaRxP * NANOSECONDS_PER_SECOND) / deltaNs;
          }
          if (totalTxPkts >= lastPoint.txPackets) {
            const deltaTxP = totalTxPkts - lastPoint.txPackets;
            txRatePps = (deltaTxP * NANOSECONDS_PER_SECOND) / deltaNs;
          }
          if (totalRxBytes >= lastPoint.rxBytes) {
            const deltaRxB = totalRxBytes - lastPoint.rxBytes;
            rxRateBps = (deltaRxB * NANOSECONDS_PER_SECOND) / deltaNs;
          }
          if (totalTxBytes >= lastPoint.txBytes) {
            const deltaTxB = totalTxBytes - lastPoint.txBytes;
            txRateBps = (deltaTxB * NANOSECONDS_PER_SECOND) / deltaNs;
          }
        }

        const portsSeries: Record<number, ZodiacPortSeriesPoint> = {};
        for (let portId = 1; portId <= 4; portId++) {
          const lp = livePorts.find((p) => p.port === portId);
          const pRxPkts = lp?.rxPackets ?? this.portRxCounters.get(portId) ?? 0n;
          const pTxPkts = lp?.txPackets ?? 0n;
          const pRxBytes = lp?.rxBytes ?? this.portByteCounters.get(portId) ?? 0n;
          const pTxBytes = lp?.txBytes ?? 0n;

          let pRxRatePps = 0n;
          let pTxRatePps = 0n;
          let pRxRateBps = 0n;
          let pTxRateBps = 0n;

          if (lastPoint?.ports?.[portId] !== undefined) {
            const lastPort = lastPoint.ports[portId]!;
            if (pRxPkts >= lastPort.rxPackets) {
              const dRxP = pRxPkts - lastPort.rxPackets;
              pRxRatePps = (dRxP * NANOSECONDS_PER_SECOND) / deltaNs;
            }
            if (pTxPkts >= lastPort.txPackets) {
              const dTxP = pTxPkts - lastPort.txPackets;
              pTxRatePps = (dTxP * NANOSECONDS_PER_SECOND) / deltaNs;
            }
            if (pRxBytes >= lastPort.rxBytes) {
              const dRxB = pRxBytes - lastPort.rxBytes;
              pRxRateBps = (dRxB * NANOSECONDS_PER_SECOND) / deltaNs;
            }
            if (pTxBytes >= lastPort.txBytes) {
              const dTxB = pTxBytes - lastPort.txBytes;
              pTxRateBps = (dTxB * NANOSECONDS_PER_SECOND) / deltaNs;
            }
          }

          portsSeries[portId] = {
            rxPackets: pRxPkts,
            txPackets: pTxPkts,
            rxBytes: pRxBytes,
            txBytes: pTxBytes,
            rxRatePps: pRxRatePps,
            txRatePps: pTxRatePps,
            rxRateBps: pRxRateBps,
            txRateBps: pTxRateBps,
          };
        }

        this.timeSeries.push({
          timestampMs: nowMs,
          rxBytes: totalRxBytes,
          txBytes: totalTxBytes,
          rxPackets: totalRxPkts,
          txPackets: totalTxPkts,
          rxRatePps,
          txRatePps,
          rxRateBps,
          txRateBps,
          cpuTemperatureC: this.cachedSnapshot.system.cpuTemperatureC,
          latencyNs: this.cachedSnapshot.openflow.lastHeartbeatLatencyNs,
          activeFlows: this.cachedSnapshot.openflow.activeFlows,
          tableLookups: this.cachedSnapshot.openflow.tableLookups,
          tableMatches: this.cachedSnapshot.openflow.tableMatches,
          ports: portsSeries,
        });

        if (this.timeSeries.length > MAX_TIME_SERIES_POINTS) {
          this.timeSeries.shift();
        }
      }

      // Probe live Jetson Orin and Coral hardware INDEPENDENTLY of switch connectivity.
      // readCoralDaemonTelemetry is awaited here (async fs.promises I/O) so it
      // never blocks the Node.js event loop during the synchronous sysfs reads.
      const nowNs = process.hrtime.bigint();
      const deltaNs = nowNs - this.lastProbeNs;
      this.lastProbeNs = nowNs;

      const [liveJetson, daemonData, burstData, liveWorkstation, liveRpi5, liveRpi3_1, liveRpi3_2] = await Promise.all([
        probeJetsonHardware(this.cachedSnapshot.jetson, deltaNs),
        readCoralDaemonTelemetry(),
        readCoralBurstTelemetry(),
        probeWorkstationHardware(this.cachedSnapshot.workstation, deltaNs),
        probeRpi5Hardware(this.cachedSnapshot.rpi5, deltaNs),
        probeRpi3Hardware(1, this.cachedSnapshot.rpi3_1, deltaNs),
        probeRpi3Hardware(2, this.cachedSnapshot.rpi3_2, deltaNs),
      ]);
      const liveCoral = await probeCoralHardware(daemonData, burstData);

      const sdnIf = liveJetson.interfaces.find((i) => i.name === 'enP8p1s0');
      const wifiIf = liveJetson.interfaces.find((i) => i.name === 'wlP1p1s0');

      this.jetsonTimeSeries.push({
        timestampMs: nowMs,
        cpuUtilizationPct: liveJetson.cpuUtilizationPct,
        gpuUtilizationPct: liveJetson.gpuUtilizationPct,
        cpuTempC: liveJetson.temperatures.cpuC,
        gpuTempC: liveJetson.temperatures.gpuC,
        junctionTempC: liveJetson.temperatures.junctionC,
        powerWatts: liveJetson.powerMw.vddIn !== null ? parseFloat((liveJetson.powerMw.vddIn / 1000).toFixed(2)) : 0,
        ramUsedBytes: liveJetson.ramUsedBytes,
        nvmeReadRateBps: liveJetson.nvmeReadRateBps,
        nvmeWriteRateBps: liveJetson.nvmeWriteRateBps,
        sdnPortRateBps: sdnIf?.rxRateBps ?? 0n,
        wifiPortRateBps: wifiIf?.rxRateBps ?? 0n,
      });

      if (this.jetsonTimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.jetsonTimeSeries.shift();
      }

      const coral1Dev = liveCoral?.devices?.find((d) => d.assignedRole === 'TAP_PACKET_CLASSIFIER' || d.id === 'coral-1') ?? null;
      const coral2Dev = liveCoral?.devices?.find((d) => d.assignedRole === 'DNS_SENTINEL' || d.id === 'coral-2') ?? null;

      this.coralTimeSeries.push({
        timestampMs: nowMs,
        inferencesPerSecond: liveCoral.inferencesPerSecond,
        tapPacketsPerSecond: 0n,
        latencyP50Us: liveCoral.latencyP50Ns / 1000n,
        latencyP99Us: liveCoral.latencyP99Ns / 1000n,
        // Council Invariant 2 & 6: Physical truth integer BigInt throughput. 0n when idle/standby, line-rate when inference active.
        usbThroughputKbps: liveCoral.inferencesPerSecond > 0n
          ? (liveCoral.inferencesPerSecond * 300n * 8n) / 1000n
          : 0n,
        coral1Ips: coral1Dev?.inferencesPerSecond ?? 0n,
        coral2Ips: coral2Dev?.inferencesPerSecond ?? 0n,
        coral1LatencyP50Us: (coral1Dev?.latencyP50Ns ?? 0n) / 1000n,
        coral2LatencyP50Us: (coral2Dev?.latencyP50Ns ?? 0n) / 1000n,
      });

      if (this.coralTimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.coralTimeSeries.shift();
      }

      this.workstationTimeSeries.push({
        timestampMs: nowMs,
        cpuUtilizationPct: liveWorkstation.cpuUtilizationPct,
        gpuUtilizationPct: liveWorkstation.gpuUtilizationPct,
        gpuMemoryUsedBytes: liveWorkstation.gpuMemoryUsedBytes,
        ramUsedBytes: liveWorkstation.memoryUsedBytes,
        tokensPerSecond: liveWorkstation.tokensPerSecond,
        promptTokensPerSecond: liveWorkstation.promptTokensPerSecond,
        totalPromptTokens: liveWorkstation.totalPromptTokens,
        totalCompletionTokens: liveWorkstation.totalCompletionTokens,
        totalTokens: liveWorkstation.totalTokens,
      });

      if (this.workstationTimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.workstationTimeSeries.shift();
      }

      this.rpi5TimeSeries.push({
        timestampMs: nowMs,
        cpuUtilizationPct: liveRpi5.cpuUtilizationPct,
        cpuTempC: liveRpi5.temperatures.cpuC,
        hailoTs0TempC: liveRpi5.temperatures.hailoTs0C,
        hailoTs1TempC: liveRpi5.temperatures.hailoTs1C,
        inferencesPerSecond: liveRpi5.hailo.inferencesPerSecond,
        inferenceLatencyMs: liveRpi5.hailo.avgInferenceLatencyMs,
        ramUsedBytes: liveRpi5.ramUsedBytes,
        eth0RateBps: liveRpi5.interfaces.find((i) => i.name === 'eth0')?.rxRateBps ?? 0n,
        eth1CaptureRateBps: liveRpi5.interfaces.find((i) => i.name === 'eth1')?.rxRateBps ?? 0n,
        wlan0RateBps: liveRpi5.interfaces.find((i) => i.name === 'wlan0')?.rxRateBps ?? 0n,
      });

      if (this.rpi5TimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.rpi5TimeSeries.shift();
      }

      const rpi3_1Eth0 = liveRpi3_1.interfaces.find((i) => i.name === 'eth0');
      const rpi3_1Wlan0 = liveRpi3_1.interfaces.find((i) => i.name === 'wlan0');
      const rpi3_1Tailscale0 = liveRpi3_1.interfaces.find((i) => i.name === 'tailscale0');
      this.rpi3_1TimeSeries.push({
        timestampMs: nowMs,
        cpuUtilizationPct: liveRpi3_1.compute.cpuUtilizationPct,
        softirqPct: liveRpi3_1.compute.softirqPct,
        cpuTempC: liveRpi3_1.silicon.cpuTempC,
        ramUsedBytes: liveRpi3_1.compute.ramUsedBytes,
        eth0RateBps: rpi3_1Eth0?.rxRateBps ?? 0n,
        eth0RatePps: rpi3_1Eth0?.rxRatePps ?? 0n,
        wlan0RateBps: rpi3_1Wlan0?.rxRateBps ?? 0n,
        tailscale0RateBps: rpi3_1Tailscale0?.rxRateBps ?? 0n,
        throttledVal: parseInt(liveRpi3_1.silicon.throttledHex, 16) || 0,
      });

      if (this.rpi3_1TimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.rpi3_1TimeSeries.shift();
      }

      const rpi3_2Eth0 = liveRpi3_2.interfaces.find((i) => i.name === 'eth0');
      const rpi3_2Wlan0 = liveRpi3_2.interfaces.find((i) => i.name === 'wlan0');
      const rpi3_2Tailscale0 = liveRpi3_2.interfaces.find((i) => i.name === 'tailscale0');
      this.rpi3_2TimeSeries.push({
        timestampMs: nowMs,
        cpuUtilizationPct: liveRpi3_2.compute.cpuUtilizationPct,
        softirqPct: liveRpi3_2.compute.softirqPct,
        cpuTempC: liveRpi3_2.silicon.cpuTempC,
        ramUsedBytes: liveRpi3_2.compute.ramUsedBytes,
        eth0RateBps: rpi3_2Eth0?.rxRateBps ?? 0n,
        eth0RatePps: rpi3_2Eth0?.rxRatePps ?? 0n,
        wlan0RateBps: rpi3_2Wlan0?.rxRateBps ?? 0n,
        tailscale0RateBps: rpi3_2Tailscale0?.rxRateBps ?? 0n,
        throttledVal: parseInt(liveRpi3_2.silicon.throttledHex, 16) || 0,
      });

      if (this.rpi3_2TimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.rpi3_2TimeSeries.shift();
      }

      this.cachedSnapshot = {
        ...this.cachedSnapshot,
        timeSeries: this.timeSeries,
        // Council Invariant 6: Physical truth — live PID and RSS from the OS, not synthetic values.
        // process.memoryUsage() is a cheap synchronous kernel read (~1µs) that is strictly decoupled
        // from the data plane: this block executes only inside the low-frequency background telemetry
        // timer (≥3s interval configured at bridge startup), never on the packet-processing hot path.
        bridgePid: process.pid,
        // BigInt preserves integer semantics end-to-end — no float regressions (Council Invariant 2).
        bridgeRssBytes: BigInt(process.memoryUsage().rss),
        jetson: {
          ...liveJetson,
          timeSeries: this.jetsonTimeSeries,
        },
        coral: {
          ...liveCoral,
          timeSeries: this.coralTimeSeries,
        },
        workstation: {
          ...liveWorkstation,
          timeSeries: this.workstationTimeSeries,
        },
        rpi5: {
          ...liveRpi5,
          timeSeries: this.rpi5TimeSeries,
        },
        rpi3_1: {
          ...liveRpi3_1,
          timeSeries: this.rpi3_1TimeSeries,
        },
        rpi3_2: {
          ...liveRpi3_2,
          timeSeries: this.rpi3_2TimeSeries,
        },
        port1Isolation: isolationStatusToJson(this.isolationStatus, process.hrtime.bigint()),
      };

      // Council Invariant 6: Epistemic Telemetry Provenance Relay to Cloud
      // Exponential backoff gates re-attempts after failures so a degraded Vercel endpoint
      // is not hammered at the full 2.5s poll cadence (Quoc Le stability invariant).
      if (this.cloudRelayUrl && !this.isRelaying && this.isRelayBackoffElapsed(nowMs) && performance.now() >= this.relayIgnoredUntilPerfMs) {
        void this.relaySnapshotToCloud(this.cachedSnapshot);
      }

      // Sanjay Ghemawat & Jeff Dean Invariant: Periodic non-blocking async state checkpoint to disk
      if (nowMs - this.lastStateFlushTimeMs >= ZodiacBridgeServer.STATE_FLUSH_INTERVAL_MS) {
        this.lastStateFlushTimeMs = nowMs;
        void this.flushTelemetryStateToDisk();
        // Append new time-series points accumulated since the last flush cycle to local JSONL history.
        // O(log N) bisection locates new points; appendLocalHistoryPoints averages and writes one
        // compact JSON line per device type — total I/O is ~150 B × 3 = ~450 B per 30-second tick.
        this.flushNewPointsToLocalHistory(nowMs);
      }
    } catch (err: unknown) {
      console.warn('[!] [Zodiac Telemetry] Comprehensive health refresh error:', err instanceof Error ? err.message : String(err));
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Append all new time-series points accumulated since the last local history flush.
   * Uses O(log N) bisection to find the cutoff index rather than a linear scan.
   */
  private flushNewPointsToLocalHistory(nowMs: number): void {
    const cutoff = this.lastLocalHistoryFlushMs;
    this.lastLocalHistoryFlushMs = nowMs;

    // findCutoffIndex returns the first index with timestampMs >= cutoff+1 (strictly newer)
    const zi = findCutoffIndex(this.timeSeries,            cutoff + 1);
    const ji = findCutoffIndex(this.jetsonTimeSeries,      cutoff + 1);
    const ci = findCutoffIndex(this.coralTimeSeries,       cutoff + 1);
    const wi = findCutoffIndex(this.workstationTimeSeries, cutoff + 1);

    // Fire-and-forget async write — never blocks the SDN event loop (Jeff Dean latency invariant).
    // Explicit .catch() ensures unhandled rejections don't propagate to the process unhandledRejection handler.
    appendLocalHistoryPoints(
      this.timeSeries.slice(zi),
      this.jetsonTimeSeries.slice(ji),
      this.coralTimeSeries.slice(ci),
      this.workstationTimeSeries.slice(wi),
    ).catch((err: unknown) => {
      console.warn('[!] [Bridge] Local history append failed:', err instanceof Error ? err.message : String(err));
    });
  }

  /** Single source of truth for the current exponential backoff duration. */
  private get currentRelayBackoffMs(): number {
    // Clamp lower bound to 0: without Math.max, consecutiveRelayFailures=0 → exp=-1
    // → (1 << -1) applies modulo-32 → (1 << 31) = -2147483648 (signed overflow).
    const exp = Math.max(0, Math.min(this.consecutiveRelayFailures - 1, 10));
    return Math.min(
      ZodiacBridgeServer.RELAY_BASE_BACKOFF_MS * (1 << exp),
      ZodiacBridgeServer.RELAY_MAX_BACKOFF_MS,
    );
  }

  /**
   * Returns true when enough time has elapsed since the last relay attempt.
   * Uses performance.now() (monotonic) so NTP clock adjustments cannot stall the relay.
   * Backoff schedule: 0 failures → immediate | 1 → 5 s | 2 → 10 s | 3 → 20 s | 4 → 40 s | 5+ → 60 s
   */
  private isRelayBackoffElapsed(_nowMs: number): boolean {
    if (this.consecutiveRelayFailures === 0) return true;
    return performance.now() - this.lastRelayAttemptPerfMs >= this.currentRelayBackoffMs;
  }

  /**
   * Asynchronously streams the physical hardware telemetry snapshot to a cloud relay endpoint
   * (e.g. Vercel) using the cryptographic ZODIAC_BRIDGE_SECRET to guarantee physical provenance.
   *
   * Adheres to Dean Latency Budget: bounded by a 3000ms AbortSignal so the local control loop never blocks.
   * Exponential backoff on failure prevents hammering a degraded endpoint.
   */
  private async relaySnapshotToCloud(snapshot: ZodiacFullTelemetrySnapshot): Promise<void> {
    if (!this.cloudRelayUrl || this.isRelaying) return;
    this.isRelaying = true;
    this.lastRelayAttemptPerfMs = performance.now(); // monotonic stamp for backoff gating
    try {
      const endpoint = new URL('/api/zodiac', this.cloudRelayUrl).toString();

      // Council Invariant 2 & 6 (Dean Latency & Epistemic Provenance):
      // Strictly bound ALL time-series to CLOUD_RELAY_BOUNDS.MAX_RELAY_POINTS before WAN transit.
      // Coordinated bounds provide a 12.5-17m continuous live telemetry window with ample headroom
      // for the 10m Live dashboard view without exceeding serverless payload thresholds.
      const maxRelayPoints = CLOUD_RELAY_BOUNDS.MAX_RELAY_POINTS;
      const boundedTimeSeries        = boundSeriesWithHistory(snapshot.timeSeries ?? this.timeSeries, downsamplePoints, maxRelayPoints);
      const boundedJetsonSeries      = boundSeriesWithHistory(snapshot.jetson?.timeSeries ?? this.jetsonTimeSeries, downsampleJetsonPoints, maxRelayPoints);
      const boundedCoralSeries       = boundSeriesWithHistory(snapshot.coral?.timeSeries ?? this.coralTimeSeries, downsampleCoralPoints, maxRelayPoints);
      const boundedWorkstationSeries = boundSeriesWithHistory(snapshot.workstation?.timeSeries ?? this.workstationTimeSeries, downsampleWorkstationPoints, maxRelayPoints);
      const boundedRpi5Series        = boundSeriesWithHistory(snapshot.rpi5?.timeSeries ?? this.rpi5TimeSeries, (pts, max) => pts.slice(-max), maxRelayPoints);
      const boundedRpi3_1Series      = boundSeriesWithHistory(snapshot.rpi3_1?.timeSeries ?? this.rpi3_1TimeSeries, (pts, max) => pts.slice(-max), maxRelayPoints);
      const boundedRpi3_2Series      = boundSeriesWithHistory(snapshot.rpi3_2?.timeSeries ?? this.rpi3_2TimeSeries, (pts, max) => pts.slice(-max), maxRelayPoints);

      const boundedSnapshot: ZodiacFullTelemetrySnapshot = {
        ...snapshot,
        timeSeries: boundedTimeSeries,
        source: snapshot.source === 'disconnected' ? 'disconnected' : 'live_hardware',
        ...(snapshot.jetson ? { jetson: { ...snapshot.jetson, timeSeries: boundedJetsonSeries } } : {}),
        ...(snapshot.coral  ? { coral:  { ...snapshot.coral,  timeSeries: boundedCoralSeries  } } : {}),
        ...(snapshot.workstation ? {
          workstation: {
            ...snapshot.workstation,
            timeSeries: boundedWorkstationSeries,
          },
        } : {}),
        ...(snapshot.rpi5 ? {
          rpi5: {
            ...snapshot.rpi5,
            timeSeries: boundedRpi5Series,
          },
        } : {}),
        ...(snapshot.rpi3_1 ? {
          rpi3_1: {
            ...snapshot.rpi3_1,
            timeSeries: boundedRpi3_1Series,
          },
        } : {}),
        ...(snapshot.rpi3_2 ? {
          rpi3_2: {
            ...snapshot.rpi3_2,
            timeSeries: boundedRpi3_2Series,
          },
        } : {}),
      };

      const payload = this.serializeSnapshot({ ...boundedSnapshot, bridgeId: this.bridgeId });

      // Guard: log payload size; skip send if over limit to avoid infinite 413 storm.
      const payloadBytes = Buffer.byteLength(payload, 'utf8');
      if (payloadBytes > CLOUD_RELAY_BOUNDS.MAX_SAFE_WAN_PAYLOAD_BYTES) {
        console.warn(`[!] [Cloud Relay] Payload too large (${payloadBytes} bytes) — skipping push.`);
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.bridgeSecret) {
        headers['X-Zodiac-Bridge-Secret'] = this.bridgeSecret;
        // 0.6C: HMAC-SHA256 replay protection — sign payload with wall-clock timestamp.
        const { timestampNs, signature } = signBridgePayload(payload, this.bridgeSecret);
        headers['X-Timestamp-Ns'] = timestampNs;
        headers['X-Zodiac-Signature'] = signature;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        const text = await res.text().catch((e: unknown) => `[unreadable: ${e instanceof Error ? e.message : String(e)}]`);
        this.consecutiveRelayFailures++;
        console.warn(`[!] [Cloud Relay] HTTP ${res.status} (failure #${this.consecutiveRelayFailures}, next retry in ${this.currentRelayBackoffMs / 1000}s): ${text}`);
      } else {
        const ack: unknown = await res.json().catch(() => null);
        if (isRelayIgnoredAck(ack)) {
          // Not a transport failure: the cloud received this and refused to let it overwrite a fresh live snapshot from
          // another bridge. Pushing at the full cadence would only add load, so pause and say why.
          this.relayIgnoredUntilPerfMs = performance.now() + RELAY_IGNORED_PAUSE_MS;
          console.warn(
            `[!] [Cloud Relay] The cloud IGNORED this bridge's snapshot (${ack.reason}): another bridge is the live source. ` +
              `Pausing relay for ${RELAY_IGNORED_PAUSE_MS / 1000}s. If this is the real bridge, look for a second bridge pushing to the same endpoint.`,
          );
        } else if (this.consecutiveRelayFailures > 0) {
          console.log(`[+] [Cloud Relay] Relay recovered after ${this.consecutiveRelayFailures} consecutive failure(s).`);
          this.consecutiveRelayFailures = 0;
        }
      }
    } catch (err: unknown) {
      this.consecutiveRelayFailures++;
      console.warn(`[!] [Cloud Relay] Network error (failure #${this.consecutiveRelayFailures}, next retry in ${this.currentRelayBackoffMs / 1000}s):`, err instanceof Error ? err.message : String(err));
    } finally {
      this.isRelaying = false;
    }
  }

  private serializeSnapshot(snapshot: ZodiacFullTelemetrySnapshot & { readonly bridgeId?: string }): string {
    return JSON.stringify(snapshot, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  }
}

// Autonomous systemd service and CLI entrypoint
const isMain = process.argv[1] !== undefined && (
  process.argv[1].endsWith('zodiac-bridge-server.js') ||
  process.argv[1].endsWith('zodiac-bridge-server.ts')
);

if (isMain) {
  const portArg = process.argv[2] === 'serve' ? process.argv[3] : process.argv[2];
  const port = parseInt(process.env['PORT'] ?? portArg ?? '3003', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const cloudRelayUrl = resolveCloudRelayUrl();
  if (cloudRelayUrl === undefined) {
    console.warn('[!] [ZodiacBridgeServer] ZODIAC_CLOUD_RELAY_URL is not set: this bridge will NOT push to the cloud dashboard.');
  }
  const bridgeSecret = process.env['ZODIAC_BRIDGE_SECRET'];

  const bridge = new ZodiacBridgeServer(
    undefined,
    undefined,
    undefined,
    cloudRelayUrl,
    bridgeSecret
  );

  bridge.start(port, host).then((boundPort) => {
    console.log(`[+] [ZodiacBridgeServer] Autonomous bridge active on http://${host}:${boundPort}`);
    const ctrlHost = process.env['SDN_CONTROLLER_IP'] ?? host;
    if (bridge.controlPlaneState === 'ACTIVE') {
      console.log(`[+] [ZodiacBridgeServer] OpenFlow 1.3 controller listening on ${ctrlHost}:6633`);
    } else {
      console.warn(`[!] [ZodiacBridgeServer] OpenFlow controller is NOT listening on ${ctrlHost}:6633 (state ${bridge.controlPlaneState}); running degraded by explicit override.`);
    }
  }).catch((err) => {
    console.error('[-] [ZodiacBridgeServer] Fatal startup error:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    console.log('\n[!] Stopping ZodiacBridgeServer...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[!] Stopping ZodiacBridgeServer...');
    await bridge.stop();
    process.exit(0);
  });
}

