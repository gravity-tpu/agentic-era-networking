/**
 * isolation-status.test.ts
 * The bridge's isolation status: how a readback becomes `state` and `provenForwarding`, and that the status never
 * claims more than the switch reported.
 *
 * IMPORTANT (Invariant 6): the switch replies are FIXTURES (test/helpers/flow-stats-fixtures.ts). The measured
 * behaviour of Zodiac FX firmware 0.86 is pinned separately in flow-probe-real-capture.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import { buildPort1IsolationPolicy, verifyIsolationReadback } from '../../src/sdn/port1-isolation.js';
import {
  describeReadback,
  initialIsolationStatus,
  isolationStatusToJson,
  pendingReadbackStatus,
  readbackFailedStatus,
  statusFromReadback,
  verifierRejectedStatus,
  withSwitchError,
  type IsolationStatus,
} from '../../src/sdn/isolation-status.js';
import { applyActions, entryFrom, outputAction, replyOf } from '../helpers/flow-stats-fixtures.js';

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);
const OFPP_CONTROLLER = 0xfffffffd;

const faithful = (): Buffer[] => [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))];
const verdictFor = (entries: readonly Buffer[]) =>
  verifyIsolationReadback(policy, parseFlowStatsReply(replyOf(entries)).entries);
const statusFor = (entries: readonly Buffer[], prev: IsolationStatus = pendingReadbackStatus()): IsolationStatus =>
  statusFromReadback(prev, verdictFor(entries), 1_700_000_000_000, 42n);

describe('statusFromReadback', () => {
  it('a switch that reports the policy exactly: verified, and forwarding proven', () => {
    const s = statusFor(faithful());
    expect(s.state).toBe('verified');
    expect(s.provenForwarding).toBe(true);
    expect(s.actions?.status).toBe('confirmed');
    expect(s.actions?.tableMiss).toBe('drops');
    expect(s.confirmed).toHaveLength(policy.length);
    expect(s.checkedAtMs).toBe(1_700_000_000_000);
    expect(s.checkedAtMonoNs).toBe(42n);
    const line = describeReadback(s, policy.length, 7);
    expect(line).toContain('Isolation readback VERIFIED: 6/6 rules confirmed on switch (7 total entries)');
    expect(line).toContain('actions confirmed');
  });

  it('a switch that reports no actions: verified at the match level only, forwarding NOT proven, and the log says so', () => {
    const matchOnly = [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm, Buffer.alloc(0)))];
    const s = statusFor(matchOnly);
    expect(s.state).toBe('verified');
    expect(s.provenForwarding).toBe(false);
    expect(s.actions?.status).toBe('unobservable');
    const line = describeReadback(s, policy.length, 7);
    expect(line).toContain('Isolation readback VERIFIED');
    expect(line).toContain('MATCH LEVEL ONLY');
    expect(line).toContain('not proven');
  });

  it('a leak the match level cannot see (tap-only rule that also outputs to the uplink) is a mismatch', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p1-default-tap-only') + 1;
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(2), outputAction(3)));
    const s = statusFor(entries);
    expect(s.state).toBe('mismatch');
    expect(s.provenForwarding).toBe(false);
    expect(s.actions?.status).toBe('mismatch');
    const line = describeReadback(s, policy.length, 7);
    expect(line).toContain('MISMATCH');
    expect(line).toContain('p1-default-tap-only');
  });

  it('a table-miss that punts to the controller is a mismatch', () => {
    const entries = faithful();
    entries[0] = entryFrom(tableMissMod, applyActions(outputAction(OFPP_CONTROLLER)));
    const s = statusFor(entries);
    expect(s.state).toBe('mismatch');
    expect(s.actions?.tableMiss).toBe('forwards');
    expect(describeReadback(s, policy.length, 7)).toContain('CONTROLLER');
  });

  it('a missing rule is a match-level mismatch and forwarding is not proven', () => {
    const s = statusFor(faithful().filter((_, i) => i !== 1));
    expect(s.state).toBe('mismatch');
    expect(s.provenForwarding).toBe(false);
    expect(s.mismatches.some((m) => m.startsWith('p1-ipv4-intra-segment'))).toBe(true);
  });

  it('an OFPT_ERROR for an isolation FlowMod keeps the state a mismatch even if the readback looks right', () => {
    const prev: IsolationStatus = { ...pendingReadbackStatus(), switchErrors: ['OFPT_ERROR xid 104 (isolation rule p1-default-tap-only): type 5, code 1'] };
    const s = statusFor(faithful(), prev);
    expect(s.state).toBe('mismatch');
    expect(s.provenForwarding).toBe(false);
    expect(describeReadback(s, policy.length, 7)).toContain('OFPT_ERROR');
  });

  it('does not alias the previous status: a later error never changes an earlier status', () => {
    const prev = pendingReadbackStatus();
    const s = statusFor(faithful(), prev);
    const after = withSwitchError(s, 'late error');
    expect(s.switchErrors).toEqual([]);
    expect(prev.switchErrors).toEqual([]);
    expect(after.switchErrors).toEqual(['late error']);
  });

  it('an error that arrives after a verified readback makes it a mismatch and withdraws the proof', () => {
    const verified = statusFor(faithful());
    expect(verified.provenForwarding).toBe(true);
    const after = withSwitchError(verified, 'OFPT_ERROR xid 105 (isolation rule p2-ipv4-to-segment): type 5, code 1');
    expect(after.state).toBe('mismatch');
    expect(after.provenForwarding).toBe(false);
    expect(verified.state).toBe('verified'); // the earlier status is untouched
  });

  it('an error that arrives before the readback is recorded and the readback then reports a mismatch', () => {
    const pending = withSwitchError(pendingReadbackStatus(), 'OFPT_ERROR xid 104');
    expect(pending.state).toBe('pending_readback');
    const s = statusFor(faithful(), pending);
    expect(s.state).toBe('mismatch');
    expect(s.switchErrors).toEqual(['OFPT_ERROR xid 104']);
  });

  it('never claims more than it saw: provenForwarding implies verified and a confirmed action level', () => {
    const variants: Buffer[][] = [
      faithful(),
      [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm, Buffer.alloc(0)))],
      faithful().slice(1),
      faithful().filter((_, i) => i !== 3),
      [],
    ];
    for (const v of variants) {
      const s = statusFor(v);
      if (s.provenForwarding) {
        expect(s.state).toBe('verified');
        expect(s.actions?.status).toBe('confirmed');
        expect(s.actions?.tableMiss).toBe('drops');
      }
    }
  });
});

describe('the other states', () => {
  it('a readback failure carries no action verdict and proves nothing', () => {
    const s = readbackFailedStatus(pendingReadbackStatus(), 'OFPMP_FLOW readback timed out after 10000 ms', 5, 6n);
    expect(s.state).toBe('readback_failed');
    expect(s.actions).toBeNull();
    expect(s.provenForwarding).toBe(false);
    expect(s.mismatches).toEqual(['OFPMP_FLOW readback timed out after 10000 ms']);
  });

  it('a failed readback after a verified one drops the earlier confirmations and proof', () => {
    const verified = statusFor(faithful());
    expect(verified.provenForwarding).toBe(true);
    const s = readbackFailedStatus(verified, 'switch rejected OFPMP_FLOW (type 1, code 2)', 7, 8n);
    expect(s.state).toBe('readback_failed');
    expect(s.confirmed).toEqual([]);
    expect(s.actions).toBeNull();
    expect(s.provenForwarding).toBe(false);
  });

  it('initial, pending and verifier-rejected statuses prove nothing', () => {
    for (const s of [initialIsolationStatus(), pendingReadbackStatus(), verifierRejectedStatus(['x'], 1, 2n)]) {
      expect(s.provenForwarding).toBe(false);
      expect(s.actions).toBeNull();
    }
    expect(initialIsolationStatus().state).toBe('not_installed');
    expect(verifierRejectedStatus(['x'], 1, 2n).mismatches).toEqual(['x']);
  });
});

describe('API form', () => {
  it('serialises with JSON (the monotonic BigInt becomes a string) and keeps the action level', () => {
    const json = JSON.parse(JSON.stringify(isolationStatusToJson(statusFor(faithful()), 42n))) as Record<string, unknown>;
    expect(json['checkedAtMonoNs']).toBe('42');
    expect(json['provenForwarding']).toBe(true);
    expect((json['actions'] as Record<string, unknown>)['status']).toBe('confirmed');
  });

  it('reports how old the readback is, from the monotonic clock, so a stale verified is visible', () => {
    const s = statusFor(faithful()); // checked at monotonic 42 ns
    expect(isolationStatusToJson(s, 42n + 5_000_000_000n).checkedAgeMs).toBe(5000);
    expect(isolationStatusToJson(s, 42n + 3_600_000_000_000n).checkedAgeMs).toBe(3_600_000); // an hour old
    expect(isolationStatusToJson(s, 42n + 5_000_000_000n).ageStatus).toBe('ok');
  });

  it('a readback whose age cannot be read is a clock_error, distinct from never checked', () => {
    const s = statusFor(faithful()); // checked at monotonic 42 ns
    const backwards = isolationStatusToJson(s, 0n);
    expect(backwards.checkedAgeMs).toBeNull();
    expect(backwards.ageStatus).toBe('clock_error');
    expect(backwards.state).toBe('verified'); // the state is untouched; ageStatus is what tells a consumer not to trust it
    expect(isolationStatusToJson(initialIsolationStatus(), 99n).ageStatus).toBe('never_checked');
  });

  it('an unchecked status serialises null timestamp, null age and null action level', () => {
    const json = JSON.parse(JSON.stringify(isolationStatusToJson(initialIsolationStatus(), 99n))) as Record<string, unknown>;
    expect(json['checkedAtMonoNs']).toBeNull();
    expect(json['checkedAgeMs']).toBeNull();
    expect(json['ageStatus']).toBe('never_checked');
    expect(json['actions']).toBeNull();
    expect(json['provenForwarding']).toBe(false);
  });
});
