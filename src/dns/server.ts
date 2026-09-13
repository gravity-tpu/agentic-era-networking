/**
 * server.ts
 * Wire-Protocol DNS UDP Socket Server (RFC 1035)
 *
 * Invariant:
 * - Fail-closed resolution: all unregistered names return NXDOMAIN (RCODE = 3).
 * - Zero uncaught exceptions on malformed datagrams; packets are dropped or error-coded.
 */

import dgram from 'node:dgram';
import { DnsWireProtocol } from './wire.js';
import { FailClosedDnsResolver, DnsResolutionError } from './resolver.js';

export interface DnsServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly resolver: FailClosedDnsResolver;
}

export class DnsUdpServer {
  private socket: dgram.Socket | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly resolver: FailClosedDnsResolver;
  private _queriesProcessed: bigint = 0n;
  private _nxdomainResponses: bigint = 0n;

  constructor(options: DnsServerOptions) {
    this.port = options.port ?? 5353;
    this.host = options.host ?? '0.0.0.0';
    this.resolver = options.resolver;
  }

  public get queriesProcessed(): bigint {
    return this._queriesProcessed;
  }

  public get nxdomainResponses(): bigint {
    return this._nxdomainResponses;
  }

  /**
   * Starts the UDP socket server.
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.bind(this.port, this.host, () => {
        resolve();
      });
    });
  }

  /**
   * Stops the UDP socket server.
   */
  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          this.socket = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this._queriesProcessed += 1n;

    try {
      const header = DnsWireProtocol.parseHeader(msg);
      if (header.isResponse || header.qdcount === 0) {
        return; // Ignore responses or empty queries
      }

      const { question } = DnsWireProtocol.parseQuestion(msg, 12);

      try {
        const record = this.resolver.resolve(question.qname, 'A');
        const response = DnsWireProtocol.buildResponse(header.id, question, 0, record.value, record.ttlSeconds);
        this.socket?.send(response, rinfo.port, rinfo.address);
      } catch (err) {
        if (err instanceof DnsResolutionError) {
          this._nxdomainResponses += 1n;
          // Fail-closed NXDOMAIN response
          const nxResponse = DnsWireProtocol.buildResponse(header.id, question, 3);
          this.socket?.send(nxResponse, rinfo.port, rinfo.address);
        }
      }
    } catch {
      // Malformed datagram dropped safely
    }
  }
}
