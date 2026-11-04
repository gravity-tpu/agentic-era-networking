/**
 * test/invariants/workload-frames.test.ts
 * Scenario 5, narrowed (docs/benchmarks/results/scenario5-workload-frames/PREREGISTRATION.md): 18 frame classes sent from the workload side. These tests hold the code to the
 * registered table: ids, predictions, source MACs, the bytes of every class built here from the standards, the prediction evaluated against the six live policy rules, the
 * groups, and the judge. Nothing here touches a host: the python is run with a stub ssh first on PATH, so a call that is not scripted fails at once.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';

const LIB = fileURLToPath(new URL('../../scripts/workload_frames_lib.py', import.meta.url));

const withNoSsh = <T>(f: (env: NodeJS.ProcessEnv) => T): T => {
  const bin = mkdtempSync(path.join(tmpdir(), 'no-ssh-'));
  try {
    writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "ssh disabled in the offline tests" >&2\nexit 255\n');
    chmodSync(path.join(bin, 'ssh'), 0o755);
    return f({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};
const py = (cmd: string, stdin?: unknown): any =>
  withNoSsh((env) => JSON.parse(execFileSync('python3', ['-I', LIB, cmd], { encoding: 'utf-8', timeout: 30_000, env, ...(stdin === undefined ? {} : { input: JSON.stringify(stdin) }) })));

type Kind = 'control' | 'contained' | 'info';
interface Cls { id: string; name: string; kind: Kind; prediction: 'p2p3' | 'p3only' | 'info'; src: string; bpf: string; visible: { etherType: number; srcIp?: string; dstIp?: string; arpSpa?: string }; model_says: string; frame_hex: string; frame_hex_7: string }
const dump = py('dump') as { classes: Cls[]; groups: string[][]; frames_per_class: number };
const byId = (id: string): Cls => dump.classes.find((c) => c.id === id) as Cls;

// The registered table (PREREGISTRATION.md, "Classes"), written out here independently of the code.
const REGISTERED: Array<[string, string, 'p2p3' | 'p3only' | 'info']> = [
  ['C0', 'allow-ipv4-inside', 'p2p3'], ['C1', 'allow-arp-known-host', 'p2p3'],
  ['A1', 'experimental', 'p3only'], ['A2', 'ipv6', 'p3only'], ['A3', 'vlan-tagged', 'p3only'], ['A4', 'stp-bpdu', 'p3only'], ['A5', 'runt', 'p3only'], ['A6', 'near-mtu', 'p3only'],
  ['A7', 'arp-unknown-spa', 'p3only'], ['A8', 'lldp', 'p3only'],
  ['B1', 'ipv4-options-outside', 'p3only'], ['B2', 'ipv4-first-fragment-outside', 'p3only'], ['B3', 'ipv4-later-fragment-outside', 'p3only'], ['B4', 'vlan-ipv4-outside', 'p3only'], ['B5', 'ipv4-spoofed-source', 'p3only'],
  ['I1', 'vlan-ipv4-inside', 'info'], ['I2', 'ipv4-options-inside', 'info'], ['I3', 'ipv4-later-fragment-inside', 'info'],
];

describe('the registered table', () => {
  it('has the 18 classes of the pre-registration, in order, with its predictions', () => {
    expect(dump.classes.map((c) => [c.id, c.name, c.prediction])).toEqual(REGISTERED);
    expect(dump.frames_per_class).toBe(20);
  });

  it('gives each class its own source MAC from 02:00:00:00:00:80, in table order, and a filter that names only that MAC', () => {
    dump.classes.forEach((c, i) => {
      expect(c.src).toBe(`02:00:00:00:00:${(0x80 + i).toString(16)}`);
      expect(c.bpf).toBe(`ether src ${c.src}`);
    });
    expect(new Set(dump.classes.map((c) => c.src)).size).toBe(18);
  });

  it('sends in three groups, each opened by the two positive controls, so a breach stops the later groups; every other class is in exactly one group', () => {
    expect(dump.groups).toHaveLength(3);
    for (const g of dump.groups) expect(g.slice(0, 2)).toEqual(['C0', 'C1']);
    const rest = dump.groups.flatMap((g) => g.slice(2));
    expect([...rest].sort()).toEqual(REGISTERED.map((r) => r[0]).filter((id) => !id.startsWith('C')).sort());
    expect(dump.groups[0]!.slice(2)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
    expect(dump.groups[1]!.slice(2)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
    expect(dump.groups[2]!.slice(2)).toEqual(['I1', 'I2', 'I3']);
  });
});

// ---- bytes, built here from the standards ----------------------------------------------------------------------------------------------------------------
const mac = (t: string): number[] => t.split(':').map((x) => parseInt(x, 16));
const ip = (t: string): number[] => t.split('.').map((x) => parseInt(x, 10));
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const cksum = (h: number[]): number => {
  let s = 0;
  for (let i = 0; i < h.length; i += 2) s += (h[i]! << 8) | h[i + 1]!;
  while (s > 0xffff) s = (s & 0xffff) + (s >> 16);
  return ~s & 0xffff;
};
const pad60 = (b: number[]): number[] => (b.length >= 60 ? b : [...b, ...new Array(60 - b.length).fill(0)]);
const hex = (b: number[]): string => Buffer.from(b).toString('hex');
const payload = (n: number): number[] => [...Buffer.from(`wf ${String(n).padStart(4, '0')}`.padEnd(16, ' '), 'ascii')];
const IP_SENDER = '10.0.2.52', IP_INSIDE = '10.0.2.50', IP_OUTSIDE = '198.51.100.7', IP_SPOOF = '192.0.2.77', IP_UNKNOWN = '10.0.2.77', IP_ARP_TARGET = '10.0.2.1';
const BCAST = 'ff:ff:ff:ff:ff:ff';

const ipv4Packet = (src: string, dst: string, n: number, o: { options?: number[]; flagsFrag?: number; udp?: boolean } = {}): number[] => {
  const options = o.options ?? [];
  const l4 = (o.udp ?? true) ? [...be16(40000), ...be16(9), ...be16(8 + 16), 0, 0, ...payload(n)] : payload(n);
  const ihl = 5 + options.length / 4;
  const head = [(4 << 4) | ihl, 0, ...be16(ihl * 4 + l4.length), ...be16(n & 0xffff), ...be16(o.flagsFrag ?? 0), 64, 17, 0, 0, ...ip(src), ...ip(dst), ...options];
  const c = cksum(head);
  head[10] = c >> 8; head[11] = c & 0xff;
  return [...head, ...l4];
};
const arpRequest = (srcMac: string, spa: string, tpa: string): number[] =>
  [...be16(1), ...be16(0x0800), 6, 4, ...be16(1), ...mac(srcMac), ...ip(spa), 0, 0, 0, 0, 0, 0, ...ip(tpa)];
const frame = (srcMac: string, ethertype: number, body: number[]): number[] => pad60([...mac(BCAST), ...mac(srcMac), ...be16(ethertype), ...body]);
const tagged = (srcMac: string, inner: number, body: number[]): number[] => pad60([...mac(BCAST), ...mac(srcMac), ...be16(0x8100), ...be16(100), ...be16(inner), ...body]);
const NOPS = [1, 1, 1, 0];  // NOP, NOP, NOP, end of options: IHL 6
const MF = 0x2000, LATER = 185;  // more-fragments flag; offset 185 x 8 = 1480

const expected = (id: string, n: number): number[] => {
  const s = byId(id).src;
  switch (id) {
    case 'C0': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_INSIDE, n));
    case 'C1': return frame(s, 0x0806, arpRequest(s, IP_SENDER, IP_ARP_TARGET));
    case 'A7': return frame(s, 0x0806, arpRequest(s, IP_UNKNOWN, IP_ARP_TARGET));
    case 'B1': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_OUTSIDE, n, { options: NOPS }));
    case 'B2': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_OUTSIDE, n, { flagsFrag: MF }));
    case 'B3': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_OUTSIDE, n, { flagsFrag: LATER, udp: false }));
    case 'B4': return tagged(s, 0x0800, ipv4Packet(IP_SENDER, IP_OUTSIDE, n));
    case 'B5': return frame(s, 0x0800, ipv4Packet(IP_SPOOF, IP_INSIDE, n));
    case 'I1': return tagged(s, 0x0800, ipv4Packet(IP_SENDER, IP_INSIDE, n));
    case 'I2': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_INSIDE, n, { options: NOPS }));
    case 'I3': return frame(s, 0x0800, ipv4Packet(IP_SENDER, IP_INSIDE, n, { flagsFrag: LATER, udp: false }));
    default: throw new Error(id);
  }
};

describe('frame bytes', () => {
  for (const id of ['C0', 'C1', 'A7', 'B1', 'B2', 'B3', 'B4', 'B5', 'I1', 'I2', 'I3']) {
    it(`${id} ${byId(id).name} equals the frame written out here from the standards (sequence numbers 0 and 7)`, () => {
      expect(byId(id).frame_hex).toBe(hex(expected(id, 0)));
      expect(byId(id).frame_hex_7).toBe(hex(expected(id, 7)));
    });
  }

  it('can fail: the checker tells an options frame from a plain one, and an offset-0 fragment from a later one', () => {
    expect(hex(expected('B1', 0))).not.toBe(hex(frame(byId('B1').src, 0x0800, ipv4Packet(IP_SENDER, IP_OUTSIDE, 0))));
    expect(hex(expected('B2', 0))).not.toBe(hex(expected('B3', 0)));
  });

  it('the reused classes carry their own source MAC at bytes 6 to 11 and the ethertype or tag they are named for', () => {
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A8']) {
      const b = Buffer.from(byId(id).frame_hex, 'hex');
      expect([...b.subarray(6, 12)]).toEqual(mac(byId(id).src));
    }
    const type = (id: string): number => Buffer.from(byId(id).frame_hex, 'hex').readUInt16BE(12);
    expect(type('A1')).toBe(0x88b5);
    expect(type('A2')).toBe(0x86dd);
    expect(type('A3')).toBe(0x8100);
    expect(type('A8')).toBe(0x88cc);
    expect(Buffer.from(byId('A6').frame_hex, 'hex').length).toBe(1514);
    expect(Buffer.from(byId('A5').frame_hex, 'hex').length).toBeLessThan(60);
  });
});

// ---- the prediction, evaluated against the six live rules --------------------------------------------------------------------------------------------------
const inPrefix = (addr: string | undefined, net: string, len: number | undefined): boolean => {
  if (net === undefined) return true;
  if (addr === undefined) return false;
  const a = ip(addr), n = ip(net), bits = len ?? 32;
  const toInt = (x: number[]): number => ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(a) & mask) === (toInt(n) & mask);
};
const evaluate = (v: Cls['visible']): string => {
  const rules = [...buildPort1IsolationPolicy(undefined, undefined, undefined, [])].filter((r) => r.flowMod.match?.inPort === 1).sort((x, y) => (y.flowMod.priority ?? 0) - (x.flowMod.priority ?? 0));
  for (const r of rules) {
    const m = r.flowMod.match as Record<string, any>;
    if (m.etherType !== undefined && m.etherType !== v.etherType) continue;
    if (m.arpSpa !== undefined && m.arpSpa !== v.arpSpa) continue;
    if (m.srcIp !== undefined && !inPrefix(v.srcIp, m.srcIp, m.srcIpPrefixLen)) continue;
    if (m.dstIp !== undefined && !inPrefix(v.dstIp, m.dstIp, m.dstIpPrefixLen)) continue;
    const out = r.flowMod.outputPorts ?? [];
    return out.includes(2) ? 'p2p3' : out.length === 1 && out[0] === 3 ? 'p3only' : `other:${out.join(',')}`;
  }
  return 'table-miss';
};

describe('the prediction against the policy', () => {
  it('every class with a firm prediction equals what the six live rules do with the fields the model sees (priority order, first match)', () => {
    for (const c of dump.classes) {
      if (c.prediction === 'info') continue;
      expect(evaluate(c.visible), `${c.id} ${c.name}`).toBe(c.prediction);
    }
  });

  it('records what the model says for the informational classes, and the code and this evaluator agree on it', () => {
    for (const id of ['I1', 'I2', 'I3']) expect(byId(id).model_says).toBe(evaluate(byId(id).visible));
    expect(byId('I2').model_says).toBe('p2p3');   // options and fragments are invisible to the model, so it sees plain in-segment IPv4
    expect(byId('I1').model_says).toBe('p3only'); // a strict parser sees the 0x8100 outer type, which no allow rule matches
  });

  it('can fail: the evaluator separates an allowed crossing from a tap-only class, and a policy that stopped being tap-only would break the table', () => {
    expect(evaluate(byId('C0').visible)).toBe('p2p3');
    expect(evaluate(byId('B5').visible)).toBe('p3only');
    expect(evaluate({ etherType: 0x0800, srcIp: '10.0.2.52', dstIp: '10.0.2.50' })).not.toBe(evaluate({ etherType: 0x0800, srcIp: '10.0.2.52', dstIp: '198.51.100.7' }));
  });
});

// ---- the judge ----------------------------------------------------------------------------------------------------------------------------------------------
const ALL = REGISTERED.map((r) => r[0]);
const clean = (ids: string[] = ALL): Record<string, { O3: number; O2: number }> =>
  Object.fromEntries(ids.map((id) => [id, { O3: byId(id).prediction === 'p2p3' ? 20 : 0, O2: 20 }]));
const judge = (counts: Record<string, { O3: number; O2: number }>, invalid: Record<string, string> = {}): any => py('judge', { counts, invalid, n: 20 });

describe('the judge', () => {
  it('a clean pass: controls as predicted, every tap-only class contained, informational classes recorded, no stop', () => {
    const j = judge({ ...clean(), I1: { O3: 0, O2: 20 }, I2: { O3: 20, O2: 20 }, I3: { O3: 0, O2: 20 } });
    expect(j.verdicts.C0).toBe('as_predicted');
    expect(j.verdicts.A1).toBe('contained');
    expect(j.verdicts.I1).toBe('observed_p3_only');
    expect(j.verdicts.I2).toBe('observed_p2_p3');
    expect(j).toMatchObject({ breaches: [], stop: false, void: false });
  });

  it('a P3-only class seen at O3 is a breach and stops the run, even for one frame', () => {
    const c = clean(); c.B4 = { O3: 1, O2: 20 };
    const j = judge(c);
    expect(j.verdicts.B4).toBe('breach');
    expect(j).toMatchObject({ breaches: ['B4'], stop: true });
  });

  it('frames at O3 for a class whose tap control failed are not read as contained: control_failed with the O3 count shown, and the run stops', () => {
    const c = clean(); c.A2 = { O3: 5, O2: 0 };
    const j = judge(c);
    expect(j.verdicts.A2).toBe('control_failed');
    expect(j.o3_frames).toEqual({ A2: 5 });
    expect(j.stop).toBe(true);
  });

  it('a class that did not reach the tap and shows nothing at O3 is control_failed and is not a result, but does not stop the run (a bridge may eat BPDU and LLDP)', () => {
    const c = clean(); c.A4 = { O3: 0, O2: 0 }; c.A8 = { O3: 0, O2: 0 };
    const j = judge(c);
    expect(j.verdicts.A4).toBe('control_failed');
    expect(j.verdicts.A8).toBe('control_failed');
    expect(j).toMatchObject({ breaches: [], stop: false, void: false });
  });

  it('a positive control that does not read exactly 20 at both observers voids the run', () => {
    for (const bad of [{ O3: 19, O2: 20 }, { O3: 20, O2: 19 }, { O3: 0, O2: 20 }]) {
      const c = clean(); c.C0 = bad;
      expect(judge(c), JSON.stringify(bad)).toMatchObject({ void: true, stop: true });
    }
    const c1 = clean(); c1.C1 = { O3: 0, O2: 20 };
    expect(judge(c1).void).toBe(true);
  });

  it('an invalid observer makes every class observer_invalid and the run void; nothing is contained', () => {
    for (const obs of ['O3', 'O2']) {
      const j = judge(clean(), { [obs]: 'the capture never ran' });
      expect(Object.values(j.verdicts).every((v) => v === 'observer_invalid')).toBe(true);
      expect(j).toMatchObject({ void: true, stop: true, breaches: [] });
    }
  });

  it('can fail: the same frames at O3 turn a contained verdict into a breach', () => {
    const c = clean();
    expect(judge(c).verdicts.B3).toBe('contained');
    c.B3 = { O3: 20, O2: 20 };
    expect(judge(c).verdicts.B3).toBe('breach');
  });
});

describe('the group runner, against a scripted ssh', () => {
  it('passes its own selftest: no frame is sent unless every observer is listening, a breach stops later groups, a quarantine appearing voids the group, an isolation status that is not verified stops the run', () => {
    const out = withNoSsh((env) => execFileSync('python3', ['-I', LIB, 'selftest'], { encoding: 'utf-8', timeout: 60_000, env }));
    expect(out).toContain('selftest ok');
  });
});

describe('the runner script', () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/workload-frames.py', import.meta.url));
  const run = (args: string[]): { code: number; out: any } =>
    withNoSsh((env) => {
      try {
        return { code: 0, out: JSON.parse(execFileSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf-8', timeout: 30_000, env })) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: JSON.parse(err.stdout) };
      }
    });

  it('refuses a group that does not exist, before any ssh', () => {
    const r = run(['t', '--groups', '9']);
    expect(r.code).toBe(2);
    expect(r.out.error).toMatch(/--groups must name groups/);
  });

  it('refuses to send when the adversary preflight cannot run (every ssh fails here), and says why, with nothing sent', () => {
    for (const args of [['t'], ['t', '--dry-run']]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(r.out.error).toMatch(/refusing to send: the adversary preflight did not pass/);
      expect(r.out.groups).toBeUndefined();
    }
  });

  it('the sender template compiles, binds the AF_PACKET socket to the interface by name, and refuses an interface that is not there', () => {
    const src = execFileSync('python3', ['-I', '-c', `import importlib.util,sys\nsys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT))})\nspec = importlib.util.spec_from_file_location('wfs', ${JSON.stringify(SCRIPT)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(m.SENDER % ('eth1', "'aa', 'bb'", '0.1'))`], { encoding: 'utf-8' });
    expect(src).toContain("s.bind((iface, 0))");
    expect(src).toContain("os.path.isdir('/sys/class/net/' + iface)");
    execFileSync('python3', ['-I', '-c', `compile(${JSON.stringify(src)}, 'sender', 'exec')`]);
    const refused = (() => { try { execFileSync('python3', ['-I', '-c', src.replace("'eth1'", "'no-such-iface0'")], { encoding: 'utf-8', stdio: 'pipe' }); return false; } catch (e) { return String((e as { stderr: string }).stderr).includes('no such interface'); } })();
    expect(refused).toBe(true);
  });
});
