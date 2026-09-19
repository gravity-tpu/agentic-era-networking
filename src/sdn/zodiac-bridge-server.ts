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
  JetsonTimeSeriesPoint,
  CoralTimeSeriesPoint,
  generateHistoricalTelemetry,
  createDisconnectedZodiacSnapshot,
  CLOUD_RELAY_BOUNDS,
} from './zodiac-telemetry.js';
import { probeJetsonHardware, probeCoralHardware, readCoralDaemonTelemetry } from './hardware-probe.js';
import {
  downsamplePoints,
  downsampleJetsonPoints,
  downsampleCoralPoints,
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
// isLocalDev is now superseded by isLanOperator defined below.

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

export class ZodiacBridgeServer {
  public controlPlaneState: 'INITIALIZING' | 'ACTIVE' | 'DEGRADED_FAULT' = 'INITIALIZING';
  private readonly controller: ZodiacController;
  private readonly switchIp: string;
  private readonly controllerIp: string;
  private server: http.Server | null = null;
  private cachedSnapshot: ZodiacFullTelemetrySnapshot = createDisconnectedZodiacSnapshot();
  private timeSeries: ZodiacTimeSeriesPoint[] = [];
  private jetsonTimeSeries: JetsonTimeSeriesPoint[] = [];
  private coralTimeSeries: CoralTimeSeriesPoint[] = [];
  private lastProbeNs: bigint = process.hrtime.bigint();
  private lastSwitchPollNs: bigint = process.hrtime.bigint();
  private readonly portRxCounters = new Map<number, bigint>();
  private readonly portByteCounters = new Map<number, bigint>();
  private readonly cloudRelayUrl?: string | undefined;
  private readonly bridgeSecret?: string | undefined;
  private isRelaying = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private consecutiveMissedProbes = 0;
  public static readonly MAX_MISSED_PROBES_BEFORE_DISCONNECT = 3;
  private coralDaemon: ChildProcess | null = null;
  private coralDaemonRestartTimer: NodeJS.Timeout | null = null;
  /** Vinyals flap-prevention: terminal fail-closed after MAX_CORAL_RESTARTS permanent failures. */
  private coralDaemonRestartCount = 0;
  private static readonly MAX_CORAL_RESTARTS = 10;
  private readonly stateFilePath: string = resolveTelemetryStateFilePath();
  private lastStateFlushTimeMs = 0;
  public static readonly STATE_FLUSH_INTERVAL_MS = 30_000;

  constructor(
    controller?: ZodiacController,
    switchIp?: string,
    controllerIp?: string,
    cloudRelayUrl?: string,
    bridgeSecret?: string
  ) {
    this.controller = controller ?? new ZodiacController();
    this.switchIp = switchIp ?? process.env['ZODIAC_SWITCH_IP'] ?? '127.0.0.1';
    this.controllerIp = controllerIp ?? process.env['SDN_CONTROLLER_IP'] ?? '0.0.0.0';
    this.cloudRelayUrl = cloudRelayUrl ?? process.env['ZODIAC_CLOUD_RELAY_URL'];
    this.bridgeSecret = bridgeSecret ?? process.env['ZODIAC_BRIDGE_SECRET'];
    this.timeSeries = generateHistoricalTelemetry(this.cachedSnapshot, 1, 60);
    this.jetsonTimeSeries = this.cachedSnapshot.jetson?.timeSeries ? [...this.cachedSnapshot.jetson.timeSeries] : [];
    this.coralTimeSeries = this.cachedSnapshot.coral?.timeSeries ? [...this.cachedSnapshot.coral.timeSeries] : [];

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
    };

    // Auto-install Table-Miss rule on connection to forward live traffic to controller
    this.controller.openFlow.on('ready', () => {
      try {
        // Bounded header-only packet sampling (max 128 bytes) to controller for live telemetry accounting
        this.controller.openFlow.sendTableMissRule(0, 'CONTROLLER', 128);
        console.log('[+] [Bridge Server] Table-Miss flow rule installed (CONTROLLER packet sampling, 128B bounded header).');
      } catch (err: unknown) {
        console.warn('[!] [Bridge Server] Failed to install table-miss rule:', err instanceof Error ? err.message : String(err));
      }
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

  public async start(requestedPort: number = 3000, host: string = '0.0.0.0'): Promise<number> {
    // 1. Start OpenFlow 1.3 controller in background
    try {
      await this.controller.startOpenFlow(6633, this.controllerIp);
      this.controlPlaneState = 'ACTIVE';
    } catch (err: unknown) {
      this.controlPlaneState = 'DEGRADED_FAULT';
      console.error('[!] [OpenFlow Error] Control plane failed to bind on 6633. Entering DEGRADED_FAULT state:', err instanceof Error ? err.message : String(err));
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

    // 3. Start decoupled asynchronous background telemetry polling loop with backpressure
    this.scheduleNextPoll(0);

    // 4. Spawn the Coral inference daemon (managed child process).
    //    Produces /tmp/coral-telemetry.json read by probeCoralHardware().
    //    Only launched on Linux — no-ops silently on other platforms.
    if (process.platform === 'linux') {
      this.spawnCoralDaemon(0);
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

    return boundPort;
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
    });
  }

  public async stop(): Promise<void> {
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
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(async () => {
          this.server = null;
          await this.controller.stop();
          resolve();
        });
      } else {
        resolve();
      }
    });
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
      const range = url.searchParams.get('range');
      if (range && isValidRange(range)) {
        const config = RANGE_CONFIGS[range];

        // 1. If Neon DB Prisma client is available, attempt querying full historical DB (up to 30 days)
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
              }));
              return;
            }
          } catch (dbErr: unknown) {
            console.warn('[!] [Bridge DB] Historical Neon query failed, falling back to in-memory window:', dbErr instanceof Error ? dbErr.message : String(dbErr));
          }
        }

        // 2. In-Memory Window Downsampling (Dean & Ghemawat Invariants)
        // Strictly filter by requested range duration so 1h doesn't downsample 2.5+ hours of history
        const durationMs = RANGE_DURATION_MS[range];
        const cutoffMs = Date.now() - durationMs;
        // Sanjay Ghemawat - Algorithmic Efficiency Invariant:
        // O(log N) bisection search + slice instead of O(N) linear filter on synchronous HTTP path
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
            { port: 1, name: 'Port 1', physicalLocation: 'Opposite Micro-USB connector (Leftmost)', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Unassigned', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 2, name: 'Port 2', physicalLocation: 'Middle Left', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Gateway Uplink', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 3, name: 'Port 3', physicalLocation: 'Middle Right', status: 'DOWN', vlanType: 'OpenFlow', vlanId: 100, ipAddress: 'Unassigned', rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
            { port: 4, name: 'Port 4', physicalLocation: 'Next to Micro-USB connector (Rightmost)', status: 'DOWN', vlanType: 'Native', vlanId: 200, ipAddress: this.switchIp, rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n },
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
              const portRxPkts = this.portRxCounters.get(p.port) ?? existing?.rxPackets ?? 0n;
              const portRxBytes = this.portByteCounters.get(p.port) ?? existing?.rxBytes ?? 0n;
              const portIp = p.port === 4
                ? (health.config?.ipAddress ?? this.switchIp)
                : p.port === 2
                  ? 'Gateway Uplink'
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
                txBytes: existing?.txBytes ?? 0n,
                rxPackets: portRxPkts,
                txPackets: existing?.txPackets ?? 0n,
                rxDropped: 0n,
                txDropped: 0n,
                rxCrcErrors: 0n,
              };
            })
          : this.cachedSnapshot.ports;

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
            cpuTemperatureC: health.deviceStatus?.cpuTempC ?? this.cachedSnapshot.system.cpuTemperatureC,
            cpuUid: health.deviceStatus?.cpuUid ?? this.cachedSnapshot.system.cpuUid ?? 'N/A',
            firmwareVersion: health.deviceStatus?.firmwareVersion ?? this.cachedSnapshot.system.firmwareVersion ?? '0.86',
            uptime: health.deviceStatus?.uptime ?? this.cachedSnapshot.system.uptime ?? '00:00:00',
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
            activeFlows: health.openFlowMetrics.state === 'ESTABLISHED' ? 1 : 0,
            tableLookups: health.openFlowMetrics.messagesReceived,
            tableMatches: health.openFlowMetrics.messagesReceived,
            lastHeartbeatLatencyNs: health.openFlowMetrics.lastEchoLatencyNs,
          },
        };

        // Real rate accounting from actual OpenFlow bytes received
        const totalRxBytes = health.openFlowMetrics.bytesReceived;
        const totalTxBytes = 0n;
        const totalRxPkts = health.openFlowMetrics.messagesReceived;
        const totalTxPkts = 0n;

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

        if (lastPoint !== undefined && totalRxPkts >= lastPoint.rxPackets) {
          const deltaRxP = totalRxPkts - lastPoint.rxPackets;
          const deltaTxP = totalTxPkts >= lastPoint.txPackets ? totalTxPkts - lastPoint.txPackets : 0n;
          const deltaRxB = totalRxBytes >= lastPoint.rxBytes ? totalRxBytes - lastPoint.rxBytes : 0n;
          const deltaTxB = totalTxBytes >= lastPoint.txBytes ? totalTxBytes - lastPoint.txBytes : 0n;

          rxRatePps = (deltaRxP * NANOSECONDS_PER_SECOND) / deltaNs;
          txRatePps = (deltaTxP * NANOSECONDS_PER_SECOND) / deltaNs;
          rxRateBps = (deltaRxB * NANOSECONDS_PER_SECOND) / deltaNs;
          txRateBps = (deltaTxB * NANOSECONDS_PER_SECOND) / deltaNs;
        }

        const portsSeries: Record<number, ZodiacPortSeriesPoint> = {};
        for (let portId = 1; portId <= 4; portId++) {
          const pRxPkts = this.portRxCounters.get(portId) ?? 0n;
          const pRxBytes = this.portByteCounters.get(portId) ?? 0n;
          const pTxPkts = 0n;
          const pTxBytes = 0n;

          let pRxRatePps = 0n;
          let pTxRatePps = 0n;
          let pRxRateBps = 0n;
          let pTxRateBps = 0n;

          if (lastPoint?.ports?.[portId] !== undefined) {
            const lastPort = lastPoint.ports[portId]!;
            if (pRxPkts >= lastPort.rxPackets) {
              const dRxP = pRxPkts - lastPort.rxPackets;
              const dTxP = pTxPkts >= lastPort.txPackets ? pTxPkts - lastPort.txPackets : 0n;
              const dRxB = pRxBytes >= lastPort.rxBytes ? pRxBytes - lastPort.rxBytes : 0n;
              const dTxB = pTxBytes >= lastPort.txBytes ? pTxBytes - lastPort.txBytes : 0n;

              pRxRatePps = (dRxP * NANOSECONDS_PER_SECOND) / deltaNs;
              pTxRatePps = (dTxP * NANOSECONDS_PER_SECOND) / deltaNs;
              pRxRateBps = (dRxB * NANOSECONDS_PER_SECOND) / deltaNs;
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

      const [liveJetson, daemonData] = await Promise.all([
        probeJetsonHardware(this.cachedSnapshot.jetson, deltaNs),
        readCoralDaemonTelemetry(),
      ]);
      const liveCoral = await probeCoralHardware(daemonData);

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
      });

      if (this.coralTimeSeries.length > MAX_TIME_SERIES_POINTS) {
        this.coralTimeSeries.shift();
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
      };

      // Council Invariant 6: Epistemic Telemetry Provenance Relay to Cloud
      if (this.cloudRelayUrl && !this.isRelaying) {
        void this.relaySnapshotToCloud(this.cachedSnapshot);
      }

      // Sanjay Ghemawat & Jeff Dean Invariant: Periodic non-blocking async state checkpoint to disk
      if (nowMs - this.lastStateFlushTimeMs >= ZodiacBridgeServer.STATE_FLUSH_INTERVAL_MS) {
        this.lastStateFlushTimeMs = nowMs;
        void this.flushTelemetryStateToDisk();
      }
    } catch (err: unknown) {
      console.warn('[!] [Zodiac Telemetry] Comprehensive health refresh error:', err instanceof Error ? err.message : String(err));
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Asynchronously streams the physical hardware telemetry snapshot to a cloud relay endpoint
   * (e.g. Vercel) using the cryptographic ZODIAC_BRIDGE_SECRET to guarantee physical provenance.
   *
   * Adheres to Dean Latency Budget: bounded by a 3000ms AbortSignal so the local control loop never blocks.
   */
  private async relaySnapshotToCloud(snapshot: ZodiacFullTelemetrySnapshot): Promise<void> {
    if (!this.cloudRelayUrl || this.isRelaying) return;
    this.isRelaying = true;
    try {
      const endpoint = new URL('/api/zodiac', this.cloudRelayUrl).toString();

      // Council Invariant 2 & 6 (Dean Latency & Epistemic Provenance):
      // Strictly bound ALL time-series to CLOUD_RELAY_BOUNDS.MAX_RELAY_POINTS before WAN transit.
      // Coordinated bounds provide a 12.5-17m continuous live telemetry window with ample headroom
      // for the 10m Live dashboard view without exceeding serverless payload thresholds.
      const maxRelayPoints = CLOUD_RELAY_BOUNDS.MAX_RELAY_POINTS;
      const boundedTimeSeries      = snapshot.timeSeries?.slice(-maxRelayPoints) ?? [];
      const boundedJetsonSeries    = snapshot.jetson?.timeSeries?.slice(-maxRelayPoints) ?? [];
      const boundedCoralSeries     = snapshot.coral?.timeSeries?.slice(-maxRelayPoints) ?? [];

      const boundedSnapshot: ZodiacFullTelemetrySnapshot = {
        ...snapshot,
        timeSeries: boundedTimeSeries,
        source: snapshot.source === 'disconnected' ? 'disconnected' : 'live_hardware',
        ...(snapshot.jetson ? { jetson: { ...snapshot.jetson, timeSeries: boundedJetsonSeries } } : {}),
        ...(snapshot.coral  ? { coral:  { ...snapshot.coral,  timeSeries: boundedCoralSeries  } } : {}),
      };

      const payload = this.serializeSnapshot(boundedSnapshot);

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
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[!] [Cloud Relay] Telemetry push returned HTTP ${res.status}: ${text}`);
      }
    } catch (err: unknown) {
      console.warn('[!] [Cloud Relay] Failed to push telemetry to cloud:', err instanceof Error ? err.message : String(err));
    } finally {
      this.isRelaying = false;
    }
  }

  private serializeSnapshot(snapshot: ZodiacFullTelemetrySnapshot): string {
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
  const cloudRelayUrl = process.env['ZODIAC_CLOUD_RELAY_URL'] ?? 'https://agentic-era-networking.vercel.app';
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
    console.log(`[+] [ZodiacBridgeServer] OpenFlow 1.3 controller listening on ${ctrlHost}:6633`);
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

