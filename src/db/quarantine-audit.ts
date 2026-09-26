/**
 * src/db/quarantine-audit.ts
 * Quarantine Audit Log — appends every enforcement event to local JSONL
 * and Neon Postgres for long-term retrieval independent of the live UI.
 *
 * Both writes are best-effort and fire-and-forget; failures are logged
 * but never propagate to the caller (the SDN control plane must not
 * block on audit I/O — Jeff Dean latency invariant).
 */

import fs from 'node:fs';
import path from 'node:path';
import { neonConfig, neon } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuarantineAuditEntry {
  readonly ruleId: string;
  readonly priority: number;
  readonly action: string;
  readonly srcCidr: string;
  readonly dstCidr: string;
  readonly protocol: string;
  readonly srcMac?: string | undefined;
  readonly dstMac?: string | undefined;
  readonly installedAtMs: number;
  readonly openFlowInstalled: boolean;
}

// ─── Local append-log via persistent write stream ────────────────────────────
// A single open WriteStream avoids opening and closing a file descriptor on
// every quarantine event (which under rapid-fire events would exhaust FDs).

function resolveAuditFilePath(): string {
  for (const dir of [
    process.env['STATE_DIRECTORY'] ?? '',
    '/var/lib/zodiac',
    '/tmp',
  ].filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.qa-probe');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return path.join(dir, 'quarantine-audit.jsonl');
    } catch (err: unknown) {
      console.warn(`[!] [Quarantine Audit] Directory ${dir} not usable:`,
        err instanceof Error ? err.message : String(err));
    }
  }
  return '/tmp/quarantine-audit.jsonl';
}

const AUDIT_FILE = resolveAuditFilePath();

let auditStream: fs.WriteStream | null = null;
// Monotonic nanosecond timestamp (process.hrtime.bigint) — immune to NTP shifts
// and leap-second clock rewinds that would corrupt Date.now()-based backoff math.
let auditStreamFailedAtNs = 0n;
const AUDIT_STREAM_BACKOFF_NS = 5_000_000_000n; // 5 s in nanoseconds

// Bounded in-memory buffer preserves quarantine audit events during transient
// disk unavailability. Entries are drained to the write stream when it recovers.
// Sized at 1000 to bound memory; once full, events are shed (and rejection counted).
const AUDIT_PENDING_BUFFER_MAX = 1000;
// `let` enables the O(1) pointer-swap drain idiom inside drainPendingBuffer.
let auditPendingBuffer: string[] = [];

// Single in-flight drain guard. Never awaited by appendToLocalAuditLog callers —
// this is a fire-and-forget pipeline consistent with the file-header contract.
// No caller ever receives a rejection from the drain; errors are logged and counted.
let drainPromise: Promise<void> | null = null;

// One-shot retry timer: ensures buffered events are not stranded indefinitely
// if traffic ceases before the circuit breaker clears. unref()'d so it never
// blocks process exit.
let drainRetryTimer: NodeJS.Timeout | null = null;

function scheduleCircuitBreakerDrain(): void {
  if (drainRetryTimer !== null) return; // already scheduled, no double-fire
  // Dynamically compute the exact remaining backoff so there is no arbitrary
  // padding heuristic — schedule fires the instant the circuit breaker clears.
  const elapsed = auditStreamFailedAtNs !== 0n
    ? process.hrtime.bigint() - auditStreamFailedAtNs
    : 0n;
  const remainingMs = elapsed < AUDIT_STREAM_BACKOFF_NS
    ? Number((AUDIT_STREAM_BACKOFF_NS - elapsed) / 1_000_000n) + 1
    : 1;
  drainRetryTimer = setTimeout(() => {
    drainRetryTimer = null;
    if (auditPendingBuffer.length > 0) triggerDrain();
  }, remainingMs);
  drainRetryTimer.unref();
}

