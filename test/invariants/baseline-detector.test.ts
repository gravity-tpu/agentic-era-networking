/**
 * baseline-detector.test.ts
 * The offline prototype of the per-source baseline detector (scripts/baseline-detector.py): its rules on hand-built
 * per-second series, and its scores on the committed labelled runs. Nothing here touches the rack.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/baseline-detector.py');
const DATA = resolve(ROOT, 'docs/benchmarks/results/labelled-runs');
const hasNumpy = spawnSync('python3', ['-c', 'import numpy']).status === 0;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bd', sys.argv[1]); bd = importlib.util.module_from_spec(spec); spec.loader.exec_module(bd)
case = json.loads(sys.argv[2])
zero = {'nontcp_pps': 0, 'nontcp_bytes': 0, 'syn_per_s': 0, 'ports_10s': 0}
def series(rows):
    return {i: {**zero, **r} for i, r in enumerate(rows)}
out = {}
if 'alerts' in case:
    thr = {**{f: bd.FLOORS[f] for f in bd.FEATURES}, **case.get('thr', {})}
    out['alerts'] = [[b, f] for b, f in bd.alerts(series(case['alerts']), thr)]
if 'thresholds' in case:
    benign = [{'src': series(case['thresholds'])}]
    out['withFloors'] = bd.thresholds(benign)
    out['dataOnly'] = bd.thresholds(benign, floors=False)
out['consts'] = {'margin': bd.MARGIN, 'severe': bd.SEVERE, 'window': bd.WINDOW, 'hits': bd.HITS, 'quiet': bd.QUIET_BUCKETS, 'floors': bd.FLOORS}
print(json.dumps(out))
`;

interface Out {
  alerts?: Array<[number, string[]]>;
  withFloors?: Record<string, number>;
  dataOnly?: Record<string, number>;
  consts: { margin: number; severe: number; window: number; hits: number; quiet: number; floors: Record<string, number> };
}

function run(c: Record<string, unknown>): Out {
  const r = spawnSync('python3', ['-c', DRIVER, SCRIPT, JSON.stringify(c)], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const parsed: Out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  return parsed;
}

const syn = (n: number) => ({ syn_per_s: n });

describe.skipIf(!hasNumpy)('baseline detector rules', () => {
  it('needs HITS of the last WINDOW buckets above threshold: one moderate bucket does not alert, two do', () => {
    expect(run({ alerts: [syn(40), syn(0), syn(0), syn(0)] }).alerts).toEqual([]);
    const two = run({ alerts: [syn(40), syn(40), syn(0)] }).alerts ?? [];
    expect(two).toHaveLength(1);
    expect(two[0]?.[1]).toEqual(['syn_per_s']);
  });

  it('a single bucket at SEVERE times the threshold alerts at once (a burst that ends inside one second)', () => {
    const o = run({ alerts: [syn(300)] });
    expect(o.alerts).toEqual([[0, ['syn_per_s']]]);
    expect(run({ alerts: [syn(299)] }).alerts).toEqual([]); // 299 < 10 x 30
  });

  it('a value at the threshold is not above it', () => {
    expect(run({ alerts: [syn(30), syn(30), syn(30)] }).alerts).toEqual([]);
  });

  it('is re-armed after QUIET_BUCKETS quiet buckets, not "once until restart", and does not repeat while it is still hot', () => {
    const hot = [syn(40), syn(40), syn(40), syn(40), syn(40), syn(40)];
    expect(run({ alerts: hot }).alerts).toHaveLength(1); // one report per episode, however long it lasts
    const quiet = Array.from({ length: 6 }, () => ({}));
    const again = run({ alerts: [...hot.slice(0, 2), ...quiet, ...hot.slice(0, 2)] }).alerts ?? [];
    expect(again).toHaveLength(2);
  });

  it('judges each feature on its own threshold and reports every feature that is over', () => {
    const o = run({ alerts: [{ nontcp_bytes: 150_000, nontcp_pps: 200 }, { nontcp_bytes: 150_000, nontcp_pps: 200 }] });
    expect(o.alerts?.[0]?.[1]).toEqual(['nontcp_bytes', 'nontcp_pps']);
  });

  it('thresholds are max(floor, margin x the largest benign value); without floors the data alone can give zero', () => {
    const o = run({ thresholds: [{ nontcp_pps: 100, syn_per_s: 0 }, { nontcp_pps: 200 }] });
    expect(o.withFloors).toEqual({ nontcp_pps: 600, nontcp_bytes: 100_000, syn_per_s: 30, ports_10s: 10 }); // 3 x 200
    expect(o.dataOnly?.['syn_per_s']).toBe(0); // a source never seen sending SYNs would alert on its first one
    expect(o.dataOnly?.['nontcp_pps']).toBe(600);
  });
});

describe.skipIf(!hasNumpy)('baseline detector on the committed labelled runs', () => {
  const out = () => {
    const r = spawnSync('python3', [SCRIPT, DATA], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };

  it('detects all five attacks with the right sender and alerts on none of the 18 benign runs, in sample', () => {
    expect(out()).toContain('in-sample (thresholds from all benign runs)    attacks detected with the right sender 5/5   benign runs with any alert 0/18   runs naming a non-sender 0/23');
  });

  it('holds up leaving each benign family out, and shows the floors are what carries it', () => {
    const o = out();
    expect(o).toContain('held-out benign runs with any alert, all folds: 0/18   (without the floors, data-derived thresholds only: 5/18)');
    expect(o).toMatch(/hold out http-get\s+\(5 runs\)\s+alerts 0\/5\s+attacks detected 5\/5.*WITHOUT floors: alerts 5\/5/);
  });

  it('catches the fast scan only through the severe path, and the slow scan late', () => {
    const o = out();
    expect(o).toMatch(/attack-portscan-fast\s+attack\s+1\s+yes\s+0\s+ports_10s,syn_per_s/);
    expect(o).toMatch(/attack-portscan-slow\s+attack\s+16\s+yes\s+5\s+ports_10s/);
  });

  it('records the constants the design document quotes', () => {
    const c = run({}).consts;
    expect(c).toEqual({ margin: 3, severe: 10, window: 3, hits: 2, quiet: 5, floors: { nontcp_pps: 100, nontcp_bytes: 100000, syn_per_s: 30, ports_10s: 10 } });
  });
});
