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

export type FlowStatsSource = Pick<OpenFlowServer, 'reserveXid' | 'sendRaw' | 'on' | 'off'>;

/**
 * Requests every flow entry from the switch and resolves once the final multipart segment
 * (OFPMPF_REPLY_MORE clear) arrives. Rejects on OFPT_ERROR for this xid, parse failure, timeout,
 * or if accumulated entries exceed maxEntries (unbounded memory allocation defense).
 *
 * Ordering: the request is written on the same TCP stream after any preceding FlowMods. The Zodiac FX
 * MCU processes controller messages sequentially, so FlowMod errors arrive before this reply.
 */
export function readFlowStats(
  of: FlowStatsSource,
  timeoutMs: number,
  maxEntries: number = MAX_READBACK_FLOW_ENTRIES,
): Promise<FlowStatsEntry[]> {
  const xid = of.reserveXid();
  const entries: FlowStatsEntry[] = [];
  return new Promise<FlowStatsEntry[]>((resolve, reject) => {
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
        if (!reply.more) done(() => resolve(entries));
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
