/**
 * src/sdn/experiment-install.ts
 * A bounded install path for the on-wire conformance experiment (RQ4, docs/research/evaluation-plan.md): put an agent-proposed rule
 * set that the orchestrator has ALREADY run through the intent verifier onto the live switch, read it back, and take it off again.
 * The bridge has no other way to install anything but the hardcoded port-1 isolation policy.
 *
 * Invariant 4 (verify before actuating): this layer re-checks what it can without the intent (bounds, hairpin, the A5 and A6 hygiene
 * checks, the A7 table budget) and refuses on any violation; the intent check (A11) stays with the caller, which owns the intent.
 * Invariant 3 (fail closed): the table-miss DROP is re-installed on every install and restore; an experiment is never left on the
 * switch past its time limit, because (a) the bridge restores the isolation policy when the limit expires and (b) every experimental
 * rule also carries a hard timeout at the switch, so if the bridge dies the rules expire and the table-miss drop keeps the data plane dark.
 * Invariant 5 (bounded limits): every limit below is a named constant. Invariant 6 (provenance): "sent" is not "installed"; the result
 * of an install is the readback verdict, not the FlowMods that were written.
 */

import { FlowModCommand } from './openflow-types.js';
import type { FlowModMatchOptions, FlowModOptions } from './openflow-types.js';
import { verifyIsolationReadback, ZODIAC_PORT_UPLINK, ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_TAP } from './port1-isolation.js';
import type { IsolationRule } from './port1-isolation.js';
import { checkRuleHygiene } from './rule-hygiene.js';
import { checkRuleBudget } from './capacity-budget.js';
import type { FlowStatsEntry } from './dataplane-benchmark.js';

/** Most rules an experiment may install. Below the A7 limit (128 entries, minus the table-miss and the quarantine reserve). */
export const EXPERIMENT_MAX_RULES = 100;
export const EXPERIMENT_MAX_ID_LENGTH = 64;
/** 65535 is reserved for quarantine DROP rules (src/sdn/quarantine-envelope.ts); 0 is the table-miss. */
export const EXPERIMENT_MIN_PRIORITY = 1;
export const EXPERIMENT_MAX_PRIORITY = 65534;
/** The workload, uplink and tap ports. Port 4 is the controller link and is never an output of an experiment rule. */
export const EXPERIMENT_ALLOWED_PORTS: readonly number[] = [ZODIAC_PORT_WORKLOAD, ZODIAC_PORT_UPLINK, ZODIAC_PORT_TAP];
export const EXPERIMENT_TTL_MIN_SECONDS = 10;
export const EXPERIMENT_TTL_DEFAULT_SECONDS = 90;
export const EXPERIMENT_TTL_MAX_SECONDS = 300;
/** The switch-side hard timeout is the bridge-side limit plus this, so the bridge's own restore normally acts first. */
export const EXPERIMENT_SWITCH_EXPIRY_MARGIN_SECONDS = 30;
/** Wait after sending FlowMods before reading the table back (the MCU processes them in software). */
export const EXPERIMENT_SETTLE_MS = 1500;
export const EXPERIMENT_SETTLE_MIN_MS = 250;
export const EXPERIMENT_SETTLE_MAX_MS = 10_000;

/** Reads ZODIAC_EXPERIMENT_SETTLE_MS: an integer within the bounds, else the default (a value outside them is refused, not clamped). */
export function parseExperimentSettleMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return EXPERIMENT_SETTLE_MS;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < EXPERIMENT_SETTLE_MIN_MS || v > EXPERIMENT_SETTLE_MAX_MS) {
    throw new Error(`ZODIAC_EXPERIMENT_SETTLE_MS must be an integer ${EXPERIMENT_SETTLE_MIN_MS} to ${EXPERIMENT_SETTLE_MAX_MS}, got ${raw}`);
  }
  return v;
}
/** The shared secret that the install endpoints require in the x-experiment-token header must be at least this long. */
export const EXPERIMENT_TOKEN_MIN_LENGTH = 32;
export const EXPERIMENT_MAX_BODY_BYTES = 64 * 1024;
export const EXPERIMENT_READBACK_LOCK_RETRIES = 10;
export const EXPERIMENT_READBACK_LOCK_WAIT_MS = 500;

