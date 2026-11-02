/**
 * table-miss-extended.test.ts
 * Offline checks of scripts/table_miss_lib.py (frame classes, per-class filters, counting, the expectation per table-miss state, and the abort logic of the load test) and of the
 * refusals of scripts/table-miss-traffic.py and scripts/table-miss-load.py. Nothing here touches hardware: the scripts are only run on arguments they refuse before any ssh.
 * The expected frame bytes are built here, independently of the Python, from the layouts in the standards (IEEE 802.3, 802.1Q, 802.1AB, 802.1D, RFC 791, RFC 826, RFC 8200).
 * What this proves: the bytes, filters and decisions are what the pre-registration says. It does not prove what any frame does on the switch.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const LIB = path.resolve(__dirname, '../../scripts/table_miss_lib.py');
const TRAFFIC = path.resolve(__dirname, '../../scripts/table-miss-traffic.py');
const LOAD = path.resolve(__dirname, '../../scripts/table-miss-load.py');
const py = <T>(cmd: string, input?: unknown): T => JSON.parse(execFileSync('python3', [LIB, cmd], { input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8' })) as T;

interface Dump { classes: Record<string, { src: string; bpf: string; frames: string[]; forwardConfidence: string }>; captureFilter: string; legacy0: string; schedule: Array<[string, number]> }
const dump = py<Dump>('dump');

const mac = (t: string): Buffer => Buffer.from(t.replace(/:/g, ''), 'hex');
const DST = '02:00:00:00:be:ef';
const tag = (n: number): Buffer => Buffer.from(`zodiac-table-miss-traffic ${String(n).padStart(4, '0')}`);
const pad = (b: Buffer, n: number): Buffer => (b.length >= n ? b : Buffer.concat([b, Buffer.alloc(n - b.length)]));
const fill = (b: Buffer, n: number, ch: string): Buffer => (b.length >= n ? b : Buffer.concat([b, Buffer.alloc(n - b.length, ch)]));
const be16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const be32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const eth = (dst: string, src: string, type: number, payload: Buffer): Buffer => Buffer.concat([mac(dst), mac(src), be16(type), payload]);
const ip = (t: string): Buffer => Buffer.from(t.split('.').map(Number));
const csum = (h: Buffer): number => { let s = 0; for (let i = 0; i < h.length; i += 2) s += h.readUInt16BE(i); while (s > 0xffff) s = (s & 0xffff) + (s >>> 16); return ~s & 0xffff; };

const expectedFrame = (cls: string, n: number): Buffer => {
  const src = dump.classes[cls]?.src ?? '';
  switch (cls) {
    case 'experimental': return eth(DST, src, 0x88b5, fill(tag(n), 46, '.'));
    case 'ipv6': {
      const payload = tag(n).subarray(0, 8);
      const h = Buffer.concat([be32(0x60000000), be16(payload.length), Buffer.from([59, 64]), Buffer.from('20010db8000000000000000000000077', 'hex'), Buffer.from('20010db80000000000000000000000ef', 'hex')]);
      return pad(eth(DST, src, 0x86dd, Buffer.concat([h, payload])), 60);
    }
    case 'vlan-tagged': return eth(DST, src, 0x8100, Buffer.concat([be16(100), be16(0x88b5), fill(tag(n), 42, '.')]));
    case 'lldp': return pad(eth('01:80:c2:00:00:0e', src, 0x88cc, Buffer.concat([be16(0x0207), Buffer.from([4]), mac(src), be16(0x0407), Buffer.from([3]), mac(src), be16(0x0602), be16(120), be16(0)])), 60);
    case 'stp-bpdu': {
      const bid = Buffer.concat([be16(0xf000), mac(src)]);
      const bpdu = Buffer.concat([Buffer.alloc(5), bid, be32(0), bid, be16(0x8001), be16(0), be16(20 * 256), be16(2 * 256), be16(15 * 256)]);
      const body = Buffer.concat([Buffer.from([0x42, 0x42, 0x03]), bpdu]);
      return pad(Buffer.concat([mac('01:80:c2:00:00:00'), mac(src), be16(body.length), body]), 60);
    }
    case 'runt': return eth(DST, src, 0x88b5, tag(n).subarray(0, 4));
    case 'near-mtu': return eth(DST, src, 0x88b5, fill(tag(n), 1500, '.'));
    case 'ipv4-outside-segment': {
      const payload = tag(n).subarray(0, 18);
      const udp = Buffer.concat([be16(41951), be16(41951), be16(8 + payload.length), be16(0), payload]);
      const head = Buffer.concat([Buffer.from([0x45, 0]), be16(20 + udp.length), be16(n), be16(0), Buffer.from([64, 17]), be16(0), ip('192.0.2.77'), ip('198.51.100.7')]);
      head.writeUInt16BE(csum(head), 10);
      return pad(eth(DST, src, 0x0800, Buffer.concat([head, udp])), 60);
    }
    case 'arp-request': return pad(eth('ff:ff:ff:ff:ff:ff', src, 0x0806, Buffer.concat([be16(1), be16(0x0800), Buffer.from([6, 4]), be16(1), mac(src), ip('192.0.2.77'), Buffer.alloc(6), ip('192.0.2.78')])), 60);
    default: throw new Error(`no expectation written for class ${cls}`);
  }
};

describe('the frame classes', () => {
  it('has exactly the nine classes asked for, each with its own source MAC', () => {
    expect(Object.keys(dump.classes)).toEqual(['experimental', 'ipv6', 'vlan-tagged', 'lldp', 'stp-bpdu', 'runt', 'near-mtu', 'ipv4-outside-segment', 'arp-request']);
    const macs = Object.values(dump.classes).map((c) => c.src);
    expect(new Set(macs).size).toBe(macs.length);
    for (const m of macs) expect(m).toMatch(/^02:00:00:00:00:7[0-9]$/); // locally administered unicast
  });

  for (const cls of ['experimental', 'ipv6', 'vlan-tagged', 'lldp', 'stp-bpdu', 'runt', 'near-mtu', 'ipv4-outside-segment', 'arp-request']) {
    it(`${cls}: the Python frame is byte-for-byte the frame built here from the standards (three sequence numbers)`, () => {
      const frames = dump.classes[cls]?.frames ?? [];
      expect(frames).toHaveLength(3);
      frames.forEach((hex, n) => expect(hex, `${cls} #${n}`).toBe(expectedFrame(cls, n).toString('hex')));
    });
  }

  it('has the lengths the classes are named for: 60-byte minimum frames, an 18-byte runt, a 1514-byte near-MTU frame, a 62-byte IPv6 frame', () => {
    const len = (c: string): number => (dump.classes[c]?.frames[0]?.length ?? 0) / 2;
    expect([len('experimental'), len('vlan-tagged'), len('lldp'), len('stp-bpdu'), len('ipv4-outside-segment'), len('arp-request')]).toEqual([60, 60, 60, 60, 60, 60]);
    expect([len('runt'), len('near-mtu'), len('ipv6')]).toEqual([18, 1514, 62]);
  });

  it('keeps the original class byte-for-byte the frame the script has always sent (ethertype 0x88b5, source 02:00:00:00:00:77, payload padded with dots to 46 bytes)', () => {
    expect(dump.legacy0).toBe(Buffer.concat([mac('02:00:00:00:be:ef'), mac('02:00:00:00:00:77'), Buffer.from('88b5', 'hex'), Buffer.from('zodiac-table-miss-traffic 0000'.padEnd(46, '.'))]).toString('hex'));
  });

  it('sends no frame that a rule of the isolation policy could match from P2: no IPv4 to 10.0.2.0/24, and the only ARP is from the uplink with an empty peer list', () => {
    const ipv4 = Buffer.from(dump.classes['ipv4-outside-segment']?.frames[0] ?? '', 'hex');
    const dst = ipv4.subarray(30, 34);
    expect([...dst]).toEqual([198, 51, 100, 7]);
    expect(dst[0] === 10 && dst[1] === 0 && dst[2] === 2).toBe(false);
  });

  it('interleaves the classes by round, so no class is sent as one burst', () => {
    expect(dump.schedule.map(([c]) => c).slice(0, 9)).toEqual(Object.keys(dump.classes));
    expect(dump.schedule.map(([, n]) => n)).toEqual([...Array(9).fill(0), ...Array(9).fill(1)]);
  });
});

describe('the per-class filters and the counting', () => {
  it('every class has its own filter naming its own source MAC and its own protocol; the combined filter holds them all, the vlan class last', () => {
    for (const [name, c] of Object.entries(dump.classes)) {
      expect(c.bpf, name).toContain(`ether src ${c.src}`);
      expect(dump.captureFilter, name).toContain(`(${c.bpf})`);
    }
    expect(dump.classes['vlan-tagged']?.bpf).toContain('vlan 100');
    expect(dump.classes['stp-bpdu']?.bpf).toContain('ether dst 01:80:c2:00:00:00');
    expect(dump.classes['ipv4-outside-segment']?.bpf).toContain('ip dst 198.51.100.7');
    expect(dump.classes['arp-request']?.bpf).toContain('arp');
    // libpcap's `vlan` shifts the offsets of what follows it, so it must come after every other clause
    expect(dump.captureFilter.lastIndexOf('vlan')).toBeGreaterThan(dump.captureFilter.lastIndexOf('ether proto 0x88cc'));
    expect(dump.captureFilter.endsWith(`(${dump.classes['vlan-tagged']?.bpf ?? ''})`)).toBe(true);
  });

  const L = (src: string, dst: string, len: number, rest = 'ethertype Unknown (0x88b5)'): string => `15:30:01.123456 ${src} > ${dst}, ${rest}, length ${len}: x`;
  it('counts frames per source MAC from tcpdump -e text, with the lengths printed, and ignores lines that are not frame lines', () => {
    const text = [
      L('02:00:00:00:00:77', DST, 60), L('02:00:00:00:00:77', DST, 60), L('02:00:00:00:00:75', DST, 60), // a runt padded to 60 on the wire
      L('02:00:00:00:00:74', '01:80:c2:00:00:00', 52, '802.3'),
      '15:30:02.000000 02:00:00:00:00:72 > 02:00:00:00:be:ef, ethertype 802.1Q (0x8100), length 64: vlan 100, p 0, ethertype Unknown (0x88b5), x',
      'tcpdump: listening on eth0, link-type EN10MB', '', '    continuation line without a timestamp',
    ].join('\n');
    const r = py<Record<string, { count: number; lengths: Record<string, number> }>>('parse', { text, names: ['experimental', 'runt', 'stp-bpdu', 'vlan-tagged', 'lldp'] });
    expect(r['experimental']).toEqual({ count: 2, lengths: { '60': 2 } });
    expect(r['runt']).toEqual({ count: 1, lengths: { '60': 1 } });
    expect(r['stp-bpdu']).toEqual({ count: 1, lengths: { '52': 1 } });
    expect(r['vlan-tagged']).toEqual({ count: 1, lengths: { '64': 1 } });
    expect(r['lldp']).toEqual({ count: 0, lengths: {} });
  });
});

type Counts = Record<string, { O3: number; O2: number; O4: number }>;
interface Judged { breach: boolean; valid_classes: string[]; classes: Record<string, { verdict: string; expected: { O3: number; O2: number; O4: number; confidence: string } }> }
const judge = (state: string, counts: Counts): Judged => py<Judged>('judge', { state, counts, n: 20 });

describe('the expectation per state, and the judge', () => {
  it('predicts: control exact in every state, nothing out of P3 or P1 unless the table-miss forwards, and then 20 out of P3 and still none out of P1', () => {
    for (const s of ['drop', 'absent', 'unrecognised']) {
      const j = judge(s, { ipv6: { O3: 20, O2: 0, O4: 0 } });
      expect(j.classes['ipv6']?.expected).toMatchObject({ O3: 20, O2: 0, O4: 0 });
    }
    expect(judge('forwards', { ipv6: { O3: 20, O2: 20, O4: 0 } }).classes['ipv6']?.expected).toMatchObject({ O3: 20, O2: 20, O4: 0, confidence: 'medium' });
    expect(judge('forwards', { lldp: { O3: 20, O2: 20, O4: 0 } }).classes['lldp']?.expected.confidence).toBe('low');
  });

  it('can reject: a control that is not exact makes the class invalid; a frame out of P1 or a leak out of P3 is a breach; a forwarding state that does not forward is a finding, not a breach', () => {
    expect(judge('drop', { ipv6: { O3: 19, O2: 0, O4: 0 } }).classes['ipv6']?.verdict).toBe('control_failed');
    expect(judge('drop', { ipv6: { O3: 21, O2: 0, O4: 0 } }).classes['ipv6']?.verdict).toBe('control_failed');
    expect(judge('drop', { ipv6: { O3: 0, O2: 0, O4: 0 } }).valid_classes).toEqual([]);
    expect(judge('drop', { ipv6: { O3: 20, O2: 0, O4: 1 } })).toMatchObject({ breach: true, classes: { ipv6: { verdict: 'workload_reach' } } });
    expect(judge('forwards', { ipv6: { O3: 20, O2: 20, O4: 1 } }).classes['ipv6']?.verdict).toBe('workload_reach'); // the forward goes to P3 only
    expect(judge('absent', { ipv6: { O3: 20, O2: 1, O4: 0 } })).toMatchObject({ breach: true, classes: { ipv6: { verdict: 'leak' } } });
    expect(judge('unrecognised', { ipv6: { O3: 20, O2: 20, O4: 0 } }).breach).toBe(true);
    expect(judge('forwards', { ipv6: { O3: 20, O2: 0, O4: 0 } })).toMatchObject({ breach: false, classes: { ipv6: { verdict: 'forwarding_differs' } } });
    expect(judge('forwards', { ipv6: { O3: 20, O2: 20, O4: 0 } })).toMatchObject({ breach: false, classes: { ipv6: { verdict: 'as_predicted' } } });
    expect(judge('drop', { ipv6: { O3: 20, O2: 0, O4: 0 } })).toMatchObject({ breach: false, classes: { ipv6: { verdict: 'as_predicted' } } });
  });
});

describe('the load plan and its limits', () => {
  const plan = (state: string, rates: number[], stepSeconds: number): { ok: boolean; totalSeconds?: number; error?: string } => py('plan', { state, rates, stepSeconds });

  it('accepts the stepped plan of the pre-registration for drop and forwards, and counts its seconds (5 steps of 10 s plus 8 s of overhead each, and 4 pauses of 3 s)', () => {
    expect(plan('drop', [500, 1000, 2000, 4000, 8000], 10)).toEqual({ ok: true, totalSeconds: 102 });
    expect(plan('forwards', [500, 1000, 2000, 4000, 8000], 10).ok).toBe(true);
    expect(plan('unrecognised', [500, 1000, 2000, 4000], 10).ok).toBe(true);
    expect(plan('absent', [500, 1000, 2000], 10).ok).toBe(true);
  });

  it('refuses a rate above the limit for the state (the hard maximum is 8000), a non-increasing or non-positive ladder, a step outside 5 to 10 s, too many steps, an unknown state', () => {
    expect(plan('drop', [500, 8001], 10).error).toContain('above the 8000 pps limit');
    expect(plan('drop', [500, 16000], 10).ok).toBe(false);
    expect(plan('unrecognised', [500, 8000], 10).error).toContain('4000 pps limit');
    expect(plan('absent', [500, 4000], 10).error).toContain('2000 pps limit');
    expect(plan('drop', [1000, 1000], 10).error).toContain('strictly increasing');
    expect(plan('drop', [2000, 1000], 10).ok).toBe(false);
    expect(plan('drop', [0, 1000], 10).ok).toBe(false);
    expect(plan('drop', [], 10).ok).toBe(false);
    expect(plan('drop', [500], 4).error).toContain('5 to 10 s');
    expect(plan('drop', [500], 11).ok).toBe(false);
    expect(plan('drop', [1, 2, 3, 4, 5, 6, 7], 5).error).toContain('between 1 and 6 steps');
    expect(plan('bogus', [500], 10).ok).toBe(false);
    expect(plan('drop', [500, 1000, 2000, 4000, 6000, 8000], 10).error).toContain('120 s limit'); // 6 x 18 + 5 x 3 = 123 s
  });

  it('refuses before any ssh: both scripts print a refusal and exit 2 for a plan or class they do not accept', () => {
    const run = (script: string, args: string[]): { status: number | null; out: string } => { const r = spawnSync('python3', [script, ...args], { encoding: 'utf8', timeout: 20_000 }); return { status: r.status, out: r.stdout }; };
    expect(run(LOAD, ['x', '--state', 'forwards', '--rates', '500,9000'])).toMatchObject({ status: 2 });
    expect(run(LOAD, ['x', '--state', 'absent', '--rates', '500,4000']).out).toContain('plan refused');
    expect(run(LOAD, ['x', '--rates', '500']).status).toBe(2); // no state
    expect(run(LOAD, ['x', '--state', 'forwards', '--rates', '500', '--step-seconds', '30']).status).toBe(2);
    expect(run(TRAFFIC, ['x', '--classes', 'bogus', '--state', 'drop'])).toMatchObject({ status: 2 });
    expect(run(TRAFFIC, ['x', '--classes', 'all']).out).toContain('--state is required');
  });
});

interface Sample { ok: boolean; error?: string; isolation_state?: string; table_miss?: string | null; checked_age_ms?: number | null; openflow?: string; of_messages?: number; sessions?: number; switch_errors?: number; copp_drops?: number; fault_ended?: number; epoch?: number; fault_active_epoch?: number | null }
type Abort = { code: string; text: string } | null;
const good = (over: Partial<Sample> = {}): Sample => ({ ok: true, isolation_state: 'verified', table_miss: 'drops', checked_age_ms: 5000, openflow: 'Connected', of_messages: 100, sessions: 1, switch_errors: 0, copp_drops: 0, fault_ended: 0, epoch: 1000, fault_active_epoch: null, ...over });
const monitor = (state: string, samples: Sample[], faultSeconds = 0): Abort[] => py<Abort[]>('monitor', { state, samples, faultSeconds });

describe('the load abort logic (each sign of trouble stops the run, with its reason)', () => {
  it('lets a healthy run through: the baseline drop, and each fault state either before or after the first recheck', () => {
    expect(monitor('drop', [good(), good(), good()])).toEqual([null, null, null]);
    expect(monitor('forwards', [good({ fault_active_epoch: 900, epoch: 950 }), good({ isolation_state: 'mismatch', table_miss: 'forwards', fault_active_epoch: 900, epoch: 1000 })], 600)).toEqual([null, null]);
    expect(monitor('absent', [good({ isolation_state: 'mismatch', table_miss: 'absent', fault_active_epoch: 900, epoch: 950 })], 600)).toEqual([null]);
    expect(monitor('unrecognised', [good({ isolation_state: 'mismatch', table_miss: 'unrecognised', fault_active_epoch: 900, epoch: 950 })], 600)).toEqual([null]);
  });

  it('aborts when the switch session is not Connected, with that reason', () => {
    const r = monitor('drop', [good(), good({ openflow: 'Disconnected' })]);
    expect(r[0]).toBeNull();
    expect(r[1]?.code).toBe('session_not_connected');
    expect(r[1]?.text).toContain('Disconnected');
  });

  it('aborts when the bridge logged a new switch session (the session was lost and re-made), counted against the first sample, not against zero', () => {
    const r = monitor('drop', [good({ sessions: 3 }), good({ sessions: 3 }), good({ sessions: 4 })]);
    expect(r.map((a) => a?.code ?? null)).toEqual([null, null, 'session_restarted']);
  });

  it('aborts on an OFPT_ERROR logged during the load, but not on one that was already there before it started', () => {
    expect(monitor('drop', [good({ switch_errors: 2 }), good({ switch_errors: 2 }), good({ switch_errors: 3 })]).map((a) => a?.code ?? null)).toEqual([null, null, 'switch_error']);
  });

  it('aborts when the bridge logs a CoPP rate limit on packet-ins (the switch is punting unmatched frames to the controller), counted from the first sample', () => {
    expect(monitor('drop', [good({ copp_drops: 3 }), good({ copp_drops: 3 }), good({ copp_drops: 4 })]).map((x) => x?.code ?? null)).toEqual([null, null, 'packet_in_flood']);
    const a = (n: number): Sample => good({ isolation_state: 'mismatch', table_miss: 'absent', fault_active_epoch: 900, epoch: 950, copp_drops: n });
    expect(monitor('absent', [a(0), a(0), a(2)], 600).map((x) => x?.code ?? null)).toEqual([null, null, 'packet_in_flood']);
  });

  it('aborts when the fault ended or was cancelled under a fault state, but a drop run has no fault to end', () => {
    const f = (n: number): Sample => good({ isolation_state: 'mismatch', table_miss: 'forwards', fault_active_epoch: 900, epoch: 950, fault_ended: n });
    expect(monitor('forwards', [f(0), f(1)], 600).map((a) => a?.code ?? null)).toEqual([null, 'fault_ended']);
    expect(monitor('drop', [good({ fault_ended: 0 }), good({ fault_ended: 1 })])[1]).toBeNull();
  });

  it('aborts on an isolation status the state does not expect: readback_failed, a different table-miss class, a verified status with a forwarding fault only if the class is wrong', () => {
    const base = { fault_active_epoch: 900, epoch: 950 };
    expect(monitor('forwards', [good(base), good({ ...base, isolation_state: 'readback_failed', table_miss: null })], 600)[1]?.code).toBe('isolation_unexpected');
    expect(monitor('forwards', [good(base), good({ ...base, isolation_state: 'mismatch', table_miss: 'absent' })], 600)[1]?.code).toBe('isolation_unexpected');
    expect(monitor('drop', [good(), good({ isolation_state: 'mismatch', table_miss: 'forwards' })])[1]?.code).toBe('isolation_unexpected');
    expect(monitor('drop', [good(), good({ isolation_state: 'pending_readback', table_miss: null })])[1]?.code).toBe('isolation_unexpected');
    expect(monitor('absent', [good(base), good({ ...base, isolation_state: 'mismatch', table_miss: 'unrecognised' })], 600)[1]?.code).toBe('isolation_unexpected');
  });

  it('tolerates one unreadable poll and aborts on two in a row; a good poll in between resets the count', () => {
    const bad: Sample = { ok: false, error: 'the poll timed out after 20 s' };
    expect(monitor('drop', [good(), bad, good(), bad, good()])).toEqual([null, null, null, null, null]);
    const r = monitor('drop', [good(), bad, bad]);
    expect(r[1]).toBeNull();
    expect(r[2]?.code).toBe('poll_failed');
    expect(r[2]?.text).toContain('timed out');
  });

  it('aborts when too little of the fault time limit is left, so a step cannot straddle the revert', () => {
    const at = (left: number): Sample => good({ isolation_state: 'mismatch', table_miss: 'forwards', fault_active_epoch: 1000, epoch: 1000 + 600 - left });
    expect(monitor('forwards', [at(100), at(31)], 600).map((a) => a?.code ?? null)).toEqual([null, null]);
    expect(monitor('forwards', [at(100), at(29)], 600)[1]?.code).toBe('fault_time_low');
  });

  it('does not invent a time left: without an active-fault epoch the time check stays silent (the load script itself refuses to start a fault state without one)', () => {
    expect(monitor('forwards', [good({ isolation_state: 'mismatch', table_miss: 'forwards', fault_active_epoch: null })], 600)).toEqual([null]);
  });
});

describe('the load step arithmetic', () => {
  interface Step { judge: { verdict: string; breach: boolean }; delivered: number; senderLimited: boolean }
  const step = (o: { state: string; sent: number; observed: { O3: number; O2: number; O4: number }; series?: Array<[number, number]>; idlePps?: number; elapsedNs?: number; targetPps?: number }): Step =>
    py<Step>('step', { series: [], idlePps: 0, elapsedNs: 10_000_000_000, targetPps: 1000, ...o });

  it('corrects an observer count for its idle rate, in integers and never below zero', () => {
    expect(step({ state: 'drop', sent: 1, observed: { O3: 1, O2: 0, O4: 0 }, series: [[0, 1000], [10_000_000_000, 11_300]], idlePps: 30 }).delivered).toBe(10_000);
    expect(step({ state: 'drop', sent: 1, observed: { O3: 1, O2: 0, O4: 0 }, series: [[0, 1000], [10_000_000_000, 1100]], idlePps: 30 }).delivered).toBe(0);
    expect(step({ state: 'drop', sent: 1, observed: { O3: 1, O2: 0, O4: 0 }, series: [[0, 5]], idlePps: 0 }).delivered).toBe(0);
  });

  it('judges a step: the control must see 97% of the frames sent; a drop state must show no frame out of P3 or P1; a forwarding state must show 97% out of P3', () => {
    const v = (state: string, o3: number, o2: number, o4: number): string => step({ state, sent: 10_000, observed: { O3: o3, O2: o2, O4: o4 } }).judge.verdict;
    expect(v('drop', 9_699, 0, 0)).toBe('control_failed');
    expect(v('drop', 9_700, 0, 0)).toBe('as_predicted');
    expect(v('drop', 10_000, 3, 0)).toBe('as_predicted'); // within the 3-frame noise allowance
    expect(v('drop', 10_000, 4, 0)).toBe('leak');
    expect(v('absent', 10_000, 0, 4)).toBe('workload_reach');
    expect(v('forwards', 10_000, 10_000, 0)).toBe('as_predicted');
    expect(v('forwards', 10_000, 9_700, 0)).toBe('as_predicted');
    expect(v('forwards', 10_000, 9_699, 0)).toBe('tap_path_lossy');
    expect(v('forwards', 10_000, 10_000, 4)).toBe('workload_reach');
    expect(step({ state: 'drop', sent: 10_000, observed: { O3: 10_000, O2: 4, O4: 0 } }).judge.breach).toBe(true);
    expect(step({ state: 'forwards', sent: 10_000, observed: { O3: 10_000, O2: 100, O4: 0 } }).judge.breach).toBe(false); // lossy, not a breach
    expect(step({ state: 'drop', sent: 0, observed: { O3: 0, O2: 0, O4: 0 } }).judge.verdict).toBe('no_frames_sent');
  });

  it('flags a sender that did not reach 97% of the target rate, so the step is read as the sender and not the switch', () => {
    const limited = (sent: number, targetPps: number): boolean => step({ state: 'drop', sent, observed: { O3: sent, O2: 0, O4: 0 }, elapsedNs: 10_000_000_000, targetPps }).senderLimited;
    expect(limited(80_000, 8000)).toBe(false);
    expect(limited(77_600, 8000)).toBe(false);
    expect(limited(77_599, 8000)).toBe(true);
    expect(limited(0, 8000)).toBe(true);
  });
});

describe('reading one poll of the bridge', () => {
  const poll = (text: string): Sample => py<Sample>('poll', { text });
  const OK = '#epoch\n1793647900\n#flows\nmismatch forwards 12000\n#summary\nConnected 4521\n#journal\n1793647700.1 jetson zodiac-bridge[7]: [+] [Bridge Server] Table-Miss flow rule installed (DROP fail-closed).\n1793647750.5 jetson zodiac-bridge[7]: [!] [Fault] TEST FAULT ACTIVE (forward-to-tap): x\n';

  it('reads the epoch, the isolation status and its age, the OpenFlow status, the session count and the fault line', () => {
    expect(poll(OK)).toEqual({ ok: true, epoch: 1793647900, isolation_state: 'mismatch', table_miss: 'forwards', checked_age_ms: 12000, openflow: 'Connected', of_messages: 4521, sessions: 1, switch_errors: 0, copp_drops: 0, fault_ended: 0, fault_active_epoch: 1793647750 });
  });

  it('counts a second session line, an OFPT_ERROR and each way the fault can end', () => {
    const more = '1793647800.0 j z: [+] [Bridge Server] Table-Miss flow rule installed (DROP fail-closed).\n1793647801.0 j z: OFPT_ERROR xid 5: bad\n1793647802.0 j z: [!] [Fault] test fault ended: x\n1793647803.0 j z: [!] [Fault] pending test-fault revert cancelled: y\n1793647804.0 j z: [!] [Bridge Server] CoPP rate-limited OFPT_PACKET_IN (xid: 9, total drops: 5)\n';
    expect(poll(OK + more)).toMatchObject({ sessions: 2, switch_errors: 1, copp_drops: 1, fault_ended: 2 });
  });

  it('never guesses: a missing or malformed section is an unreadable poll, not a default', () => {
    expect(poll('').ok).toBe(false);
    expect(poll('#epoch\n1793647900\n#flows\n#summary\nConnected 4521\n#journal\n').ok).toBe(false); // the isolation line is empty
    expect(poll('#epoch\nabc\n#flows\nverified drops 1\n#summary\nConnected 4521\n').ok).toBe(false);
    expect(poll('#epoch\n1\n#flows\nverified drops\n#summary\nConnected 4521\n').ok).toBe(false); // two fields instead of three
    expect(poll('#epoch\n1\n#flows\nverified drops 1\n#summary\n#journal\n').ok).toBe(false); // no OpenFlow status
    expect(poll('#epoch\n1\n#flows\nverified drops 1\n#summary\nConnected\n#journal\n').ok).toBe(false); // no message count
  });
});

/** An observer counts only if its capture provably ran: structured remote results, a verified start, a summary that agrees with the lines, and a verdict that outranks control_failed. A fake ssh is scripted by rule. */
interface Rule { match: string; host?: string; rc?: number; out?: string; err?: string; times?: number; raise?: string }
const OBS = { O3_p2_mirror: ['jetson', 'ifa', false], O4_node01_eth0: ['agentic-node-01', 'eth0', true] };
const observe = <T>(op: string, rules: Rule[], extra: Record<string, unknown> = {}, observers: Record<string, unknown[]> = OBS): T => py<T>('observe', { op, rules, observers, ...extra });
const FRAME = (n: number): string => `15:30:0${n}.123456 02:00:00:00:00:77 > 02:00:00:00:be:ef, ethertype Unknown (0x88b5), length 60: x`;
const ERR = (n: number, extra = ''): string => `tcpdump: listening on ifa, link-type EN10MB\n${n} packets captured\n${n} packets received by filter\n${extra || '0 packets dropped by kernel'}\n`;

