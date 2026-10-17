/**
 * labelled-runs.test.ts
 * The labelled-run harness refuses anything outside its bounds before sending a packet, builds commands only from fixed
 * templates, and its own catalog passes every bound. Runs python3 against scripts/labelled-runs.py with --list and
 * --dry-run, plus direct calls to validate(); nothing here touches the network.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/labelled-runs.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('lr', sys.argv[1]); lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
cases = json.loads(sys.argv[2])
out = []
for c in cases:
    try:
        lr.validate(c); out.append({'ok': True, 'cmd': lr.remote_command(c)})
    except lr.RunRejected as e:
        out.append({'ok': False, 'why': str(e)})
print(json.dumps(out))
`;

interface Verdict {
  ok: boolean;
  why?: string;
  cmd?: string[];
}

const base = { id: 'x-run', class: 'attack', tool: 'hping3', sender: 'agentic-node-01', target: '10.0.2.119', seconds: 10, pps: 1000, count: 10000, flags_or_proto: 'syn' };

function check(cases: Array<Record<string, unknown>>): Verdict[] {
  const r = spawnSync('python3', ['-c', DRIVER, SCRIPT, JSON.stringify(cases)], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const parsed: Verdict[] = JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]');
  return parsed;
}

describe.skipIf(!hasPython)('labelled-runs.py bounds', () => {
  it('accepts a run inside every bound and builds a root-under-timeout command from the fixed template', () => {
    const [v] = check([base]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd).toEqual(['sudo', '-n', 'timeout', '15', 'hping3', '-c', '10000', '-i', 'u1000', '-I', 'eth0', '-d', '0', '-q', '-S', '-p', '80', '10.0.2.119']);
  });

  it.each([
    ['rate above the cap', { pps: 5000, count: 5000 }, /pps=5000 is above the limit 2000/],
    ['packet count above the cap', { count: 50000, pps: 1000, seconds: 60 }, /count=50000 is above the limit 20000/],
    ['duration above the cap', { seconds: 600 }, /seconds=600 is above the limit 120/],
    ['count over rate longer than a run may last', { count: 20000, pps: 100, seconds: 100 }, /above the 120 s limit/],
    ['payload larger than the cap', { payload_bytes: 9000 }, /payload_bytes must be/],
    ['target outside the allowed receivers', { target: '10.0.0.1' }, /not one of the allowed receivers/],
    ['target that is not an address', { target: '10.0.2.119; reboot' }, /not an IP address/],
    ['attack from the legitimate client', { sender: 'agentic-node-02' }, /an attack may only come from/],
    ['unknown sender', { sender: 'jetson' }, /sender must be one of/],
    ['unknown tool', { tool: 'curl' }, /tool must be one of/],
    ['id that could escape a path', { id: '../etc/passwd' }, /id must be/],
    ['unknown class', { class: 'testing' }, /class must be/],
    ['unsupported hping3 mode', { flags_or_proto: 'rst' }, /flags_or_proto must be/],
    ['zero rate', { pps: 0 }, /pps must be a positive integer/],
    ['boolean passed as a number', { pps: true }, /pps must be a positive integer/],
  ])('refuses %s', (_name, patch, why) => {
    const [v] = check([{ ...base, ...patch }]);
    expect(v?.ok).toBe(false);
    expect(v?.why).toMatch(why);
  });

  it('refuses nmap at aggressive timing or over a wide port range, and ping above 20 pps', () => {
    const nmap = { id: 'n', class: 'attack', tool: 'nmap', sender: 'agentic-node-01', target: '10.0.2.119', seconds: 20, timing: 4, ports: '1-1000' };
    const [ok, t5, wide, fast] = check([
      nmap,
      { ...nmap, timing: 5 },
      { ...nmap, ports: '1-65535' },
      { id: 'p', class: 'benign', tool: 'ping', sender: 'agentic-node-02', target: '10.0.2.119', seconds: 10, pps: 100 },
    ]);
    expect(ok?.ok).toBe(true);
    expect(t5?.why).toMatch(/never 5/);
    expect(wide?.why).toMatch(/at most 2000 ports/);
    expect(fast?.why).toMatch(/at most 20/);
  });

  it('reports every problem with a run, not only the first', () => {
    const [v] = check([{ ...base, pps: 9999, seconds: 999, target: '8.8.8.8' }]);
    expect(v?.ok).toBe(false);
    expect(v?.why).toMatch(/pps=9999/);
    expect(v?.why).toMatch(/seconds=999/);
    expect(v?.why).toMatch(/allowed receivers/);
  });
});

describe.skipIf(!hasPython)('labelled-runs.py catalog', () => {
  it('every catalog run passes validation and --list shows them all', () => {
    const r = spawnSync('python3', [SCRIPT, '--list'], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(r.stderr).not.toMatch(/REJECTED/);
  });

  it('--dry-run prints each command and runs nothing; attacks only from node-01 and always as root under timeout', () => {
    const r = spawnSync('python3', [SCRIPT, '--dry-run'], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const attackLines = r.stdout.split('\n').filter((l) => /hping3|nmap/.test(l) && l.trim().startsWith('agentic-node'));
    expect(attackLines.length).toBeGreaterThan(0);
    for (const l of attackLines) {
      expect(l.trim().startsWith('agentic-node-01:'), l).toBe(true);
      expect(l).toMatch(/sudo -n timeout \d+ /);
    }
    for (const l of r.stdout.split('\n').filter((x) => x.includes('tcpdump'))) expect(l).toContain('timeout -s INT');
  });

  it('needs exactly one mode, and --execute needs --out', () => {
    expect(spawnSync('python3', [SCRIPT], { encoding: 'utf-8' }).status).not.toBe(0);
    expect(spawnSync('python3', [SCRIPT, '--list', '--dry-run'], { encoding: 'utf-8' }).status).not.toBe(0);
    const noOut = spawnSync('python3', [SCRIPT, '--execute'], { encoding: 'utf-8' });
    expect(noOut.status).not.toBe(0);
    expect(noOut.stderr).toMatch(/--out/);
  });
});
