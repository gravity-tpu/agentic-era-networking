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

function getAuditStream(): fs.WriteStream | null {
  if (auditStream && !auditStream.destroyed) return auditStream;
  // Circuit breaker: don't spin-recreate on every call while disk/FD is unavailable.
  if (auditStream === null && process.hrtime.bigint() - auditStreamFailedAtNs < AUDIT_STREAM_BACKOFF_NS) {
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
  // The write callback fires only after the chunk is flushed to the underlying
  // resource — both on the fast path (ok=true) and the backpressured path (ok=false).
  // This guarantees durability and propagates errors to the caller without needing
  // drain/error listener gymnastics. Concurrency is bounded by the caller
  // (see MAX_INFLIGHT_WRITES in appendQuarantineEvent), not by an awaiting caller.
  return new Promise((resolve, reject) => {
    const stream = getAuditStream();
    if (!stream) {
      reject(new Error('Audit write stream unavailable (5s circuit breaker active)'));
      return;
    }
    stream.write(JSON.stringify(entry) + '\n', (err) => {
      if (err) { reject(err); return; }
      resolve();
    });
  });
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
  if (!(await ensureNeonTable())) return;
  const dbUrl = getNeonUrl();
  if (!dbUrl) return;
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