describe('(a) every remote command returns a structured result, never an empty string for a failure', () => {
  const run = (rule: Rule): { ok: boolean; rc: number | null; out: string; reason: string } => observe('cmd', [rule], { cmd: 'echo hi' });
  it('ok only for return code 0', () => { expect(run({ match: 'echo', out: 'hi\n' })).toMatchObject({ ok: true, rc: 0, out: 'hi\n' }); });
  it('a failed command, a refused sudo and an unreachable host are failures with their reason', () => {
    expect(run({ match: 'echo', rc: 1, err: 'sudo: a password is required' })).toMatchObject({ ok: false, rc: 1, out: '' });
    expect(run({ match: 'echo', rc: 1, err: 'sudo: a password is required' }).reason).toContain('a password is required');
    expect(run({ match: 'echo', rc: 255, err: 'ssh: connect to host x port 22: No route' }).reason).toContain('exit 255');
    expect(run({ match: 'nothing-matches' })).toMatchObject({ ok: false, rc: 255 });
  });
  it('a timeout is a failure, not an empty result', () => { expect(run({ match: 'echo', raise: 'timeout' })).toMatchObject({ ok: false, rc: null, out: '' }); });
});

describe('(b) each capture is verified listening before any frame is sent', () => {
  type Started = { result: Record<string, { listening: boolean; base: string; reason: string }>; calls: string[] };
  const listening = (host: string): Rule => ({ host, match: "grep -c 'listening on'", out: '1\n' });
  it('reports listening when the stderr file shows "listening on", and starts detached (setsid nohup) so ending the ssh session cannot kill it', () => {
    const r = observe<Started>('start', [{ match: 'rm -f' }, listening('jetson'), listening('agentic-node-01')]);
    expect(r.result['O3_p2_mirror']).toMatchObject({ listening: true, reason: '' });
    expect(r.result['O4_node01_eth0']?.listening).toBe(true);
    expect(r.calls.filter((c) => c.includes('tcpdump')).every((c) => c.includes('setsid nohup'))).toBe(true);
    expect(r.calls.find((c) => c.startsWith('agentic-node-01') && c.includes('tcpdump'))).toContain('sudo -n timeout');
  });
  it('a capture that never prints "listening on" is not listening, with the stderr it did print, after bounded checks', () => {
    const r = observe<Started>('start', [{ match: 'rm -f' }, listening('jetson'), { host: 'agentic-node-01', match: "grep -c 'listening on'", out: '0\n' }, { host: 'agentic-node-01', match: 'head -c 150', out: 'sudo: a password is required\n' }]);
    expect(r.result['O3_p2_mirror']?.listening).toBe(true);
    expect(r.result['O4_node01_eth0']).toMatchObject({ listening: false });
    expect(r.result['O4_node01_eth0']?.reason).toContain('never printed "listening on"');
    expect(r.result['O4_node01_eth0']?.reason).toContain('a password is required');
    expect(r.calls.filter((c) => c.startsWith('agentic-node-01') && c.includes("grep -c 'listening on'")).length).toBe(6); // 3 checks x 2 attempts: bounded
  });
  it('retries a failed start once, with a fresh file, and accepts it if the retry listens', () => {
    const r = observe<Started>('start', [{ host: 'jetson', match: 'rm -f', rc: 255, err: 'ssh: timeout', times: 1 }, { match: 'rm -f' }, listening('jetson'), listening('agentic-node-01')]);
    expect(r.result['O3_p2_mirror']).toMatchObject({ listening: true });
    expect(r.result['O3_p2_mirror']?.base).toMatch(/-retry$/);
  });
  it('gives up after the one retry and says why; an ssh failure or a refused sudo is "could not be started", never "listening"', () => {
    const r = observe<Started>('start', [{ host: 'jetson', match: 'rm -f', rc: 255, err: 'ssh: timeout' }, { host: 'agentic-node-01', match: 'rm -f', rc: 1, err: 'sudo: a password is required' }]);
    expect(r.result['O3_p2_mirror']).toMatchObject({ listening: false });
    expect(r.result['O3_p2_mirror']?.reason).toContain('could not be started');
    expect(r.result['O4_node01_eth0']?.reason).toContain('a password is required');
    expect(r.calls.filter((c) => c.startsWith('jetson') && c.includes('rm -f')).length).toBe(2);
  });
});

