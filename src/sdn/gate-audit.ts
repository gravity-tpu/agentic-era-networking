/**
 * gate-audit.ts
 * An append-only audit trail of what the pre-install gate (install-gate.ts) refused, and of throughput shortfalls it let through as advisory.
 *
 * Why it exists: a refusal is a security-relevant event (someone, or something, tried to put a leaking, hairpinning or over-capacity rule on the
 * switch), and until now it was one console line that rotates away with the journal. Each event is one JSON line with when, which route, who
 * (the peer address the socket reported), what rule was proposed, and which properties failed on which rules.
 *
 * Contract (the same as the quarantine audit's): the audit never changes the outcome. A refusal is returned to the caller whether or not the
 * line could be written (fail closed; Invariant 3), and a write failure is returned as an error STRING, counted and logged, never thrown and
 * never silently dropped. It is synchronous and small (refusals are rare, and the allow route is operator-only), so it needs no buffer.
 *
 * Bounds (Invariant 5): every string is truncated, a record carries at most MAX_VIOLATIONS violations, the file rotates once at MAX_FILE_BYTES
 * (keeping one previous file), and at most MAX_EVENTS_PER_MINUTE are written per minute: beyond that events are COUNTED, and the count is written
 * into the next line that is allowed, so a flood cannot fill the disk and cannot hide that it happened. Time is injected, so tests need no sleeps.
 *
 * What it is not: tamper-evident. The file is owned by the bridge's user; a process running as that user can edit it.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IsolationRule } from './port1-isolation.js';
import type { GateViolation } from './install-gate.js';

export const GATE_AUDIT_SCHEMA = 'zodiac-gate-audit/v1';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EVENTS_PER_MINUTE = 60;
export const MAX_VIOLATIONS = 20;
const MAX_STRING = 500;
const MAX_NOTES = 10;

export type GateAuditRoute = 'allow' | 'quarantine' | 'startup';
export type GateAuditEvent = 'refused' | 'advisory';

export interface GateAuditInput {
  readonly event: GateAuditEvent;
  readonly route: GateAuditRoute;
  /** The peer address the socket reported, or null when the call did not come from a request. */
  readonly peer: string | null;
  readonly what: string;
  readonly proposed: readonly IsolationRule[];
  readonly violations: readonly GateViolation[];
  readonly notes: readonly string[];
  /** Rules in the table the install would have produced. */
  readonly tableRules: number;
}

export interface GateAuditRecord {
  readonly schema: typeof GATE_AUDIT_SCHEMA;
  readonly atMs: number;
  readonly event: GateAuditEvent;
  readonly route: GateAuditRoute;
  readonly peer: string | null;
  readonly what: string;
  readonly tableRules: number;
  readonly proposed: ReadonlyArray<{ id: string; priority: number; outputPorts: readonly number[]; match: Readonly<Record<string, unknown>> }>;
  readonly violations: ReadonlyArray<{ property: string; ruleIds: readonly string[]; detail: string }>;
  readonly violationsOmitted: number;
  readonly notes: readonly string[];
  /** Events that were refused-to-record since the previous line because of the per-minute limit. */
  readonly suppressedBefore: number;
}

const clip = (s: string): string => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s);

/** Pure: the record for an event. Truncates everything it copies, so a hostile rule id or detail cannot make a line unbounded. */
export function buildGateAuditRecord(input: GateAuditInput, atMs: number, suppressedBefore: number): GateAuditRecord {
  return {
    schema: GATE_AUDIT_SCHEMA,
    atMs,
    event: input.event,
    route: input.route,
    peer: input.peer === null ? null : clip(input.peer),
    what: clip(input.what),
    tableRules: input.tableRules,
    proposed: input.proposed.slice(0, MAX_VIOLATIONS).map((r) => ({
      id: clip(r.id),
      priority: r.flowMod.priority,
      outputPorts: [...(r.flowMod.outputPorts ?? [])],
      match: JSON.parse(JSON.stringify(r.flowMod.match ?? {})) as Record<string, unknown>,
    })),
    violations: input.violations.slice(0, MAX_VIOLATIONS).map((v) => ({ property: v.property, ruleIds: v.ruleIds.slice(0, MAX_VIOLATIONS).map(clip), detail: clip(v.detail) })),
    violationsOmitted: Math.max(0, input.violations.length - MAX_VIOLATIONS),
    notes: input.notes.slice(0, MAX_NOTES).map(clip),
    suppressedBefore,
  };
}

export interface GateAuditOptions {
  readonly file: string;
  readonly nowMs?: () => number;
  readonly maxFileBytes?: number;
  readonly maxEventsPerMinute?: number;
}

export class GateAuditLog {
  private readonly file: string;
  private readonly nowMs: () => number;
  private readonly maxBytes: number;
  private readonly perMinute: number;
  private windowStartMs = 0;
  private inWindow = 0;
  private suppressed = 0;
  public failedWrites = 0;
  public totalSuppressed = 0;

  public constructor(options: GateAuditOptions) {
    this.file = options.file;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.perMinute = options.maxEventsPerMinute ?? MAX_EVENTS_PER_MINUTE;
  }

  /** Writes one event. Returns null on success or when the event was counted as suppressed; an error string when the write failed. Never throws. */
  public record(input: GateAuditInput): string | null {
    const now = this.nowMs();
    if (now - this.windowStartMs >= 60_000) { this.windowStartMs = now; this.inWindow = 0; }
    if (this.inWindow >= this.perMinute) {
      this.suppressed += 1;
      this.totalSuppressed += 1;
      return null;
    }
    const line = `${JSON.stringify(buildGateAuditRecord(input, now, this.suppressed))}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.inWindow += 1;
      this.suppressed = 0;
      return null;
    } catch (err: unknown) {
      this.failedWrites += 1;
      return `could not write the gate audit trail ${this.file}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Keeps one previous file: when the next line would pass the limit, the current file becomes `<file>.1`. */
  private rotateIfNeeded(nextBytes: number): void {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (err: unknown) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    if (size + nextBytes > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
  }
}

/** Where the bridge keeps it: `ZODIAC_GATE_AUDIT_FILE`, else `$STATE_DIRECTORY` or `/var/lib/zodiac`. */
export function resolveGateAuditFile(env: NodeJS.ProcessEnv): string {
  const explicit = env['ZODIAC_GATE_AUDIT_FILE'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return path.join(env['STATE_DIRECTORY'] ?? '/var/lib/zodiac', 'install-gate-audit.jsonl');
}
