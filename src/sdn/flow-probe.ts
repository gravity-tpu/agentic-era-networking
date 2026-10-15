/**
 * flow-probe.ts
 * A read-only probe report of the switch's own flow table: what the Zodiac FX says it holds, including the raw
 * bytes, and what that implies for action-level readback.
 *
 * Why it exists: action-level readback (action-readback.ts) is tested only on fixtures built from the
 * controller's own encoding. Whether firmware 0.86 reports the instruction block of a flow-stats entry at all is
 * unmeasured. This report is the measurement. It keeps the raw reply bytes, so a real capture can later be
 * replayed through the parser (and become a test fixture) without touching hardware, and so a reader of the
 * report does not have to trust this module's summary: `analyzeFlowProbe` re-derives it from the bytes.
 *
 * Read-only by construction: nothing here builds or sends a message. The bridge sends a single OFPMP_FLOW
 * request; this module only interprets what came back.
 *
 * Pure functions, no I/O. Counters are decimal strings of BigInt values (Invariant 2); timestamps are supplied by
 * the caller (the monotonic one from process.hrtime.bigint()).
 */

import { createHash } from 'node:crypto';
import { parseFlowStatsReply, type FlowStatsEntry } from './dataplane-benchmark.js';
import type { FlowStatsActions } from './flow-actions.js';
import type { ActionReadbackVerdict } from './action-readback.js';
import { verifyIsolationReadback, type IsolationRule } from './port1-isolation.js';

export const FLOW_PROBE_SCHEMA = 'zodiac-flow-probe/v1';
/** Provenance: bytes read from a physical switch over a live OpenFlow session (Invariant 6). */
export const FLOW_PROBE_ORIGIN = 'physical_readback';

/**
 * What the probe established about the firmware.
 *   no-entries                 the switch reported an empty flow table (the policy is not installed, or was lost)
 *   reports-instructions       at least one entry carried instruction bytes: action-level readback is observable
 *   no-instructions-reported   no entry carried any: the firmware omits them, or every installed rule is a drop
 *   unreadable-instructions    entries carried instruction bytes this parser could not read completely
 */
export type FlowProbeFinding = 'no-entries' | 'reports-instructions' | 'no-instructions-reported' | 'unreadable-instructions';

export interface FlowProbeEntry {
  readonly tableId: number;
  readonly priority: number;
  readonly packetCount: string;
  readonly byteCount: string;
  readonly inPort?: number;
  readonly ethType?: number;
  readonly srcIp?: string;
  readonly srcMask?: string;
  readonly dstIp?: string;
  readonly dstMask?: string;
  readonly actions: FlowStatsActions;
  /** The whole ofp_flow_stats entry as the switch sent it, lowercase hex. */
  readonly entryHex: string;
}

export interface FlowProbeReadback {
  /** Match level (verifyIsolationReadback.verified). */
  readonly verified: boolean;
  readonly mismatches: readonly string[];
  readonly actions: ActionReadbackVerdict;
  readonly provenForwarding: boolean;
}

export interface FlowProbeReport {
  readonly schema: typeof FLOW_PROBE_SCHEMA;
  readonly origin: typeof FLOW_PROBE_ORIGIN;
  readonly capturedAtIso: string;
  /** process.hrtime.bigint() at capture, decimal string. */
  readonly capturedMonotonicNs: string;
  /** Free-form context the caller knows (host, switch identity, firmware); never used by the analysis. */
  readonly context: Readonly<Record<string, string>>;
  readonly finding: FlowProbeFinding;
  readonly findingDetail: string;
  readonly entryCount: number;
  readonly entries: readonly FlowProbeEntry[];
  readonly readback: FlowProbeReadback;
  /** Every OFPT_MULTIPART_REPLY message, byte for byte, lowercase hex. The evidence the summary above derives from. */
  readonly rawRepliesHex: readonly string[];
  /** sha256 over the concatenated raw reply bytes. */
  readonly rawRepliesSha256: string;
}

export class FlowProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowProbeError';
  }
}

/** More than one probe at a time, or too soon after the last one. Carries how long to wait. */
export class FlowProbeRateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number, reason: string) {
    super(reason);
    this.name = 'FlowProbeRateLimitedError';
  }
}

/**
 * The smallest ofp_flow_stats entry (OpenFlow 1.3 section 7.3.5.2): the 48-byte fixed part (length 2, table_id 1,
 * pad 1, duration_sec 4, duration_nsec 4, priority 2, idle_timeout 2, hard_timeout 2, flags 2, pad 4, cookie 8,
 * packet_count 8, byte_count 8) plus an ofp_match of at least 8 bytes (4-byte header padded to 8). Same floor as
 * parseFlowStatsReply.
 */
const MIN_FLOW_STATS_ENTRY_BYTES = 56;

