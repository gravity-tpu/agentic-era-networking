/**
 * wire.ts
 * RFC 1035 DNS binary wire protocol parser and builder.
 *
 * Invariant:
 * - Unparseable or malformed packets must fail closed (return FORMERR or throw).
 * - Queries for non-existent domains return NXDOMAIN (RCODE = 3).
 */

import { Buffer } from 'node:buffer';

export interface DnsHeader {
  readonly id: number;
  readonly isResponse: boolean;
  readonly opcode: number;
  readonly authoritativeAnswer: boolean;
  readonly truncated: boolean;
  readonly recursionDesired: boolean;
  readonly recursionAvailable: boolean;
  readonly rcode: number;
  readonly qdcount: number;
  readonly ancount: number;
  readonly nscount: number;
  readonly arcount: number;
}

export interface DnsQuestion {
  readonly qname: string;
  readonly qtype: number;
  readonly qclass: number;
}

export class DnsWireProtocol {
  public static parseHeader(buffer: Buffer): DnsHeader {
    if (buffer.length < 12) {
      throw new Error('DnsWireProtocol: buffer too short for DNS header (<12 bytes)');
    }

    const id = buffer.readUInt16BE(0);
    const flags = buffer.readUInt16BE(2);

    return {
      id,
      isResponse: (flags & 0x8000) !== 0,
      opcode: (flags >> 11) & 0x0f,
      authoritativeAnswer: (flags & 0x0400) !== 0,
      truncated: (flags & 0x0200) !== 0,
      recursionDesired: (flags & 0x0100) !== 0,
      recursionAvailable: (flags & 0x0080) !== 0,
      rcode: flags & 0x000f,
      qdcount: buffer.readUInt16BE(4),
      ancount: buffer.readUInt16BE(6),
      nscount: buffer.readUInt16BE(8),
      arcount: buffer.readUInt16BE(10),
    };
  }

  public static parseQuestion(buffer: Buffer, offset: number = 12): { question: DnsQuestion; nextOffset: number } {
    const labels: string[] = [];
    let current = offset;

    while (current < buffer.length) {
      const len = buffer.readUInt8(current);
      if (len === 0) {
        current += 1;
        break;
      }
      current += 1;
      if (current + len > buffer.length) {
        throw new Error('DnsWireProtocol: malformed label length in QNAME');
      }
      labels.push(buffer.subarray(current, current + len).toString('ascii'));
      current += len;
    }

    if (current + 4 > buffer.length) {
      throw new Error('DnsWireProtocol: buffer truncated in question QTYPE/QCLASS');
    }

    const qtype = buffer.readUInt16BE(current);
    const qclass = buffer.readUInt16BE(current + 2);

    return {
      question: {
        qname: labels.join('.').toLowerCase(),
        qtype,
        qclass,
      },
      nextOffset: current + 4,
    };
  }

  /**
   * Encodes a DNS response buffer with standard header and optional answer.
   * rcode: 0 = NOERROR, 3 = NXDOMAIN (fail-closed default)
   */
  public static buildResponse(
    id: number,
    question: DnsQuestion,
    rcode: number,
    ipv4Answer?: string,
    ttlSeconds: number = 300
  ): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);

    // QR=1, Opcode=0, AA=1, TC=0, RD=1, RA=1, RCODE
    let flags = 0x8580 | (rcode & 0x0f);
    header.writeUInt16BE(flags, 2);

    header.writeUInt16BE(1, 4); // QDCOUNT = 1
    header.writeUInt16BE(ipv4Answer && rcode === 0 ? 1 : 0, 6); // ANCOUNT
    header.writeUInt16BE(0, 8); // NSCOUNT = 0
    header.writeUInt16BE(0, 10); // ARCOUNT = 0

    // Encode Question section
    const qParts: Buffer[] = [];
    for (const label of question.qname.split('.')) {
      const lBuf = Buffer.alloc(1 + label.length);
      lBuf.writeUInt8(label.length, 0);
      lBuf.write(label, 1, 'ascii');
      qParts.push(lBuf);
    }
    qParts.push(Buffer.from([0x00])); // Null root label

    const qTypeClass = Buffer.alloc(4);
    qTypeClass.writeUInt16BE(question.qtype, 0);
    qTypeClass.writeUInt16BE(question.qclass, 2);
    qParts.push(qTypeClass);

    const questionBuf = Buffer.concat(qParts);

    // If answer is present
    if (ipv4Answer && rcode === 0) {
      const ansHeader = Buffer.alloc(16);
      ansHeader.writeUInt16BE(0xc00c, 0); // Pointer to question QNAME at offset 12
      ansHeader.writeUInt16BE(1, 2);      // TYPE = A
      ansHeader.writeUInt16BE(1, 4);      // CLASS = IN
      ansHeader.writeUInt32BE(ttlSeconds, 6); // TTL
      ansHeader.writeUInt16BE(4, 10);     // RDLENGTH = 4 bytes for IPv4

      const octets = ipv4Answer.split('.').map(o => parseInt(o, 10));
      ansHeader.writeUInt8(octets[0] ?? 0, 12);
      ansHeader.writeUInt8(octets[1] ?? 0, 13);
      ansHeader.writeUInt8(octets[2] ?? 0, 14);
      ansHeader.writeUInt8(octets[3] ?? 0, 15);

      return Buffer.concat([header, questionBuf, ansHeader]);
    }

    return Buffer.concat([header, questionBuf]);
  }
}
