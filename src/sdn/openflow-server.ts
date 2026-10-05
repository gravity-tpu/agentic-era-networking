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
  FlowModOptions,
} from './openflow-types.js';
import { FlowRuleEntry } from './flow-table.js';

export interface OpenFlowServerEvents {
  connected: (clientAddress: string) => void;
  ready: (features: SwitchFeatures) => void;
  echoLatency: (latencyNs: bigint) => void;
  deadPeerTimeout: (clientAddress: string) => void;
  disconnected: (clientAddress: string) => void;
  error: (err: Error) => void;
  rawMessage: (type: OpenFlowType, length: number, xid: number) => void;
  packetIn: (packet: DecodedPacketIn) => void;
}

export type SwitchState = 'DISCONNECTED' | 'HANDSHAKE' | 'ESTABLISHED';

const DEFAULT_ECHO_DEAD_PEER_TIMEOUT_MS = 8_000;
const parsedEchoTimeoutMs = process.env['OPENFLOW_ECHO_DEAD_PEER_TIMEOUT_MS']
  ? parseInt(process.env['OPENFLOW_ECHO_DEAD_PEER_TIMEOUT_MS'], 10)
  : NaN;
// Bounded between 3s (must exceed several ~2.5s poll cycles to tolerate transient
// jitter without a false positive) and 60s (a dead peer must not look "online" indefinitely).
const ECHO_DEAD_PEER_TIMEOUT_NS = BigInt(
  Number.isFinite(parsedEchoTimeoutMs) && parsedEchoTimeoutMs > 0
    ? Math.min(Math.max(parsedEchoTimeoutMs, 3_000), 60_000)
    : DEFAULT_ECHO_DEAD_PEER_TIMEOUT_MS
) * 1_000_000n;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const parsedHandshakeTimeoutMs = process.env['OPENFLOW_HANDSHAKE_TIMEOUT_MS']
  ? parseInt(process.env['OPENFLOW_HANDSHAKE_TIMEOUT_MS'], 10)
  : NaN;
// Bounded between 1s (must allow real hardware time to complete HELLO -> FEATURES_REPLY)
// and 30s (a stalled client must not be able to hold a socket open indefinitely — Slowloris
// style file descriptor exhaustion against the OpenFlow listener).
const HANDSHAKE_TIMEOUT_MS = Number.isFinite(parsedHandshakeTimeoutMs) && parsedHandshakeTimeoutMs > 0
  ? Math.min(Math.max(parsedHandshakeTimeoutMs, 1_000), 30_000)
  : DEFAULT_HANDSHAKE_TIMEOUT_MS;

export interface ControllerMetrics {
  readonly state: SwitchState;
  readonly connectedAddress?: string | undefined;
  readonly switchFeatures?: SwitchFeatures | undefined;
  readonly messagesReceived: bigint;
  readonly bytesReceived: bigint;
  readonly lastEchoLatencyNs: bigint;
  readonly totalPacketIns?: bigint | undefined;
  readonly coppPacketInDrops?: bigint | undefined;
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
  private lastRxNs: bigint = 0n;
  private readonly echoDeadPeerTimeoutNs: bigint;
  private readonly handshakeTimeoutMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;

  // CCIE Invariant NET-001: Control Plane Policing (CoPP) on OFPT_PACKET_IN
  private coppTokens: number;
  private coppLastRefillNs: bigint = 0n;
  private readonly coppRateLimit: number;
  private readonly coppMaxBurst: number;
  private _totalPacketIns: bigint = 0n;
  private _coppPacketInDrops: bigint = 0n;

  constructor(
    echoDeadPeerTimeoutNs: bigint = ECHO_DEAD_PEER_TIMEOUT_NS,
    handshakeTimeoutMs: number = HANDSHAKE_TIMEOUT_MS,
    coppRateLimit: number = 100, // packets per second
    coppMaxBurst: number = 200,   // maximum burst tokens
  ) {
    super();
    this.echoDeadPeerTimeoutNs = echoDeadPeerTimeoutNs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.coppRateLimit = coppRateLimit;
    this.coppMaxBurst = coppMaxBurst;
    this.coppTokens = coppMaxBurst;
  }