describe('(c) a count is taken only from a capture whose tcpdump summary is present, drop-free and equal to the line count', () => {
  type Read = { results: Record<string, { valid: boolean; reason: string; packets: number | null }>; invalid: Record<string, string>; counts: Record<string, number> };
  const cap = (host: string, err: string, text: string): Rule => ({ host, match: 'head -c 4000', out: `${err}#TXT#\n${text}` });
  const good = (host: string): Rule => cap(host, ERR(2), `${FRAME(1)}\n${FRAME(2)}\n`);
  it('accepts a capture whose summary equals its frame lines and counts it from the lines', () => {
    const r = observe<Read>('read', [good('jetson'), good('agentic-node-01')]);
    expect(r.invalid).toEqual({});
    expect(r.counts).toEqual({ O3_p2_mirror: 2, O4_node01_eth0: 2 });
    expect(r.results['O3_p2_mirror']).toMatchObject({ valid: true, packets: 2 });
  });
  it('a genuine zero is valid only with a summary that says 0 packets captured', () => {
    const r = observe<Read>('read', [cap('jetson', ERR(0), ''), good('agentic-node-01')]);
    expect(r.invalid).toEqual({});
    expect(r.counts['O3_p2_mirror']).toBe(0);
  });
  it('no summary (the capture never ran, or did not finish) is INVALID with the reason, not zero', () => {
    const r = observe<Read>('read', [cap('jetson', 'tcpdump: listening on ifa, link-type EN10MB\n', ''), good('agentic-node-01')]);
    expect(r.results['O3_p2_mirror']?.valid).toBe(false);
    expect(r.invalid['O3']).toContain('no "N packets captured" summary');
    expect(r.counts).not.toHaveProperty('O3_p2_mirror');
    expect(observe<Read>('read', [cap('jetson', '', ''), good('agentic-node-01')]).invalid['O3']).toContain('summary');
  });
  it('a summary that disagrees with the frame lines, in either direction, is INVALID', () => {
    expect(observe<Read>('read', [cap('jetson', ERR(3), `${FRAME(1)}\n${FRAME(2)}\n`), good('agentic-node-01')]).invalid['O3']).toContain('summary says 3 packets but the text has 2');
    expect(observe<Read>('read', [cap('jetson', ERR(1), `${FRAME(1)}\n${FRAME(2)}\n`), good('agentic-node-01')]).invalid['O3']).toContain('summary says 1 packets but the text has 2');
  });
  it('kernel drops make the capture INVALID even when the numbers agree', () => {
    expect(observe<Read>('read', [cap('jetson', ERR(2, '4 packets dropped by kernel'), `${FRAME(1)}\n${FRAME(2)}\n`), good('agentic-node-01')]).invalid['O3']).toContain('kernel dropped 4');
  });
  it('a capture that cannot be read at all (ssh failed, file missing) is INVALID, and two workload captures are one observer, invalid if either is', () => {
    const r = observe<Read>('read', [{ host: 'jetson', match: 'head -c 4000', rc: 1, err: 'head: cannot open' }, good('agentic-node-01')]);
    expect(r.invalid['O3']).toContain('could not be read');
    const obs = { O4_node01_eth0: ['agentic-node-01', 'eth0', true], O4_rpi_hailo_eth0: ['rpi-hailo', 'eth0', true] };
    const two = observe<Read>('read', [good('agentic-node-01'), { host: 'rpi-hailo', match: 'head -c 4000', rc: 255, err: 'ssh: timeout' }], {}, obs);
    expect(Object.keys(two.invalid)).toEqual(['O4']);
    expect(two.invalid['O4']).toContain('O4_rpi_hailo_eth0');
  });
});

