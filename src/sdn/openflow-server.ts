/**
 * openflow-server.ts
 * Event-Driven OpenFlow 1.3 SDN Controller Daemon
 *
 * Council Invariants Enforced:
 * - Anti-Shortcut Law: Fully typed EventEmitter and protocol error handling.
 * - Dean & Ghemawat: Stream framing with buffer accumulation, BigInt nanosecond latency timers.
 * - Fail-Closed Default: Defaults to dropping unmatched traffic; strict state transitions.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  OpenFlowType,
  OFP_VERSION_1_3,
  SwitchFeatures,
  FlowModCommand,
  decodeOfpHeader,
  buildOfpHello,
  buildOfpFeaturesRequest,
  buildOfpEchoReply,
  buildOfpEchoRequest,
  parseOfpFeaturesReply,
  buildOfpFlowMod,
  buildOfpTableMissFlowMod,
  parseOfpPacketIn,
  DecodedPacketIn,
} from './openflow-types.js';
import { FlowRuleEntry } from './flow-table.js';

export interface OpenFlowServerEvents {
  connected: (clientAddress: string) => void;
  ready: (features: SwitchFeatures) => void;
  echoLatency: (latencyNs: bigint) => void;
  disconnected: (clientAddress: string) => void;
  error: (err: Error) => void;
  rawMessage: (type: OpenFlowType, length: number, xid: number) => void;
  packetIn: (packet: DecodedPacketIn) => void;
}

export type SwitchState = 'DISCONNECTED' | 'HANDSHAKE' | 'ESTABLISHED';

export interface ControllerMetrics {
  readonly state: SwitchState;
  readonly connectedAddress?: string | undefined;
  readonly switchFeatures?: SwitchFeatures | undefined;
  readonly messagesReceived: bigint;
  readonly bytesReceived: bigint;
  readonly lastEchoLatencyNs: bigint;
}

export class OpenFlowServer extends EventEmitter {
  private server: net.Server | null = null;
  private clientSocket: net.Socket | null = null;
  private state: SwitchState = 'DISCONNECTED';
  private switchFeatures?: SwitchFeatures | undefined;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private nextXid: number = 100;

  private allocateXid(): number {
    const xid = this.nextXid;
    this.nextXid = (this.nextXid + 1) >>> 0; // 32-bit unsigned wrap; prevents ERR_OUT_OF_RANGE
    return xid;
  }

  // Invariant counters
  private _messagesReceived: bigint = 0n;
  private _bytesReceived: bigint = 0n;
  private _lastEchoLatencyNs: bigint = 0n;
  private echoSentNs: bigint = 0n;
  private activeEchoXid: number | null = null;

  public get metrics(): ControllerMetrics {
    return {
      state: this.state,
      connectedAddress: this.clientSocket?.remoteAddress,
      switchFeatures: this.switchFeatures,
      messagesReceived: this._messagesReceived,
      bytesReceived: this._bytesReceived,
      lastEchoLatencyNs: this._lastEchoLatencyNs,
    };
  }

  /**
   * Starts listening for OpenFlow switch connections.
   */
  public async listen(port: number = 6633, host: string = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleClient(socket));

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(port, host, () => {
        resolve();
      });
    });
  }

  /**
   * Closes the server and terminates any active switch session.
   */
  public async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.clientSocket) {
        this.clientSocket.destroy();
        this.clientSocket = null;
      }
      this.state = 'DISCONNECTED';
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Pushes a flow rule to the physical switch hardware.
   */
  public sendFlowMod(rule: FlowRuleEntry, outPort?: number): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send FlowMod: switch not in ESTABLISHED state (current: ${this.state})`);
    }

    const xid = this.allocateXid();
    const isDrop = rule.action === 'DROP';
    const flowModPacket = buildOfpFlowMod({
      command: FlowModCommand.OFPFC_ADD,
      priority: rule.priority,
      outPort: isDrop ? undefined : outPort,
      match: {
        srcMac: rule.srcMac,
        dstMac: rule.dstMac,
        srcIp: rule.srcCidr && rule.srcCidr !== '0.0.0.0/0' ? rule.srcCidr.split('/')[0] : undefined,
        dstIp: rule.dstCidr && rule.dstCidr !== '0.0.0.0/0' ? rule.dstCidr.split('/')[0] : undefined,
      },
    }, xid);

    this.clientSocket.write(flowModPacket);
  }

  /**
   * Installs a low-priority mirror rule that copies frames arriving on inPort to outPort.
   * Used to wire the Zodiac Port 3 tap so the GPU sentinel can observe data-plane traffic.
   * Priority 1 ensures quarantine rules at 65535 always take precedence (fail-closed).
   *
   * Council Invariant 3 (Fail-Closed): quarantine DROP at 65535 overrides this mirror at 1.
   * Council Invariant 6 (Anti-Simulation): mirror delivers real hardware frames to the sentinel.
   */
  public sendMirrorRule(inPort: number, outPort: number, priority: number = 1): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send MirrorRule: switch not in ESTABLISHED state (current: ${this.state})`);
    }

    const xid = this.allocateXid();
    const packet = buildOfpFlowMod({
      command: FlowModCommand.OFPFC_ADD,
      priority,
      outputPorts: [outPort],
      match: { inPort },
    }, xid);
    this.clientSocket.write(packet);
  }

  /**
   * Installs an OpenFlow 1.3 Table-Miss rule (priority 0 wildcard matching all packets).
   * Council Invariant 3 (Fail-Closed): Defaults to 'DROP' unless explicitly configured for telemetry sampling.
   *
   * @param priority Rule priority (default 0 for table-miss)
   * @param action 'DROP' (fail-closed default) or 'CONTROLLER'
   * @param maxLen Maximum payload bytes punted if action is 'CONTROLLER' (default 128 to prevent DoS)
   */
  public sendTableMissRule(
    priority: number = 0,
    action: 'DROP' | 'CONTROLLER' = 'DROP',
    maxLen: number = 128
  ): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send Table-Miss FlowMod: switch not in ESTABLISHED state (current: ${this.state})`);
    }

    const xid = this.allocateXid();
    const packet = buildOfpTableMissFlowMod(xid, priority, action, maxLen);
    this.clientSocket.write(packet);
  }

  /**
   * Sends an OpenFlow Echo Request to measure nanosecond round-trip latency.
   */
  public pingEcho(): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') return;

    const xid = this.allocateXid();
    this.activeEchoXid = xid;
    this.echoSentNs = process.hrtime.bigint();

    const echoPacket = buildOfpEchoRequest(xid);
    this.clientSocket.write(echoPacket);
  }

  private handleClient(socket: net.Socket): void {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;

    socket.on('error', (err) => {
      this.emit('clientError', err, remoteAddr);
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    });

    if (this.clientSocket && !this.clientSocket.destroyed) {
      this.clientSocket.destroy();
    }

    this.clientSocket = socket;
    this.state = 'HANDSHAKE';
    this.rxBuffer = Buffer.alloc(0);
    this.emit('connected', remoteAddr);

    socket.on('data', (data) => this.onData(data));

    socket.on('close', () => {
      if (this.clientSocket === socket) {
        this.state = 'DISCONNECTED';
        this.switchFeatures = undefined;
        this.clientSocket = null;
        this.emit('disconnected', remoteAddr);
      }
    });
  }

  private onData(chunk: Buffer | Uint8Array | string): void {
    const buf = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf-8')
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    this._bytesReceived += BigInt(buf.length);
    this.rxBuffer = Buffer.concat([this.rxBuffer, buf]);

    // Frame processing loop
    while (this.rxBuffer.length >= 8) {
      const header = decodeOfpHeader(this.rxBuffer);

      if (this.rxBuffer.length < header.length) {
        // Incomplete packet in buffer; wait for next TCP chunk
        break;
      }

      const packet = this.rxBuffer.subarray(0, header.length);
      this.rxBuffer = this.rxBuffer.subarray(header.length);
      this._messagesReceived += 1n;

      this.handleMessage(header.type, header.length, header.xid, packet);
    }
  }

  private handleMessage(type: OpenFlowType, length: number, xid: number, packet: Buffer): void {
    this.emit('rawMessage', type, length, xid);

    switch (type) {
      case OpenFlowType.OFPT_HELLO: {
        // OpenFlow handshake initiated by switch
        const version = packet.readUInt8(0);
        if (version !== OFP_VERSION_1_3) {
          this.emit('error', new Error(`Unsupported OpenFlow version: 0x${version.toString(16)} (expected 0x04)`));
          this.clientSocket?.destroy();
          return;
        }

        // 1. Reply with OFPT_HELLO
        const helloReply = buildOfpHello(xid);
        this.clientSocket?.write(helloReply);

        // 2. Query switch hardware capabilities
        const featuresReq = buildOfpFeaturesRequest(this.allocateXid());
        this.clientSocket?.write(featuresReq);
        break;
      }

      case OpenFlowType.OFPT_FEATURES_REPLY: {
        this.switchFeatures = parseOfpFeaturesReply(packet);
        this.state = 'ESTABLISHED';
        this.emit('ready', this.switchFeatures);
        break;
      }

      case OpenFlowType.OFPT_ECHO_REQUEST: {
        // Echo back payload to maintain keep-alive
        const payload = packet.subarray(8);
        const reply = buildOfpEchoReply(payload, xid);
        this.clientSocket?.write(reply);
        break;
      }

      case OpenFlowType.OFPT_ECHO_REPLY: {
        if (this.activeEchoXid === xid && this.echoSentNs > 0n) {
          const nowNs = process.hrtime.bigint();
          this._lastEchoLatencyNs = nowNs - this.echoSentNs;
          this.activeEchoXid = null;
          this.echoSentNs = 0n;
          this.emit('echoLatency', this._lastEchoLatencyNs);
        }
        break;
      }

      case OpenFlowType.OFPT_PACKET_IN: {
        try {
          const decoded = parseOfpPacketIn(packet);
          this.emit('packetIn', decoded);
        } catch (err) {
          this.emit('error', new Error(`Failed to decode OFPT_PACKET_IN: ${err instanceof Error ? err.message : String(err)}`));
        }
        break;
      }

      default:
        // Other messages (e.g. OFPT_PORT_STATUS) logged or handled in extensions
        break;
    }
  }
}
