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
  buildOfpTableMissFlowMod,
  parseOfpPacketIn,
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

  it('builds an 80-byte OpenFlow 1.3 Table-Miss FlowMod with output to CONTROLLER', () => {
    const tableMiss = buildOfpTableMissFlowMod(777, 0);

    expect(tableMiss.length).toBe(80);
    expect(tableMiss[0]).toBe(OFP_VERSION_1_3);
    expect(tableMiss[1]).toBe(OpenFlowType.OFPT_FLOW_MOD);
    expect(tableMiss.readUInt16BE(2)).toBe(80);
    expect(tableMiss.readUInt32BE(4)).toBe(777); // xid
    expect(tableMiss.readUInt16BE(30)).toBe(0); // priority 0 (table miss)

    // Instructions: OFPIT_APPLY_ACTIONS at offset 56
    expect(tableMiss.readUInt16BE(56)).toBe(4); // OFPIT_APPLY_ACTIONS
    expect(tableMiss.readUInt16BE(58)).toBe(24); // instruction length 24

    // Action: OFPAT_OUTPUT at offset 64
    expect(tableMiss.readUInt16BE(64)).toBe(0); // OFPAT_OUTPUT
    expect(tableMiss.readUInt16BE(66)).toBe(16); // action length 16
    expect(tableMiss.readUInt32BE(68)).toBe(0xfffffffd); // OFPP_CONTROLLER
  });

  it('correctly parses an OFPT_PACKET_IN message and decodes ARP packet payload', () => {
    // Construct an OFPT_PACKET_IN with an ARP frame
    const etherFrame = Buffer.alloc(42);
    // Dst MAC: ff:ff:ff:ff:ff:ff
    etherFrame.fill(0xff, 0, 6);
    // Src MAC: 00:1c:b3:11:22:33
    Buffer.from([0x00, 0x1c, 0xb3, 0x11, 0x22, 0x33]).copy(etherFrame, 6);
    // EtherType: 0x0806 (ARP)
    etherFrame.writeUInt16BE(0x0806, 12);
    // ARP Sender IP: 10.0.0.1 at offset 28
    Buffer.from([10, 0, 0, 1]).copy(etherFrame, 28);
    // ARP Target IP: 10.0.0.254 at offset 38
    Buffer.from([10, 0, 0, 254]).copy(etherFrame, 38);

    // Build OFPT_PACKET_IN packet: 8 (header) + 16 (body) + 12 (match with in_port) + 4 (pad) + 2 (pad) + 42 (frame)
    // Minimal match with in_port: type=1 (2B), len=8 (2B), oxm_in_port=0x80000004 (4B), val=2 (4B) -> total 12 bytes, +4 pad = 16 bytes
    const match = Buffer.alloc(16);
    match.writeUInt16BE(1, 0); // type
    match.writeUInt16BE(12, 2); // len
    match.writeUInt32BE(0x80000004, 4); // oxm in_port
    match.writeUInt32BE(2, 8); // port 2

    const packetInHeader = Buffer.alloc(24);
    packetInHeader.writeUInt8(OFP_VERSION_1_3, 0);
    packetInHeader.writeUInt8(OpenFlowType.OFPT_PACKET_IN, 1);
    const totalPktLen = 24 + match.length + 2 + etherFrame.length;
    packetInHeader.writeUInt16BE(totalPktLen, 2);
    packetInHeader.writeUInt32BE(1001, 4);
    packetInHeader.writeUInt32BE(0xffffffff, 8); // buffer_id
    packetInHeader.writeUInt16BE(etherFrame.length, 12); // total_len
    packetInHeader.writeUInt8(0, 14); // reason = NO_MATCH
    packetInHeader.writeUInt8(0, 15); // table_id

    const pad2 = Buffer.alloc(2);
    const fullPacket = Buffer.concat([packetInHeader, match, pad2, etherFrame]);

    const decoded = parseOfpPacketIn(fullPacket);
    expect(decoded.inPort).toBe(2);
    expect(decoded.srcMac).toBe('00:1c:b3:11:22:33');
    expect(decoded.dstMac).toBe('ff:ff:ff:ff:ff:ff');
    expect(decoded.etherTypeStr).toBe('ARP');
    expect(decoded.arpSenderIp).toBe('10.0.0.1');
    expect(decoded.arpTargetIp).toBe('10.0.0.254');
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
      const buf = typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf-8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      switchRx = Buffer.concat([switchRx, buf]);
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
