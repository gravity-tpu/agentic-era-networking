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

  private cachedConfig: ZodiacConfig | undefined;
  private cachedStatus: ZodiacDeviceStatus | undefined;
  private cachedPorts: ZodiacPortInfo[] | undefined;
  private lastSerialProbeMs: number = 0;

  /**
   * Probes end-to-end health across Serial and OpenFlow without aggressive polling.
   */
  public async getComprehensiveHealth(_targetIp: string = '10.0.1.99'): Promise<ZodiacHealthReport> {
    let serialDetected = false;
    let deviceStatus: ZodiacDeviceStatus | undefined;
    let ports: ZodiacPortInfo[] | undefined;
    let config: ZodiacConfig | undefined;

    try {
      const path = this.serial.detectDevice();
      if (path) {
        serialDetected = true;
      }
    } catch (err: unknown) {
      console.warn('[!] [ZodiacController] Serial device not detected:', err instanceof Error ? err.message : String(err));
      serialDetected = false;
    }

    const now = Date.now();
    const shouldProbeSerial = serialDetected && (now - this.lastSerialProbeMs > 30_000 || !this.cachedConfig);

    if (serialDetected) {
      if (shouldProbeSerial) {
        this.lastSerialProbeMs = now;
        try {
          deviceStatus = await this.serial.getStatus();
          if (deviceStatus) this.cachedStatus = deviceStatus;
        } catch (err: unknown) {
          console.warn('[!] [ZodiacController] Serial getStatus error:', err instanceof Error ? err.message : String(err));
        }
        try {
          ports = await this.serial.getPorts();
          if (ports && ports.length > 0) this.cachedPorts = ports;
        } catch (err: unknown) {
          console.warn('[!] [ZodiacController] Serial getPorts error:', err instanceof Error ? err.message : String(err));
        }
        if (!this.cachedConfig) {
          try {
            config = await this.serial.getConfig();
            if (config) this.cachedConfig = config;
          } catch (err: unknown) {
            console.warn('[!] [ZodiacController] Serial getConfig error:', err instanceof Error ? err.message : String(err));
          }
        }
      } else {
        deviceStatus = this.cachedStatus;
        ports = this.cachedPorts;
        config = this.cachedConfig;
      }
    } else {
      // Disconnected: Do not masquerade stale cache as live hardware (Reality Invariant)
      this.cachedStatus = undefined;
      this.cachedPorts = undefined;
      deviceStatus = undefined;
      ports = undefined;
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
   * Generates formatted diagnostics output for CLI commands when physical hardware is disconnected or unresponsive.
   * Council Invariant: Zero Suppression of Reality. Never fake hardware metrics.
   */
  public getDiagnosticsOutput(command: string): string {
    let serialPresent = false;
    try {
      serialPresent = Boolean(this.serial.detectDevice());
    } catch {
      serialPresent = false;
    }

    const ofConnected = this.ofServer.metrics.state === 'ESTABLISHED';

    if (!serialPresent && !ofConnected) {
      return `[!] Zodiac FX Hardware Disconnected
No serial modem detected under /dev/cu.usbmodem* and OpenFlow switch is disconnected.
Please connect the physical switch via USB (serial CLI) or Ethernet (OpenFlow 10.0.1.8:6633) to query live device state.`;
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
