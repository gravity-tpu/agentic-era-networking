/**
 * openflow.test.ts
 * Invariant Test Suite for OpenFlow 1.3 Wire Framing & Hardware Controller
 *
 * Council Invariants Validated:
 * - Dean & Ghemawat: BigInt 64-bit integer datapath/cookie math and nanosecond timers.
 * - Hassabis & Vinyals: Symbolic loop-free verifier gate before flow mod dispatch.
 * - Anti-Shortcut Law: Error handling on malformed packet headers and stream fragmentation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import {
  OpenFlowType,
  OFP_VERSION_1_3,
  encodeOfpHeader,
  decodeOfpHeader,
  buildOfpHello,
  buildOfpFeaturesRequest,
  buildOfpEchoReply,
  buildOfpEchoRequest,
  parseOfpFeaturesReply,
  buildOfpFlowMod,
  FlowModCommand,
} from '../../src/sdn/openflow-types.js';
import { OpenFlowServer } from '../../src/sdn/openflow-server.js';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { RoutingLoopDetectedError } from '../../src/core/routing-verifier.js';

describe('OpenFlow 1.3 Wire Protocol Serialization', () => {
  it('encodes and decodes standard 8-byte OpenFlow headers deterministically', () => {
    const xid = 0x12345678;
    const buf = encodeOfpHeader(OpenFlowType.OFPT_HELLO, 8, xid);

    expect(buf.length).toBe(8);
    expect(buf[0]).toBe(OFP_VERSION_1_3);
    expect(buf[1]).toBe(OpenFlowType.OFPT_HELLO);
    expect(buf.readUInt16BE(2)).toBe(8);
    expect(buf.readUInt32BE(4)).toBe(xid);

    const decoded = decodeOfpHeader(buf);
    expect(decoded.version).toBe(OFP_VERSION_1_3);
    expect(decoded.type).toBe(OpenFlowType.OFPT_HELLO);
    expect(decoded.length).toBe(8);
    expect(decoded.xid).toBe(xid);
  });

  it('throws fail-closed error when decoding truncated header under 8 bytes', () => {
    const truncated = Buffer.from([0x04, 0x00, 0x00]);
    expect(() => decodeOfpHeader(truncated)).toThrow(/buffer underflow/i);
  });

  it('encodes and parses switch features reply with 64-bit BigInt Datapath ID', () => {
    const raw = Buffer.alloc(32);
    raw.writeUInt8(OFP_VERSION_1_3, 0);
    raw.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
    raw.writeUInt16BE(32, 2);
    raw.writeUInt32BE(10, 4);

    const dpid = 0x70b3d58740bcn; // BigInt MAC based datapath id
    raw.writeBigUInt64BE(dpid, 8);
    raw.writeUInt32BE(128, 16); // n_buffers
    raw.writeUInt8(2, 20); // n_tables
    raw.writeUInt8(0, 21); // auxiliary_id
    raw.writeUInt32BE(0x00000007, 24); // capabilities

    const features = parseOfpFeaturesReply(raw);
    expect(features.datapathId).toBe(dpid);
    expect(features.nBuffers).toBe(128);
    expect(features.nTables).toBe(2);
    expect(features.capabilities).toBe(7);
  });

  it('builds valid OFPT_FLOW_MOD packets with match fields', () => {
    const flowMod = buildOfpFlowMod({
      command: FlowModCommand.OFPFC_ADD,
      priority: 100,
      cookie: 42n,
      outPort: 1,
    }, 999);

    expect(flowMod.length).toBe(56);
    expect(flowMod[0]).toBe(OFP_VERSION_1_3);
    expect(flowMod[1]).toBe(OpenFlowType.OFPT_FLOW_MOD);
    expect(flowMod.readUInt32BE(4)).toBe(999); // xid
    expect(flowMod.readBigUInt64BE(8)).toBe(42n); // cookie
    expect(flowMod.readUInt8(25)).toBe(FlowModCommand.OFPFC_ADD);
    expect(flowMod.readUInt16BE(30)).toBe(100); // priority
    expect(flowMod.readUInt32BE(36)).toBe(1); // outPort
  });
});

describe('OpenFlowServer Live Handshake & State Invariants', () => {
  let server: OpenFlowServer;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  it('completes the HELLO -> FEATURES -> ESTABLISHED handshake state machine', async () => {
    server = new OpenFlowServer();
    await server.listen(0, '127.0.0.1');

    const address = (server['server'] as net.Server).address() as net.AddressInfo;
    const testPort = address.port;

    const handshakeComplete = new Promise<void>((resolve) => {
      server.on('ready', (features) => {
        expect(features.datapathId).toBe(0x12345678n);
        expect(server.metrics.state).toBe('ESTABLISHED');
        resolve();
      });
    });

    // Mock physical switch client
    let switchRx = Buffer.alloc(0);
    const switchSocket = net.connect({ port: testPort, host: '127.0.0.1' }, () => {
      // 1. Switch sends OFPT_HELLO
      switchSocket.write(buildOfpHello(1));
    });

    switchSocket.on('data', (chunk) => {
      switchRx = Buffer.concat([switchRx, chunk]);
      while (switchRx.length >= 8) {
        const header = decodeOfpHeader(switchRx);
        if (switchRx.length < header.length) break;
        const msg = switchRx.subarray(0, header.length);
        switchRx = switchRx.subarray(header.length);

        if (header.type === OpenFlowType.OFPT_FEATURES_REQUEST) {
          // 2. Switch replies with OFPT_FEATURES_REPLY
          const reply = Buffer.alloc(32);
          reply.writeUInt8(OFP_VERSION_1_3, 0);
          reply.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
          reply.writeUInt16BE(32, 2);
          reply.writeUInt32BE(header.xid, 4);
          reply.writeBigUInt64BE(0x12345678n, 8);
          reply.writeUInt32BE(128, 16);
          reply.writeUInt8(1, 20);
          reply.writeUInt8(0, 21);
          reply.writeUInt32BE(0x01, 24);
          switchSocket.write(reply);
        }
      }
    });

    await handshakeComplete;
    switchSocket.destroy();
  });
});

describe('ZodiacController Invariant Protection Gate', () => {
  it('strictly blocks flow rule dispatch when symbolic loop verifier detects a routing cycle', () => {
    const controller = new ZodiacController();

    const cyclicHops = [
      { fromNode: 'switch-1', toNode: 'switch-2', cost: 1 },
      { fromNode: 'switch-2', toNode: 'switch-3', cost: 1 },
      { fromNode: 'switch-3', toNode: 'switch-1', cost: 1 }, // Cycle!
    ];

    const rule = {
      id: 'rule-test-1',
      priority: 100,
      srcCidr: '10.0.0.0/24',
      dstCidr: '10.0.1.0/24',
      protocol: 'TCP' as const,
      action: 'FORWARD' as const,
    };

    expect(() => {
      controller.pushVerifiedRule(rule, cyclicHops, 1);
    }).toThrow(RoutingLoopDetectedError);
  });
});
