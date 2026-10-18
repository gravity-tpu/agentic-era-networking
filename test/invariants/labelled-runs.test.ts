/**
 * labelled-runs.test.ts
 * The labelled-run harness refuses anything outside its bounds before sending a packet, builds commands only from fixed
 * templates, and its own catalog passes every bound. Runs python3 against scripts/labelled-runs.py with --list and
 * --dry-run, plus direct calls to validate(); nothing here touches the network.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
        lr.validate(c); out.append({'ok': True, 'cmd': lr.remote_command(c), 'recv': lr.receiver_command(c)})
    except lr.RunRejected as e:
        out.append({'ok': False, 'why': str(e)})
print(json.dumps(out))
`;

interface Verdict {
  ok: boolean;
  why?: string;
  cmd?: string[] | null;
  recv?: string[] | null;
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
  it('checks the rack is healthy before every run, and stops the batch if not', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/def execute\(run, outdir\):\n    ok, why = rack_healthy\(\)\n    if not ok:\n        raise SystemExit/);
    expect(src).toContain("iso.get(\"state\") != \"verified\"");
  });

  it('paces in integer nanoseconds: no float rate arithmetic in the scripts it sends', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    for (const marker of ['UDP_SMALL_SCRIPT', 'TCP_STREAM_SCRIPT']) {
      const start = src.indexOf(`${marker} = (`);
      const block = src.slice(start, src.indexOf('\n)\n', start));
      expect(block, marker).not.toMatch(/\d\.\d|1\.0\/|\.0\b|monotonic\(\)/); // no float literal and no float-second clock
      expect(block, marker).toContain('monotonic_ns()');
    }
    expect(src).not.toMatch(/f"\{1 \/ run/);
  });

  it('never uses a wall clock for a duration, and never kills by command-line match', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).not.toMatch(/time\.time\(/);
    expect(src).not.toMatch(/pkill/);
  });

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
    const captures = r.stdout.split('\n').filter((x) => x.includes('tcpdump'));
    expect(captures.length).toBeGreaterThan(0);
    for (const l of captures) {
      expect(l).toContain('timeout -s INT');
      expect(l).toMatch(/echo \$\$ > \/tmp\/labelled-[a-z0-9-]+\.pid; exec /); // pid recorded so teardown kills by pid, not by matching text
    }
  });

  it('needs exactly one mode, and --execute needs --out', () => {
    expect(spawnSync('python3', [SCRIPT], { encoding: 'utf-8' }).status).not.toBe(0);
    expect(spawnSync('python3', [SCRIPT, '--list', '--dry-run'], { encoding: 'utf-8' }).status).not.toBe(0);
    const noOut = spawnSync('python3', [SCRIPT, '--execute'], { encoding: 'utf-8' });
    expect(noOut.status).not.toBe(0);
    expect(noOut.stderr).toMatch(/--out/);
  });
});

const benign = { id: 'b-run', class: 'benign', sender: 'agentic-node-02', target: '10.0.2.119', seconds: 30 };

describe.skipIf(!hasPython)('labelled-runs.py benign workloads', () => {
  it('builds the HTTP poll from validated numbers and an allowlisted path only', () => {
    const [v] = check([{ ...benign, tool: 'http-get', rps: 5, path: '/health' }]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd?.slice(0, 4)).toEqual(['timeout', '35', 'sh', '-c']);
    // The loop text is constant; url, gap and duration are arguments, never spliced into the script.
    expect(v?.cmd?.[4]).toContain('"$1"');
    expect(v?.cmd?.[4]).not.toContain('10.0.2.119');
    expect(v?.cmd?.slice(5)).toEqual(['sh', 'http://10.0.2.119:8000/health', '0.200', '30']); // 0.200 s from integer arithmetic
    // The receiver is a local web server on the Mac's uplink-side alias (traffic to the Pi 5 never crosses the Zodiac).
    expect(v?.recv?.slice(0, 5)).toEqual(['python3', '-m', 'http.server', '8000', '--bind']);
    expect(v?.recv?.[5]).toBe('10.0.2.119');
  });

  it.each([
    ['a path outside the allowlist', { path: '/admin' }, /http-get path must be/],
    ['a path that tries to inject a command', { path: '/health; reboot' }, /http-get path must be/],
    ['a rate above the limit', { rps: 500 }, /http-get rps must be 1 to 20/],
    ['a target other than the local web server', { target: '10.0.2.51' }, /http-get only targets 10\.0\.2\.119/],
  ])('refuses an HTTP poll with %s', (_n, patch, why) => {
    const [v] = check([{ ...benign, tool: 'http-get', rps: 5, path: '/health', ...patch }]);
    expect(v?.ok).toBe(false);
    expect(v?.why).toMatch(why);
  });

  it('builds small UDP from one fixed script, bounded in rate and size', () => {
    const [v] = check([{ ...benign, tool: 'udp-small', pps: 10, payload_bytes: 60, port: 53 }]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd?.slice(0, 4)).toEqual(['timeout', '35', 'python3', '-c']);
    expect(v?.cmd?.slice(5)).toEqual(['10.0.2.119', '53', '10', '30', '60', '10.0.2.52']);
    const [hi, big, badPort] = check([
      { ...benign, target: '10.0.2.119', tool: 'udp-small', pps: 500, payload_bytes: 60 },
      { ...benign, target: '10.0.2.119', tool: 'udp-small', pps: 10, payload_bytes: 5000 },
      { ...benign, target: '10.0.2.119', tool: 'udp-small', pps: 10, payload_bytes: 60, port: 70000 },
    ]);
    expect(hi?.why).toMatch(/pps must be a positive integer of at most 50/);
    expect(big?.why).toMatch(/payload_bytes must be 20 to 200/);
    expect(badPort?.why).toMatch(/port must be 1 to 65535/);
  });

  it('starts a TCP sink on this machine, bound to the uplink-side alias, before the sender', () => {
    const [v] = check([{ ...benign, tool: 'tcp-stream', seconds: 20, bandwidth_mbit: 10 }]);
    expect(v?.ok).toBe(true);
    expect(v?.recv?.slice(0, 2)).toEqual(['python3', '-c']);
    expect(v?.recv?.slice(3)).toEqual(['10.0.2.119', '5201', '35']); // bound to the alias, with its own time limit
    expect(v?.cmd?.slice(0, 4)).toEqual(['timeout', '30', 'python3', '-c']);
    expect(v?.cmd?.slice(5)).toEqual(['10.0.2.119', '5201', '10', '20', '10.0.2.52']);
  });

  it('refuses bulk TCP above the bandwidth limit or to a receiver it cannot start', () => {
    const [fast, mac] = check([
      { ...benign, tool: 'tcp-stream', seconds: 20, bandwidth_mbit: 500 },
      { ...benign, tool: 'tcp-stream', seconds: 20, bandwidth_mbit: 10, target: '10.0.2.51' },
    ]);
    expect(fast?.why).toMatch(/bandwidth_mbit must be 1 to 20/);
    expect(mac?.why).toMatch(/needs a receiver this harness can start/); // only the local receiver is supported
  });

  it('an idle run sends nothing and takes no sender or target', () => {
    const [ok, withSender, withTarget] = check([
      { id: 'idle', class: 'benign', tool: 'idle', sender: null, target: null, seconds: 60 },
      { id: 'idle', class: 'benign', tool: 'idle', sender: 'agentic-node-02', target: null, seconds: 60 },
      { id: 'idle', class: 'benign', tool: 'idle', sender: null, target: '10.0.2.119', seconds: 60 },
    ]);
    expect(ok?.ok).toBe(true);
    expect(ok?.cmd).toBeNull();
    expect(withSender?.why).toMatch(/idle run has no sender and no target/);
    expect(withTarget?.why).toMatch(/idle run has no sender and no target/);
  });

  it('keeps attack tools out of benign runs and benign tools out of attack runs', () => {
    const [a, b] = check([
      { ...benign, tool: 'hping3', target: '10.0.2.119', pps: 100, count: 100, flags_or_proto: 'syn' },
      { id: 'x', class: 'attack', tool: 'http-get', sender: 'agentic-node-01', target: '10.0.2.119', seconds: 10, rps: 5, path: '/health' },
    ]);
    expect(a?.why).toMatch(/attack tool and cannot be a benign run/);
    expect(b?.why).toMatch(/benign tool and cannot be an attack run/);
  });
});

describe.skipIf(!hasPython)('labelled-runs.py catalog shape', () => {
  it('has unique ids, repeats of every class, and covers the benign workloads the scoring needs', () => {
    const r = spawnSync('python3', [SCRIPT, '--list'], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
    const ids = rows.map((x) => x[0] ?? '');
    expect(new Set(ids).size).toBe(ids.length);
    const tools = new Set(rows.filter((x) => x[1] === 'benign').map((x) => x[2]));
    for (const t of ['ping', 'http-get', 'udp-small', 'tcp-stream', 'idle']) expect(tools.has(t), t).toBe(true);
    for (const base of ['benign-http-5rps', 'benign-udp-small-10pps', 'attack-synflood-1000pps', 'attack-portscan-fast']) {
      expect(ids.filter((i) => i === base || i.startsWith(`${base}-r`)).length, base).toBeGreaterThanOrEqual(3);
    }
  });

  it('every run carries an explicit pattern, shared by its repeats', () => {
    const r = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('lr', sys.argv[1]); lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
bad = [r['id'] for r in lr.CATALOG if not r['id'].startswith(r['pattern']) ]
rep = [r['id'] for r in lr.CATALOG if r['pattern'] == 'benign-http-5rps']
print(bad, rep)
`, SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("[] ['benign-http-5rps', 'benign-http-5rps-r2', 'benign-http-5rps-r3']");
  });

  it('--class selects only that class', () => {
    const all = spawnSync('python3', [SCRIPT, '--list', '--class', 'benign'], { encoding: 'utf-8' });
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).not.toMatch(/\sattack\s/);
    expect(all.stdout).toMatch(/\sbenign\s/);
  });
});
