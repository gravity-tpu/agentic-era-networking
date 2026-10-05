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
 * Requests every flow entry from the switch and resolves once the final multipart segment
 * (OFPMPF_REPLY_MORE clear) arrives. Rejects on OFPT_ERROR for this xid, parse failure, or timeout.
 *
 * Ordering: the request is written on the same TCP stream after any preceding FlowMods. The Zodiac FX
 * MCU processes controller messages sequentially, so FlowMod errors arrive before this reply.
 */
export function readFlowStats(of: OpenFlowServer, timeoutMs: number): Promise<FlowStatsEntry[]> {
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
