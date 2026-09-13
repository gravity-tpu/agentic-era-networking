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
   * Probes end-to-end health across Serial, HTTP, and OpenFlow.
   */
  public async getComprehensiveHealth(httpTargetIp: string = '10.0.1.99'): Promise<ZodiacHealthReport> {
    let serialDetected = false;
    let deviceStatus: ZodiacDeviceStatus | undefined;
    let ports: ZodiacPortInfo[] | undefined;
    let config: ZodiacConfig | undefined;

    try {
      const path = this.serial.detectDevice();
      if (path) {
        serialDetected = true;
      }
    } catch {
      serialDetected = false;
    }

    if (serialDetected) {
      try {
        deviceStatus = await this.serial.getStatus();
      } catch {}
      try {
        ports = await this.serial.getPorts();
      } catch {}
      try {
        config = await this.serial.getConfig();
      } catch {}
    }

    // Check HTTP responsiveness
    let httpResponsive = false;
    try {
      const resp = await fetch(`http://${httpTargetIp}/`, { signal: AbortSignal.timeout(1500) });
      httpResponsive = resp.ok;
    } catch {
      httpResponsive = false;
    }

    return {
      serialDetected,
      serialPath: serialDetected ? this.serial.path : undefined,
      deviceStatus,
      ports,
      config,
      openFlowMetrics: this.ofServer.metrics,
      httpResponsive,
    };
  }

  /**
   * Shuts down all hardware server listeners.
   */
  public async stop(): Promise<void> {
    await this.ofServer.close();
  }
}
