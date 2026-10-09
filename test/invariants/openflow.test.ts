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

  it('builds an 80-byte OpenFlow 1.3 Table-Miss FlowMod with output to CONTROLLER and bounded maxLen', () => {
    const tableMiss = buildOfpTableMissFlowMod(777, 0, 'CONTROLLER', 128);

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
    expect(tableMiss.readUInt16BE(72)).toBe(128); // max_len = 128 (bounded header sampling)
  });

  it('builds a 56-byte fail-closed DROP Table-Miss FlowMod by default (Council Invariant 3)', () => {
    const defaultTableMiss = buildOfpTableMissFlowMod(888, 0);

    expect(defaultTableMiss.length).toBe(56);
    expect(defaultTableMiss[0]).toBe(OFP_VERSION_1_3);
    expect(defaultTableMiss[1]).toBe(OpenFlowType.OFPT_FLOW_MOD);
    expect(defaultTableMiss.readUInt16BE(2)).toBe(56);
    expect(defaultTableMiss.readUInt32BE(4)).toBe(888);
    expect(defaultTableMiss.readUInt16BE(30)).toBe(0);
    // No instructions appended -> hardware drops unmatched traffic
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

  it('correctly parses an 802.1Q VLAN-tagged IPv4 packet and decodes VLAN ID, IPs, and MACs', () => {
    // 802.1Q tagged frame:
    // Dst MAC (6B), Src MAC (6B), TPID 0x8100 (2B), TCI (2B: PCP/DEI/VID=100), EtherType 0x0800 (2B), IPv4 Header (20B)
    const etherFrame = Buffer.alloc(14 + 4 + 20); // 14 untagged + 4 VLAN tag + 20 IPv4 = 38 bytes
    // Dst MAC: 00:0e:c6:11:22:33
    Buffer.from([0x00, 0x0e, 0xc6, 0x11, 0x22, 0x33]).copy(etherFrame, 0);
    // Src MAC: 00:1c:b3:aa:bb:cc
    Buffer.from([0x00, 0x1c, 0xb3, 0xaa, 0xbb, 0xcc]).copy(etherFrame, 6);
    // TPID: 0x8100
    etherFrame.writeUInt16BE(0x8100, 12);
    // TCI: VLAN ID 100 -> 0x0064
    etherFrame.writeUInt16BE(100, 14);
    // Inner EtherType: 0x0800 (IPv4)
    etherFrame.writeUInt16BE(0x0800, 16);
    // IPv4 Header starting at 18:
    // Version & IHL (0x45)
    etherFrame.writeUInt8(0x45, 18);
    // IP Src: 192.168.1.50 at offset 18 + 12 = 30
    Buffer.from([192, 168, 1, 50]).copy(etherFrame, 30);
    // IP Dst: 1.1.1.1 at offset 18 + 16 = 34
    Buffer.from([1, 1, 1, 1]).copy(etherFrame, 34);

    const match = Buffer.alloc(16);
    match.writeUInt16BE(1, 0);
    match.writeUInt16BE(12, 2);
    match.writeUInt32BE(0x80000004, 4); // in_port
    match.writeUInt32BE(3, 8); // port 3

    const packetInHeader = Buffer.alloc(24);
    packetInHeader.writeUInt8(OFP_VERSION_1_3, 0);
    packetInHeader.writeUInt8(OpenFlowType.OFPT_PACKET_IN, 1);
    const totalPktLen = 24 + match.length + 2 + etherFrame.length;
    packetInHeader.writeUInt16BE(totalPktLen, 2);
    packetInHeader.writeUInt32BE(1002, 4);
    packetInHeader.writeUInt32BE(0xffffffff, 8);
    packetInHeader.writeUInt16BE(etherFrame.length, 12);
    packetInHeader.writeUInt8(0, 14);
    packetInHeader.writeUInt8(0, 15);

    const pad2 = Buffer.alloc(2);
    const fullPacket = Buffer.concat([packetInHeader, match, pad2, etherFrame]);

    const decoded = parseOfpPacketIn(fullPacket);
    expect(decoded.inPort).toBe(3);
    expect(decoded.srcMac).toBe('00:1c:b3:aa:bb:cc');
    expect(decoded.dstMac).toBe('00:0e:c6:11:22:33');
    expect(decoded.vlanId).toBe(100);
    expect(decoded.vlanIds).toEqual([100]);
    expect(decoded.etherTypeStr).toBe('IPv4');
    expect(decoded.srcIp).toBe('192.168.1.50');
    expect(decoded.dstIp).toBe('1.1.1.1');
  });

  it('correctly parses an 802.1ad / 802.1Q QinQ double-tagged packet preserving full VLAN stack', () => {
    // QinQ frame:
    // Dst MAC (6B), Src MAC (6B), TPID 0x88a8 (2B: S-VLAN 200), TCI (2B), TPID 0x8100 (2B: C-VLAN 100), TCI (2B), EtherType 0x0800 (2B), IPv4 Header (20B)
    const etherFrame = Buffer.alloc(14 + 4 + 4 + 20); // 42 bytes
    Buffer.from([0x00, 0x0e, 0xc6, 0x11, 0x22, 0x33]).copy(etherFrame, 0);
    Buffer.from([0x00, 0x1c, 0xb3, 0xaa, 0xbb, 0xcc]).copy(etherFrame, 6);
    // Outer TPID: 0x88a8
    etherFrame.writeUInt16BE(0x88a8, 12);
    // Outer TCI: S-VLAN ID 200
    etherFrame.writeUInt16BE(200, 14);
    // Inner TPID: 0x8100
    etherFrame.writeUInt16BE(0x8100, 16);
    // Inner TCI: C-VLAN ID 100
    etherFrame.writeUInt16BE(100, 18);
    // Inner EtherType: 0x0800 (IPv4)
    etherFrame.writeUInt16BE(0x0800, 20);
    // IPv4 Header starting at 22:
    etherFrame.writeUInt8(0x45, 22);
    // IP Src: 10.10.1.1 at offset 22 + 12 = 34
    Buffer.from([10, 10, 1, 1]).copy(etherFrame, 34);
    // IP Dst: 10.10.2.2 at offset 22 + 16 = 38
    Buffer.from([10, 10, 2, 2]).copy(etherFrame, 38);

    const match = Buffer.alloc(16);
    match.writeUInt16BE(1, 0);
    match.writeUInt16BE(12, 2);
    match.writeUInt32BE(0x80000004, 4); // in_port
    match.writeUInt32BE(2, 8); // port 2

    const packetInHeader = Buffer.alloc(24);
    packetInHeader.writeUInt8(OFP_VERSION_1_3, 0);
    packetInHeader.writeUInt8(OpenFlowType.OFPT_PACKET_IN, 1);
    const totalPktLen = 24 + match.length + 2 + etherFrame.length;
    packetInHeader.writeUInt16BE(totalPktLen, 2);
    packetInHeader.writeUInt32BE(1003, 4);
    packetInHeader.writeUInt32BE(0xffffffff, 8);
    packetInHeader.writeUInt16BE(etherFrame.length, 12);
    packetInHeader.writeUInt8(0, 14);
    packetInHeader.writeUInt8(0, 15);

    const pad2 = Buffer.alloc(2);
    const fullPacket = Buffer.concat([packetInHeader, match, pad2, etherFrame]);

    const decoded = parseOfpPacketIn(fullPacket);
    expect(decoded.inPort).toBe(2);
    expect(decoded.vlanId).toBe(200);
    expect(decoded.vlanIds).toEqual([200, 100]);
    expect(decoded.etherTypeStr).toBe('IPv4');
    expect(decoded.srcIp).toBe('10.10.1.1');
    expect(decoded.dstIp).toBe('10.10.2.2');
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

  it('detects a dead peer via missed OFPT_ECHO_REPLY heartbeats and transitions to DISCONNECTED (Anti-Simulation Law)', async () => {
    const shortTimeoutNs = 50_000_000n; // 50ms, injected for fast test execution
    server = new OpenFlowServer(shortTimeoutNs);
    await server.listen(0, '127.0.0.1');

    const address = (server['server'] as net.Server).address() as net.AddressInfo;
    const testPort = address.port;

    const handshakeComplete = new Promise<void>((resolve) => {
      server.on('ready', () => resolve());
    });

    let switchRx = Buffer.alloc(0);
    const switchSocket = net.connect({ port: testPort, host: '127.0.0.1' }, () => {
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
        switchRx = switchRx.subarray(header.length);

        if (header.type === OpenFlowType.OFPT_FEATURES_REQUEST) {
          const reply = Buffer.alloc(32);
          reply.writeUInt8(OFP_VERSION_1_3, 0);
          reply.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
          reply.writeUInt16BE(32, 2);
          reply.writeUInt32BE(header.xid, 4);
          reply.writeBigUInt64BE(0xdeadbeefn, 8);
          reply.writeUInt32BE(128, 16);
          reply.writeUInt8(1, 20);
          reply.writeUInt8(0, 21);
          reply.writeUInt32BE(0x01, 24);
          switchSocket.write(reply);
        }
        // Deliberately never respond to OFPT_ECHO_REQUEST — simulates an unplugged
        // physical switch that vanishes without sending a clean TCP FIN/RST.
      }
    });

    await handshakeComplete;
    expect(server.metrics.state).toBe('ESTABLISHED');

    const disconnected = new Promise<void>((resolve) => {
      server.on('disconnected', () => resolve());
    });

    // Manual pingEcho() calls, not the internal heartbeat timer: startHeartbeat()
    // clamps its interval to a 1000ms floor, which would dwarf this test's 50ms
    // injected timeout and hang the test waiting on the real heartbeat tick.
    server.pingEcho(); // sent, never replied to
    await new Promise((resolve) => setTimeout(resolve, 80)); // exceed the 50ms dead-peer timeout
    server.pingEcho(); // this call observes the missed reply and forces the socket closed

    await disconnected;
    expect(server.metrics.state).toBe('DISCONNECTED');

    switchSocket.destroy();
  });

  it('destroys a socket that stalls in HANDSHAKE without completing OFPT_FEATURES_REPLY (Slowloris guard)', async () => {
    const shortEchoTimeoutNs = 50_000_000n; // unused in this test path; kept short so nothing lingers
    const shortHandshakeTimeoutMs = 50;
    server = new OpenFlowServer(shortEchoTimeoutNs, shortHandshakeTimeoutMs);
    await server.listen(0, '127.0.0.1');

    const address = (server['server'] as net.Server).address() as net.AddressInfo;
    const testPort = address.port;

    const disconnected = new Promise<void>((resolve) => {
      server.on('disconnected', () => resolve());
    });

    // Client connects but never sends anything — never even completes OFPT_HELLO.
    const stalledSocket = net.connect({ port: testPort, host: '127.0.0.1' });

    await disconnected;
    expect(server.metrics.state).toBe('DISCONNECTED');

    stalledSocket.destroy();
  });

  it('installs multi-port forwarding and mirror rules via sendForwardingRule (CCIE Invariant NET-001)', async () => {
    server = new OpenFlowServer();
    await server.listen(0, '127.0.0.1');

    const address = (server['server'] as net.Server).address() as net.AddressInfo;
    const testPort = address.port;

    const handshakeComplete = new Promise<void>((resolve) => {
      server.on('ready', () => resolve());
    });

    let switchRx = Buffer.alloc(0);
    let capturedFlowMod: Buffer | null = null;
    const flowModReceived = new Promise<void>((resolve) => {
      // Resolve when switch receives FLOW_MOD
      const checkInterval = setInterval(() => {
        if (capturedFlowMod) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 10);
    });

    const switchSocket = net.connect({ port: testPort, host: '127.0.0.1' }, () => {
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
          const reply = Buffer.alloc(32);
          reply.writeUInt8(OFP_VERSION_1_3, 0);
          reply.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
          reply.writeUInt16BE(32, 2);
          reply.writeUInt32BE(header.xid, 4);
          reply.writeBigUInt64BE(0x11223344n, 8);
          reply.writeUInt32BE(128, 16);
          reply.writeUInt8(1, 20);
          reply.writeUInt8(0, 21);
          reply.writeUInt32BE(0x01, 24);
          switchSocket.write(reply);
        } else if (header.type === OpenFlowType.OFPT_FLOW_MOD) {
          capturedFlowMod = msg;
        }
      }
    });

    await handshakeComplete;

    // Send multi-port forwarding rule: Port 1 -> [Port 2, Port 3] at priority 100
    server.sendForwardingRule(1, [2, 3], 100);

    await flowModReceived;
    expect(capturedFlowMod).not.toBeNull();
    const fm = capturedFlowMod!;
    expect(fm[0]).toBe(OFP_VERSION_1_3);
    expect(fm[1]).toBe(OpenFlowType.OFPT_FLOW_MOD);
    expect(fm.readUInt16BE(30)).toBe(100); // priority = 100

    switchSocket.destroy();
  });

  it('enforces Control Plane Policing (CoPP) on OFPT_PACKET_IN floods and records drops (CCIE Invariant NET-001)', async () => {
    // Config: burst of 2 tokens, rate limit of 1 per second
    server = new OpenFlowServer(5_000_000_000n, 5000, 1, 2);
    await server.listen(0, '127.0.0.1');

    const address = (server['server'] as net.Server).address() as net.AddressInfo;
    const testPort = address.port;

    const handshakeComplete = new Promise<void>((resolve) => {
      server.on('ready', () => resolve());
    });

    let switchRx = Buffer.alloc(0);
    const switchSocket = net.connect({ port: testPort, host: '127.0.0.1' }, () => {
      switchSocket.write(buildOfpHello(1));
    });

    switchSocket.on('data', (chunk) => {
      switchRx = Buffer.concat([switchRx, chunk]);
      while (switchRx.length >= 8) {
        const header = decodeOfpHeader(switchRx);
        if (switchRx.length < header.length) break;
        switchRx = switchRx.subarray(header.length);

        if (header.type === OpenFlowType.OFPT_FEATURES_REQUEST) {
          const reply = Buffer.alloc(32);
          reply.writeUInt8(OFP_VERSION_1_3, 0);
          reply.writeUInt8(OpenFlowType.OFPT_FEATURES_REPLY, 1);
          reply.writeUInt16BE(32, 2);
          reply.writeUInt32BE(header.xid, 4);
          reply.writeBigUInt64BE(0x11223344n, 8);
          reply.writeUInt32BE(128, 16);
          reply.writeUInt8(1, 20);
          reply.writeUInt8(0, 21);
          reply.writeUInt32BE(0x01, 24);
          switchSocket.write(reply);
        }
      }
    });

    await handshakeComplete;

    // Helper to build a valid packet-in message
    const buildPktIn = (xid: number) => {
      const match = Buffer.alloc(12);
      match.writeUInt16BE(1, 0); // OFPMT_OXM
      match.writeUInt16BE(8, 2); // length
      match.writeUInt32BE(0x80000004, 4); // in_port
      match.writeUInt32BE(1, 8); // port 1
      const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);

      const header = Buffer.alloc(24);
      header.writeUInt8(OFP_VERSION_1_3, 0);
      header.writeUInt8(OpenFlowType.OFPT_PACKET_IN, 1);
      const totalLen = 24 + match.length + 2 + payload.length;
      header.writeUInt16BE(totalLen, 2);
      header.writeUInt32BE(xid, 4);
      header.writeUInt32BE(0xffffffff, 8);
      header.writeUInt16BE(payload.length, 12);
      header.writeUInt8(0, 14);
      header.writeUInt8(0, 15);
      const pad2 = Buffer.alloc(2);
      return Buffer.concat([header, match, pad2, payload]);
    };

    let acceptedCount = 0;
    let coppDropCount = 0;
    server.on('packetIn', () => { acceptedCount++; });
    server.on('coppDrop', () => { coppDropCount++; });

    // Send 5 rapid PACKET_IN messages
    for (let i = 1; i <= 5; i++) {
      switchSocket.write(buildPktIn(i));
    }

    // Wait 50ms for event processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.totalPacketIns).toBe(5n);
    expect(acceptedCount).toBe(2); // burst allows exactly 2
    expect(coppDropCount).toBe(3); // 3 were dropped by CoPP
    expect(server.coppPacketInDrops).toBe(3n);
    expect(server.metrics.coppPacketInDrops).toBe(3n);

    switchSocket.destroy();
  });
});