const ID_RE = /^[A-Za-z0-9_.:-]+$/;
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MATCH_KEYS: ReadonlySet<string> = new Set([
  'inPort', 'etherType', 'srcMac', 'dstMac', 'srcIp', 'srcIpPrefixLen', 'dstIp', 'dstIpPrefixLen',
  'arpSpa', 'arpSpaPrefixLen', 'arpTpa', 'arpTpaPrefixLen',
]);
const ETH_TYPE_IPV4 = 0x0800;
const ETH_TYPE_ARP = 0x0806;

export interface ExperimentRequest {
  readonly rules: readonly IsolationRule[];
  readonly ttlSeconds: number;
  readonly label: string;
}

export type ParseResult = { readonly ok: true; readonly request: ExperimentRequest } | { readonly ok: false; readonly errors: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const validIpv4 = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const m = IPV4_RE.exec(s);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
};

/**
 * Parses and checks a request body. Returns the rules as IsolationRule[] (each flowMod carries a switch-side hard timeout) or every
 * reason it was refused. Pure: no I/O.
 */
export function parseExperimentRequest(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['body must be a JSON object'] };
  const ttl = raw['ttlSeconds'] === undefined ? EXPERIMENT_TTL_DEFAULT_SECONDS : raw['ttlSeconds'];
  if (!isInt(ttl, EXPERIMENT_TTL_MIN_SECONDS, EXPERIMENT_TTL_MAX_SECONDS)) {
    errors.push(`ttlSeconds must be an integer ${EXPERIMENT_TTL_MIN_SECONDS} to ${EXPERIMENT_TTL_MAX_SECONDS}`);
  }
  const labelRaw = raw['label'];
  const label = typeof labelRaw === 'string' ? labelRaw.slice(0, 120) : '';
  const list = raw['rules'];
  if (!Array.isArray(list) || list.length < 1 || list.length > EXPERIMENT_MAX_RULES) {
    return { ok: false, errors: [...errors, `rules must be an array of 1 to ${EXPERIMENT_MAX_RULES} rules`] };
  }
  const hardTimeout = (typeof ttl === 'number' ? ttl : EXPERIMENT_TTL_DEFAULT_SECONDS) + EXPERIMENT_SWITCH_EXPIRY_MARGIN_SECONDS;
  const rules: IsolationRule[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, idx: number) => {
    const at = `rules[${idx}]`;
    if (!isRecord(entry)) { errors.push(`${at}: must be an object`); return; }
    const id = entry['id'];
    if (typeof id !== 'string' || id.length < 1 || id.length > EXPERIMENT_MAX_ID_LENGTH || !ID_RE.test(id)) {
      errors.push(`${at}: id must be 1 to ${EXPERIMENT_MAX_ID_LENGTH} characters of A-Z a-z 0-9 _ . : -`);
      return;
    }
    if (seen.has(id)) { errors.push(`${at}: duplicate id ${id}`); return; }
    seen.add(id);
    const priority = entry['priority'];
    if (!isInt(priority, EXPERIMENT_MIN_PRIORITY, EXPERIMENT_MAX_PRIORITY)) {
      errors.push(`${id}: priority must be an integer ${EXPERIMENT_MIN_PRIORITY} to ${EXPERIMENT_MAX_PRIORITY}`);
      return;
    }
    const outs = entry['outputPorts'];
    if (!Array.isArray(outs) || outs.length > EXPERIMENT_ALLOWED_PORTS.length || !outs.every((p) => typeof p === 'number' && EXPERIMENT_ALLOWED_PORTS.includes(p)) || new Set(outs).size !== outs.length) {
      errors.push(`${id}: outputPorts must be a list of distinct ports from ${EXPERIMENT_ALLOWED_PORTS.join(', ')} (empty drops)`);
      return;
    }
    const m = entry['match'] === undefined ? {} : entry['match'];
    if (!isRecord(m)) { errors.push(`${id}: match must be an object`); return; }
    const unknownKeys = Object.keys(m).filter((k) => !MATCH_KEYS.has(k));
    if (unknownKeys.length > 0) { errors.push(`${id}: unknown match fields ${unknownKeys.join(', ')}`); return; }
    const match: { -readonly [K in keyof FlowModMatchOptions]: FlowModMatchOptions[K] } = {};
    let ok = true;
    const fail = (msg: string): void => { errors.push(`${id}: ${msg}`); ok = false; };
    if (m['inPort'] !== undefined) { if (isInt(m['inPort'], 1, 3)) match.inPort = m['inPort']; else fail('inPort must be 1, 2 or 3'); }
    if (m['etherType'] !== undefined) { if (isInt(m['etherType'], 0, 0xffff)) match.etherType = m['etherType']; else fail('etherType must be an integer 0 to 65535'); }
    for (const k of ['srcMac', 'dstMac'] as const) {
      const v = m[k];
      if (v !== undefined) { if (typeof v === 'string' && MAC_RE.test(v)) match[k] = v; else fail(`${k} must be aa:bb:cc:dd:ee:ff`); }
    }
    for (const [ipKey, lenKey] of [['srcIp', 'srcIpPrefixLen'], ['dstIp', 'dstIpPrefixLen']] as const) {
      const ip = m[ipKey];
      const len = m[lenKey];
      if (ip === undefined) { if (len !== undefined) fail(`${lenKey} without ${ipKey}`); continue; }
      if (!validIpv4(ip)) { fail(`${ipKey} must be a dotted IPv4 address`); continue; }
      if (m['etherType'] !== ETH_TYPE_IPV4) { fail(`${ipKey} needs etherType 2048 in the same match`); continue; }
      match[ipKey] = ip;
      if (len !== undefined) { if (isInt(len, 1, 32)) match[lenKey] = len; else fail(`${lenKey} must be an integer 1 to 32`); }
    }
    for (const [ipKey, lenKey] of [['arpSpa', 'arpSpaPrefixLen'], ['arpTpa', 'arpTpaPrefixLen']] as const) {
      const ip = m[ipKey];
      const len = m[lenKey];
      if (ip === undefined) { if (len !== undefined) fail(`${lenKey} without ${ipKey}`); continue; }
      if (!validIpv4(ip)) { fail(`${ipKey} must be a dotted IPv4 address`); continue; }
      if (m['etherType'] !== ETH_TYPE_ARP) { fail(`${ipKey} needs etherType 2054 (ARP) in the same match`); continue; }
      match[ipKey] = ip;
      if (len !== undefined) { if (isInt(len, 1, 32)) match[lenKey] = len; else fail(`${lenKey} must be an integer 1 to 32`); }
    }
    if (ok && match.inPort !== undefined && outs.includes(match.inPort)) fail(`outputs to its own ingress port ${match.inPort} (hairpin)`);
    if (!ok) return;
    const flowMod: FlowModOptions = { command: FlowModCommand.OFPFC_ADD, priority, outputPorts: outs as number[], hardTimeout, match };
    rules.push({ id, flowMod });
  });
  if (errors.length > 0) return { ok: false, errors };

  const hygiene = checkRuleHygiene(rules);
  for (const v of hygiene.violations) errors.push(`${v.property} ${v.kind}: ${v.detail}`);
  const budget = checkRuleBudget(rules);
  for (const v of budget.violations) errors.push(`${v.property}: ${v.detail}`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, request: { rules, ttlSeconds: ttl as number, label } };
}

