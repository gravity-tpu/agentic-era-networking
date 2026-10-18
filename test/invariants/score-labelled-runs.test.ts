/**
 * score-labelled-runs.test.ts
 * Guards the scorer (scripts/score-labelled-runs.py): its copy of the trt daemon's rate rule stays equal to the
 * daemon source, the rule behaves as described on small hand-built frame lists, and scoring the committed labelled runs
 * reproduces the recorded results.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/score-labelled-runs.py');
const DAEMON = resolve(ROOT, 'scripts/trt-inference-daemon.py');
const DATA = resolve(ROOT, 'docs/benchmarks/results/labelled-runs');
const hasNumpy = spawnSync('python3', ['-c', 'import numpy']).status === 0;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sc', sys.argv[1]); sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
def frames(src, gaps_ms, t0=1_000_000.0):
    t = t0; out = []
    for g in [0.0] + gaps_ms:
        t += g * 1000.0
        out.append((t, 60, 6, 2, 1, 2, src))
    return out
cases = json.loads(sys.argv[2])
res = {}
for name, spec_ in cases.items():
    fr = []
    for src, gaps in spec_:
        fr += frames(src, gaps)
    fr.sort(key=lambda f: f[0])
    res[name] = [[a[1], a[2]] for a in sc.rate_rule_alerts(fr)]
res['consts'] = [sc.RATE_WINDOW_NS, sc.RATE_MIN_ELAPSED_NS, sc.RATE_THRESHOLD_PPS]
print(json.dumps(res))
`;

const every = (n: number, ms: number): number[] => Array.from({ length: n }, () => ms);

function run(cases: Record<string, Array<[string, number[]]>>): Record<string, unknown> {
  const r = spawnSync('python3', ['-c', DRIVER, SCRIPT, JSON.stringify(cases)], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const parsed: Record<string, unknown> = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  return parsed;
}

describe.skipIf(!hasNumpy)('score-labelled-runs rate rule', () => {
  it('uses the daemon\'s own constants', () => {
    const src = readFileSync(DAEMON, 'utf-8');
    const win = /RATE_WINDOW_NS\s*=\s*([\d_]+)/.exec(src)?.[1];
    const thr = /QUARANTINE_THRESHOLD_PPS\s*=\s*int\(os\.environ\.get\('QUARANTINE_PPS_THRESHOLD',\s*'(\d+)'\)\)/.exec(src)?.[1];
    const minElapsed = /elapsed >= ([\d_]+):/.exec(src)?.[1];
    expect(win, 'RATE_WINDOW_NS in the daemon').toBeDefined();
    expect(thr, 'default threshold in the daemon').toBeDefined();
    expect(minElapsed, 'minimum-evidence check in the daemon').toBeDefined();
    const out = run({});
    expect(out['consts']).toEqual([Number((win ?? '').replace(/_/g, '')), Number((minElapsed ?? '').replace(/_/g, '')), Number(thr)]);
  });

  it('alerts a source above the threshold once 0.5 s of data exist, and only once', () => {
    const out = run({ fast: [['10.0.2.50', every(60, 20)]] }); // 50 pps for 1.2 s
    const alerts = out['fast'] as Array<[string, number]>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.[0]).toBe('10.0.2.50');
    expect(alerts[0]?.[1]).toBeGreaterThan(10);
  });

  it('does not alert a source at or below the threshold', () => {
    expect(run({ slow: [['10.0.2.52', every(30, 200)]] })['slow']).toEqual([]); // 5 pps
  });

  it('never rules on a burst that ends before 0.5 s of data (the fast-scan blind spot)', () => {
    expect(run({ burst: [['10.0.2.50', every(980, 0.35)]] })['burst']).toEqual([]); // ~0.34 s, about 2800 pps
  });

  it('ignores loopback, multicast and broadcast sources', () => {
    const out = run({ odd: [['127.0.0.1', every(60, 20)], ['239.255.255.250', every(60, 20)], ['255.255.255.255', every(60, 20)]] });
    expect(out['odd']).toEqual([]);
  });

  it('judges each source by its own frames', () => {
    const out = run({ two: [['10.0.2.50', every(60, 20)], ['10.0.2.52', every(30, 200)]] });
    expect((out['two'] as Array<[string, number]>).map((a) => a[0])).toEqual(['10.0.2.50']);
  });
});

describe.skipIf(!hasNumpy)('score-labelled-runs on the committed runs', () => {
  it('reproduces the recorded scores', () => {
    const r = spawnSync('python3', [SCRIPT, DATA], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('rate      attack runs detected with the right sender: 3/5   benign runs with any alert (false positives): 1/3');
    expect(r.stdout).toContain('sentinel  attack runs detected with the right sender: 5/5   benign runs with any alert (false positives): 3/3');
    const row = (id: string) => r.stdout.split('\n').find((l) => l.startsWith(id)) ?? '';
    expect(row('attack-portscan-fast')).toMatch(/\| no alert\s+\|/); // the rate rule never rules on a 0.36 s scan
    expect(row('attack-portscan-slow')).toMatch(/\| no alert\s+\|/); // 2.5 pps is under the threshold
    expect(row('attack-synflood-1000pps')).toMatch(/\| names sender, first at 0\.5 s/);
    expect(row('benign-ping-5pps ')).toMatch(/\| no alert\s+\|/);
  });
});
