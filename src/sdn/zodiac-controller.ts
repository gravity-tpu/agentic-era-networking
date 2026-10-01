/**
 * zodiac-controller.ts
 * Unified Hardware Controller for Zodiac FX Physical Switch
 *
 * Integrates:
 * - Serial Out-of-Band management (CDC ACM)
 * - OpenFlow 1.3 Control Plane Server
 * - Symbolic Route Verification Invariant Gate
 */

import { ZodiacSerialClient, ZodiacPortInfo, ZodiacDeviceStatus, ZodiacConfig } from './zodiac-serial.js';
import { OpenFlowServer, ControllerMetrics } from './openflow-server.js';
import { FlowRuleEntry } from './flow-table.js';
import { SymbolicRouteVerifier, NetworkHop } from '../core/routing-verifier.js';

export interface ZodiacHealthReport {
  readonly serialDetected: boolean;
  readonly serialPath?: string | undefined;
  readonly deviceStatus?: ZodiacDeviceStatus | undefined;
  readonly ports?: ZodiacPortInfo[] | undefined;
  readonly config?: ZodiacConfig | undefined;
  readonly openFlowMetrics: ControllerMetrics;
  readonly httpResponsive: boolean;
}

export class ZodiacController {
  private readonly serial: ZodiacSerialClient;
  private readonly ofServer: OpenFlowServer;

  constructor(serialDevicePath?: string) {
    this.serial = new ZodiacSerialClient(serialDevicePath);
    this.ofServer = new OpenFlowServer();
    this.ofServer.on('error', (err: unknown) => {
      console.warn('[!] [OpenFlowServer] Daemon error:', err instanceof Error ? err.message : String(err));
    });
    this.ofServer.on('clientError', (err: unknown, addr: string) => {
      console.warn(`[!] [OpenFlowServer] Client ${addr} socket error:`, err instanceof Error ? err.message : String(err));
    });
    this.ofServer.on('deadPeerTimeout', (addr: string) => {
      console.warn(`[!] [OpenFlowServer] Dead peer detected (${addr}): no OFPT_ECHO_REPLY within timeout, likely unplugged or powered off.`);
    });
  }

  public get serialClient(): ZodiacSerialClient {
    return this.serial;
  }

  public get openFlow(): OpenFlowServer {
    return this.ofServer;
  }

  /**
   * Starts the OpenFlow SDN controller daemon.
   */
  public async startOpenFlow(port: number = 6633, host: string = '0.0.0.0'): Promise<void> {
    await this.ofServer.listen(port, host);
  }

  /**
   * Dispatches a verified SDN flow rule to the physical switch hardware.
   * Hassabis Invariant: Route must be verified loop-free before pushing to physical switch.
   */
  public pushVerifiedRule(rule: FlowRuleEntry, routeTopology: ReadonlyArray<NetworkHop>, outPort?: number): void {
    // Throws RoutingLoopDetectedError if invalid
    SymbolicRouteVerifier.verifyLoopFree(routeTopology);
    this.ofServer.sendFlowMod(rule, outPort);
  }