export type ExperimentPhase = 'idle' | 'installing' | 'active' | 'restoring';

export interface ExperimentReport {
  readonly ok: boolean;
  readonly action: 'install' | 'restore';
  readonly label: string;
  readonly rulesRequested: number;
  readonly entriesSeen: number;
  /** Entries the switch reports that are not one of the requested rules (the table-miss is expected and not counted). */
  readonly extraEntries: number;
  readonly confirmed: readonly string[];
  readonly mismatches: readonly string[];
  readonly actionsStatus: string;
  readonly provenForwarding: boolean;
  readonly detail: string;
  readonly atMs: number;
  /** Entries with priority 0 (the table-miss); exactly one is expected. */
  readonly tableMissEntries: number;
  /** False only when the write and readback could not run at all (no session, failed read); then `ok` is false and nothing was judged. */
  readonly ran: boolean;
  /** Set on a failed install: what the automatic restore that followed did, so "isolation is back" is never assumed. */
  readonly restoreAfterFailure?: ExperimentReport;
}

export interface ExperimentState {
  readonly phase: ExperimentPhase;
  readonly label: string;
  readonly activeRuleIds: readonly string[];
  readonly expiresAtMs: number | null;
  readonly last: ExperimentReport | null;
  /**
   * Non-null while the data plane may NOT be back on the isolation policy: the last restore did not verify or could not run. It is
   * cleared by the next restore that verifies. An operator or a watcher should treat a non-null value as an alarm.
   */
  readonly attention: string | null;
}

