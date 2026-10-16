/**
 * bridge-lifecycle.test.ts
 * Lifecycle guarantees of the bridge: it must not look healthy when it controls nothing, and it must not run the
 * Coral inference daemon (a fate-sharing child process) unless asked.
 *
 * Context (Invariant 3, fail closed): on 2026-10-15 a second bridge instance could not bind 6633, logged
 * DEGRADED_FAULT and kept running, so systemd reported `active` while a hand-started controller held the switch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import {
  ControlPlaneBindError,
  ZodiacBridgeServer,
  coralDaemonEnabled,
  degradedControlPlaneAllowed,
} from '../../src/sdn/zodiac-bridge-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('start() with the OpenFlow port already taken', () => {
  const make = () => {
    const controller = new ZodiacController();
    controller.startOpenFlow = (): Promise<void> => Promise.reject(new Error('listen EADDRINUSE: address already in use 0.0.0.0:6633'));
    return { controller, server: new ZodiacBridgeServer(controller) };
  };

  it('refuses to start, so the process exits and the supervisor sees a failed unit', async () => {
    vi.stubEnv('ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE', undefined);
    const { server } = make();
    const err = await server.start(0, '127.0.0.1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneBindError);
    expect((err as ControlPlaneBindError).detail).toContain('EADDRINUSE');
    expect(server.controlPlaneState).toBe('DEGRADED_FAULT');
    vi.unstubAllEnvs();
  });

  it('starts nothing else before refusing: no Coral daemon, no HTTP server to leave running', async () => {
    vi.stubEnv('ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE', undefined);
    const { server } = make();
    const coral = vi.spyOn(server, 'startCoralDaemonIfEnabled');
    const listen = vi.spyOn(http, 'createServer'); // the HTTP bridge is created only after the control plane binds
    await expect(server.start(0, '127.0.0.1')).rejects.toBeInstanceOf(ControlPlaneBindError);
    expect(coral).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('refuses for every value other than the literal "1" (a typo does not open the override)', async () => {
    for (const v of ['0', 'true', 'yes', ' 1', '']) {
      vi.stubEnv('ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE', v);
      const { server } = make();
      await expect(server.start(0, '127.0.0.1'), JSON.stringify(v)).rejects.toBeInstanceOf(ControlPlaneBindError);
    }
    vi.unstubAllEnvs();
  });
});

describe('explicit overrides are exact', () => {
  it('degraded control plane is allowed only by ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE=1', () => {
    expect(degradedControlPlaneAllowed({})).toBe(false);
    for (const v of ['0', 'true', 'yes', 'TRUE', ' 1', '']) {
      expect(degradedControlPlaneAllowed({ ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE: v }), JSON.stringify(v)).toBe(false);
    }
    expect(degradedControlPlaneAllowed({ ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE: '1' })).toBe(true);
  });

  it('the Coral daemon is opt-in: only ZODIAC_ENABLE_CORAL_DAEMON=1 enables it', () => {
    expect(coralDaemonEnabled({})).toBe(false);
    for (const v of ['0', 'true', 'yes', ' 1', '']) {
      expect(coralDaemonEnabled({ ZODIAC_ENABLE_CORAL_DAEMON: v }), JSON.stringify(v)).toBe(false);
    }
    expect(coralDaemonEnabled({ ZODIAC_ENABLE_CORAL_DAEMON: '1' })).toBe(true);
  });

  it('does not start the Coral daemon by default, and says so', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = new ZodiacBridgeServer(new ZodiacController());
    expect(server.startCoralDaemonIfEnabled({})).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Disabled (opt-in'));
  });
});