/**
 * The entries of one multipart reply, as raw bytes. These bytes are the evidence, so this does its own bounds
 * checks rather than relying on parseFlowStatsReply having rejected a bad length: a zero length would otherwise
 * never advance, and an overrun would silently truncate the evidence.
 */
export function splitFlowStatsEntries(packet: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 16;
  while (off < packet.length) {
    if (off + 2 > packet.length) throw new FlowProbeError(`entry header truncated at offset ${off}`);
    const len = packet.readUInt16BE(off);
    if (len < MIN_FLOW_STATS_ENTRY_BYTES || off + len > packet.length) {
      throw new FlowProbeError(`entry length ${len} at offset ${off} is outside the ${packet.length}-byte reply`);
    }
    out.push(packet.subarray(off, off + len));
    off += len;
  }
  return out;
}

const hex = (b: Buffer): string => b.toString('hex');

function classify(entries: readonly FlowStatsEntry[]): { finding: FlowProbeFinding; detail: string } {
  if (entries.length === 0) {
    return {
      finding: 'no-entries',
      detail: 'The switch reported an empty flow table. The isolation policy is not installed (or was lost), so nothing can be said about instruction reporting.',
    };
  }
  const withInstructions = entries.filter((e) => e.actions?.hasInstructions === true);
  if (withInstructions.length === 0) {
    return {
      finding: 'no-instructions-reported',
      detail:
        `None of the ${entries.length} entries carried instruction bytes. Either the firmware omits the instruction ` +
        'block from flow-stats entries, or every installed rule has no actions (a drop, or an output that was lost). ' +
        'This report cannot tell those apart; on-wire captures show whether traffic is actually forwarded. ' +
        'Action-level readback is `unobservable` here, and must not be described as proving forwarding intent.',
    };
  }
  const unreadable = withInstructions.filter((e) => e.actions?.complete !== true);
  if (unreadable.length > 0) {
    return {
      finding: 'unreadable-instructions',
      detail:
        `${unreadable.length} of ${withInstructions.length} entries carrying instructions could not be parsed to the ` +
        'end. Compare their entryHex with OpenFlow 1.3 section 7.3.5.2; the parser may need a new action or instruction type.',
    };
  }
  return {
    finding: 'reports-instructions',
    detail:
      `${withInstructions.length} of ${entries.length} entries carried instruction bytes that parsed completely. ` +
      'Action-level readback is observable on this firmware; see `readback.actions` for whether it matches the policy.',
  };
}

export interface FlowProbeInput {
  readonly policy: readonly IsolationRule[];
  /** Raw OFPT_MULTIPART_REPLY messages from the switch, in arrival order. */
  readonly replies: readonly Buffer[];
  readonly capturedAtIso: string;
  readonly capturedMonotonicNs: bigint;
  readonly context?: Readonly<Record<string, string>>;
}

