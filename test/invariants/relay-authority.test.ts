/**
 * relay-authority.test.ts
 * Which relay pushes may overwrite the cloud's live snapshot. The motivating incident (2026-10-12 to 2026-10-16): a
 * second bridge with no hardware, started on a laptop whose environment pointed at production, pushed a `disconnected`
 * snapshot every 2.5 s next to the real bridge's live push every 5 s. With last-writer-wins, the dashboard showed
 * "hardware disconnected" for about two thirds of all polls while no device had moved.
 *
 * IMPORTANT (Invariant 6): the cadences are those observed in Vercel runtime logs and the Mac's byte counters on
 * 2026-10-16; the replay below is a simulation of that pattern, not a capture.
 */

import { describe, it, expect } from 'vitest';
import {
  INITIAL_RELAY_AUTHORITY,
  RELAY_IGNORED_PAUSE_MS,
  decideRelayPush,
  isRelayIgnoredAck,
  nextRelayAuthority,
  readBridgeId,
  type IncomingPush,
  type RelayAuthorityState,
} from '../../src/sdn/relay-authority.js';

const FRESH_MS = 25_000; // CLOUD_RELAY_BOUNDS.BRIDGE_PUSH_CADENCE_MS * MAX_MISSED_PUSH_CYCLES

const live = (bridgeId?: string): IncomingPush => ({ verifiedSource: 'live_hardware', bridgeId });
const disconnected = (bridgeId?: string): IncomingPush => ({ verifiedSource: 'disconnected', bridgeId });
const demoted = (bridgeId?: string): IncomingPush => ({ verifiedSource: 'cloud_snapshot', bridgeId });

/** Applies one push the way the cloud handler does. */
function apply(state: RelayAuthorityState, push: IncomingPush, now: number, dbLiveFresh = false) {
  const decision = decideRelayPush(state, push, now, FRESH_MS, dbLiveFresh);
  return { decision, state: nextRelayAuthority(state, push, decision, now) };
}

describe('decideRelayPush', () => {
  it('always accepts a verified live push, and its sender becomes the live source', () => {
    const r = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 1000);
    expect(r.decision).toEqual({ accept: true, reason: 'live', competingLive: false });
    expect(r.state).toEqual({ liveBridgeId: 'jetson:1', liveReceivedAtMs: 1000 });
  });

  it('ignores a non-live push from another sender while a live snapshot is fresh', () => {
    let s = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 0).state;
    for (const t of [2500, 5000, 7500, 10_000]) {
      const r = apply(s, disconnected('mac:2'), t);
      expect(r.decision).toEqual({ accept: false, reason: 'non-live-while-live-fresh' });
      expect(r.state).toBe(s); // an ignored push changes nothing
    }
  });

  it('treats an unverified live claim (demoted to cloud_snapshot) as non-live too', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 0).state;
    expect(apply(s, demoted('mac:2'), 1000).decision.accept).toBe(false);
  });

  it('accepts a non-live push once the live snapshot is no longer fresh (the cloud never claims live without evidence)', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 0).state;
    expect(apply(s, disconnected('mac:2'), FRESH_MS).decision.accept).toBe(false); // exactly at the bound: still fresh
    const r = apply(s, disconnected('mac:2'), FRESH_MS + 1);
    expect(r.decision).toEqual({ accept: true, reason: 'no-fresh-live', competingLive: false });
    expect(r.state).toEqual(INITIAL_RELAY_AUTHORITY);
  });

  it('accepts a non-live push when nothing live has ever been seen', () => {
    expect(apply(INITIAL_RELAY_AUTHORITY, disconnected('mac:2'), 5).decision.accept).toBe(true);
  });

  it('believes the live sender at once when it reports that its hardware went away', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 0).state;
    const r = apply(s, disconnected('jetson:1'), 5000);
    expect(r.decision).toEqual({ accept: true, reason: 'primary-reports-non-live', competingLive: false });
    expect(r.state).toEqual(INITIAL_RELAY_AUTHORITY);
    // and the stray's next push is now accepted too, because nothing live is fresh any more
    expect(apply(r.state, disconnected('mac:2'), 7500).decision.accept).toBe(true);
  });

  it('a sender with no identity cannot claim to be the live sender: its disconnect waits for the freshness bound', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live(undefined), 0).state;
    expect(apply(s, disconnected(undefined), 5000).decision.accept).toBe(false);
    expect(apply(s, disconnected(undefined), FRESH_MS + 1).decision.accept).toBe(true);
  });

  it('uses the shared database when this instance has not seen the live bridge', () => {
    // another serverless instance has been receiving the real bridge; this one's memory is empty
    expect(apply(INITIAL_RELAY_AUTHORITY, disconnected('mac:2'), 100, true).decision).toEqual({
      accept: false,
      reason: 'non-live-while-live-fresh',
    });
    expect(apply(INITIAL_RELAY_AUTHORITY, disconnected('mac:2'), 100, false).decision.accept).toBe(true);
  });

  it('accepts two live senders but says they compete, so it is not silent', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson:1'), 0).state;
    const r = apply(s, live('other:9'), 1000);
    expect(r.decision).toEqual({ accept: true, reason: 'live', competingLive: true });
    expect(r.state.liveBridgeId).toBe('other:9');
  });
});

