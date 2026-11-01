/**
 * gate-audit.ts
 * An append-only audit trail of what the pre-install gate (install-gate.ts) refused, and of throughput shortfalls it let through as advisory.
 *
 * It also records the refusals that happen BEFORE the gate: a state-changing route turning away a caller (not the bridge host, a proxy header, not an
 * operator, a missing or wrong experiment token) is the same kind of event and used to be a journal line only. Those carry the property `caller`, no rule
 * (the body is never read), and, for proxy headers, the header names and values the peer sent (never the experiment token or any other header).
 *
 * Why it exists: a refusal is a security-relevant event (someone, or something, tried to put a leaking, hairpinning or over-capacity rule on the
 * switch), and until now it was one console line that rotates away with the journal. Each event is one JSON line with when, which route, who
 * (the peer address the socket reported), what rule was proposed, and which properties failed on which rules.
 *
 * Contract (the same as the quarantine audit's): the audit never changes the outcome. A refusal is returned to the caller whether or not the
 * line could be written (fail closed; Invariant 3), and a write failure is returned as an error STRING, counted and logged, never thrown and
 * never silently dropped. It is synchronous and small (refusals are rare, and the allow route is operator-only), so it needs no buffer.
 *
 * Bounds (Invariant 5): every string is truncated, a record carries at most MAX_VIOLATIONS violations and copies only the primitive fields of a rule's
 * match, the file rotates once at MAX_FILE_BYTES (keeping one previous file, so at most about twice that on disk), and at most MAX_EVENTS_PER_MINUTE
 * are written per minute: beyond that events are COUNTED, the count is written into the next line that is allowed, and `totalSuppressed` is exposed so
 * the caller can say so in the journal at once (a flood with no later event would otherwise leave no trace in the file). Time is injected, so tests need no sleeps.
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
const MAX_MATCH_FIELDS = 16;

/** Copies at most MAX_MATCH_FIELDS primitive fields of a match (strings clipped); nested values are dropped, so a hostile object cannot widen a line or break the copy. */
function boundedMatch(match: Readonly<Record<string, unknown>> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(match ?? {})) {
    if (Object.keys(out).length >= MAX_MATCH_FIELDS) break;
    if (typeof v === 'string') out[clip(k)] = clip(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[clip(k)] = v;
  }
  return out;
}

/** One header value as text for a log note: arrays joined, control characters (including newlines) replaced, length bounded. The record is JSON, so nothing can break out of the line, but a reader should not see raw control bytes either. */
export function safeHeaderText(value: string | readonly string[] | undefined, max = 200): string {
  const text = (Array.isArray(value) ? (value as readonly string[]).join(', ') : String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, '?');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type GateAuditRoute = 'allow' | 'quarantine' | 'startup' | 'approve' | 'experiment' | 'repair';
/** `refused`: the gate refused a table. `advisory`: a throughput shortfall it let through. `caller_refused`: a state-changing route refused who was asking, before any rule was read. */
export type GateAuditEvent = 'refused' | 'advisory' | 'caller_refused' | 'repair' | 'repair_exhausted';

/** What a record keeps of a violation. The gate's own violations fit it; a caller refusal uses the property `caller`. */
export interface GateAuditViolation {
  readonly property: string;
  readonly ruleIds: readonly string[];
  readonly detail: string;
}

// The gate's own violations must stay recordable: if GateViolation changes in a way this type cannot hold, this line stops compiling.
const gateViolationsAreRecordable: GateViolation extends GateAuditViolation ? true : never = true;
void gateViolationsAreRecordable;

export interface GateAuditInput {
  readonly event: GateAuditEvent;
  readonly route: GateAuditRoute;
  /** The peer address the socket reported, or null when the call did not come from a request. */
  readonly peer: string | null;
  readonly what: string;
  readonly proposed: readonly IsolationRule[];
  readonly violations: readonly GateAuditViolation[];
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
  readonly proposed: ReadonlyArray<{ id: string; priority: number; outputPorts: readonly number[]; match: Readonly<Record<string, string | number | boolean>> }>;
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
      match: boundedMatch(r.flowMod.match as Readonly<Record<string, unknown>> | undefined),
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
export function resolveCallerAuditFile(env: NodeJS.ProcessEnv): string {
  const explicit = env['ZODIAC_CALLER_AUDIT_FILE'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return path.join(env['STATE_DIRECTORY'] ?? '/var/lib/zodiac', 'install-gate-callers.jsonl');
}

/** Callers turned away before the gate come from anyone who can reach the port, so they get their OWN file and a smaller per-minute budget: a flood of them cannot evict gate refusals. */
export const CALLER_MAX_EVENTS_PER_MINUTE = 20;

export function resolveGateAuditFile(env: NodeJS.ProcessEnv): string {
  const explicit = env['ZODIAC_GATE_AUDIT_FILE'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return path.join(env['STATE_DIRECTORY'] ?? '/var/lib/zodiac', 'install-gate-audit.jsonl');
}
