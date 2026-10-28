import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/analyze-arp-capture.py');
const run = (text: string) => JSON.parse(execFileSync('python3', [SCRIPT], { input: text, encoding: 'utf8' }));

const REQ = '2026-10-26 12:47:17.597568 28:94:01:8b:70:e5 > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Request who-has 192.168.0.254 tell 192.168.0.240, length 46';
const GARP = '2026-10-26 17:50:47.100000 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 42: Request who-has 10.0.2.52 tell 10.0.2.52, length 28';
const MAC_ANNOUNCE = '2026-10-26 17:50:49.207227 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Announcement 10.0.2.52, length 46';
const REPLY = '2026-10-26 17:51:00.000000 aa:bb:cc:dd:ee:ff > b8:27:eb:79:ff:0a, ethertype ARP (0x0806), length 60: Reply 10.0.2.1 is-at aa:bb:cc:dd:ee:ff, length 46';
const IPV4 = '2026-10-26 17:52:00.000000 aa:bb:cc:dd:ee:ff > 11:22:33:44:55:66, ethertype IPv4 (0x0800), length 74: 10.0.2.1 > 10.0.2.50: ICMP echo request';

describe('analyze-arp-capture', () => {
  it('counts distinct senders, requests and replies exactly, with first and last time', () => {
    const s = run([REQ, REQ, GARP, REPLY, REQ].join('\n') + '\n');
    expect(s.frames).toBe(5);
    expect(s.arpFrames).toBe(5);
    const nets = s.senders.find((x: any) => x.senderIp === '192.168.0.240');
    expect(nets).toMatchObject({ count: 3, kind: 'request', target: '192.168.0.254', senderMac: '28:94:01:8b:70:e5' });
    expect(s.senders.find((x: any) => x.kind === 'reply')).toMatchObject({ senderIp: '10.0.2.1', target: 'aa:bb:cc:dd:ee:ff', count: 1 });
    expect(s.senders.find((x: any) => x.senderIp === '10.0.2.52')).toMatchObject({ kind: 'announcement', target: '10.0.2.52', count: 1 });
    expect(s.distinctKinds).toBe(3);
  });

  it('classifies an announcement the same way whether Linux words it as a request or macOS as "Announcement"', () => {
    const linux = run(GARP + '\n');
    const mac = run(MAC_ANNOUNCE + '\n');
    expect(linux.senders[0]).toMatchObject({ kind: 'announcement', senderIp: '10.0.2.52', target: '10.0.2.52' });
    expect(mac.senders[0]).toMatchObject({ kind: 'announcement', senderIp: '10.0.2.52', target: '10.0.2.52' });
    // a request for another address from the same sender is still a request
    const other = run('2026-10-26 17:50:47.1 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 42: Request who-has 10.0.2.50 tell 10.0.2.52, length 28\n');
    expect(other.senders[0]).toMatchObject({ kind: 'request', target: '10.0.2.50' });
  });

  it('reports a non-ARP line instead of dropping it, and does not count it as ARP', () => {
    const s = run([REQ, IPV4].join('\n') + '\n');
    expect(s.frames).toBe(2);
    expect(s.arpFrames).toBe(1);
    expect(Object.keys(s.nonArpLines)).toHaveLength(1);
  });

  it('gives an empty summary for an empty capture, and counts frames per hour', () => {
    expect(run('')).toMatchObject({ frames: 0, arpFrames: 0, senders: [] });
    const s = run([REQ, GARP, REPLY].join('\n') + '\n');
    expect(s.framesPerHour).toEqual({ '2026-10-26 12': 1, '2026-10-26 17': 2 });
  });
});
