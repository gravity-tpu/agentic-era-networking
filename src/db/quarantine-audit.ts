/**
 * src/db/quarantine-audit.ts
 * Quarantine Audit Log — appends every enforcement event to local JSONL
 * and Neon Postgres for long-term retrieval independent of the live UI.
 *
 * Both writes are best-effort and fire-and-forget; failures are logged
 * but never propagate to the caller (Council Rule 1: Zero Suppression,
 * but the SDN control plane must never block on audit I/O).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

// ─── Local JSONL ──────────────────────────────────────────────────────────────

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
    } catch { /* try next candidate */ }
  }
  return '/tmp/quarantine-audit.jsonl';
}

const AUDIT_FILE = resolveAuditFilePath();

async function appendToLocalAuditLog(entry: QuarantineAuditEntry): Promise<void> {
  await fsp.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n');
}

// ─── Neon persistence ─────────────────────────────────────────────────────────

let neonTableReady = false;

function getNeonUrl(): string | null {
  return (
    process.env['DATABASE_URL'] ??
    process.env['agentic_POSTGRES_PRISMA_URL'] ??
    process.env['agentic_DATABASE_URL'] ??
    process.env['POSTGRES_PRISMA_URL'] ??
    null
  );
}

async function ensureNeonTable(): Promise<boolean> {
  if (neonTableReady) return true;
  const dbUrl = getNeonUrl();
  if (!dbUrl) return false;
  try {
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
  } catch (err: unknown) {
    console.warn('[!] [Quarantine Audit] Failed to ensure Neon table:',
      err instanceof Error ? err.message : String(err));
    return false;
  }
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
 * Both writes are parallel and best-effort — a failure in either path is logged
 * but never blocks or throws (SDN control plane must not stall on audit I/O).
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