// triggerDrain() is the single entry point for initiating a drain.
// If a drain is already in flight its while-loop will pick up any new entries,
// so we only start a new one when drainPromise is null.
function triggerDrain(): void {
  const stream = getAuditStream();
  if (!stream) { scheduleCircuitBreakerDrain(); return; }
  if (drainPromise) return;
  drainPromise = drainPendingBuffer(stream)
    .catch((err: unknown) => {
      // Count disk failures for control-plane health monitoring. Error is absorbed
      // here: callers never receive drain rejections (fire-and-forget contract).
      failedWriteCount += 1n;
      console.warn('[!] [Quarantine Audit] Drain failed:',
        err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      drainPromise = null;
      // Re-trigger if entries arrived in the microtask window between the drain
      // loop evaluating length === 0 and drainPromise being cleared.
      if (auditPendingBuffer.length > 0) triggerDrain();
    });
}

async function drainPendingBuffer(stream: fs.WriteStream): Promise<void> {
  while (auditPendingBuffer.length > 0) {
    // O(1) pointer swap: new pushes land in the fresh array while this batch writes.
    const batch = auditPendingBuffer;
    auditPendingBuffer = [];
    // Single write() per iteration — one libuv boundary crossing.
    // Bounded: AUDIT_PENDING_BUFFER_MAX × max-entry-size ≈ 1000 × 512B = 512KB;
    // V8 string concat at this scale completes in <1ms (well within the
    // best-effort fire-and-forget audit budget).
    const blob = batch.join('');
    try {
      await new Promise<void>((resolve, reject) => {
        // write() callback fires after OS accepts the data, even when write()
        // returned false (backpressure): WriteStream guarantees callback delivery
        // after the internal drain cycle — no extra 'drain' listener needed.
        stream.write(blob, (err) => { if (err) reject(err); else resolve(); });
      });
    } catch (err) {
      // Restore the NEWEST events from the failed batch (slice(-capacity) keeps
      // the tail) — newer quarantine events carry higher security relevance and
      // must be preserved over older ones when buffer capacity is constrained.
      const capacity = AUDIT_PENDING_BUFFER_MAX - auditPendingBuffer.length;
      if (capacity > 0) auditPendingBuffer.unshift(...batch.slice(-capacity));
      throw err;
    }
  }
}

function getAuditStream(): fs.WriteStream | null {
  if (auditStream && !auditStream.destroyed) return auditStream;
  // Circuit breaker: don't spin-recreate on every call while disk/FD is unavailable.
  if (auditStream === null && auditStreamFailedAtNs !== 0n && process.hrtime.bigint() - auditStreamFailedAtNs < AUDIT_STREAM_BACKOFF_NS) {
    return null;
  }
  auditStream = fs.createWriteStream(AUDIT_FILE, { flags: 'a', encoding: 'utf-8' });
  auditStream.on('error', (err) => {
    console.warn('[!] [Quarantine Audit] Write stream error:', err.message);
    auditStreamFailedAtNs = process.hrtime.bigint();
    auditStream = null;
  });
  return auditStream;
}

function appendToLocalAuditLog(entry: QuarantineAuditEntry): Promise<void> {
  // Best-effort fire-and-forget: resolves immediately after enqueueing, NOT after
  // disk confirmation. Per the file header, the SDN control plane must never block
  // on audit I/O (Jeff Dean latency invariant). Disk persistence is asynchronous
  // via triggerDrain(); the Neon path provides the durable backup.
  const line = JSON.stringify(entry) + '\n';
  if (auditPendingBuffer.length >= AUDIT_PENDING_BUFFER_MAX) {
    return Promise.reject(new Error(
      `Audit pending buffer full (${AUDIT_PENDING_BUFFER_MAX} items): event shed`
    ));
  }
  auditPendingBuffer.push(line);
  triggerDrain();
  return Promise.resolve();
}

// ─── Neon persistence with singleton DDL guard ───────────────────────────────
// Concurrent quarantine events at startup could race on CREATE TABLE.
// A singleton Promise ensures the DDL fires exactly once.

let neonTableReady = false;
let neonTableInitPromise: Promise<boolean> | null = null;

function getNeonUrl(): string | null {
  return (
    process.env['DATABASE_URL'] ??
    process.env['agentic_POSTGRES_PRISMA_URL'] ??
    process.env['agentic_DATABASE_URL'] ??
    process.env['POSTGRES_PRISMA_URL'] ??
    null
  );
}

function ensureNeonTable(): Promise<boolean> {
  if (neonTableReady) return Promise.resolve(true);
  if (neonTableInitPromise) return neonTableInitPromise;

  neonTableInitPromise = (async () => {
    const dbUrl = getNeonUrl();
    if (!dbUrl) return false;
    const sql = neon(dbUrl);
    await sql`
      CREATE TABLE IF NOT EXISTS "QuarantineAuditEvent" (
        "id"                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "ruleId"            TEXT        NOT NULL UNIQUE,
        "priority"          INTEGER     NOT NULL DEFAULT 65535,
        "action"            TEXT        NOT NULL DEFAULT 'DROP',
        "srcCidr"           TEXT        NOT NULL DEFAULT '0.0.0.0/0',
        "dstCidr"           TEXT        NOT NULL DEFAULT '0.0.0.0/0',
        "protocol"          TEXT        NOT NULL DEFAULT 'ANY',
        "srcMac"            TEXT,
        "dstMac"            TEXT,
        "installedAtMs"     BIGINT      NOT NULL,
        "openFlowInstalled" BOOLEAN     NOT NULL DEFAULT false,
        "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS "QuarantineAuditEvent_installedAtMs_idx"
        ON "QuarantineAuditEvent" ("installedAtMs" DESC)
    `;
    neonTableReady = true;
    return true;
  })().catch((err: unknown) => {
    neonTableInitPromise = null; // allow retry on next event
    console.warn('[!] [Quarantine Audit] Failed to ensure Neon table:',
      err instanceof Error ? err.message : String(err));
    return false;
  });

  return neonTableInitPromise;
}

async function appendToNeon(entry: QuarantineAuditEntry): Promise<void> {
  // No internal try/catch: rejections propagate to the caller.
  // appendQuarantineEvent wraps this with .catch() via Promise.allSettled,
  // satisfying the fail-closed invariant without suppressing the failure signal.
  // Early-exit conditions throw rather than return so the caller's .catch() path
  // increments failedWriteCount and logs the failure (Zero Suppression of Reality).
  if (!(await ensureNeonTable())) throw new Error('[Quarantine Audit] Neon table unavailable');
  const dbUrl = getNeonUrl();
  if (!dbUrl) throw new Error('[Quarantine Audit] No Neon DATABASE_URL configured');
  const sql = neon(dbUrl);
  await sql`
    INSERT INTO "QuarantineAuditEvent"
      ("ruleId", "priority", "action", "srcCidr", "dstCidr", "protocol",
       "srcMac", "dstMac", "installedAtMs", "openFlowInstalled")
    VALUES
      (${entry.ruleId}, ${entry.priority}, ${entry.action},
       ${entry.srcCidr}, ${entry.dstCidr}, ${entry.protocol},
       ${entry.srcMac ?? null}, ${entry.dstMac ?? null},
       ${BigInt(entry.installedAtMs)}, ${entry.openFlowInstalled})
    ON CONFLICT ("ruleId") DO NOTHING
  `;
}

// ─── Public API ───────────────────────────────────────────────────────────────
// The real call site (zodiac-bridge-server.ts) invokes this fire-and-forget
// from an HTTP handler that must respond immediately, so there is no caller
// await to provide backpressure. Bound the number of concurrent audit writes
// instead: once the bound is hit, drop the event and count it, rather than
// letting promises accumulate unboundedly under an adversarial event flood.

const DEFAULT_MAX_INFLIGHT_WRITES = 256;
const parsedMaxInflight = process.env['QUARANTINE_AUDIT_MAX_INFLIGHT_WRITES']
  ? parseInt(process.env['QUARANTINE_AUDIT_MAX_INFLIGHT_WRITES'], 10)
  : NaN;
// Bounded between 1 and 10000 to prevent a misconfigured env var from disabling
// load shedding entirely or starving every write immediately.
const MAX_INFLIGHT_WRITES = Number.isFinite(parsedMaxInflight) && parsedMaxInflight > 0
  ? Math.min(Math.max(parsedMaxInflight, 1), 10_000)
  : DEFAULT_MAX_INFLIGHT_WRITES;

let inflightWrites = 0;
let droppedEventCount = 0n;
let failedWriteCount = 0n;

export function getDroppedQuarantineAuditCount(): bigint {
  return droppedEventCount;
}

export function getFailedQuarantineAuditWriteCount(): bigint {
  return failedWriteCount;
}

export function getInflightQuarantineAuditWriteCount(): bigint {
  return BigInt(inflightWrites);
}

/**
 * Persist a quarantine enforcement event to both local JSONL and Neon Postgres.
 * Uses Promise.allSettled so the "never rejects" guarantee is enforced at
 * this orchestration layer, not delegated to whether every leaf task
 * remembers to wrap itself in .catch (a future third destination could
 * otherwise silently reintroduce a rejection here).
 * Bounded concurrency: if MAX_INFLIGHT_WRITES writes are already in flight,
 * the event is dropped (and counted via getDroppedQuarantineAuditCount)
 * rather than queued indefinitely. Individual write failures are counted
 * via getFailedQuarantineAuditWriteCount for control-plane health monitoring.
 */
export async function appendQuarantineEvent(
  entry: QuarantineAuditEntry
): Promise<void> {
  if (inflightWrites >= MAX_INFLIGHT_WRITES) {
    droppedEventCount += 1n;
    console.warn(
      `[!] [Quarantine Audit] Dropping audit event for rule ${entry.ruleId}: ` +
      `${MAX_INFLIGHT_WRITES} writes already in flight (${droppedEventCount} dropped total).`
    );
    return;
  }

  inflightWrites += 1;
  try {
    await Promise.allSettled([
      appendToLocalAuditLog(entry).catch((err: unknown) => {
        failedWriteCount += 1n;
        console.warn('[!] [Quarantine Audit] Local JSONL write failed:',
          err instanceof Error ? err.message : String(err));
      }),
      appendToNeon(entry).catch((err: unknown) => {
        failedWriteCount += 1n;
        console.warn('[!] [Quarantine Audit] Neon write failed:',
          err instanceof Error ? err.message : String(err));
      }),
    ]);
  } finally {
    inflightWrites -= 1;
  }
}
