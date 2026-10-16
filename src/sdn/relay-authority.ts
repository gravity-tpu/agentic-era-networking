/**
 * relay-authority.ts
 * Which relay pushes the cloud function may let overwrite its live snapshot.
 *
 * The problem this exists for: the cloud keeps ONE in-memory snapshot and every accepted push replaces it, with no
 * notion of who is pushing. A second bridge with no hardware attached (for example a development `npm run serve`
 * on a laptop whose environment points at production) pushes a `disconnected` snapshot, and the dashboard then
 * alternates between the real bridge's live view and that one's disconnected view, several times a minute, while the
 * hardware never moved. Its time series were merged into the same rolling buffers too, so the graphs dipped to zero.
 *
 * The rule (Invariant 3, fail closed, and 6, provenance):
 *   - A verified LIVE push is always accepted, and its sender becomes the live source.
 *   - A NON-LIVE push (disconnected, or an unverified claim) is IGNORED while a live snapshot is fresh, unless it comes
 *     from the same sender that reported live: then it is the authoritative bridge reporting that its hardware went
 *     away, and it is believed at once.
 *   - With no fresh live snapshot, a non-live push is accepted: the cloud never claims live without evidence.
 * "Fresh" is the cloud's existing staleness bound (push cadence x allowed missed cycles), so the worst a real
 * disconnect can be delayed by an unidentified sender is that bound.
 *
 * Serverless instances do not share memory, so the caller also supplies whether the shared database holds a fresh
 * live row. That is only consulted on the rare non-live path.
 *
 * Two decisions worth recording, because they look like gaps and are not:
 *   - A live push is ALWAYS accepted, even when a different live sender is fresh. Making the incumbent sticky would
 *     also hold back a real bridge that restarted (a new bridgeId) for up to the freshness bound. Two live bridges on one
 *     switch are a misconfiguration; the handler reports it (competingLive) instead of hiding it behind a tie-break.
 *   - Because a live push is never ignored, a bridge that has hardware is never paused by RELAY_IGNORED_PAUSE_MS: that pause
 *     only ever follows an ignored NON-live push.
 * The bridgeId is not a credential. It travels inside the body that the bridge's HMAC attestation signs, so only a holder
 * of the shared secret can set it; a holder of the secret can push live anyway.
 *
 * Pure functions, no I/O. Time is the caller's wall clock (the cloud has no monotonic clock shared with the bridge).
 */

export interface RelayAuthorityState {
  /** The sender of the last accepted verified live push; null if it sent no identity, or none was accepted. */
  readonly liveBridgeId: string | null;
  /** When that push was received (cloud wall clock, ms); null if no live push has been accepted. */
  readonly liveReceivedAtMs: number | null;
}

export const INITIAL_RELAY_AUTHORITY: RelayAuthorityState = { liveBridgeId: null, liveReceivedAtMs: null };

/** True when this instance's own memory holds a live push no older than freshMs. */
export function isRelayLiveFresh(state: RelayAuthorityState, nowMs: number, freshMs: number): boolean {
  return localLiveFresh(state, nowMs, freshMs);
}

/** How long a bridge pauses its relay after the cloud says it ignored a push. Bounded, so a recovered primary resumes. */
export const RELAY_IGNORED_PAUSE_MS = 60_000;

export interface RelayIgnoredAck {
  readonly status: 'ignored';
  readonly reason: string;
}

/** The cloud's reply when it ignored a push. Anything else (including a malformed body) is not an ignore. */
export function isRelayIgnoredAck(body: unknown): body is RelayIgnoredAck {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  return o['status'] === 'ignored' && typeof o['reason'] === 'string';
}

export interface IncomingPush {
  /** The provenance the cloud VERIFIED (resolveVerifiedProvenance), not the one the sender claimed. */
  readonly verifiedSource: 'live_hardware' | 'cloud_snapshot' | 'disconnected';
  /** Sender identity from the attested payload; undefined for a bridge that predates it. */
  readonly bridgeId: string | undefined;
}

export type RelayDecision =
  | { readonly accept: true; readonly reason: 'live' | 'no-fresh-live' | 'primary-reports-non-live'; readonly competingLive: boolean }
  | { readonly accept: false; readonly reason: 'non-live-while-live-fresh' };

function localLiveFresh(state: RelayAuthorityState, nowMs: number, freshMs: number): boolean {
  return state.liveReceivedAtMs !== null && nowMs - state.liveReceivedAtMs <= freshMs;
}

/**
 * @param dbLiveFresh true when the shared database holds a live row newer than freshMs (another instance has been
 *                    receiving the real bridge). Only needs to be correct when the push is non-live.
 */
export function decideRelayPush(
  state: RelayAuthorityState,
  incoming: IncomingPush,
  nowMs: number,
  freshMs: number,
  dbLiveFresh: boolean,
): RelayDecision {
  const localFresh = localLiveFresh(state, nowMs, freshMs);

  if (incoming.verifiedSource === 'live_hardware') {
    // Two live senders at once cannot be reconciled here; accept, but say so, so it is not silent.
    const competing =
      localFresh &&
      state.liveBridgeId !== null &&
      incoming.bridgeId !== undefined &&
      incoming.bridgeId !== state.liveBridgeId;
    return { accept: true, reason: 'live', competingLive: competing };
  }

  const liveFresh = localFresh || dbLiveFresh;
  if (!liveFresh) return { accept: true, reason: 'no-fresh-live', competingLive: false };

  const fromLiveSender =
    localFresh && state.liveBridgeId !== null && incoming.bridgeId !== undefined && incoming.bridgeId === state.liveBridgeId;
  if (fromLiveSender) return { accept: true, reason: 'primary-reports-non-live', competingLive: false };

  return { accept: false, reason: 'non-live-while-live-fresh' };
}

/** The authority state after a push was decided. An ignored push changes nothing. */
export function nextRelayAuthority(
  state: RelayAuthorityState,
  incoming: IncomingPush,
  decision: RelayDecision,
  nowMs: number,
): RelayAuthorityState {
  if (!decision.accept) return state;
  if (incoming.verifiedSource === 'live_hardware') {
    return { liveBridgeId: incoming.bridgeId ?? null, liveReceivedAtMs: nowMs };
  }
  // The live sender itself reported non-live, or there was no live source: either way nothing live is fresh now.
  return INITIAL_RELAY_AUTHORITY;
}

/** Reads the sender identity from an untrusted payload. Bounded and shape-checked; anything else is "no identity". */
export function readBridgeId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const v = (payload as Record<string, unknown>)['bridgeId'];
  if (typeof v !== 'string') return undefined;
  if (v.length === 0 || v.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(v)) return undefined;
  return v;
}

/**
 * The cloud relay target comes only from ZODIAC_CLOUD_RELAY_URL. There is deliberately no default: a bridge started
 * anywhere without it (a laptop, a dev shell) must not push to production, which is how a hardware-less bridge made the
 * dashboard flicker (2026-10-16). Unset or blank means "do not relay".
 */
export function resolveCloudRelayUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const raw = env['ZODIAC_CLOUD_RELAY_URL']?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}
