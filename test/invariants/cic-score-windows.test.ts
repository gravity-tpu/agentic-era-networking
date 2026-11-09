/**
 * cic-score-windows.test.ts
 * scripts/cic-score-windows.py turns the CIC-IDS2017 adapter's per-window output (loss, majority label) into
 * per-class alert rates for the deployed sentinel (docs/research/detector-evaluation-plan.md, section 8). A scorer that cannot
 * reject bad input, or that silently drops windows, would make the reported rates meaningless (Invariant 3/4).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/cic-score-windows.py');
const hasNumpy = spawnSync('python3', ['-c', 'import numpy']).status === 0;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('cs', sys.argv[1]); cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)
case = json.loads(sys.argv[2])
if case['op'] == 'score':
    print(json.dumps(cs.score_lines(case['lines'], case.get('day'))))
elif case['op'] == 'wilson':
    print(json.dumps(cs.wilson(case['k'], case['n'])))
elif case['op'] == 'combine':
    print(json.dumps(cs.combine(case['summaries'])))
`;

function run(c: Record<string, unknown>): { status: number; out: any; stderr: string } {
  const r = spawnSync('python3', ['-c', DRIVER, SCRIPT, JSON.stringify(c)], { encoding: 'utf8' });
  let out: any = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { status: r.status ?? 1, out, stderr: r.stderr };
}

const w = (loss: number, label: string | null, matched = 64) => JSON.stringify({ loss, majority_label: label, matched, majority_src_ip: null, window_end_epoch: 1.0 });

describe.skipIf(!hasNumpy)('scripts/cic-score-windows.py', () => {
  it('counts windows per majority label and keeps unlabelled windows out of the rates', () => {
    const lines = [w(0.01, 'BENIGN'), w(0.01, 'BENIGN'), w(0.9, 'DoS Hulk'), w(0.9, 'DoS Hulk'), w(0.01, null, 0)];
    const { status, out } = run({ op: 'score', lines, day: 'Test' });
    expect(status).toBe(0);
    expect(out.day).toBe('Test');
    expect(out.windows_total).toBe(5);
    expect(out.unlabelled_windows).toBe(1);
    expect(out.labels['BENIGN'].windows).toBe(2);
    expect(out.labels['DoS Hulk'].windows).toBe(2);
    expect(out.labels['BENIGN'].static_alerts).toBe(0);
    expect(out.labels['DoS Hulk'].static_alerts).toBe(2);
  });

  it('applies the static 0.15 threshold and the adaptive controller separately', () => {
    const lines = [w(0.14, 'BENIGN'), w(0.15, 'BENIGN'), w(0.16, 'BENIGN')];
    const { out } = run({ op: 'score', lines });
    expect(out.labels['BENIGN'].static_alerts).toBe(2); // loss >= 0.15
    expect(out.labels['BENIGN'].adaptive_alerts).toBeGreaterThanOrEqual(0);
    expect(out.labels['BENIGN'].adaptive_alerts).toBeLessThanOrEqual(3);
  });

  it('runs the adaptive controller continuously across the file, so earlier benign variance raises the later threshold', () => {
    // Benign losses alternate 0.0 and 0.14: the controller's mean and spread rise, so its threshold exceeds 0.15. Attack windows at
    // 0.17 then alert statically (>= 0.15) but not adaptively, because the state carried over from the benign windows is in force.
    const benign = Array.from({ length: 200 }, (_, i) => w(i % 2 === 0 ? 0.0 : 0.14, 'BENIGN'));
    const attack = Array.from({ length: 100 }, () => w(0.17, 'DoS Hulk'));
    const { out } = run({ op: 'score', lines: [...benign, ...attack] });
    expect(out.labels['DoS Hulk'].static_alerts).toBe(100);
    expect(out.labels['DoS Hulk'].adaptive_alerts).toBe(0);
    expect(out.labels['BENIGN'].static_alerts).toBe(0);
  });

  it('does not let an alerting window update the controller (a far-above-threshold attack stays detected throughout)', () => {
    const lines = [...Array(200).fill(0).map(() => w(0.05, 'BENIGN')), ...Array(400).fill(0).map(() => w(0.2, 'DoS Hulk'))];
    const { out } = run({ op: 'score', lines });
    expect(out.labels['DoS Hulk'].adaptive_alerts).toBe(400);
  });

  it('reports false-positive rate on benign windows and precision from the alert counts, with Wilson intervals', () => {
    const lines = [...Array(9).fill(0).map(() => w(0.01, 'BENIGN')), w(0.9, 'BENIGN'), ...Array(4).fill(0).map(() => w(0.9, 'DoS Hulk'))];
    const { out } = run({ op: 'score', lines });
    expect(out.benign.windows).toBe(10);
    expect(out.benign.static_false_positives).toBe(1);
    expect(out.attack.windows).toBe(4);
    expect(out.attack.static_true_positives).toBe(4);
    expect(out.static.precision).toBeCloseTo(4 / 5, 10);
    expect(out.static.recall).toBeCloseTo(1, 10);
    expect(out.static.false_positive_rate.interval95).toHaveLength(2);
  });

  it('refuses a malformed line, naming the line, instead of skipping it', () => {
    const { status, stderr } = run({ op: 'score', lines: [w(0.01, 'BENIGN'), 'not json'] });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/line 2/);
  });

  it('refuses a window with a missing or non-finite loss', () => {
    for (const bad of [JSON.stringify({ majority_label: 'BENIGN', matched: 64 }), JSON.stringify({ loss: 'x', majority_label: 'BENIGN', matched: 64 })]) {
      const { status, stderr } = run({ op: 'score', lines: [bad] });
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/loss/);
    }
  });

  it('refuses an empty input rather than reporting zero rates', () => {
    const { status, stderr } = run({ op: 'score', lines: [] });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/no windows/);
  });

  it('Wilson interval matches known values', () => {
    const { out } = run({ op: 'wilson', k: 4, n: 9 });
    expect(out[0]).toBeCloseTo(0.1888, 3);
    expect(out[1]).toBeCloseTo(0.7334, 3);
    expect(run({ op: 'wilson', k: 0, n: 10 }).out[0]).toBe(0);
  });

  it('combines per-day summaries by summing counts, and refuses mixed settings', () => {
    const a = run({ op: 'score', lines: [w(0.01, 'BENIGN'), w(0.9, 'DoS Hulk')], day: 'A' }).out;
    const b = run({ op: 'score', lines: [w(0.01, 'BENIGN'), w(0.9, 'DoS Hulk'), w(0.9, 'FTP-Patator')], day: 'B' }).out;
    const { out } = run({ op: 'combine', summaries: [a, b] });
    expect(out.windows_total).toBe(5);
    expect(out.labels['DoS Hulk'].windows).toBe(2);
    expect(out.labels['FTP-Patator'].windows).toBe(1);
    expect(out.days).toEqual(['A', 'B']);
    const mixed = run({ op: 'combine', summaries: [a, { ...b, settings: { ...b.settings, static_tau: 0.3 } }] });
    expect(mixed.status).not.toBe(0);
  });

  it('CLI writes a summary file for a windows file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cic-score-'));
    const input = join(dir, 'windows.jsonl');
    writeFileSync(input, [w(0.01, 'BENIGN'), w(0.9, 'DoS Hulk')].join('\n') + '\n');
    const outPath = join(dir, 'summary.json');
    const r = spawnSync('python3', [SCRIPT, '--day', 'Cli', '--out', outPath, input], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const summary = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(summary.day).toBe('Cli');
    expect(summary.windows_total).toBe(2);
  });
});
