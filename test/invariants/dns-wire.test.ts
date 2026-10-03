import { describe, it, expect } from 'vitest';
import { DnsWireProtocol } from '../../src/dns/wire.js';

describe('Invariant: RFC 1035 DNS Binary Wire Protocol', () => {
  it('encodes and parses DNS questions correctly', () => {
    // Manually construct a DNS query for "api.agent.net" (TYPE=A, CLASS=IN, ID=0x1234)
    const id = 0x1234;
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2); // RD = 1
    header.writeUInt16BE(1, 4);      // QDCOUNT = 1

    const qnameParts = [
      Buffer.from([3]), Buffer.from('api'),
      Buffer.from([5]), Buffer.from('agent'),
      Buffer.from([3]), Buffer.from('net'),
      Buffer.from([0]),
    ];
    const qTypeClass = Buffer.alloc(4);
    qTypeClass.writeUInt16BE(1, 0); // A
    qTypeClass.writeUInt16BE(1, 2); // IN

    const queryPacket = Buffer.concat([header, ...qnameParts, qTypeClass]);

    const parsedHeader = DnsWireProtocol.parseHeader(queryPacket);
    expect(parsedHeader.id).toBe(id);
    expect(parsedHeader.isResponse).toBe(false);
    expect(parsedHeader.qdcount).toBe(1);

    const { question } = DnsWireProtocol.parseQuestion(queryPacket, 12);
    expect(question.qname).toBe('api.agent.net');
    expect(question.qtype).toBe(1);
    expect(question.qclass).toBe(1);
  });

  it('builds fail-closed NXDOMAIN response when domain does not exist', () => {
    const question = { qname: 'unregistered.local', qtype: 1, qclass: 1 };
    const response = DnsWireProtocol.buildResponse(0xabcd, question, 3); // RCODE 3 = NXDOMAIN

    const parsed = DnsWireProtocol.parseHeader(response);
    expect(parsed.id).toBe(0xabcd);
    expect(parsed.isResponse).toBe(true);
    expect(parsed.rcode).toBe(3); // Fail-Closed NXDOMAIN
    expect(parsed.ancount).toBe(0); // Zero answers
  });

  it('builds valid NOERROR response with IPv4 A record', () => {
    const question = { qname: 'dns.cluster.internal', qtype: 1, qclass: 1 };
    const response = DnsWireProtocol.buildResponse(0x5678, question, 0, '192.168.1.53', 300);

    const parsed = DnsWireProtocol.parseHeader(response);
    expect(parsed.id).toBe(0x5678);
    expect(parsed.isResponse).toBe(true);
    expect(parsed.rcode).toBe(0); // NOERROR
    expect(parsed.ancount).toBe(1); // 1 answer record
  });

  it('fails closed when question contains label length exceeding 63 octets (RFC 1035)', () => {
    // Construct packet with label length = 64 (0x40)
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(1, 4); // QDCOUNT = 1

    const invalidLabel = Buffer.concat([
      Buffer.from([64]), // 64 bytes label (> 63 max)
      Buffer.alloc(64, 'a'.charCodeAt(0)),
      Buffer.from([0]),  // root
      Buffer.alloc(4),   // QTYPE + QCLASS
    ]);

    const packet = Buffer.concat([header, invalidLabel]);
    expect(() => DnsWireProtocol.parseQuestion(packet, 12)).toThrow(/RFC 1035 max 63 octets/);
  });

  it('fails closed when total domain name length exceeds 255 octets (RFC 1035)', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x5678, 0);
    header.writeUInt16BE(1, 4); // QDCOUNT = 1

    // 5 labels of 52 bytes = 260 octets
    const labels: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      labels.push(Buffer.from([52]));
      labels.push(Buffer.alloc(52, 'b'.charCodeAt(0)));
    }
    labels.push(Buffer.from([0])); // root
    labels.push(Buffer.alloc(4));  // QTYPE + QCLASS

    const packet = Buffer.concat([header, ...labels]);
    expect(() => DnsWireProtocol.parseQuestion(packet, 12)).toThrow(/maximum of 255 octets/);
  });
});