  /**
   * Installs an emergency fail-closed quarantine rule on the OpenFlow data plane.
   * Priority defaults to 65535 (highest possible OpenFlow priority), dropping traffic from offending MAC/IP.
   */
  public quarantineAgent(options: {
    targetMac?: string | undefined;
    targetIp?: string | undefined;
    reason: string;
    priority?: number | undefined;
  }): {
    success: boolean;
    ruleId: string;
    rule: FlowRuleEntry;
    action: string;
    priority: number;
    openFlowInstalled: boolean;
    timestampNs: bigint;
  } {
    if (!options.targetMac && !options.targetIp) {
      throw new Error('quarantineAgent requires at least targetMac or targetIp to prevent total network blackhole');
    }

    const priority = options.priority ?? 65535;
    const ruleId = `quarantine-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const srcCidr = options.targetIp ? `${options.targetIp}/32` : '0.0.0.0/0';

    const rule: FlowRuleEntry = {
      id: ruleId,
      priority,
      srcCidr,
      dstCidr: '0.0.0.0/0',
      protocol: 'ANY',
      srcMac: options.targetMac,
      action: 'DROP',
    };

    let openFlowInstalled = false;
    try {
      if (this.ofServer.metrics.state === 'ESTABLISHED') {
        const fromHop = options.targetIp ?? options.targetMac ?? 'QUARANTINE_SRC';
        this.pushVerifiedRule(rule, [{ fromNode: fromHop, toNode: 'DROP', cost: 0 }]);
        openFlowInstalled = true;
      }
    } catch (err) {
      console.warn('[!] [ZodiacController] OpenFlow quarantine install error:', err instanceof Error ? err.message : String(err));
    }

    return {
      success: true,
      ruleId,
      rule,
      action: 'DROP',
      priority,
      openFlowInstalled,
      timestampNs: process.hrtime.bigint(),
    };
  }

  /**
   * Releases an emergency quarantine rule from the OpenFlow data plane.
   * Council Invariant 1 (Anti-Shortcut Law): Returns true ONLY when deleteFlow successfully
   * dispatches the OFPFC_DELETE command to an ESTABLISHED OpenFlow switch connection.
   */
  public liftQuarantine(rule: FlowRuleEntry): {
    success: boolean;
    timestampNs: bigint;
    error?: string;
  } {
    if (this.ofServer.metrics.state !== 'ESTABLISHED') {
      return {
        success: false,
        timestampNs: process.hrtime.bigint(),
        error: `OpenFlow control plane not ESTABLISHED (state: ${this.ofServer.metrics.state})`,
      };
    }

    try {
      const dispatched = this.ofServer.deleteFlow(rule);
      return {
        success: dispatched,
        timestampNs: process.hrtime.bigint(),
        ...(dispatched ? {} : { error: 'Failed to dispatch deleteFlow to OpenFlow client socket' }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[!] [ZodiacController] OpenFlow quarantine release error:', msg);
      return {
        success: false,
        timestampNs: process.hrtime.bigint(),
        error: msg,
      };
    }
  }

  private cachedConfig: ZodiacConfig | undefined;
  private cachedStatus: ZodiacDeviceStatus | undefined;
  private cachedPorts: ZodiacPortInfo[] | undefined;
  private lastSerialProbeNs: bigint = 0n;

  /**
   * Probes end-to-end health across Serial and OpenFlow without aggressive polling.
   */
  public async getComprehensiveHealth(): Promise<ZodiacHealthReport> {
    let serialDetected = false;
    let deviceStatus: ZodiacDeviceStatus | undefined;
    let ports: ZodiacPortInfo[] | undefined;
    let config: ZodiacConfig | undefined;

    try {
      const path = await this.serial.detectDevice();
      if (path) {
        serialDetected = true;
      }
    } catch (err: unknown) {
      // Council Invariant 1 (Zero Suppression of Reality): Explicit protocol boundary logging
      console.warn('[!] [ZodiacController] Serial device detection probe:', err instanceof Error ? err.message : String(err));
      serialDetected = false;
    }

    const nowNs = process.hrtime.bigint();
    if (serialDetected) {
      // Council Invariant 1 & 2 (Dean & Ghemawat):
      // 1. Static config (MAC, IP, Netmask, Gateway) is invariant at runtime; fetch ONCE on boot.
      //    Never repeatedly enter/exit 'config' mode over UART at 1Hz, which locks the switch CPU.
      if (!this.cachedConfig) {
        try {
          const configRes = await this.serial.getConfig().catch((err: unknown) => {
            console.warn('[!] [ZodiacController] Initial getConfig error:', err instanceof Error ? err.message : String(err));
            return undefined;
          });
          if (configRes) this.cachedConfig = configRes;
        } catch (err: unknown) {
          // Council Invariant 1: Explicitly log retry context rather than swallowing error
          console.warn('[!] [ZodiacController] Initial config retrieval failed; retrying on next probe cycle:', err instanceof Error ? err.message : String(err));
        }
      }

      // 2. Dynamic metrics (CPU temp, uptime, port link UP/DOWN) probed every 3000ms using monotonic nanosecond clock
      //    Dean & Vinyals Invariant: Immune to NTP wall-clock jumps or backward leaps.
      const PROBE_INTERVAL_NS = 3_000_000_000n; // 3 seconds
      if (!this.cachedStatus || (nowNs - this.lastSerialProbeNs >= PROBE_INTERVAL_NS)) {
        try {
          const [statusRes, portsRes] = await Promise.all([
            this.serial.getStatus().catch((err: unknown) => {
              console.warn('[!] [ZodiacController] Serial getStatus error:', err instanceof Error ? err.message : String(err));
              return undefined;
            }),
            this.serial.getPorts().catch((err: unknown) => {
              console.warn('[!] [ZodiacController] Serial getPorts error:', err instanceof Error ? err.message : String(err));
              return undefined;
            }),
          ]);

          if (statusRes) this.cachedStatus = statusRes;
          if (portsRes) this.cachedPorts = portsRes;
          this.lastSerialProbeNs = nowNs;
        } catch (err: unknown) {
          // Council Invariant 1: Surface transient serial bus errors deterministically
          console.warn('[!] [ZodiacController] Serial metrics probe batch error:', err instanceof Error ? err.message : String(err));
        }
      }

      deviceStatus = this.cachedStatus;
      ports = this.cachedPorts;
      config = this.cachedConfig;
    }

    return {
      serialDetected,
      serialPath: serialDetected ? this.serial.path : undefined,
      deviceStatus,
      ports,
      config,
      openFlowMetrics: this.ofServer.metrics,
      httpResponsive: false,
    };
  }

  /**
   * Executes a CLI command either via Serial CDC ACM.
   * If serial is unavailable or disconnected, returns a clear hardware status message.
   */
  public async executeCommand(command: string): Promise<string> {
    try {
      return await this.serial.executeRaw(command);
    } catch (err: unknown) {
      // Continue to check device presence below
    }

    let serialPresent = false;
    try {
      const path = await this.serial.detectDevice();
      if (path) serialPresent = true;
    } catch {
      serialPresent = false;
    }

    const ofConnected = this.ofServer.metrics.state === 'ESTABLISHED';

    if (!serialPresent && !ofConnected) {
      return `[!] Zodiac FX Hardware Disconnected
No serial modem detected and OpenFlow switch is disconnected.
Please connect the physical switch via USB (serial CLI) or Ethernet (OpenFlow controller) to query live device state.`;
    }

    if (serialPresent) {
      return `[Notice: Serial port (${this.serial.path}) was busy or timed out during '${command}'. Please retry command.]`;
    }

    return `[Notice: Switch connected via OpenFlow only (no serial CDC link). Command '${command}' cannot be executed over serial.]`;
  }

  /**
   * Shuts down all hardware server listeners.
   */
  public async stop(): Promise<void> {
    await this.ofServer.close();
  }
}