  /**
   * Council Invariant 3 (Fail-Closed): dead-peer detection must not depend on an
   * external caller remembering to invoke pingEcho() on its own poll cadence — if
   * that caller stalls or stops polling, a dead socket would leak as falsely
   * ESTABLISHED forever. Own the heartbeat internally at 1/4 the dead-peer
   * timeout (floored at 1s, so at the 3s timeout minimum this is 3 ticks
   * rather than 4), guaranteeing several heartbeats occur within the
   * timeout window regardless of caller behavior.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.max(1000, Number(this.echoDeadPeerTimeoutNs / 4n / 1_000_000n));
    this.heartbeatTimer = setInterval(() => this.pingEcho(), intervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Council Invariant 3 (Fail-Closed): a client that opens a TCP connection but
   * never completes OFPT_HELLO -> OFPT_FEATURES_REPLY must not be allowed to hold
   * the socket (and its file descriptor) open indefinitely — Slowloris-style
   * resource exhaustion against the OpenFlow listener.
   */
  private startHandshakeTimeout(socket: net.Socket): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.clientSocket === socket && this.state === 'HANDSHAKE') {
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref();
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  public get totalPacketIns(): bigint {
    return this._totalPacketIns;
  }

  public get coppPacketInDrops(): bigint {
    return this._coppPacketInDrops;
  }

  public get metrics(): ControllerMetrics {
    return {
      state: this.state,
      connectedAddress: this.clientSocket?.remoteAddress,
      switchFeatures: this.switchFeatures,
      messagesReceived: this._messagesReceived,
      bytesReceived: this._bytesReceived,
      lastEchoLatencyNs: this._lastEchoLatencyNs,
      totalPacketIns: this._totalPacketIns,
      coppPacketInDrops: this._coppPacketInDrops,
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
      this.stopHeartbeat();
      this.clearHandshakeTimeout();
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
      // outputPorts drives the OpenFlow OUTPUT action list; outPort (offset 36) is the
      // delete-match field and must not be used for forwarding rules.
      outputPorts: isDrop || outPort === undefined ? [] : [outPort],
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
   * Deletes a flow matching the specified rule criteria from the OpenFlow data plane.
   * Uses OFPFC_DELETE with matching criteria (MAC/IP/priority).
   * Returns true if packet was dispatched to socket, false if disconnected.
   */
  public deleteFlow(rule: FlowRuleEntry): boolean {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      return false;
    }

    const xid = this.allocateXid();
    const flowModPacket = buildOfpFlowMod({
      command: FlowModCommand.OFPFC_DELETE,
      priority: rule.priority,
      outputPorts: [],
      match: {
        srcMac: rule.srcMac,
        dstMac: rule.dstMac,
        srcIp: rule.srcCidr && rule.srcCidr !== '0.0.0.0/0' ? rule.srcCidr.split('/')[0] : undefined,
        dstIp: rule.dstCidr && rule.dstCidr !== '0.0.0.0/0' ? rule.dstCidr.split('/')[0] : undefined,
      },
    }, xid);

    this.clientSocket.write(flowModPacket);
    return true;
  }

  /**
   * Installs a mirror or forwarding rule that copies frames arriving on inPort to one or more outPorts.
   * Used to wire the Zodiac Port 3 tap so the GPU sentinel can observe data-plane traffic,
   * or to establish line-rate bidirectional transit forwarding between switch ports.
   * Priority 1 (or 100) ensures quarantine rules at 65535 always take precedence (fail-closed).
   *
   * Council Invariant 3 (Fail-Closed): quarantine DROP at 65535 overrides this mirror at 1/100.
   * Council Invariant 6 (Anti-Simulation): mirror delivers real hardware frames to the sentinel.
   */
  public sendMirrorRule(inPort: number, outPort: number | number[], priority: number = 1): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send MirrorRule: switch not in ESTABLISHED state (current: ${this.state})`);
    }

    const xid = this.allocateXid();
    const outputPorts = Array.isArray(outPort) ? outPort : [outPort];
    const packet = buildOfpFlowMod({
      command: FlowModCommand.OFPFC_ADD,
      priority,
      outputPorts,
      match: { inPort },
    }, xid);
    this.clientSocket.write(packet);
  }

  /**
   * Installs a forwarding rule that directs frames arriving on inPort to one or more outputPorts.
   * Alias for sendMirrorRule with a default forwarding priority of 100.
   */
  public sendForwardingRule(inPort: number, outputPorts: number | number[], priority: number = 100): void {
    this.sendMirrorRule(inPort, outputPorts, priority);
  }

  /**
   * Pushes a fully specified FlowMod (typed OXM match incl. eth_type and masked IPv4 src/dst).
   * buildOfpFlowMod throws on any unparseable match field, so a malformed policy rule can never
   * degrade into a wildcard (Council Invariant 3).
   * Returns the xid so a later OFPT_ERROR can be attributed to this exact FlowMod.
   */
  public sendFlowModOptions(options: FlowModOptions): number {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send FlowMod: switch not in ESTABLISHED state (current: ${this.state})`);
    }
    const xid = this.allocateXid();
    const packet = buildOfpFlowMod(options, xid);
    this.clientSocket.write(packet);
    return xid;
  }

  /**
   * Reserves a unique 32-bit transaction ID for externally built OpenFlow messages
   * (e.g. multipart/barrier requests) so replies can be correlated deterministically.
   */
  public reserveXid(): number {
    return this.allocateXid();
  }

  /**
   * Writes a pre-built OpenFlow message to the established switch session.
   * Council Invariant 3 (Fail-Closed): refuses to write unless the session is ESTABLISHED.
   */
  public sendRaw(packet: Buffer): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') {
      throw new Error(`Cannot send raw OpenFlow message: switch not in ESTABLISHED state (current: ${this.state})`);
    }
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
   * Council Invariant 3 (Fail-Closed): if nothing has been received from the
   * peer (echo reply or otherwise, see lastRxNs in handleMessage) within
   * echoDeadPeerTimeoutNs, it vanished without a clean TCP close (e.g.
   * unplugged / power loss) — force the socket closed so 'close' fires and
   * state correctly transitions to DISCONNECTED instead of staying falsely
   * ESTABLISHED forever.
   */
  public pingEcho(): void {
    if (!this.clientSocket || this.state !== 'ESTABLISHED') return;

    const nowNs = process.hrtime.bigint();
    if (this.lastRxNs > 0n && nowNs - this.lastRxNs > this.echoDeadPeerTimeoutNs) {
      // Distinguish this from a clean shutdown: 'close' fires from destroy() below too,
      // but only this event tells observability *why* (missed heartbeats vs. explicit stop).
      const remoteAddr = `${this.clientSocket.remoteAddress}:${this.clientSocket.remotePort}`;
      this.emit('deadPeerTimeout', remoteAddr);
      this.clientSocket.destroy();
      return;
    }

    // XID tracking is intentionally flat (single slot, not a Map<xid, sentNs>):
    // a new pingEcho() call simply overwrites activeEchoXid/echoSentNs, trading
    // per-request latency accuracy under reordering for O(1) memory instead of
    // an unbounded map of in-flight requests.
    const xid = this.allocateXid();
    this.activeEchoXid = xid;
    this.echoSentNs = nowNs;

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
    this.stopHeartbeat(); // ensure no leaked timer survives from a prior connection
    this.clearHandshakeTimeout();

    this.clientSocket = socket;
    this.state = 'HANDSHAKE';
    this.rxBuffer = Buffer.alloc(0);
    this.lastRxNs = 0n;
    this.startHandshakeTimeout(socket);
    this.emit('connected', remoteAddr);

    socket.on('data', (data) => this.onData(data));

    socket.on('close', () => {
      if (this.clientSocket === socket) {
        this.state = 'DISCONNECTED';
        this.switchFeatures = undefined;
        this.clientSocket = null;
        this.stopHeartbeat();
        this.clearHandshakeTimeout();
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
    // Any valid OpenFlow message proves peer liveness, not just OFPT_ECHO_REPLY —
    // under heavy OFPT_PACKET_IN load the switch may delay echo processing while
    // still very much alive, which would otherwise cause a false-positive dead-peer
    // disconnect (Council Invariant 3: fail-closed must not mean trigger-happy).
    this.lastRxNs = process.hrtime.bigint();
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
        this.clearHandshakeTimeout(); // handshake completed; no longer a Slowloris risk
        this.startHeartbeat();
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

      case OpenFlowType.OFPT_MULTIPART_REPLY: {
        this.emit('multipartReply', xid, packet);
        break;
      }

      case OpenFlowType.OFPT_BARRIER_REPLY: {
        this.emit('barrierReply', xid);
        break;
      }

      case OpenFlowType.OFPT_ERROR: {
        // Council Invariant 1: switch-side rejections (e.g. flow table full) must be observable.
        this.emit('ofError', xid, packet);
        break;
      }

      case OpenFlowType.OFPT_PACKET_IN: {
        this._totalPacketIns += 1n;
        const nowNs = process.hrtime.bigint();
        if (this.coppLastRefillNs === 0n) {
          this.coppLastRefillNs = nowNs;
        } else {
          const elapsedNs = nowNs - this.coppLastRefillNs;
          const tokensToAdd = Number((elapsedNs * BigInt(this.coppRateLimit)) / 1_000_000_000n);
          if (tokensToAdd > 0) {
            this.coppTokens = Math.min(this.coppMaxBurst, this.coppTokens + tokensToAdd);
            this.coppLastRefillNs = nowNs;
          }
        }

        if (this.coppTokens < 1) {
          this._coppPacketInDrops += 1n;
          this.emit('coppDrop', xid, this._coppPacketInDrops);
          break;
        }
        this.coppTokens -= 1;

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
