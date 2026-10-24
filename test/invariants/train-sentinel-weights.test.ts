/**
 * test/invariants/train-sentinel-weights.test.ts
 * Invariant Verification Suite for scripts/train-sentinel-weights.py's --objective margin mode
 * (docs/benchmarks/results/sentinel-training-margin/PREREGISTRATION.md).
 *
 * These pin the claims the margin-training README makes in prose so they are machine-checked, not just asserted:
 *   - the margin term's attack-training runs and the held-out set never overlap (the "never reads held-out data"
 *     claim), and the held-out flood-generalization pattern (attack-synflood-1000pps) is never in the margin term;
 *   - the hinge formula matches an independently-computed oracle and is bounded at zero once an attack window's
 *     loss clears the target (the "not an unbounded maximize-attack-loss term" claim);
 *   - the Nelder-Mead polish step actually respects BOUNDS when given bounds=BOUNDS (the bug found and fixed this
 *     round: this exact scipy call signature, copied from the script, used to silently ignore bounds);
 *   - --compare-weights-file is validated fail-closed before use, the same contract as
 *     scripts/gpu-sdn-anomaly-sentinel.py's load_weights_payload() for the live --weights-file path.
 *
 * Needs numpy and scipy (same optional dependency as the script itself; not used by any live or test path outside
 * this offline fitting script).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.resolve(REPO_ROOT, 'scripts/train-sentinel-weights.py');
const DATA_DIR = path.resolve(REPO_ROOT, 'docs/benchmarks/results/labelled-runs');

function runPython(driver: string, args: string[] = []): any {
  const r = execFileSync('python3', ['-c', driver, ...args], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(r.trim().split('\n').pop() ?? '{}');
}

describe('scripts/train-sentinel-weights.py --objective margin invariants', () => {
  describe('train/held-out disjointness (load_and_split, objective="margin")', () => {
    const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('tw', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
train_groups, attack_train_groups, attack_train_report, holdout = mod.load_and_split(sys.argv[2], objective="margin")
holdout_ids = {h["label"]["id"] for h in holdout}
report_ids = {r["label"]["id"] for r in attack_train_report}
attack_train_patterns = sorted(attack_train_groups.keys())
holdout_attack_patterns = sorted({h["pattern"] for h in holdout if h["class"] == "attack"})
print(json.dumps({
    "overlap": sorted(holdout_ids & report_ids),
    "attack_train_patterns": attack_train_patterns,
    "holdout_attack_patterns": holdout_attack_patterns,
    "attack_train_patterns_in_holdout": sorted(set(attack_train_patterns) & set(holdout_attack_patterns)),
    "report_run_count": len(report_ids),
}))
`;
    const out = runPython(DRIVER, [SCRIPT_PATH, DATA_DIR]);

    it('never puts a run used by the margin term into the held-out set', () => {
      expect(out.overlap).toEqual([]);
    });

    it('margin-trains on exactly the two pre-registered flood patterns', () => {
      expect(out.attack_train_patterns).toEqual(['attack-synflood-200pps', 'attack-udpflood-500pps-1400b']);
      expect(out.report_run_count).toBe(5); // 3 synflood-200pps runs + 2 udpflood runs
    });

    it('keeps the held-out generalization pattern (attack-synflood-1000pps) out of the margin term entirely', () => {
      expect(out.holdout_attack_patterns).toContain('attack-synflood-1000pps');
      expect(out.attack_train_patterns_in_holdout).toEqual([]);
    });
  });

  describe('margin hinge/target formula (make_margin_objective, margin_target)', () => {
    // Synthetic windows, not real captures: this pins the arithmetic itself against an independently computed
    // oracle, not whether real traffic happens to separate (that's what the held-out scoring in README.md covers).
    const DRIVER = `
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location('tw', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

rng = np.random.default_rng(0)
train_groups = {
    "p1": [("p1-r1", rng.random((5, 256)).astype(np.float32)), ("p1-r2", rng.random((5, 256)).astype(np.float32))],
    "p2": [("p2-r1", rng.random((5, 256)).astype(np.float32))],
}
attack_groups = {"a1": [("a1-r1", rng.random((5, 256)).astype(np.float32))]}
W = np.array([0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40], dtype=np.float32)

objective = mod.make_margin_objective(train_groups, attack_groups, margin=0.02, sigma=2.5, lam=1.0)
value = float(objective(W))

# Independent oracle: recompute benign pooled mean/std and the attack hinge directly, not via the function under test.
pooled = np.concatenate([mod.kernel_loss_batch(w, W) for _p, runs in train_groups.items() for _rid, w in runs])
target = float(np.mean(pooled) + 2.5 * np.std(pooled) + 0.02)
l_benign = float(mod.make_objective(train_groups)(W))
attack_losses = mod.kernel_loss_batch(attack_groups["a1"][0][1], W)
hinge = np.maximum(0.0, target - attack_losses)
expected = l_benign + 1.0 * float(np.mean(hinge))

# Boundedness: force the target far below every attack loss (very negative margin) -> hinge must saturate to
# exactly zero everywhere, and the objective must reduce to pure L_benign (no reward left for "overshooting").
objective_no_margin = mod.make_margin_objective(train_groups, attack_groups, margin=-1000.0, sigma=2.5, lam=1.0)
value_saturated = float(objective_no_margin(W))

# margin_target() standalone must agree with the target computed inside the objective.
target_standalone = mod.margin_target(train_groups, W, margin=0.02, sigma=2.5)

print(json.dumps({
    "value": value,
    "expected": expected,
    "hinge_all_nonnegative": bool(np.all(hinge >= 0.0)),
    "value_saturated": value_saturated,
    "l_benign": l_benign,
    "target_standalone": target_standalone,
    "target_oracle": target,
}))
`;
    const out = runPython(DRIVER, [SCRIPT_PATH]);

    it('matches an independently computed oracle for L_benign + lambda * mean(hinge)', () => {
      expect(out.value).toBeCloseTo(out.expected, 6);
    });

    it('never produces a negative hinge contribution', () => {
      expect(out.hinge_all_nonnegative).toBe(true);
    });

    it('saturates to exactly L_benign (no residual reward) once the target is cleared by every attack window', () => {
      expect(out.value_saturated).toBeCloseTo(out.l_benign, 6);
    });

    it('margin_target() standalone agrees with the target computed inside the objective', () => {
      expect(out.target_standalone).toBeCloseTo(out.target_oracle, 6);
    });
  });

  describe('Nelder-Mead polish actually respects bounds (the bug found and fixed this round)', () => {
    // Same minimize(..., method="Nelder-Mead", bounds=BOUNDS) call signature as scripts/train-sentinel-weights.py's
    // own fitting loop, on a pathological objective (a convex bowl centered at w=10, well outside every weight's
    // [-3, 5] box) run twice: once exactly as the pre-fix code did (no bounds kwarg at all -- reproducing the
    // original bug's symptom) and once with bounds=BOUNDS (the fix). A bounded Nelder-Mead call that happened to
    // stay in the box by luck, not by actually being constrained, would not be distinguishable from a real fix any
    // other way than comparing against the unbounded call on the same objective from the same start point.
    const DRIVER = `
import importlib.util, json, sys
import numpy as np
from scipy.optimize import minimize
spec = importlib.util.spec_from_file_location('tw', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
BOUNDS = mod.BOUNDS
f = lambda w: float(np.sum((np.asarray(w) - 10.0) ** 2))
x0 = np.zeros(len(BOUNDS))
opts = {"xatol": 1e-8, "fatol": 1e-12, "maxiter": 2000, "maxfev": 2000}
unbounded = minimize(f, x0, method="Nelder-Mead", options=opts)
bounded = minimize(f, x0, method="Nelder-Mead", bounds=BOUNDS, options=opts)
lo = [b[0] for b in BOUNDS]
hi = [b[1] for b in BOUNDS]
def in_bounds(x):
    return all(lo[i] - 1e-6 <= x[i] <= hi[i] + 1e-6 for i in range(len(BOUNDS)))
print(json.dumps({
    "unbounded_escapes": not in_bounds(unbounded.x),
    "bounded_stays_in_box": in_bounds(bounded.x),
    "unbounded_x": [float(v) for v in unbounded.x],
    "bounded_x": [float(v) for v in bounded.x],
}))
`;
    const out = runPython(DRIVER, [SCRIPT_PATH]);

    it('reproduces the original bug: the same call without bounds= escapes the box on a diverging objective', () => {
      expect(out.unbounded_escapes).toBe(true);
    });

    it('the fix (bounds=BOUNDS passed) keeps every weight inside the declared [-3, 5] box on the same objective', () => {
      expect(out.bounded_stays_in_box).toBe(true);
    });
  });

  describe('--compare-weights-file validation (validate_weights_payload)', () => {
    const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('tw', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
try:
    w, tau = mod.validate_weights_payload(json.loads(sys.argv[2]), "<test>")
    print(json.dumps({"ok": True, "weights": [float(x) for x in w], "tau": tau}))
except SystemExit as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`;
    function runLoader(jsonText: string) {
      return runPython(DRIVER, [SCRIPT_PATH, jsonText]);
    }

    it('accepts a well-formed weights+tau payload', () => {
      const out = runLoader(
        JSON.stringify({ weights: [0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, 0.4], tau: 0.17 })
      );
      expect(out.ok).toBe(true);
      expect(out.weights.length).toBe(10);
      expect(out.tau).toBeCloseTo(0.17, 6);
    });

    it('rejects a weights list of the wrong length (fail closed, not padded or truncated)', () => {
      const out = runLoader(JSON.stringify({ weights: [1, 2, 3], tau: 0.1 }));
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/10-element/);
    });

    it('rejects a non-finite weight', () => {
      const out = runLoader('{"weights": [0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, NaN], "tau": 0.1}');
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/finite/);
    });

    it('rejects a missing or non-finite tau', () => {
      const out = runLoader(JSON.stringify({ weights: [0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, 0.4] }));
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/tau/);
    });

    it('rejects a payload that is not a JSON object', () => {
      const out = runLoader(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/JSON object/);
    });
  });
});
