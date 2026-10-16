/**
 * workstation-agent.ts
 * MacBook M5 Hardware Telemetry Agent — Zodiac Agentic Era Networking
 *
 * Council Invariants Enforced:
 * - Anti-Simulation (Invariant 6): Only runs on darwin. Calls probeWorkstationHardware()
 *   which reads physical truth from ioreg IOAccelerator, node:os, Ollama /api/ps, and
 *   /tmp/zodiac-workstation-telemetry.json. Never synthesises hardware specs.
 * - Determinism (Invariant 2): All BigInt fields serialised as decimal strings, never floats.
 * - Fail-Closed (Invariant 3): Returns 503 with provenance-tagged error body on probe failure.
 * - Epistemic Provenance (Invariant 6): Every response carries source: 'live_hardware' and
 *   a monotonic timestampNs so consumers can detect stale data.
 *
 * Usage (macOS only):
 *   npm run workstation:agent
 *   WORKSTATION_AGENT_PORT=11435 npm run workstation:agent
 *   WORKSTATION_AGENT_HOST=100.x.y.z npm run workstation:agent   # bind one interface (default 0.0.0.0, every interface)
 *
 * To keep it running (start at login, restart on crash), install the LaunchAgent: deploy/macos/README.md.
 *
 * The Jetson reads from http://192.168.55.100:11435/api/hardware (USB-C tether)
 * or http://10.0.0.119:11435/api/hardware (Wi-Fi fallback).
 */

import http from 'node:http';
import os from 'node:os';
import { probeWorkstationHardware } from '../dist/sdn/hardware-probe.js';
import type { WorkstationTelemetrySnapshot } from '../dist/sdn/zodiac-telemetry.js';

// ── Council Invariant 6: Physical platform guard ─────────────────────────────
if (os.platform() !== 'darwin') {
  process.stderr.write(
    '[workstation-agent] FATAL: This agent may only run on macOS (darwin). ' +
    `Detected platform: ${os.platform()}. Exiting.\n`
  );
  process.exit(1);
}

const rawPort = parseInt(process.env['WORKSTATION_AGENT_PORT'] ?? '11435', 10);
// Sanjay Ghemawat - Bounds Rigor: Validate numeric parse and TCP port boundary [1, 65535].
const PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 11435;
// Which interface to listen on. UNSET means every interface (0.0.0.0): what a manual run has always done, which the
// USB-C tether and LAN paths rely on. On a laptop that serves hardware metrics, unauthenticated, to whatever network it
// joins, so the LaunchAgent binds the Tailscale address instead.
// Fail closed (Invariant 3): a value that IS set but invalid is a fatal error, never a quiet fall back to 0.0.0.0. A typo
// in the setting meant to narrow the bind must not widen it.
const hostFromEnv = process.env['WORKSTATION_AGENT_HOST'];
if (hostFromEnv !== undefined && !/^[A-Za-z0-9.-]{1,253}$/.test(hostFromEnv)) {
  process.stderr.write(
    `[workstation-agent] FATAL: WORKSTATION_AGENT_HOST ${JSON.stringify(hostFromEnv)} is not a valid IPv4 address or hostname. ` +
    'Refusing to start rather than listen on every interface. Unset it for the default, or fix it.\n'
  );
  process.exit(1);
}
const HOST = hostFromEnv ?? '0.0.0.0';
const PROBE_INTERVAL_MS = 3_000;

// ── Probe failure counter (Council Invariant 2: BigInt integer accounting) ───
let probeFailureCount = 0n;
let lastSnapshot: WorkstationTelemetrySnapshot | undefined;
let lastSnapshotNs = 0n;