export interface FlowReadGate {
  tryAcquire(): boolean;
  release(): void;
  readonly isHeld: boolean;
}

export interface InstallerDeps {
  sendFlowMod(options: FlowModOptions): number;
  sendTableMissDrop(): void;
  readFlowStats(): Promise<readonly FlowStatsEntry[]>;
  isSessionEstablished(): boolean;
  readonly gate: FlowReadGate;
  /** The policy to put back (the port-1 isolation policy). */
  isolationPolicy(): readonly IsolationRule[];
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Wait between sending FlowMods and reading the table back. Default EXPERIMENT_SETTLE_MS; the bridge sets it from the environment. */
  readonly settleMs?: number;
  /** Called after a restore whose readback verified, so the bridge can refresh its isolation status. */
  onRestored?(report: ExperimentReport): void;
  /** How many quarantine DROPs are active. An install wipes the whole table, so it is refused while any are (they would be lifted for the experiment's duration). */
  activeQuarantines?(): number;
  /** Called after every restore that ran, verified or not, once its readback is done: the wipe also removed any quarantine added during the experiment, so the bridge re-sends them. */
  afterRestore?(): void;
  log?(line: string): void;
}

const WIPE_ALL: FlowModOptions = { command: FlowModCommand.OFPFC_DELETE, priority: 0, match: {} };

/** Serializes installs: at most one experiment at a time, always ended by a restore (explicit, after a failed install, or on the time limit). */
export class ExperimentInstaller {
  private phase: ExperimentPhase = 'idle';
  private label = '';
  private activeIds: readonly string[] = [];
  private expiresAtMs: number | null = null;
  private last: ExperimentReport | null = null;
  private attention: string | null = null;
  private timer: unknown = null;

  public constructor(private readonly deps: InstallerDeps) {}

  public state(): ExperimentState {
    return { phase: this.phase, label: this.label, activeRuleIds: this.activeIds, expiresAtMs: this.expiresAtMs, last: this.last, attention: this.attention };
  }

  private log(line: string): void { this.deps.log?.(line); }

  /**
   * Take the flow-table lock before the first FlowMod and keep it through the settle wait and the readback. The periodic isolation
   * re-check shares this lock and skips a tick while it is held, so it can never read a half-written table (wipe sent, rules not yet
   * landed) and raise a false alarm. Throws, with nothing sent, if the lock stays busy.
   */
  private async acquireTableLock(): Promise<void> {
    for (let i = 0; i < EXPERIMENT_READBACK_LOCK_RETRIES; i++) {
      if (this.deps.gate.tryAcquire()) return;
      await this.deps.sleep(EXPERIMENT_READBACK_LOCK_WAIT_MS);
    }
    throw new Error('the flow-table lock stayed busy; refusing to rewrite the table without being able to read it back');
  }

