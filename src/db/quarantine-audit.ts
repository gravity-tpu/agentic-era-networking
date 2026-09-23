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

function getAuditStream(): fs.WriteStream {
  if (auditStream && !auditStream.destroyed) return auditStream;
  auditStream = fs.createWriteStream(AUDIT_FILE, { flags: 'a', encoding: 'utf-8' });
  auditStream.on('error', (err) => {
    console.warn('[!] [Quarantine Audit] Write stream error:', err.message);
    auditStream = null; // reset so the next call opens a fresh stream
  });
  return auditStream;
}

function appendToLocalAuditLog(entry: QuarantineAuditEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = getAuditStream();
    const ok = stream.write(JSON.stringify(entry) + '\n', (err) => {
      if (err) { reject(err); return; }
      resolve();
    });
    // write() returns false when the internal buffer is full (backpressure signal).
    // Registering a drain listener prevents the buffer from growing unboundedly under
    // a rapid-fire quarantine storm. Promises settle only once — if the write callback
    // fires first, the drain resolve() is a no-op, and vice versa.
    if (!ok) stream.once('drain', resolve);
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

/**
 * Persist a quarantine enforcement event to both local JSONL and Neon Postgres.
 * Uses Promise.allSettled so a failure in either path never rejects — errors
 * are logged and the function always resolves (SDN control plane invariant).
 */
export async function appendQuarantineEvent(
  entry: QuarantineAuditEntry
): Promise<void> {
  await Promise.allSettled([
    appendToLocalAuditLog(entry).catch((err: unknown) => {
      console.warn('[!] [Quarantine Audit] Local JSONL write failed:',
        err instanceof Error ? err.message : String(err));
    }),
    appendToNeon(entry).catch((err: unknown) => {
      console.warn('[!] [Quarantine Audit] Neon write failed:',
        err instanceof Error ? err.message : String(err));
    }),
  ]);
}
