/**
 * state-machine.ts
 * Deterministic finite state machine (FSM) for network link and tunnel sessions.
 *
 * Invariant:
 * - State transitions are deterministic and closed.
 * - Illegal transitions throw explicit, typed errors rather than silent transitions.
 */

export type NetworkState = 'DOWN' | 'INITIALIZING' | 'ESTABLISHED' | 'DEGRADED' | 'TERMINATED';

export type NetworkEvent =
  | 'START'
  | 'HANDSHAKE_SUCCESS'
  | 'HANDSHAKE_FAIL'
  | 'KEEPALIVE_TIMEOUT'
  | 'PACKET_LOSS_SPIKE'
  | 'LINK_RESTORED'
  | 'SHUTDOWN';

export class NetworkStateError extends Error {
  constructor(
    public readonly currentState: NetworkState,
    public readonly attemptedEvent: NetworkEvent
  ) {
    super(`Illegal network state transition: cannot process '${attemptedEvent}' while in '${currentState}'`);
    this.name = 'NetworkStateError';
  }
}

export class NetworkStateMachine {
  private _state: NetworkState;
  private readonly _transitionLog: Array<{ from: NetworkState; to: NetworkState; event: NetworkEvent; timestampNs: bigint }> = [];

  constructor(initialState: NetworkState = 'DOWN') {
    this._state = initialState;
  }

  public get state(): NetworkState {
    return this._state;
  }

  public get transitionLog(): ReadonlyArray<{ from: NetworkState; to: NetworkState; event: NetworkEvent; timestampNs: bigint }> {
    return this._transitionLog;
  }

  /**
   * Applies an event and advances the state machine deterministically.
   */
  public transition(event: NetworkEvent): NetworkState {
    const from = this._state;
    let to: NetworkState;

    switch (from) {
      case 'DOWN':
        if (event === 'START') to = 'INITIALIZING';
        else if (event === 'SHUTDOWN') to = 'TERMINATED';
        else throw new NetworkStateError(from, event);
        break;

      case 'INITIALIZING':
        if (event === 'HANDSHAKE_SUCCESS') to = 'ESTABLISHED';
        else if (event === 'HANDSHAKE_FAIL') to = 'DOWN';
        else if (event === 'SHUTDOWN') to = 'TERMINATED';
        else throw new NetworkStateError(from, event);
        break;

      case 'ESTABLISHED':
        if (event === 'PACKET_LOSS_SPIKE') to = 'DEGRADED';
        else if (event === 'KEEPALIVE_TIMEOUT') to = 'DOWN';
        else if (event === 'SHUTDOWN') to = 'TERMINATED';
        else throw new NetworkStateError(from, event);
        break;

      case 'DEGRADED':
        if (event === 'LINK_RESTORED') to = 'ESTABLISHED';
        else if (event === 'KEEPALIVE_TIMEOUT') to = 'DOWN';
        else if (event === 'SHUTDOWN') to = 'TERMINATED';
        else throw new NetworkStateError(from, event);
        break;

      case 'TERMINATED':
        throw new NetworkStateError(from, event);

      default:
        const _exhaustive: never = from;
        throw new Error(`Unhandled state: ${_exhaustive}`);
    }

    this._state = to;
    this._transitionLog.push({
      from,
      to,
      event,
      timestampNs: process.hrtime.bigint(),
    });

    return to;
  }
}