describe('(d) an invalid observer makes the verdict observer_invalid, stronger than control_failed, and lists the reason', () => {
  const j = (counts: Counts, invalid: Record<string, string>): Judged & { invalid_observers: Record<string, string>; classes: Record<string, { verdict: string; observed: Record<string, number | null> }> } =>
    py('judge', { state: 'drop', counts, n: 20, invalid });
  it('outranks control_failed, workload_reach and leak, never counts as a breach, and shows the invalid observer as null, not 0', () => {
    const r = j({ ipv6: { O3: 19, O2: 5, O4: 0 }, lldp: { O3: 20, O2: 0, O4: 3 } }, { O4: 'O4_rpi_hailo_eth0: no "N packets captured" summary' });
    expect(r.classes['ipv6']?.verdict).toBe('observer_invalid');
    expect(r.classes['lldp']?.verdict).toBe('observer_invalid');
    expect(r.classes['lldp']?.observed).toEqual({ O3: 20, O2: 0, O4: null });
    expect(r.breach).toBe(false);
    expect(r.valid_classes).toEqual([]);
    expect(r.invalid_observers).toEqual({ O4: 'O4_rpi_hailo_eth0: no "N packets captured" summary' });
  });
  it('changes nothing when every observer is valid', () => {
    expect(j({ ipv6: { O3: 19, O2: 0, O4: 0 } }, {}).classes['ipv6']?.verdict).toBe('control_failed');
    expect(j({ ipv6: { O3: 20, O2: 0, O4: 1 } }, {}).classes['ipv6']?.verdict).toBe('workload_reach');
  });
});

describe('the workload-side observer of the class pass', () => {
  it('is rpi-hailo alone: agentic-node-01 has no tcpdump, so a node-01 capture could only ever read as a false zero', () => {
    const src = readFileSync('scripts/table-miss-traffic.py', 'utf-8');
    const line = src.split('\n').find((l) => l.startsWith('OBSERVERS = {')) ?? '';
    expect(line).toContain('O4_rpi_hailo_eth0');
    expect(line).not.toContain('node01');
    expect(line).not.toContain('NODE01');
  });
});

