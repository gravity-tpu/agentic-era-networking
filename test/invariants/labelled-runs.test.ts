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
  it('checks the rack after every run too, records the verdict in the label, and stops the batch if the switch dropped', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('healthy_after, why_after = rack_healthy()');
    expect(src).toContain('"rackHealthyAfter": healthy_after');
    expect(src).toMatch(/if not healthy_after:\n\s+# Stop the batch/);
    expect(src).toContain('raise SystemExit(f"STOPPED: the rack is unhealthy after');
    // A session that is not Connected is unhealthy even when an old readback still says verified.
    expect(src).toContain('of_status != "Connected"');
    // A drop that recovered before the check is still caught: the bridge's own dead-peer log lines are counted across the run window.
    expect(src).toContain('"Dead peer detected" in line'); // counted here, so a failed read is not mistaken for zero matches
    expect(src).toMatch(/if drops is None:\n\s+healthy_after, why_after = False/); // an unreadable journal is unhealthy
    expect(src).toContain('could not read the Jetson\'s clock');
    expect(src).toContain('controller_drops_since(window_start)');
    expect(src).toContain('"controllerDropsDuringRun": drops');
  });

  it('checks the rack is healthy before every run, and stops the batch if not', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/def execute\(run, outdir\):\n    ok, why = rack_healthy\(\)\n    if not ok:\n        raise SystemExit/);
    expect(src).toContain("iso.get(\"state\") != \"verified\"");
  });

  it('interval_text is exact where it can be and refuses a rate that would round to a zero gap', () => {
    const r = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('lr', sys.argv[1]); lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
out = [lr.interval_text(n) for n in (1, 5, 20, 1000)]
for bad in (0, -1, 1001, True, 2.5):
    try:
        lr.interval_text(bad); out.append('accepted')
    except ValueError:
        out.append('refused')
print(out)
`, SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("['1.000000', '0.200000', '0.050000', '0.001000', 'refused', 'refused', 'refused', 'refused', 'refused']");
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
    expect(v?.cmd?.slice(5)).toEqual(['sh', 'http://10.0.2.119:8000/health', '0.200000', '30']); // from integer arithmetic
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

describe.skipIf(!hasPython)('labelled-runs.py second-recording workloads', () => {
  it('builds ssh-like interactive TCP from one fixed script, bounded, with a local sink as receiver', () => {
    const [v] = check([{ ...benign, tool: 'tcp-interactive', events_per_s: 8 }]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd?.slice(0, 4)).toEqual(['timeout', '40', 'python3', '-c']);
    expect(v?.cmd?.slice(5)).toEqual(['10.0.2.119', '5201', '8', '30', '10.0.2.52']);
    expect(v?.recv?.slice(0, 2)).toEqual(['python3', '-c']);
    const [hi, wrong] = check([
      { ...benign, tool: 'tcp-interactive', events_per_s: 500 },
      { ...benign, tool: 'tcp-interactive', events_per_s: 8, target: '10.0.2.51' },
    ]);
    expect(hi?.why).toMatch(/events_per_s must be 1 to 30/);
    expect(wrong?.why).toMatch(/tcp-interactive only targets 10\.0\.2\.119/);
  });

  it('builds the browsing-like burst from a constant script with its values as arguments', () => {
    const [v] = check([{ ...benign, tool: 'http-burst', conns: 8, period_s: 3 }]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd?.slice(0, 4)).toEqual(['timeout', '40', 'sh', '-c']);
    expect(v?.cmd?.[4]).not.toContain('10.0.2.119');
    expect(v?.cmd?.slice(5)).toEqual(['sh', 'http://10.0.2.119:8000', '8', '3', '30']);
    expect(v?.recv?.slice(0, 5)).toEqual(['python3', '-m', 'http.server', '8000', '--bind']);
    const [many, slow] = check([
      { ...benign, tool: 'http-burst', conns: 200, period_s: 3 },
      { ...benign, tool: 'http-burst', conns: 8, period_s: 60 },
    ]);
    expect(many?.why).toMatch(/conns must be 1 to 16/);
    expect(slow?.why).toMatch(/period_s must be 1 to 10/);
  });

  it('builds the Tailscale-like UDP burst on a port other than the one the nodes drop, bounded', () => {
    const [v] = check([{ ...benign, tool: 'udp-burst', burst: 25, payload_bytes: 1300, period_s: 10 }]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd?.slice(5)).toEqual(['10.0.2.119', '51820', '25', '1300', '10', '30', '10.0.2.52']);
    const [big, tiny, many] = check([
      { ...benign, tool: 'udp-burst', burst: 25, payload_bytes: 9000, period_s: 10 },
      { ...benign, tool: 'udp-burst', burst: 25, payload_bytes: 100, period_s: 10 },
      { ...benign, tool: 'udp-burst', burst: 400, payload_bytes: 1300, period_s: 10 },
    ]);
    expect(big?.why).toMatch(/payload_bytes must be 600 to 1400/);
    expect(tiny?.why).toMatch(/payload_bytes must be 600 to 1400/);
    expect(many?.why).toMatch(/burst must be 1 to 40/);
  });

  it('an ARP flood is an attack tool: root, from the adversary only, under timeout, bounded in rate and duration', () => {
    const flood = { id: 'a', class: 'attack', tool: 'arp-flood', sender: 'agentic-node-01', target: '10.0.2.119', seconds: 12, pps: 200, count: 2000 };
    const [v, fast, long, fromNode2, asBenign] = check([
      flood,
      { ...flood, pps: 5000 },
      { ...flood, pps: 10, count: 20000 },
      { ...flood, sender: 'agentic-node-02' },
      { ...flood, class: 'benign' },
    ]);
    expect(v?.ok).toBe(true);
    expect(v?.cmd).toEqual(['sudo', '-n', 'timeout', '17', 'nping', '--arp', '--arp-type', 'arp-request', '--arp-target-ip', '10.0.2.119', '--rate', '200', '-c', '2000', '-e', 'eth0', '10.0.2.119']);
    expect(fast?.why).toMatch(/pps must be a positive integer of at most 300/);
    expect(long?.why).toMatch(/above the 120 s limit/);
    expect(fromNode2?.why).toMatch(/an attack may only come from/);
    expect(asBenign?.why).toMatch(/attack tool and cannot be a benign run/);
  });

  it('a scan delay is bounded and goes to nmap as milliseconds', () => {
    const scan = { id: 's', class: 'attack', tool: 'nmap', sender: 'agentic-node-01', target: '10.0.2.119', seconds: 70, timing: 2, ports: '1-60' };
    const [v, none, big] = check([{ ...scan, delay_ms: 1000 }, scan, { ...scan, delay_ms: 600000 }]);
    expect(v?.cmd).toEqual(['sudo', '-n', 'timeout', '75', 'nmap', '-sS', '-T2', '-p', '1-60', '-n', '-Pn', '--max-retries', '0', '--scan-delay', '1000ms', '10.0.2.119']);
    expect(none?.cmd).not.toContain('--scan-delay');
    expect(big?.why).toMatch(/delay_ms must be an integer from 0 to 5000/);
  });

  it('the catalog covers every workload family the guard asks for and the evasion-boundary scans', () => {
    const r = spawnSync('python3', [SCRIPT, '--list'], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
    const benignTools = new Set(rows.filter((x) => x[1] === 'benign').map((x) => x[2]));
    for (const t of ['ping', 'idle', 'http-get', 'http-burst', 'udp-small', 'udp-burst', 'tcp-stream', 'tcp-interactive']) expect(benignTools.has(t), t).toBe(true);
    const ids = rows.map((x) => x[0] ?? '');
    // (The 5, 10 and 20 Mbit bulk runs are marked risky and so are not in this default listing: see the test below.)
    for (const base of ['attack-portscan-1pps', 'attack-portscan-half-pps', 'attack-arpflood-200pps', 'benign-bulk-tcp-2mbit']) {
      expect(ids.some((i) => i === base || i.startsWith(`${base}-r`)), base).toBe(true);
    }
  });

  it('bulk TCP at 5 Mbit and above is marked risky: left out of a whole-catalog run, refused by name without the flag', () => {
    const all = spawnSync('python3', [SCRIPT, '--list'], { encoding: 'utf-8' });
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toContain('benign-bulk-tcp-2mbit');
    for (const risky of ['benign-bulk-tcp-5mbit', 'benign-bulk-tcp-10mbit', 'benign-bulk-tcp-20mbit', 'benign-bulk-tcp-node01-10mbit']) expect(all.stdout, risky).not.toContain(risky);
    const named = spawnSync('python3', [SCRIPT, '--list', '--only', 'benign-bulk-tcp-5mbit'], { encoding: 'utf-8' });
    expect(named.status).not.toBe(0);
    expect(named.stderr).toMatch(/marked risky/);
    const allowed = spawnSync('python3', [SCRIPT, '--list', '--only', 'benign-bulk-tcp-5mbit', '--include-risky'], { encoding: 'utf-8' });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain('benign-bulk-tcp-5mbit');
  });
});
