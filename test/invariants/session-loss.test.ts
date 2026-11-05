/**
 * test/invariants/session-loss.test.ts
 * Scenario 4, reframed: recovery after the control-plane session is lost (docs/benchmarks/results/scenario4-session-loss/PREREGISTRATION.md). These tests hold the code to the
 * registered bounds: exactly 25,000 pps (not a ceiling with a lower starting point — the plan is rejected if it asks for anything else), the frame reused unchanged from the
 * scenario 5 tooling, the judge's verdicts (recovered, recovered_with_fallback, not_recovered, leak, observer_invalid), and the choreography against a scripted ssh (a bounded wait
 * for the switch's own reconnect, the local-restart fallback firing only once and only after that wait, and a leak stopping everything at once). Nothing here touches a host: a
 * stub ssh is first on PATH, so a call the code forgets to script fails loudly instead of reaching a real machine.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployedCapacityPps } from '../../src/sdn/deployed-cost-model.js';

const LIB = fileURLToPath(new URL('../../scripts/session_loss_lib.py', import.meta.url));

const withNoSsh = <T>(f: (env: NodeJS.ProcessEnv) => T): T => {
  const bin = mkdtempSync(path.join(tmpdir(), 'no-ssh-'));
  try {
    writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "ssh disabled in the offline tests" >&2\nexit 255\n');
    chmodSync(path.join(bin, 'ssh'), 0o755);
    return f({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};
const py = (cmd: string, stdin?: unknown): any =>
  withNoSsh((env) => JSON.parse(execFileSync('python3', ['-I', LIB, cmd], { encoding: 'utf-8', timeout: 30_000, env, ...(stdin === undefined ? {} : { input: JSON.stringify(stdin) }) })));

describe('the registered rate', () => {
  it('is exactly 2x the deployed table\'s measured capacity at k = 0, which is 12,500 pps, so the target is 25,000 pps', () => {
    const capacity = deployedCapacityPps(572n, 0n);
    expect(capacity).toBe(12_500n);
    const dump = py('dump');
    expect(dump.target_pps).toBe(25_000);
    expect(BigInt(dump.target_pps)).toBe(capacity * 2n);
  });

  it('the frame is built with the unchanged workload_frames_lib construction (no options, no fragment flags), 572 B, matched by p1-default-tap-only', () => {
    const dump = py('dump');
    const b = Buffer.from(dump.frame_hex, 'hex');
    expect(b.length).toBe(572);
    expect(b.readUInt16BE(12)).toBe(0x0800); // untagged IPv4
    expect([...b.subarray(26, 30)]).toEqual([10, 0, 2, 52]); // source: in-segment
    expect([...b.subarray(30, 34)]).toEqual([198, 51, 100, 7]); // destination: outside the segment (RFC 5737 TEST-NET-2)
  });
});

describe('plan validation: exactly 25,000 pps, not a ceiling with headroom', () => {
  const validate = (pps: number, stepSeconds = 10): any => py('validate', { pps, step_seconds: stepSeconds });

  it('accepts only the registered plan', () => {
    expect(validate(25_000, 10)).toEqual({ ok: true });
    expect(validate(25_000, 5)).toEqual({ ok: true });
  });

  it('rejects any other rate, above OR below 25,000: this is not a ceiling with a lower starting point', () => {
    for (const pps of [24_999, 25_001, 12_500, 50_000, 1]) {
      const r = validate(pps);
      expect(r.ok, `pps=${pps}`).toBe(false);
      expect(r.reason).toMatch(/25,?000/);
    }
  });

  it('rejects a step outside the reused 5 to 10 s bound, even at the right rate', () => {
    for (const s of [4, 11, 0, -1]) {
      expect(validate(25_000, s).ok).toBe(false);
    }
  });

  it('can fail: a plan at exactly the boundary values passes, one past either boundary does not', () => {
    expect(validate(25_000, 5).ok).toBe(true);
    expect(validate(25_000, 10).ok).toBe(true);
    expect(validate(25_000, 4.999 as unknown as number).ok).toBe(false);
  });
});

type Poll = { ok: true; openflow: string; isolation_state: string; table_miss: string | null; sessions: number } | { ok: false; error: string };
const connected = (sessions: number, state = 'verified', tableMiss: string | null = 'drops'): Poll => ({ ok: true, openflow: 'Connected', isolation_state: state, table_miss: tableMiss, sessions });
const disconnected: Poll = { ok: true, openflow: 'Disconnected', isolation_state: 'mismatch', table_miss: null, sessions: 0 };
const unreadable: Poll = { ok: false, error: 'timeout' };

const judge = (polls: Poll[], o3: number | null, o2: number | null, invalid: Record<string, string> = {}, fallbackFired = false): any =>
  py('judge', { polls, o3_frames: o3, o2_frames: o2, invalid, fallback_fired: fallbackFired });

describe('the judge', () => {
  it('recovered: loss seen, then a poll with a higher session count, verified/drops, no fallback', () => {
    const j = judge([connected(1), disconnected, disconnected, connected(2)], 0, 0);
    expect(j).toMatchObject({ verdict: 'recovered', loss_detected: true });
  });

  it('a poll that is Connected/verified/drops but with the SAME session count as before the loss is not read as recovered: it could be a stale read, not a new session', () => {
    const j = judge([connected(1), disconnected, connected(1)], 0, 0);
    expect(j.verdict).not.toBe('recovered');
  });

  it('recovered_with_fallback: the fallback flag is set, and the final poll is verified/drops with a higher session count', () => {
    const j = judge([connected(1), disconnected, disconnected, connected(2)], 0, 0, {}, true);
    expect(j.verdict).toBe('recovered_with_fallback');
  });

  it('not_recovered: even with the fallback fired, the last poll never comes back verified/drops', () => {
    const j = judge([connected(1), disconnected, disconnected, connected(2, 'mismatch')], 0, 0, {}, true);
    expect(j.verdict).toBe('not_recovered');
  });

  it('not_recovered: no loss was ever even seen to begin with is reported distinctly from a clean recovery (the rate may not have been enough on this run)', () => {
    const j = judge([connected(1), connected(1), connected(1)], 0, 0);
    expect(j).toMatchObject({ verdict: 'no_loss_observed', loss_detected: false });
  });

  it('leak beats every other verdict: any frame at O3 is reported even alongside a clean recovery', () => {
    const j = judge([connected(1), disconnected, connected(2)], 3, 0);
    expect(j.verdict).toBe('leak');
  });

  it('a frame at O2 alone (the tap) is not a leak (the policy already sends this traffic there once restored) and does not override recovered', () => {
    const j = judge([connected(1), disconnected, connected(2)], 0, 5);
    expect(j.verdict).toBe('recovered');
  });

  it('observer_invalid beats everything except nothing (the run is void, no verdict about recovery can be drawn)', () => {
    const j = judge([connected(1), disconnected, connected(2)], 0, 0, { O3: 'capture never ran' });
    expect(j.verdict).toBe('observer_invalid');
  });

  it('accepts null for a frame count (an invalid observer has no count, not a confirmed zero) and does not crash or read it as a leak', () => {
    const j = judge([connected(1), disconnected, connected(2)], null, null, { O3: 'capture never ran' });
    expect(j).toMatchObject({ verdict: 'observer_invalid', o3_frames: null, o2_frames: null });
  });

  it('can fail: a null frame count with an EMPTY invalid map must not crash the leak check (a caller contract judge() has to hold on its own, not just via the observer_invalid short-circuit)', () => {
    const j = judge([connected(1), disconnected, connected(2)], null, null, {});
    expect(j.verdict).toBe('recovered');
    expect(j.o3_frames).toBeNull();
  });

  it('an unreadable poll counts as neither connected nor disconnected: it never by itself flips loss_detected or recovery', () => {
    const j = judge([connected(1), unreadable, unreadable, connected(1)], 0, 0);
    expect(j).toMatchObject({ verdict: 'no_loss_observed', loss_detected: false });
  });

  it('can fail: swapping one poll from disconnected to connected changes recovered to no_loss_observed', () => {
    expect(judge([connected(1), disconnected, connected(2)], 0, 0).verdict).toBe('recovered');
    expect(judge([connected(1), connected(1), connected(2)], 0, 0).verdict).toBe('no_loss_observed');
  });
});

describe('the choreography, against a scripted ssh and bridge', () => {
  it('passes its own selftest: the plan is validated before any ssh; the fallback restart runs at most once and only after the reconnect wait elapses; a leak is found when the captures are read at the end of the window, exactly as in every other experiment in this series (no component here does an interim capture read); an invalid observer is reported as a null frame count, not a confirmed zero; a dry run sends no load and never calls the restart command', () => {
    const out = withNoSsh((env) => execFileSync('python3', ['-I', LIB, 'selftest'], { encoding: 'utf-8', timeout: 60_000, env }));
    expect(out).toContain('selftest ok');
  });
});

describe('the runner script', () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/session-loss.py', import.meta.url));
  const run = (args: string[]): { code: number; out: any } =>
    withNoSsh((env) => {
      try {
        return { code: 0, out: JSON.parse(execFileSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf-8', timeout: 30_000, env })) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: JSON.parse(err.stdout) };
      }
    });

  it('refuses to send load unless given exactly one of --dry-run or --owner-go-for-real-load, before any ssh', () => {
    const r = run(['t']);
    expect(r.code).toBe(2);
    expect(r.out.error).toMatch(/--owner-go-for-real-load/);
  });

  it('refuses a rate argument other than 25000 even if one is explicitly passed, before any ssh', () => {
    const r = run(['t', '--dry-run', '--pps', '50000']);
    expect(r.code).toBe(2);
    expect(r.out.error).toMatch(/25,?000/);
  });

  it('refuses to do anything when the adversary preflight cannot run (every ssh fails here)', () => {
    for (const args of [['t', '--dry-run'], ['t', '--owner-go-for-real-load']]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(r.out.error).toMatch(/refusing to start: the adversary preflight did not pass/);
    }
  });
});