/** Serialise BigInts as decimal strings — same pattern as bridge server serializeSnapshot(). */
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Run a fresh hardware probe and cache the result. */
async function refreshSnapshot(): Promise<void> {
  try {
    const snap = await probeWorkstationHardware(lastSnapshot);
    lastSnapshot = snap;
    lastSnapshotNs = process.hrtime.bigint();
  } catch (err) {
    probeFailureCount += 1n;
    process.stderr.write(
      `[workstation-agent] probeWorkstationHardware failed ` +
      `(total failures: ${probeFailureCount}): ` +
      `${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

// Prime the cache immediately before accepting requests.
await refreshSnapshot();

// Background refresh — recursive setTimeout prevents concurrent probe overlap
// if ioreg or Ollama probes spike beyond PROBE_INTERVAL_MS (Council Invariant 5).
let isProbing = false;
let refreshTimerHandle: ReturnType<typeof setTimeout> | undefined;

function scheduleNextRefresh(): void {
  refreshTimerHandle = setTimeout(async () => {
    if (!isProbing) {
      isProbing = true;
      try {
        await refreshSnapshot();
      } finally {
        isProbing = false;
      }
    }
    scheduleNextRefresh();
  }, PROBE_INTERVAL_MS);
  refreshTimerHandle.unref();
}

scheduleNextRefresh();

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  try {
    const origin = req.headers['origin'] ?? '';
    // Demis Hassabis - Fail-Closed Isolation: Match exact valid IP octets (0-255) for local tether and LAN subnets.
    const allowedOriginRe = /^https?:\/\/(?:192\.168\.55\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|10\.0\.0\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))(:\d+)?$/;
    if (typeof origin === 'string' && origin && allowedOriginRe.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url: URL;
    try {
      const rawHost = req.headers['host'];
      const host = (typeof rawHost === 'string' && rawHost.trim().length > 0) ? rawHost.trim() : 'localhost';
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request', message: 'Malformed request URL or host header' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        source: 'live_hardware',
        platform: os.platform(),
        agentVersion: '1.0.0',
        probeFailureCount: probeFailureCount.toString(),
        lastSnapshotAgeMs: lastSnapshotNs > 0n
          ? Number((process.hrtime.bigint() - lastSnapshotNs) / 1_000_000n)
          : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/hardware') {
      if (!lastSnapshot) {
        const body = JSON.stringify({
          source: 'disconnected',
          error: 'Hardware probe not yet available',
          probeFailureCount: probeFailureCount.toString(),
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      const ageMs = Number((process.hrtime.bigint() - lastSnapshotNs) / 1_000_000n);
      const envelope = {
        source: 'live_hardware',
        timestampNs: process.hrtime.bigint().toString(),
        snapshotAgeMs: ageMs,
        probeFailureCount: probeFailureCount.toString(),
        hardware: lastSnapshot,
      };

      const body = JSON.stringify(envelope, bigIntReplacer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[workstation-agent] Request handler exception: ${message}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error', message }));
    }
  }
});

server.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    // Backward compatible default (the USB-C tether and LAN paths rely on it), but say so: these metrics are unauthenticated.
    process.stderr.write(
      '[workstation-agent] WARNING: listening on every interface (0.0.0.0); hardware and Ollama metrics are served, ' +
      'unauthenticated, to any network this Mac joins. Set WORKSTATION_AGENT_HOST to the Tailscale address to narrow it ' +
      '(the LaunchAgent in deploy/macos/ does).\n'
    );
  }
  process.stdout.write(
    `[workstation-agent] Listening on ${HOST}:${PORT}\n` +
    `  /api/hardware — live Apple Silicon + Ollama telemetry\n` +
    `  /health       — agent liveness\n` +
    `  Probe interval: ${PROBE_INTERVAL_MS}ms · source: live_hardware\n`
  );
});

server.on('error', (err) => {
  process.stderr.write(`[workstation-agent] Server error: ${err.message}\n`);
  process.exit(1);
});

const shutdown = (): void => {
  clearTimeout(refreshTimerHandle);
  server.close(() => {
    process.stdout.write('[workstation-agent] Shutdown complete.\n');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