describe('a real bridge is never the one that gets paused', () => {
  it('a live push is accepted even when a different live sender is fresh, so a restarted bridge (new id) is not held back', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson-orin:100:1000'), 0).state;
    const restarted = apply(s, live('jetson-orin:200:2000'), 3000);
    expect(restarted.decision.accept).toBe(true);
    expect(restarted.state.liveBridgeId).toBe('jetson-orin:200:2000');
  });

  it('only a non-live push can be ignored, and so only a non-live push is ever followed by the pause', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('a'), 0).state;
    for (const id of ['a', 'b', undefined]) {
      expect(apply(s, live(id), 1000).decision.accept, `live from ${String(id)}`).toBe(true);
    }
  });

  it('a restarted real bridge reporting a disconnect with its new id waits out the bound, like any other sender', () => {
    const s = apply(INITIAL_RELAY_AUTHORITY, live('jetson-orin:100:1000'), 0).state;
    expect(apply(s, disconnected('jetson-orin:200:2000'), 3000).decision.accept).toBe(false);
  });
});

describe('the incident, replayed', () => {
  /** Last writer wins: what the cloud did before. Counts how many times the served source flipped. */
  function baselineFlips(pushes: Array<{ at: number; push: IncomingPush }>): number {
    let served: string | null = null;
    let flips = 0;
    for (const { push } of pushes) {
      if (served !== null && served !== push.verifiedSource) flips += 1;
      served = push.verifiedSource;
    }
    return flips;
  }

  const tenMinutes = 600_000;
  const pushes = (() => {
    const out: Array<{ at: number; push: IncomingPush }> = [];
    for (let t = 0; t < tenMinutes; t += 5000) out.push({ at: t, push: live('jetson:1') });
    for (let t = 1300; t < tenMinutes; t += 2500) out.push({ at: t, push: disconnected('mac:2') });
    return out.sort((a, b) => a.at - b.at);
  })();

  it('the old behaviour flipped the served source constantly', () => {
    expect(baselineFlips(pushes)).toBeGreaterThan(100); // many flips over ten minutes
  });

  it('with authority, the stray bridge never displaces the live snapshot, and every live push is accepted', () => {
    let s = INITIAL_RELAY_AUTHORITY;
    let acceptedNonLive = 0;
    let acceptedLive = 0;
    let liveSeen = 0;
    for (const { at, push } of pushes) {
      const r = apply(s, push, at);
      s = r.state;
      if (push.verifiedSource === 'live_hardware') {
        liveSeen += 1;
        if (r.decision.accept) acceptedLive += 1;
      } else if (r.decision.accept) {
        // the only non-live pushes accepted may be those before the first live push
        acceptedNonLive += 1;
      }
    }
    expect(acceptedLive).toBe(liveSeen);
    // the stray's very first push (t=1300) arrives after the first live push (t=0), so none are accepted
    expect(acceptedNonLive).toBe(0);
  });

  it('when the live bridge really does die, the stray is believed only after the freshness bound', () => {
    let s = INITIAL_RELAY_AUTHORITY;
    s = apply(s, live('jetson:1'), 0).state;
    s = apply(s, live('jetson:1'), 5000).state; // last live push at 5 s, then the Jetson goes silent
    const at = (t: number) => apply(s, disconnected('mac:2'), t).decision.accept;
    expect(at(5000 + FRESH_MS)).toBe(false);
    expect(at(5000 + FRESH_MS + 1)).toBe(true);
  });
});

describe('readBridgeId', () => {
  it('accepts a normal identity and rejects anything unbounded or odd', () => {
    expect(readBridgeId({ bridgeId: 'jetson-orin:257128:1792000000000' })).toBe('jetson-orin:257128:1792000000000');
    for (const bad of ['', 'a'.repeat(129), 'has space', 'semi;colon', '../../etc', 'új']) {
      expect(readBridgeId({ bridgeId: bad }), JSON.stringify(bad)).toBeUndefined();
    }
    for (const notString of [1, null, undefined, {}, [], true]) {
      expect(readBridgeId({ bridgeId: notString })).toBeUndefined();
    }
    for (const notObject of [null, undefined, 'x', 5, []]) {
      expect(readBridgeId(notObject)).toBeUndefined();
    }
  });
});

describe('isRelayIgnoredAck (how a bridge learns it was ignored)', () => {
  it('recognises exactly the cloud\'s ignore reply, and nothing else', () => {
    expect(isRelayIgnoredAck({ status: 'ignored', synced: false, reason: 'non-live-while-live-fresh' })).toBe(true);
    for (const notIgnore of [
      { status: 'ok', synced: true, provenance: 'live_hardware' },
      { status: 'ignored' }, // no reason
      { status: 'ignored', reason: 7 },
      { status: 'IGNORED', reason: 'x' },
      null,
      undefined,
      'ignored',
      [],
    ]) {
      expect(isRelayIgnoredAck(notIgnore), JSON.stringify(notIgnore)).toBe(false);
    }
  });

  it('the pause is bounded: long enough to stop hammering, short enough that a recovered primary resumes', () => {
    expect(RELAY_IGNORED_PAUSE_MS).toBeGreaterThanOrEqual(10_000);
    expect(RELAY_IGNORED_PAUSE_MS).toBeLessThanOrEqual(300_000);
  });
});
