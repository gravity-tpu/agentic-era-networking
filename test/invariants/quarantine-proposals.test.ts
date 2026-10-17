/**
 * quarantine-proposals.test.ts
 * The proposal store: one entry per source, bounded, and stale proposals cannot be approved.
 */

import { describe, it, expect } from 'vitest';
import {
  QUARANTINE_PROPOSAL_CAPACITY,
  QUARANTINE_PROPOSAL_MAX_AGE_MS,
  QuarantineProposals,
} from '../../src/sdn/quarantine-proposals.js';

const MS = 1_000_000n;
const input = (ip: string) => ({ targetIp: ip, reason: 'r', priority: 65535, evidence: { pps: 18 } });

describe('QuarantineProposals', () => {
  it('keeps one entry per source and counts repeat requests', () => {
    const p = new QuarantineProposals();
    p.record(input('10.0.2.50'), 0n, 1000);
    const again = p.record(input('10.0.2.50'), 5n * MS, 2000);
    expect(again.requests).toBe(2);
    expect(again.firstProposedAtMs).toBe(1000);
    expect(again.lastProposedAtMs).toBe(2000);
    expect(p.list(10n * MS)).toHaveLength(1);
  });

  it('lists the most recent first', () => {
    const p = new QuarantineProposals();
    p.record(input('10.0.2.50'), 0n, 1);
    p.record(input('10.0.2.51'), 1n, 2);
    p.record(input('10.0.2.50'), 2n, 3);
    expect(p.list(3n).map((x) => x.targetIp)).toEqual(['10.0.2.50', '10.0.2.51']);
  });

  it('does not offer a stale proposal, and removes it', () => {
    const p = new QuarantineProposals();
    p.record(input('10.0.2.50'), 0n, 1);
    const fresh = BigInt(QUARANTINE_PROPOSAL_MAX_AGE_MS) * MS;
    expect(p.get('10.0.2.50', fresh)).not.toBeNull();
    expect(p.get('10.0.2.50', fresh + 1n)).toBeNull();
    expect(p.list(fresh + 1n)).toEqual([]);
  });

  it('a clock that appears to have gone backwards is treated as stale, not fresh', () => {
    const p = new QuarantineProposals();
    p.record(input('10.0.2.50'), 100n * MS, 1);
    expect(p.get('10.0.2.50', 50n * MS)).toBeNull();
  });

  it('is bounded: the least recently proposed is dropped first', () => {
    const p = new QuarantineProposals();
    for (let i = 0; i < QUARANTINE_PROPOSAL_CAPACITY + 5; i++) p.record(input(`10.0.2.${i + 1}`), BigInt(i), i);
    const ips = p.list(BigInt(QUARANTINE_PROPOSAL_CAPACITY + 5)).map((x) => x.targetIp);
    expect(ips).toHaveLength(QUARANTINE_PROPOSAL_CAPACITY);
    expect(ips).not.toContain('10.0.2.1');
    expect(ips).toContain(`10.0.2.${QUARANTINE_PROPOSAL_CAPACITY + 5}`);
  });

  it('remove forgets a proposal', () => {
    const p = new QuarantineProposals();
    p.record(input('10.0.2.50'), 0n, 1);
    p.remove('10.0.2.50');
    expect(p.get('10.0.2.50', 1n)).toBeNull();
  });
});
