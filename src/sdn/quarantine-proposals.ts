/**
 * Proposals for quarantine that a person has not yet approved (the bridge's `propose` mode).
 *
 * One entry per source IP, bounded, and stale ones are refused at approval: a proposal is a claim about traffic
 * that was seen a moment ago, not a standing instruction. Ages use monotonic nanoseconds (Invariant 2); the wall-clock
 * milliseconds are for display only. Pure: no I/O, time is passed in.
 */

import type { EvidenceValue } from './quarantine-envelope.js';

/** How long a proposal can still be approved. */
export const QUARANTINE_PROPOSAL_MAX_AGE_MS = 600_000;
/** Most proposals held at once; the least recently proposed is dropped first. */
export const QUARANTINE_PROPOSAL_CAPACITY = 64;

export interface QuarantineProposal {
  readonly targetIp: string;
  readonly reason: string;
  readonly priority: number;
  readonly evidence: Readonly<Record<string, EvidenceValue>>;
  readonly firstProposedAtMs: number;
  readonly lastProposedAtMs: number;
  /** How many times a detector has asked for this source since the first. */
  readonly requests: number;
}

interface Stored {
  proposal: QuarantineProposal;
  lastMonoNs: bigint;
}

export class QuarantineProposals {
  private readonly byIp = new Map<string, Stored>();

  record(
    input: { targetIp: string; reason: string; priority: number; evidence: Readonly<Record<string, EvidenceValue>> },
    nowMonoNs: bigint,
    nowMs: number,
  ): QuarantineProposal {
    const existing = this.byIp.get(input.targetIp);
    const proposal: QuarantineProposal = {
      ...input,
      firstProposedAtMs: existing?.proposal.firstProposedAtMs ?? nowMs,
      lastProposedAtMs: nowMs,
      requests: (existing?.proposal.requests ?? 0) + 1,
    };
    // Re-insert so the Map's order is least recently proposed first.
    this.byIp.delete(input.targetIp);
    this.byIp.set(input.targetIp, { proposal, lastMonoNs: nowMonoNs });
    while (this.byIp.size > QUARANTINE_PROPOSAL_CAPACITY) {
      const oldest = this.byIp.keys().next().value;
      if (oldest === undefined) break;
      this.byIp.delete(oldest);
    }
    return proposal;
  }

  private isFresh(s: Stored, nowMonoNs: bigint): boolean {
    return nowMonoNs >= s.lastMonoNs && nowMonoNs - s.lastMonoNs <= BigInt(QUARANTINE_PROPOSAL_MAX_AGE_MS) * 1_000_000n;
  }

  /** Proposals still approvable, most recent first. Stale ones are removed. */
  list(nowMonoNs: bigint): QuarantineProposal[] {
    for (const [ip, s] of [...this.byIp.entries()]) {
      if (!this.isFresh(s, nowMonoNs)) this.byIp.delete(ip);
    }
    return [...this.byIp.values()].reverse().map((s) => s.proposal);
  }

  /** The current proposal for an IP, or null when there is none or it is stale. */
  get(targetIp: string, nowMonoNs: bigint): QuarantineProposal | null {
    const s = this.byIp.get(targetIp);
    if (s === undefined) return null;
    if (!this.isFresh(s, nowMonoNs)) {
      this.byIp.delete(targetIp);
      return null;
    }
    return s.proposal;
  }

  remove(targetIp: string): void {
    this.byIp.delete(targetIp);
  }
}