  /** Wipe the table, re-install the table-miss DROP, add `rules`, then read back and judge. Throws only on no session or a failed read. */
  private async writeAndVerify(rules: readonly IsolationRule[], action: 'install' | 'restore', label: string): Promise<ExperimentReport> {
    if (!this.deps.isSessionEstablished()) throw new Error('no OpenFlow session with the switch');
    await this.acquireTableLock();
    let entries: readonly FlowStatsEntry[];
    try {
      this.deps.sendFlowMod(WIPE_ALL);
      this.deps.sendTableMissDrop();
      for (const rule of rules) this.deps.sendFlowMod(rule.flowMod);
      await this.deps.sleep(this.deps.settleMs ?? EXPERIMENT_SETTLE_MS);
      entries = await this.deps.readFlowStats();
    } finally {
      this.deps.gate.release();
    }
    const verdict = verifyIsolationReadback(rules, entries);
    // The table-miss is the priority-0 entry and there must be exactly one; every other entry must be one of the requested rules.
    const missEntries = entries.filter((e) => e.priority === 0).length;
    const nonMiss = entries.length - missEntries;
    // Defensive: confirmed rules map to distinct non-table-miss entries, so this should never be negative; the floor keeps a surprise from going negative in the report.
    const extra = Math.max(0, nonMiss - verdict.confirmed.length);
    const ok = verdict.mismatches.length === 0 && verdict.confirmed.length === rules.length && extra === 0 && missEntries === 1;
    const detail = ok
      ? `${rules.length}/${rules.length} rules confirmed, ${entries.length} entries including the table-miss`
      : `confirmed ${verdict.confirmed.length}/${rules.length}, ${verdict.mismatches.length} mismatches, ${extra} extra entries, ${missEntries} priority-0 entries (expected 1)`;
    return {
      ok, ran: true, action, label, rulesRequested: rules.length, entriesSeen: entries.length, extraEntries: extra, tableMissEntries: missEntries,
      confirmed: verdict.confirmed, mismatches: verdict.mismatches, actionsStatus: verdict.actions.status, provenForwarding: verdict.provenForwarding,
      detail, atMs: this.deps.nowMs(),
    };
  }

  private cancelTimer(): void {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
  }

  private clearActive(): void {
    this.label = '';
    this.activeIds = [];
    this.expiresAtMs = null;
  }

  /**
   * Put the isolation policy back. Assumes the caller has already moved the phase to 'restoring', so there is no window in which another
   * install could start. Never throws: a restore that cannot run or does not verify is returned as a failing report and sets `attention`.
   */
  private async restoreNow(label: string): Promise<ExperimentReport> {
    try {
      const report = await this.writeAndVerify(this.deps.isolationPolicy(), 'restore', label);
      this.deps.afterRestore?.();
      this.last = report;
      if (report.ok) {
        this.attention = null;
        this.log(`[experiment] restore VERIFIED: ${report.detail}`);
        this.deps.onRestored?.(report);
      } else {
        this.attention = `isolation policy NOT verified after restore: ${report.detail}`;
        this.log(`[experiment] ALERT restore NOT VERIFIED: ${report.detail}`);
      }
      return report;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.attention = `restore could not run: ${msg}`;
      this.log(`[experiment] ALERT restore FAILED to run: ${msg}`);
      const failed: ExperimentReport = {
        ok: false, ran: false, action: 'restore', label, rulesRequested: this.deps.isolationPolicy().length, entriesSeen: 0, extraEntries: 0, tableMissEntries: 0,
        confirmed: [], mismatches: [], actionsStatus: 'unobservable', provenForwarding: false, detail: `restore could not run: ${msg}`, atMs: this.deps.nowMs(),
      };
      this.last = failed;
      return failed;
    } finally {
      this.phase = 'idle';
      this.clearActive();
    }
  }