/** Builds the report from raw reply bytes. Throws FlowProbeError if a reply cannot be parsed at all. */
export function buildFlowProbeReport(input: FlowProbeInput): FlowProbeReport {
  // Each parsed entry is kept together with its own raw bytes, so the two can never be matched up by position.
  const pairs: { readonly entry: FlowStatsEntry; readonly rawEntry: Buffer }[] = [];
  for (const [i, packet] of input.replies.entries()) {
    let reply;
    try {
      reply = parseFlowStatsReply(packet);
    } catch (e: unknown) {
      throw new FlowProbeError(`reply ${i} is not a parseable OFPMP_FLOW reply: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bufs = splitFlowStatsEntries(packet);
    if (bufs.length !== reply.entries.length) {
      // Two independent walks of the same bytes must agree, or entryHex would not belong to its parsed entry.
      throw new FlowProbeError(`reply ${i}: parsed ${reply.entries.length} entries but found ${bufs.length} raw entries`);
    }
    reply.entries.forEach((entry, j) => {
      const rawEntry = bufs[j];
      if (rawEntry === undefined) throw new FlowProbeError(`reply ${i}: no raw bytes for entry ${j}`);
      pairs.push({ entry, rawEntry });
    });
  }

  const entries = pairs.map((p) => p.entry);
  const verdict = verifyIsolationReadback(input.policy, entries);
  const { finding, detail } = classify(entries);
  const probeEntries: FlowProbeEntry[] = pairs.map(({ entry: e, rawEntry }) => ({
    tableId: e.tableId,
    priority: e.priority,
    packetCount: e.packetCount.toString(),
    byteCount: e.byteCount.toString(),
    ...(e.inPort !== undefined ? { inPort: e.inPort } : {}),
    ...(e.ethType !== undefined ? { ethType: e.ethType } : {}),
    ...(e.srcIp !== undefined ? { srcIp: e.srcIp } : {}),
    ...(e.srcMask !== undefined ? { srcMask: e.srcMask } : {}),
    ...(e.dstIp !== undefined ? { dstIp: e.dstIp } : {}),
    ...(e.dstMask !== undefined ? { dstMask: e.dstMask } : {}),
    actions: e.actions ?? { outputPorts: [], otherActionTypes: [], otherInstructionTypes: [], hasInstructions: false, complete: false },
    entryHex: hex(rawEntry),
  }));

  return {
    schema: FLOW_PROBE_SCHEMA,
    origin: FLOW_PROBE_ORIGIN,
    capturedAtIso: input.capturedAtIso,
    capturedMonotonicNs: input.capturedMonotonicNs.toString(),
    context: input.context ?? {},
    finding,
    findingDetail: detail,
    entryCount: entries.length,
    entries: probeEntries,
    readback: {
      verified: verdict.verified,
      mismatches: verdict.mismatches,
      actions: verdict.actions,
      provenForwarding: verdict.provenForwarding,
    },
    rawRepliesHex: input.replies.map(hex),
    rawRepliesSha256: createHash('sha256').update(Buffer.concat(input.replies.map((b) => Buffer.from(b)))).digest('hex'),
  };
}

export interface FlowProbeDisagreement {
  readonly field: string;
  readonly reported: string;
  readonly rederived: string;
}

export interface FlowProbeAnalysis {
  /** The report rebuilt from its own raw bytes. */
  readonly rederived: FlowProbeReport;
  /** Fields where the stored report differs from the re-derivation. Empty means the summary matches the bytes. */
  readonly disagreements: readonly FlowProbeDisagreement[];
}

const isHex = (s: string): boolean => /^(?:[0-9a-f]{2})*$/.test(s);

/**
 * Independent check of a stored report: decode its raw bytes, rebuild the report with the same code, and compare
 * the summary fields. A report whose summary was edited, or produced by a different version of the parser, shows
 * up as a disagreement rather than being trusted.
 */
export function analyzeFlowProbe(report: FlowProbeReport, policy: readonly IsolationRule[]): FlowProbeAnalysis {
  if (report.schema !== FLOW_PROBE_SCHEMA) throw new FlowProbeError(`unsupported schema ${JSON.stringify(report.schema)}`);
  if (report.origin !== FLOW_PROBE_ORIGIN) throw new FlowProbeError(`unexpected origin ${JSON.stringify(report.origin)}`);
  const replies = report.rawRepliesHex.map((h, i) => {
    if (!isHex(h)) throw new FlowProbeError(`rawRepliesHex[${i}] is not lowercase hex`);
    return Buffer.from(h, 'hex');
  });
  const rederived = buildFlowProbeReport({
    policy,
    replies,
    capturedAtIso: report.capturedAtIso,
    capturedMonotonicNs: BigInt(report.capturedMonotonicNs),
    context: report.context,
  });
  const disagreements: FlowProbeDisagreement[] = [];
  const check = (field: string, reported: unknown, derived: unknown): void => {
    const a = JSON.stringify(reported);
    const b = JSON.stringify(derived);
    if (a !== b) disagreements.push({ field, reported: a ?? 'undefined', rederived: b ?? 'undefined' });
  };
  check('rawRepliesSha256', report.rawRepliesSha256, rederived.rawRepliesSha256);
  check('finding', report.finding, rederived.finding);
  check('entryCount', report.entryCount, rederived.entryCount);
  check('entries', report.entries, rederived.entries);
  check('readback', report.readback, rederived.readback);
  return { rederived, disagreements };
}

export interface ProbeHttpResponse {
  readonly status: number;
  readonly body: { readonly error: string; readonly retryAfterSeconds?: number };
}

/**
 * Maps a probe failure to an HTTP response. Messages are this project's own strings, never stack traces.
 * 429 rate limited or already running; 503 no established switch session; 504 the switch did not answer in time;
 * 502 the switch answered with something that is not a parseable flow-stats reply; 500 anything unexpected.
 */
export function probeErrorToHttp(err: unknown): ProbeHttpResponse {
  if (err instanceof FlowProbeRateLimitedError) {
    return { status: 429, body: { error: err.message, retryAfterSeconds: Math.max(1, Math.floor((err.retryAfterMs + 999) / 1000)) } };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Cannot send raw OpenFlow message')) return { status: 503, body: { error: 'switch not connected: no established OpenFlow session' } };
  if (message.includes('timed out')) return { status: 504, body: { error: message } };
  if (err instanceof FlowProbeError) return { status: 502, body: { error: message } };
  if (message.includes('OFPMP_FLOW')) return { status: 502, body: { error: message } };
  return { status: 500, body: { error: 'flow-table probe failed unexpectedly' } };
}
