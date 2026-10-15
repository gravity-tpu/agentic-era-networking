/**
 * flow-readback.ts
 * Switch-side OFPMP_FLOW readback over an established controller session.
 *
 * Council Invariant 6 (Anti-Simulation): the result is whatever the switch reports about its own
 * flow table — never the controller's intent. Council Invariant 1: every failure path rejects
 * with a descriptive error; nothing is swallowed.
 */

import type { OpenFlowServer } from './openflow-server.js';
import { buildFlowStatsRequest, parseFlowStatsReply, parseOfpError } from './dataplane-benchmark.js';
import type { FlowStatsEntry } from './dataplane-benchmark.js';

/**
 * Maximum flow entries allowed during readback to prevent unbounded memory allocation (DoS/OOM protection).
 * The Zodiac FX hardware capacity is 128 rules; 512 provides safe headroom while strictly bounding heap growth.
 */
export const MAX_READBACK_FLOW_ENTRIES = 512;

/**
 * Ceiling on the raw reply bytes retained by readFlowStatsRaw. Each multipart message is at most 64 KiB and the
 * entry cap already bounds a conforming reply far below this; the byte cap also covers a firmware that keeps
 * sending OFPMPF_REPLY_MORE segments with no entries.
 */
export const MAX_READBACK_RAW_BYTES = 1_048_576;

export type FlowStatsSource = Pick<OpenFlowServer, 'reserveXid' | 'sendRaw' | 'on' | 'off'>;

export interface RawFlowStats {
  readonly entries: FlowStatsEntry[];
  /** Every OFPT_MULTIPART_REPLY message received for the request, byte for byte, in arrival order. */
  readonly replies: Buffer[];
}

/**
 * Requests every flow entry from the switch and resolves once the final multipart segment
 * (OFPMPF_REPLY_MORE clear) arrives. Rejects on OFPT_ERROR for this xid, parse failure, timeout,
 * or if accumulated entries exceed maxEntries (unbounded memory allocation defense).
 *
 * Ordering: the request is written on the same TCP stream after any preceding FlowMods. The Zodiac FX
 * MCU processes controller messages sequentially, so FlowMod errors arrive before this reply.
 */
export async function readFlowStats(
  of: FlowStatsSource,
  timeoutMs: number,
  maxEntries: number = MAX_READBACK_FLOW_ENTRIES,
): Promise<FlowStatsEntry[]> {
  return (await readFlowStatsRaw(of, timeoutMs, maxEntries)).entries;
}

/**
 * Same request and the same bounds as readFlowStats, but also returns the raw reply messages. The bytes are the
 * evidence: a parsed entry shows what this code understood, the raw message shows what the switch actually said,
 * and it can be replayed through the parser later (for example into a test fixture) without touching hardware.
 */
export function readFlowStatsRaw(
  of: FlowStatsSource,
  timeoutMs: number,
  maxEntries: number = MAX_READBACK_FLOW_ENTRIES,
  maxRawBytes: number = MAX_READBACK_RAW_BYTES,
): Promise<RawFlowStats> {
  const xid = of.reserveXid();
  const entries: FlowStatsEntry[] = [];
  const replies: Buffer[] = [];
  let rawBytes = 0;
  return new Promise<RawFlowStats>((resolve, reject) => {
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      of.off('multipartReply', onReply);
      of.off('ofError', onError);
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`OFPMP_FLOW readback timed out after ${timeoutMs} ms`))),
      timeoutMs,
    );
    const onReply = (rxXid: number, packet: Buffer): void => {
      if (rxXid !== xid) return;
      try {
        rawBytes += packet.length;
        if (rawBytes > maxRawBytes) {
          done(() => reject(new Error(`OFPMP_FLOW readback exceeded ${maxRawBytes} raw bytes; aborted to bound memory`)));
          return;
        }
        replies.push(Buffer.from(packet)); // copy: the socket may reuse its buffer
        const reply = parseFlowStatsReply(packet);
        if (entries.length + reply.entries.length > maxEntries) {
          done(() =>
            reject(
              new Error(
                `OFPMP_FLOW readback exceeded max flow entries limit (${entries.length + reply.entries.length} > ${maxEntries}); aborted to prevent unbounded memory allocation`,
              ),
            ),
          );
          return;
        }
        entries.push(...reply.entries);
        if (!reply.more) done(() => resolve({ entries, replies }));
      } catch (e: unknown) {
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    };
    const onError = (rxXid: number, packet: Buffer): void => {
      if (rxXid !== xid) return;
      const info = parseOfpError(packet);
      done(() => reject(new Error(`switch rejected OFPMP_FLOW (type ${info.errorType}, code ${info.errorCode})`)));
    };
    of.on('multipartReply', onReply);
    of.on('ofError', onError);
    try {
      of.sendRaw(buildFlowStatsRequest(xid));
    } catch (e: unknown) {
      done(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}
