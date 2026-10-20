/**
 * Persistence for active quarantines, so a bridge restart (or a switch reconnect) puts them back.
 *
 * Measured 2026-10-20 (conformance safety-backstop tests): when the bridge dies or freezes, this firmware flushes its whole
 * flow table within about 5 s, so every quarantine DROP is gone before the bridge is back. Without this file the bridge forgets
 * them too, and a quarantined source regains the data plane (fail-open). The file holds only what is needed to re-install:
 * source IP, reason, priority and the WALL-CLOCK end of the quarantine. The original time limit is never extended: a record past
 * its end is dropped, and the remaining time is re-capped to the envelope's maximum.
 *
 * Every record is re-checked against the CURRENT envelope on load (scope, protected list, cap), so a protected-list change takes
 * effect on restart. A record that fails is dropped with a reason, never installed. An unreadable or corrupt file yields no
 * records and a warning (the caller logs it); it is never trusted partially.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decideQuarantine, MAX_QUARANTINE_TTL_MS, type QuarantineEnvelopeConfig } from './quarantine-envelope.js';

export interface PersistedQuarantine {
  readonly ip: string;
  readonly reason: string;
  readonly priority: number;
  /** Wall-clock end of the quarantine, ms since the epoch. */
  readonly expiresAtMs: number;
}

export interface LoadedQuarantines {
  readonly records: readonly PersistedQuarantine[];
  /** One line per dropped record or problem with the file. */
  readonly notes: readonly string[];
}

const FILE_VERSION = 1;
const MAX_REASON_LEN = 200;
const MAX_FILE_BYTES = 64 * 1024;

export function parseQuarantineState(text: string, nowMs: number, envelope: QuarantineEnvelopeConfig): LoadedQuarantines {
  const notes: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err: unknown) {
    return { records: [], notes: [`quarantine state file is not valid JSON, ignored: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== FILE_VERSION || !Array.isArray((data as { active?: unknown }).active)) {
    return { records: [], notes: ['quarantine state file has an unexpected shape, ignored'] };
  }
  const records: PersistedQuarantine[] = [];
  const kept: string[] = [];
  for (const raw of (data as { active: unknown[] }).active) {
    const r = raw as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null || typeof r['ip'] !== 'string' || typeof r['expiresAtMs'] !== 'number' || !Number.isSafeInteger(r['expiresAtMs'])) {
      notes.push('dropped a malformed quarantine record');
      continue;
    }
    const ip = r['ip'];
    const priority = typeof r['priority'] === 'number' && Number.isInteger(r['priority']) && r['priority'] >= 1 && r['priority'] <= 65535 ? r['priority'] : 65535;
    const reason = typeof r['reason'] === 'string' ? r['reason'].slice(0, MAX_REASON_LEN) : 'restored after restart';
    const remainingMs = r['expiresAtMs'] - nowMs;
    if (remainingMs <= 0) {
      notes.push(`${ip}: time limit already passed, not restored`);
      continue;
    }
    // Never longer than the envelope allows from now, even if the file was edited.
    const expiresAtMs = nowMs + Math.min(remainingMs, MAX_QUARANTINE_TTL_MS);
    const decision = decideQuarantine({ targetIp: ip, targetMac: undefined }, kept, envelope);
    if (!decision.allow) {
      notes.push(`${ip}: not restored, outside the current envelope (${decision.code})`);
      continue;
    }
    kept.push(ip);
    records.push({ ip, reason, priority, expiresAtMs });
  }
  return { records, notes };
}

export function loadQuarantineState(file: string, nowMs: number, envelope: QuarantineEnvelopeConfig): LoadedQuarantines {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) return { records: [], notes: [`quarantine state file is ${st.size} bytes (limit ${MAX_FILE_BYTES}), ignored`] };
    text = fs.readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], notes: [] };
    return { records: [], notes: [`quarantine state file could not be read, ignored: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return parseQuarantineState(text, nowMs, envelope);
}

/** Atomic write (temp file in the same directory, then rename). Returns an error string, or null on success; never throws. */
export function saveQuarantineState(file: string, records: readonly PersistedQuarantine[]): string | null {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, active: records }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return null;
  } catch (err: unknown) {
    try { fs.rmSync(tmp, { force: true }); } catch (cleanupErr: unknown) { return `could not write ${file}: ${err instanceof Error ? err.message : String(err)} (and could not remove the temp file: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`; }
    return `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Where the bridge keeps the file: `ZODIAC_QUARANTINE_STATE_FILE`, else `$STATE_DIRECTORY` or `/var/lib/zodiac`. */
export function resolveQuarantineStateFile(env: NodeJS.ProcessEnv): string {
  const explicit = env['ZODIAC_QUARANTINE_STATE_FILE'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return path.join(env['STATE_DIRECTORY'] ?? '/var/lib/zodiac', 'quarantine-state.json');
}
