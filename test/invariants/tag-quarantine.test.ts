/**
 * test/invariants/tag-quarantine.test.ts
 * Does a quarantine DROP match a tagged frame? (docs/benchmarks/results/scenario5-tag-quarantine/PREREGISTRATION.md.) These tests hold the code to the registered table: five classes,
 * their source MACs and predictions, the bytes of every frame built here from the standards, the judge's verdicts (including the cases that can fail), the install-send-release
 * choreography against a scripted ssh, and the runner's refusals. The python runs with a stub ssh first on PATH, so nothing here can reach a host.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../../scripts/tag_quarantine_lib.py', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/tag-quarantine.py', import.meta.url));

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

type Pred = 'crosses' | 'dropped' | 'question';
interface Cls { id: string; name: string; prediction: Pred; src: string; bpf: string; frame_hex: string; frame_hex_7: string }
const dump = py('dump') as { classes: Cls[]; quarantined_ip: string; frames_per_class: number };
const byId = (id: string): Cls => dump.classes.find((c) => c.id === id) as Cls;

const REGISTERED: Array<[string, Pred]> = [['QC0', 'crosses'], ['QC1', 'crosses'], ['Q0', 'dropped'], ['Q1', 'question'], ['Q2', 'question']];

describe('the registered table', () => {
  it('has the five classes of the pre-registration, in order, with its predictions, 20 frames each and the quarantined address 10.0.2.101', () => {
    expect(dump.classes.map((c) => [c.id, c.prediction])).toEqual(REGISTERED);
    expect(dump.frames_per_class).toBe(20);
    expect(dump.quarantined_ip).toBe('10.0.2.101');
  });

  it('gives each class its own source MAC from 02:00:00:00:00:a0, in order, and a filter that names only that MAC', () => {
    dump.classes.forEach((c, i) => {
      expect(c.src).toBe(`02:00:00:00:00:${(0xa0 + i).toString(16)}`);
      expect(c.bpf).toBe(`ether src ${c.src}`);
    });
  });
});

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
const udpPacket = (src: string, dst: string, n: number): number[] => {
  const l4 = [...be16(40000), ...be16(9), ...be16(8 + 16), 0, 0, ...payload(n)];
  const head = [(4 << 4) | 5, 0, ...be16(20 + l4.length), ...be16(n & 0xffff), ...be16(0), 64, 17, 0, 0, ...ip(src), ...ip(dst)];
  const c = cksum(head);
  head[10] = c >> 8; head[11] = c & 0xff;
  return [...head, ...l4];
};
const BCAST = 'ff:ff:ff:ff:ff:ff';
const untagged = (src: string, body: number[]): number[] => pad60([...mac(BCAST), ...mac(src), ...be16(0x0800), ...body]);
const tagged = (src: string, vid: number, body: number[]): number[] => pad60([...mac(BCAST), ...mac(src), ...be16(0x8100), ...be16(vid), ...be16(0x0800), ...body]);

const expected = (id: string, n: number): number[] => {
  const s = byId(id).src;
  switch (id) {
    case 'QC0': return untagged(s, udpPacket('10.0.2.52', '10.0.2.50', n));
    case 'QC1': return tagged(s, 100, udpPacket('10.0.2.52', '10.0.2.50', n));
    case 'Q0': return untagged(s, udpPacket('10.0.2.101', '10.0.2.50', n));
    case 'Q1': return tagged(s, 100, udpPacket('10.0.2.101', '10.0.2.50', n));
    case 'Q2': return tagged(s, 200, udpPacket('10.0.2.101', '10.0.2.50', n));
    default: throw new Error(id);
  }
};

describe('frame bytes', () => {
  for (const [id] of REGISTERED) {
    it(`${id} ${byId(id).name} equals the frame written out here from the standards (sequence numbers 0 and 7)`, () => {
      expect(byId(id).frame_hex).toBe(hex(expected(id, 0)));
      expect(byId(id).frame_hex_7).toBe(hex(expected(id, 7)));
    });
  }

  it('can fail: the checker tells the two VLAN IDs apart, a tagged frame from an untagged one, and the quarantined source from the allowed one', () => {
    expect(hex(expected('Q1', 0))).not.toBe(hex(expected('Q2', 0)));
    expect(hex(expected('Q0', 0))).not.toBe(hex(expected('Q1', 0)));
    expect(hex(expected('QC1', 0))).not.toBe(hex(expected('Q1', 0)));
  });
});

type Counts = Record<string, { O3: number; O2: number }>;
const base = (): Counts => ({ QC0: { O3: 20, O2: 20 }, QC1: { O3: 20, O2: 20 }, Q0: { O3: 0, O2: 0 }, Q1: { O3: 0, O2: 0 }, Q2: { O3: 0, O2: 0 } });
const judge = (counts: Counts, invalid: Record<string, string> = {}): any => py('judge', { counts, invalid, n: 20 });

describe('the judge', () => {
  it('a clean run: the controls hold and both tagged quarantined classes are dropped; no stop', () => {
    const j = judge(base());
    expect(j.verdicts).toEqual({ QC0: 'as_predicted', QC1: 'as_predicted', Q0: 'as_predicted', Q1: 'dropped', Q2: 'dropped' });
    expect(j).toMatchObject({ evaded: [], void: false, stop: false });
  });

  it('frames from the quarantined source at O3 for a tagged class are evaded and stop the run, even one frame, each tag separately', () => {
    for (const q of ['Q1', 'Q2']) {
      const c = base(); c[q] = { O3: 1, O2: 0 };
      const j = judge(c);
      expect(j.verdicts[q]).toBe('evaded');
      expect(j).toMatchObject({ evaded: [q], stop: true, void: false });
    }
  });

  it('a tagged quarantined class that reaches only the tap is reported as such, not as dropped and not as evaded', () => {
    const c = base(); c.Q1 = { O3: 0, O2: 20 };
    const j = judge(c);
    expect(j.verdicts.Q1).toBe('reached_tap_only');
    expect(j.evaded).toEqual([]);
  });

  it('a failed control voids the run and nothing is concluded about Q1 and Q2; frames at O3 for them are still shown', () => {
    const cases: Array<[string, { O3: number; O2: number }]> = [['QC0', { O3: 19, O2: 20 }], ['QC1', { O3: 20, O2: 0 }], ['Q0', { O3: 0, O2: 3 }], ['Q0', { O3: 5, O2: 0 }]];
    for (const [id, bad] of cases) {
      const c = base(); c[id] = bad; c.Q1 = { O3: 2, O2: 0 };
      const j = judge(c);
      expect(j, `${id} ${JSON.stringify(bad)}`).toMatchObject({ void: true, stop: true });
      expect(j.verdicts.Q1).toBe('void');
      expect(j.o3_frames.Q1).toBe(2);
    }
  });

  it('an invalid observer makes every class observer_invalid and the run void; nothing is dropped or evaded', () => {
    for (const obs of ['O3', 'O2']) {
      const j = judge(base(), { [obs]: 'the capture never ran' });
      expect(Object.values(j.verdicts).every((v) => v === 'observer_invalid')).toBe(true);
      expect(j).toMatchObject({ void: true, stop: true, evaded: [] });
    }
  });

  it('a missing control class voids the run', () => {
    const c = base(); delete c.Q0;
    expect(judge(c).void).toBe(true);
  });

  it('has no "partial" outcome for a tagged quarantined class: O3 above 0 is evaded, otherwise dropped or tap-only (the registration listed a partial that cannot occur)', () => {
    for (const o3 of [0, 1, 19, 20]) {
      for (const o2 of [0, 1, 20]) {
        const c = base(); c.Q1 = { O3: o3, O2: o2 };
        expect(['dropped', 'evaded', 'reached_tap_only']).toContain(judge(c).verdicts.Q1);
      }
    }
  });
});

describe('the choreography, against a scripted ssh and a scripted bridge', () => {
  it('passes its own selftest: a refused install sends nothing and still tries to release, an error after the install still releases, a failed release is reported and not hidden, a second quarantine voids the run, nothing is installed unless every observer is listening and the status and mode are readable, and the run is clean only when the final status is', () => {
    const out = withNoSsh((env) => execFileSync('python3', ['-I', LIB, 'selftest'], { encoding: 'utf-8', timeout: 60_000, env }));
    expect(out).toContain('selftest ok');
  });
});

describe('the runner script', () => {
  const run = (args: string[]): { code: number; out: any } =>
    withNoSsh((env) => {
      try {
        return { code: 0, out: JSON.parse(execFileSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf-8', timeout: 30_000, env })) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: JSON.parse(err.stdout) };
      }
    });

  it('refuses to install anything unless it is a dry run or the owner\'s go for the install is named on the command line, before any ssh', () => {
    const r = run(['t']);
    expect(r.code).toBe(2);
    expect(r.out.error).toMatch(/--owner-go-for-install/);
  });

  it('refuses to do anything when the adversary preflight cannot run (every ssh fails here), dry run or not, and installs nothing', () => {
    for (const args of [['t', '--dry-run'], ['t', '--owner-go-for-install']]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(r.out.error).toMatch(/refusing to start: the adversary preflight did not pass/);
      expect(r.out.installed).toBeUndefined();
    }
  });
});