  /** Put the isolation policy back. Safe to call at any time except mid-install or mid-restore; the report says whether the readback verified. */
  public async restore(): Promise<ExperimentReport> {
    if (this.phase === 'installing' || this.phase === 'restoring') throw new Error(`cannot restore while ${this.phase}`);
    this.cancelTimer();
    const label = this.label;
    this.phase = 'restoring';
    const report = await this.restoreNow(label);
    // An explicit restore that cannot run is an error to the caller (HTTP 409); one that ran but did not verify is a failing report (502).
    if (!report.ran) throw new Error(report.detail);
    return report;
  }

  /**
   * Install a parsed request. On a failed readback, or on an error after FlowMods were sent, the isolation policy is restored at once and
   * the result carries that restore's outcome (`restoreAfterFailure`), so a caller can tell "install failed, isolation back" from "install
   * failed, isolation NOT back". Throws if an experiment is already running or the session is down.
   */
  public async install(request: ExperimentRequest): Promise<ExperimentReport> {
    if (this.phase !== 'idle') throw new Error(`an experiment is already ${this.phase}; restore first`);
    const quarantined = this.deps.activeQuarantines?.() ?? 0;
    if (quarantined > 0) throw new Error(`${quarantined} quarantine DROP rule(s) are active and an install wipes the table; release them or wait for their time limit first`);
    this.phase = 'installing';
    this.label = request.label;
    let report: ExperimentReport;
    try {
      report = await this.writeAndVerify(request.rules, 'install', request.label);
    } catch (err: unknown) {
      // Nothing verified. If any FlowMod may have gone out, put the policy back; either way surface the original error.
      this.phase = 'restoring';
      this.cancelTimer();
      const restored = await this.restoreNow(request.label);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}${restored.ok ? '' : ` (and the restore did not verify: ${restored.detail})`}`);
    }
    this.last = report;
    if (!report.ok) {
      this.log(`[experiment] install NOT VERIFIED (${report.detail}); restoring the isolation policy`);
      this.phase = 'restoring'; // straight to restoring: no idle window between the failed install and its restore
      const restored = await this.restoreNow(request.label);
      return { ...report, restoreAfterFailure: restored };
    }
    this.phase = 'active';
    this.activeIds = request.rules.map((r) => r.id);
    this.expiresAtMs = this.deps.nowMs() + request.ttlSeconds * 1000;
    this.log(`[experiment] install VERIFIED (${request.label || 'unlabelled'}): ${report.detail}; restores in ${request.ttlSeconds} s`);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (this.phase !== 'active') return; // an explicit restore or a session reset got there first
      this.phase = 'restoring';
      this.restoreNow(request.label).catch((err: unknown) => {
        this.log(`[experiment] ALERT automatic restore threw: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, request.ttlSeconds * 1000);
    return report;
  }

  /**
   * The switch session was re-established. The bridge's own `ready` handler reinstalls the isolation policy (table-miss DROP plus the
   * six rules), so forget any active experiment and its time limit. Experimental rules the switch kept across the reconnect expire by
   * their switch-side hard timeout; the readback of the next install or restore will show any that remain.
   */
  public sessionReset(): void {
    if (this.phase !== 'idle') this.log(`[experiment] session reset while ${this.phase}${this.label ? ` (${this.label})` : ''}: the experiment is forgotten and the bridge reinstalls the isolation policy`);
    this.cancelTimer();
    this.phase = 'idle';
    this.clearActive();
  }

  /**
   * The bridge's own session handler re-installed the isolation policy after a reconnect and its readback verified, so a stale "isolation may
   * not be back" alarm from before the reconnect is resolved by the thing it was about. Found in a live test: after the bridge was frozen
   * mid-experiment its overdue restore could not run, the switch dropped the session and flushed its table, the reconnect re-installed and
   * verified isolation, yet the alarm stayed set until a manual restore. Never clears while an experiment is running or being restored.
   */
  public isolationReestablished(): void {
    if (this.phase === 'idle' && this.attention !== null) {
      this.log(`[experiment] isolation re-established and verified by the session handler; clearing the alarm: ${this.attention}`);
      this.attention = null;
    }
  }

  public dispose(): void { this.cancelTimer(); }
}
