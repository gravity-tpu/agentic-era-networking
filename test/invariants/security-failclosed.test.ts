import { describe, it, expect } from 'vitest';
import { FailClosedDnsResolver, DnsResolutionError } from '../../src/dns/resolver.js';
import { NetworkStateMachine, NetworkStateError } from '../../src/core/state-machine.js';

describe('Invariant: Fail-Closed Isolation & Determinism', () => {
  describe('FailClosedDnsResolver', () => {
    it('fails closed (NXDOMAIN) when queried for an unknown domain', () => {
      const resolver = new FailClosedDnsResolver();

      expect(() => resolver.resolve('unknown.local', 'A')).toThrow(DnsResolutionError);
      expect(() => resolver.resolve('unknown.local', 'A')).toThrow(/NXDOMAIN/);
    });

    it('fails closed (NODATA) when queried domain exists but requested type is missing', () => {
      const resolver = new FailClosedDnsResolver();
      resolver.registerRecord('api.agent.net', 'A', '10.0.0.1');

      expect(() => resolver.resolve('api.agent.net', 'AAAA')).toThrow(DnsResolutionError);
      expect(() => resolver.resolve('api.agent.net', 'AAAA')).toThrow(/NODATA/);
    });

    it('resolves valid registered record within TTL', () => {
      const resolver = new FailClosedDnsResolver();
      resolver.registerRecord('dns.cluster.internal', 'A', '192.168.1.53', 300);

      const record = resolver.resolve('dns.cluster.internal', 'A');
      expect(record.value).toBe('192.168.1.53');
      expect(record.type).toBe('A');
    });

    it('fails closed on empty or invalid hostname inputs', () => {
      const resolver = new FailClosedDnsResolver();

      expect(() => resolver.resolve('', 'A')).toThrow(/INVALID_HOSTNAME/);
      expect(() => resolver.resolve('   ', 'A')).toThrow(/INVALID_HOSTNAME/);
    });
  });

  describe('NetworkStateMachine', () => {
    it('initializes in DOWN state', () => {
      const fsm = new NetworkStateMachine();
      expect(fsm.state).toBe('DOWN');
      expect(fsm.transitionLog.length).toBe(0);
    });

    it('executes valid deterministic transitions', () => {
      const fsm = new NetworkStateMachine();

      expect(fsm.transition('START')).toBe('INITIALIZING');
      expect(fsm.transition('HANDSHAKE_SUCCESS')).toBe('ESTABLISHED');
      expect(fsm.transition('PACKET_LOSS_SPIKE')).toBe('DEGRADED');
      expect(fsm.transition('LINK_RESTORED')).toBe('ESTABLISHED');
      expect(fsm.transition('SHUTDOWN')).toBe('TERMINATED');

      expect(fsm.state).toBe('TERMINATED');
      expect(fsm.transitionLog.length).toBe(5);
    });

    it('fails closed and throws NetworkStateError on illegal state transition', () => {
      const fsm = new NetworkStateMachine('DOWN');

      // Cannot restore link or spike packet loss while DOWN
      expect(() => fsm.transition('LINK_RESTORED')).toThrow(NetworkStateError);
      expect(() => fsm.transition('PACKET_LOSS_SPIKE')).toThrow(NetworkStateError);
      expect(() => fsm.transition('HANDSHAKE_SUCCESS')).toThrow(NetworkStateError);

      // State remains strictly DOWN
      expect(fsm.state).toBe('DOWN');
    });

    it('rejects all transitions once TERMINATED', () => {
      const fsm = new NetworkStateMachine('DOWN');
      fsm.transition('SHUTDOWN');
      expect(fsm.state).toBe('TERMINATED');

      expect(() => fsm.transition('START')).toThrow(NetworkStateError);
      expect(() => fsm.transition('SHUTDOWN')).toThrow(NetworkStateError);
    });
  });
});
