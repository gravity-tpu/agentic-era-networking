import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  parseIpv4ToUint32,
  isPrivateIpv4,
  parseHextet,
  parseIpv6ToHextets,
  isPrivateIpv6,
  isLanOperator,
} from '../../src/sdn/zodiac-bridge-server.js';

function createMockRequest(remoteAddress: string | undefined): IncomingMessage {
  return {
    socket: {
      remoteAddress,
    },
    headers: {},
  } as unknown as IncomingMessage;
}

describe('Invariant: Dual-Stack Bitwise Operator Authentication & BeyondCorp Law', () => {
  const originalClientId = process.env['GOOGLE_CLIENT_ID'];

  beforeEach(() => {
    delete process.env['GOOGLE_CLIENT_ID'];
  });

  afterEach(() => {
    if (originalClientId !== undefined) {
      process.env['GOOGLE_CLIENT_ID'] = originalClientId;
    } else {
      delete process.env['GOOGLE_CLIENT_ID'];
    }
  });

  describe('Bitwise IPv4 Parsing & Range Classification (Jeff Dean Latency Standard)', () => {
    it('converts valid dotted-quad strings to exact 32-bit unsigned integers', () => {
      expect(parseIpv4ToUint32('0.0.0.0')).toBe(0);
      expect(parseIpv4ToUint32('127.0.0.1')).toBe(0x7f000001);
      expect(parseIpv4ToUint32('10.0.0.15')).toBe(0x0a00000f);
      expect(parseIpv4ToUint32('192.168.1.1')).toBe(0xc0a80101);
      expect(parseIpv4ToUint32('255.255.255.255')).toBe(0xffffffff);
    });

    it('fails closed on invalid, malformed, or out-of-range IPv4 strings', () => {
      expect(parseIpv4ToUint32('')).toBeNull();
      expect(parseIpv4ToUint32('127.0.0')).toBeNull();
      expect(parseIpv4ToUint32('127.0.0.1.5')).toBeNull();
      expect(parseIpv4ToUint32('127.0.0.256')).toBeNull();
      expect(parseIpv4ToUint32('127.0.0.-1')).toBeNull();
      expect(parseIpv4ToUint32('127.0.0.01')).toBeNull(); // Leading zero ambiguity
      expect(parseIpv4ToUint32(' 127.0.0.1')).toBeNull(); // Leading whitespace rejection
      expect(parseIpv4ToUint32('127. 0.0.1')).toBeNull(); // Infix whitespace rejection
      expect(parseIpv4ToUint32('127.0.0.1 ')).toBeNull(); // Trailing whitespace rejection
      expect(parseIpv4ToUint32('localhost')).toBeNull();
    });

    it('correctly classifies RFC 1122 Loopback (127.0.0.0/8)', () => {
      expect(isPrivateIpv4('127.0.0.1')).toBe(true);
      expect(isPrivateIpv4('127.0.0.53')).toBe(true);
      expect(isPrivateIpv4('127.255.255.254')).toBe(true);
    });

    it('correctly classifies RFC 1918 Class A (10.0.0.0/8)', () => {
      expect(isPrivateIpv4('10.0.0.1')).toBe(true);
      expect(isPrivateIpv4('10.0.0.15')).toBe(true);
      expect(isPrivateIpv4('10.254.1.99')).toBe(true);
      expect(isPrivateIpv4('10.255.255.255')).toBe(true);
    });

    it('correctly classifies RFC 1918 Class B (172.16.0.0/12) with exact bitmask boundaries', () => {
      expect(isPrivateIpv4('172.16.0.0')).toBe(true);
      expect(isPrivateIpv4('172.16.0.1')).toBe(true);
      expect(isPrivateIpv4('172.24.10.5')).toBe(true);
      expect(isPrivateIpv4('172.31.255.255')).toBe(true);

      // Boundary violations must fail closed
      expect(isPrivateIpv4('172.15.255.255')).toBe(false);
      expect(isPrivateIpv4('172.32.0.0')).toBe(false);
      expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    });

    it('correctly classifies RFC 1918 Class C (192.168.0.0/16)', () => {
      expect(isPrivateIpv4('192.168.0.1')).toBe(true);
      expect(isPrivateIpv4('192.168.1.100')).toBe(true);
      expect(isPrivateIpv4('192.168.255.254')).toBe(true);

      expect(isPrivateIpv4('192.167.255.255')).toBe(false);
      expect(isPrivateIpv4('192.169.0.1')).toBe(false);
    });

    it('correctly classifies RFC 3927 Link-Local (169.254.0.0/16)', () => {
      expect(isPrivateIpv4('169.254.1.1')).toBe(true);
      expect(isPrivateIpv4('169.254.254.254')).toBe(true);

      expect(isPrivateIpv4('169.253.255.255')).toBe(false);
      expect(isPrivateIpv4('169.255.0.1')).toBe(false);
    });

    it('rejects public internet IPv4 addresses', () => {
      expect(isPrivateIpv4('8.8.8.8')).toBe(false);
      expect(isPrivateIpv4('1.1.1.1')).toBe(false);
      expect(isPrivateIpv4('142.250.190.46')).toBe(false);
      expect(isPrivateIpv4('192.0.2.1')).toBe(false); // TEST-NET-1
    });
  });

  describe('Bitwise IPv6 Parsing & Dual-Stack Classification (Ghemawat Simplicity)', () => {
    it('strictly parses hexadecimal hextets with zero permissive fallbacks (Fail-Closed)', () => {
      expect(parseHextet('0')).toBe(0);
      expect(parseHextet('fe80')).toBe(0xfe80);
      expect(parseHextet('FFFF')).toBe(0xffff);
      expect(parseHextet('1a2b')).toBe(0x1a2b);

      // Rejects non-hex characters deterministically
      expect(parseHextet('fe80z')).toBeNull();
      expect(parseHextet('fez')).toBeNull();
      expect(parseHextet('123g')).toBeNull();
      expect(parseHextet('')).toBeNull();
      expect(parseHextet('12345')).toBeNull();
    });

    it('parses IPv6 addresses into 8 hextets and fails closed on malformed structures', () => {
      expect(parseIpv6ToHextets('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
      expect(parseIpv6ToHextets('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);

      // Malformed inputs must return null
      expect(parseIpv6ToHextets('fe80::1::2')).toBeNull(); // Multiple ::
      expect(parseIpv6ToHextets('fe80z::1')).toBeNull(); // Invalid hex character
      expect(parseIpv6ToHextets('fe80:1:2:3:4:5:6:7:8')).toBeNull(); // 9 hextets
    });

    it('identifies RFC 4291 IPv6 Loopback with full mathematical equivalence', () => {
      expect(isPrivateIpv6('::1')).toBe(true);
      expect(isPrivateIpv6('0:0:0:0:0:0:0:1')).toBe(true); // Uncompressed equivalence
      expect(isPrivateIpv6('0000::0001')).toBe(true);
      expect(isPrivateIpv6('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    });

    it('identifies RFC 4291 Link-Local (fe80::/10) with exact 10-bit prefix masking', () => {
      expect(isPrivateIpv6('fe80::1')).toBe(true);
      expect(isPrivateIpv6('fe80::ac3a:e2ff:fe98:99dd')).toBe(true);
      expect(isPrivateIpv6('fe90::1')).toBe(true);
      expect(isPrivateIpv6('fea0::1')).toBe(true);
      expect(isPrivateIpv6('febf::ffff:ffff:ffff:ffff')).toBe(true);

      // Boundaries outside fe80::/10 (first 10 bits: 1111 1110 10xx xxxx)
      expect(isPrivateIpv6('fe7f::1')).toBe(false);
      expect(isPrivateIpv6('fec0::1')).toBe(false); // Deprecated site-local
      expect(isPrivateIpv6('fe80z::1')).toBe(false); // Malformed must fail closed
    });

    it('correctly handles IPv6 interface zone/scope index (%eth0, %enP8p1s0)', () => {
      expect(isPrivateIpv6('fe80::1%enP8p1s0')).toBe(true);
      expect(isPrivateIpv6('fe80::2%eth0')).toBe(true);
      expect(isPrivateIpv6('fe80::a00:27ff:fe8e:5678%12')).toBe(true);
    });

    it('identifies RFC 4193 Unique Local Addresses (ULA, fc00::/7)', () => {
      expect(isPrivateIpv6('fc00::1')).toBe(true);
      expect(isPrivateIpv6('fc12:3456:789a::1')).toBe(true);
      expect(isPrivateIpv6('fd00::1')).toBe(true);
      expect(isPrivateIpv6('fd12:3456:789a:1::1')).toBe(true);
      expect(isPrivateIpv6('fdff:ffff:ffff:ffff::1')).toBe(true);

      // Boundaries outside fc00::/7 (first 7 bits: 1111 110x xxxx xxxx)
      expect(isPrivateIpv6('fbff::1')).toBe(false);
      expect(isPrivateIpv6('fe00::1')).toBe(false);
    });

    it('rejects public global unicast IPv6 addresses', () => {
      expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
      expect(isPrivateIpv6('2600:1901:0:0::1')).toBe(false);
      expect(isPrivateIpv6('2404:6800:4003:c02::64')).toBe(false);
    });
  });

  describe('isLanOperator End-to-End Socket Request Evaluation', () => {
    it('authorizes IPv4-mapped IPv6 private addresses', () => {
      const req = createMockRequest('::ffff:10.0.0.15');
      expect(isLanOperator(req)).toBe(true);

      const reqLoop = createMockRequest('::ffff:127.0.0.1');
      expect(isLanOperator(reqLoop)).toBe(true);

      const reqClassC = createMockRequest('::ffff:192.168.1.42');
      expect(isLanOperator(reqClassC)).toBe(true);
    });

    it('rejects IPv4-mapped IPv6 public addresses', () => {
      const req = createMockRequest('::ffff:8.8.8.8');
      expect(isLanOperator(req)).toBe(false);
    });

    it('authorizes native IPv4 LAN addresses', () => {
      expect(isLanOperator(createMockRequest('10.0.0.15'))).toBe(true);
      expect(isLanOperator(createMockRequest('192.168.1.50'))).toBe(true);
      expect(isLanOperator(createMockRequest('172.20.1.2'))).toBe(true);
    });

    it('authorizes native IPv6 link-local and ULA addresses', () => {
      expect(isLanOperator(createMockRequest('fe80::ac3a:e2ff:fe98:99dd'))).toBe(true);
      expect(isLanOperator(createMockRequest('fe80::1%enP8p1s0'))).toBe(true);
      expect(isLanOperator(createMockRequest('fd12:3456:789a::1'))).toBe(true);
      expect(isLanOperator(createMockRequest('::1'))).toBe(true);
    });

    it('rejects public IPv4 and IPv6 requests', () => {
      expect(isLanOperator(createMockRequest('203.0.113.195'))).toBe(false);
      expect(isLanOperator(createMockRequest('2001:db8::1'))).toBe(false);
    });

    it('fails closed if remoteAddress is missing or undefined', () => {
      expect(isLanOperator(createMockRequest(undefined))).toBe(false);
      expect(isLanOperator(createMockRequest(''))).toBe(false);
    });
  });

  describe('BeyondCorp Zero-Trust Enforcement Invariant', () => {
    it('completely disables LAN IP bypass when GOOGLE_CLIENT_ID is configured', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'mock-corp-client-id.apps.googleusercontent.com';

      // When OAuth is configured, network locality CANNOT be conflated with identity
      expect(isLanOperator(createMockRequest('127.0.0.1'))).toBe(false);
      expect(isLanOperator(createMockRequest('10.0.0.15'))).toBe(false);
      expect(isLanOperator(createMockRequest('192.168.1.1'))).toBe(false);
      expect(isLanOperator(createMockRequest('fe80::1'))).toBe(false);
      expect(isLanOperator(createMockRequest('::1'))).toBe(false);
      expect(isLanOperator(createMockRequest('::ffff:10.0.0.15'))).toBe(false);
    });
  });
});
