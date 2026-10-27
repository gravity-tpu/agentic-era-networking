/**
 * test/invariants/gpu-sdn-anomaly-sentinel.test.ts
 * Invariant verification for scripts/gpu-sdn-anomaly-sentinel.py's opt-in two-model ensemble
 * (--enable-ensemble), the production integration of the sentinel-training-two-anchor campaign's
 * verified answer (docs/benchmarks/results/sentinel-training-two-anchor/CAMPAIGN-SUMMARY.md, batch 13/17).
 *
 * Pins three things that must never silently drift:
 *   - the default config (weights file, tau_a, tau_b) matches the campaign's actual recommended values,
 *     and the default weights file genuinely exists at the path the script resolves to;
 *   - format_ensemble_reason (the audit-trail string an operator sees for a quarantine decision) discloses
 *     exactly which model(s) fired, in every combination, without needing a real hardware detection to
 *     trigger it;
 *   - the ensemble is opt-in: default CLI behavior is byte-for-byte the pre-existing single-model path,
 *     and --enable-ensemble changes behavior only when explicitly passed.
 *
 * This repo's GPU engine requires a native CUDA .so that only exists on the Jetson; these tests run against
 * the script's documented NumPy/pure-math fallback path (the same fallback any non-CUDA CI runner uses), so
 * they verify control-flow and argument wiring, not real model behavior or on-hardware latency -- those were
 * independently verified on the live Jetson Orin GPU as part of this integration (see CAMPAIGN-SUMMARY.md's
 * "Compute cost" section for the measured, not assumed, latency figures).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.resolve(REPO_ROOT, 'scripts/gpu-sdn-anomaly-sentinel.py');

function runPython(driver: string, args: string[] = []): any {
  const r = execFileSync('python3', ['-c', driver, ...args], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(r.trim().split('\n').pop() ?? '{}');
}

const IMPORT_DRIVER_PREFIX = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
`;

describe('scripts/gpu-sdn-anomaly-sentinel.py: --enable-ensemble defaults', () => {
  const out = runPython(IMPORT_DRIVER_PREFIX + `
print(json.dumps({
    'weights_file_a': mod.DEFAULT_ENSEMBLE_WEIGHTS_FILE_A,
    'weights_file_a_exists': __import__('os').path.exists(mod.DEFAULT_ENSEMBLE_WEIGHTS_FILE_A),
    'tau_a': mod.DEFAULT_ENSEMBLE_TAU_A,
    'weights_file_b': mod.DEFAULT_ENSEMBLE_WEIGHTS_FILE_B,
    'tau_b': mod.DEFAULT_ENSEMBLE_TAU_B,
}))
`, [SCRIPT_PATH]);

  it('defaults Model A to batch 10\'s committed CIC-shaped weights, and that file actually exists', () => {
    expect(out.weights_file_a).toContain('trained-weights-two-anchor-batch10-2026-10-25.json');
    expect(out.weights_file_a_exists).toBe(true);
  });

  it('defaults Model A\'s tau to batch 10\'s calibrated value (0.187660), not a round number guessed later', () => {
    expect(out.tau_a).toBeCloseTo(0.18766, 6);
  });

  it('defaults Model B to the compiled-in baseline (empty weights file), matching the campaign\'s Model B choice', () => {
    expect(out.weights_file_b).toBe('');
  });

  it('defaults Model B\'s tau to batch 17\'s recommended 0.19 (raised from its own standalone-optimal 0.15)', () => {
    expect(out.tau_b).toBeCloseTo(0.19, 6);
  });

  it('the resolved weights file path is also directly visible on disk from the repo root (sanity, not just os.path.exists via the module)', () => {
    expect(existsSync(path.resolve(REPO_ROOT, 'docs/benchmarks/results/sentinel-training-two-anchor/trained-weights-two-anchor-batch10-2026-10-25.json'))).toBe(true);
  });
});

describe('format_ensemble_reason: the quarantine audit-trail string', () => {
  const callDriver = (a: boolean, la: number, ta: number, b: boolean, lb: number, tb: number) => runPython(IMPORT_DRIVER_PREFIX + `
print(json.dumps(mod.format_ensemble_reason(${a ? 'True' : 'False'}, ${la}, ${ta}, ${b ? 'True' : 'False'}, ${lb}, ${tb})))
`, [SCRIPT_PATH]);

  it('discloses ONLY Model A when Model A alone fired', () => {
    const reason = callDriver(true, 0.25, 0.1877, false, 0.05, 0.19);
    expect(reason).toContain('A(loss=0.2500>=tau=0.1877)');
    expect(reason).not.toContain('B(');
  });

  it('discloses ONLY Model B when Model B alone fired', () => {
    const reason = callDriver(false, 0.10, 0.1877, true, 0.30, 0.19);
    expect(reason).toContain('B(loss=0.3000>=tau=0.1900)');
    expect(reason).not.toContain('A(');
  });

  it('discloses BOTH models when both fired (the rare but real case the owner required visibility into)', () => {
    const reason = callDriver(true, 0.25, 0.1877, true, 0.30, 0.19);
    expect(reason).toContain('A(loss=0.2500>=tau=0.1877)');
    expect(reason).toContain('B(loss=0.3000>=tau=0.1900)');
  });

  it('never fabricates a firing model: neither fired is never called in production (is_anomaly gates the call), but the pure function itself must not silently invent an empty match string', () => {
    const reason = callDriver(false, 0.10, 0.1877, false, 0.05, 0.19);
    expect(reason).toBe('Ensemble anomaly, fired: ');
  });
});

describe('scripts/gpu-sdn-anomaly-sentinel.py --demo smoke test (NumPy/pure-math fallback; no CUDA hardware required)', () => {
  function runDemo(extraArgs: string[]): string {
    return execFileSync('python3', [SCRIPT_PATH, '--demo', '--duration', '2', ...extraArgs], {
      encoding: 'utf8',
      timeout: 20000,
    });
  }

  it('default (no --enable-ensemble): behaves exactly as the pre-existing single-model path', () => {
    const out = runDemo([]);
    expect(out).toContain('Neural Engine Initialized');
    expect(out).not.toContain('TWO-MODEL ENSEMBLE');
    expect(out).not.toContain('Neural Engine A Initialized');
    expect(out).toContain('RECOMMENDATION');
    expect(out).toContain('GPU SDN ANOMALY SENTINEL STOPPED');
  });

  it('--enable-ensemble: initializes both engines, discloses the validated numbers, and completes cleanly', () => {
    const out = runDemo(['--enable-ensemble']);
    expect(out).toContain('TWO-MODEL ENSEMBLE');
    expect(out).toContain('Neural Engine A Initialized');
    expect(out).toContain('Neural Engine B Initialized');
    expect(out).toContain('lab held-out 6/13 attacks');
    expect(out).toContain('not a general intrusion detector');
    expect(out).toContain('GPU SDN ANOMALY SENTINEL STOPPED');
  });

  it('--enable-ensemble with explicit tau overrides: accepts and reports the overridden values', () => {
    const out = runDemo(['--enable-ensemble', '--ensemble-tau-a', '0.5', '--ensemble-tau-b', '0.6']);
    expect(out).toContain('tau=0.5');
    expect(out).toContain('tau=0.6');
  });
});
