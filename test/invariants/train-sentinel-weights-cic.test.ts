/**
 * test/invariants/train-sentinel-weights-cic.test.ts
 * Invariant Verification Suite for scripts/train-sentinel-weights-cic.py, this round's CIC-IDS2017-augmented
 * margin training (docs/benchmarks/results/sentinel-training-margin-cic/PREREGISTRATION.md). Pins the claims that
 * document makes in prose so they are machine-checked:
 *   - the pre-registered scope constants (which CIC labels train the margin term, which are held out) match what
 *     the pre-registration document says, so the two cannot silently drift apart;
 *   - score_cic_block's window-level recall/false-positive-rate and attacker-IP-agreement arithmetic matches an
 *     independently-computed oracle, including its n=0 ("bucket never collected") edge case;
 *   - score_cic_block feeds windows through a FRESH Adaptive() each call (no state leaking between conditions
 *     scored against the same block), the same per-call-reset contract scripts/score-labelled-runs.py's
 *     sentinel_alerts() already has per run.
 *
 * Needs numpy and scipy (same optional dependency as scripts/train-sentinel-weights.py); none of this needs the
 * multi-gigabyte pcap files or scripts/cic-flood-margin-sampler.py's .npz output to be present - everything here
 * uses small inline fixtures built directly against score_cic_block.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.resolve(REPO_ROOT, 'scripts/train-sentinel-weights-cic.py');
const hasScipy = spawnSync('python3', ['-c', 'import numpy, scipy']).status === 0;

function runPython(driver: string, args: string[] = []): any {
  const r = execFileSync('python3', ['-c', driver, ...args], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(r.trim().split('\n').pop() ?? '{}');
}

describe.skipIf(!hasScipy)('scripts/train-sentinel-weights-cic.py', () => {
  describe('pre-registered scope constants', () => {
    const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print(json.dumps({
    'train_labels': list(mod.CIC_TRAIN_LABELS),
    'holdout_wed_labels': list(mod.CIC_HOLDOUT_WED_LABELS),
    'holdout_fri_labels': list(mod.CIC_HOLDOUT_FRI_LABELS),
    'known_attacker_ip': mod.KNOWN_ATTACKER_IP,
}))
`;
    const out = runPython(DRIVER, [SCRIPT_PATH]);

    it('trains the margin term on exactly DoS Hulk and DoS GoldenEye (the two highest-volume flood classes)', () => {
      expect(out.train_labels).toEqual(['DoS Hulk', 'DoS GoldenEye']);
    });

    it('holds out DoS Slowhttptest and DoS slowloris (same-day, different mechanism) from Wednesday', () => {
      expect(out.holdout_wed_labels).toEqual(['DoS Slowhttptest', 'DoS slowloris']);
    });

    it('holds out DDoS (different day, different tool) from Friday', () => {
      expect(out.holdout_fri_labels).toEqual(['DDoS']);
    });

    it('never trains or holds out on PortScan, Bot, or Heartbleed (out of scope per the pre-registration)', () => {
      const allLabels = [...out.train_labels, ...out.holdout_wed_labels, ...out.holdout_fri_labels];
      expect(allLabels).not.toContain('PortScan');
      expect(allLabels).not.toContain('Bot');
      expect(allLabels).not.toContain('Heartbleed');
    });

    it('uses the independently-verified CIC attacker IP, not a different or re-guessed value', () => {
      expect(out.known_attacker_ip).toBe('172.16.0.1');
    });

    it('never puts a margin-training label into either held-out list (no leakage between the two pools)', () => {
      const trainSet = new Set(out.train_labels);
      const holdoutSet = new Set([...out.holdout_wed_labels, ...out.holdout_fri_labels]);
      const overlap = [...trainSet].filter((l) => holdoutSet.has(l));
      expect(overlap).toEqual([]);
    });
  });

  describe('score_cic_block', () => {
    const DRIVER = `
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location('m', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
sr = mod.sr

# Weights/tau chosen so kernel_loss is predictable isn't needed: we bypass kernel_loss entirely by monkeypatching
# kernel_loss_batch with an oracle that returns a fixed, caller-supplied loss array, so this test pins
# score_cic_block's OWN arithmetic (alert-count / attacker-IP-agreement bookkeeping, Adaptive wiring), not whether a
# real feature vector happens to produce a particular loss - that is covered by self_check/the real training run.
# score_cic_block returns integer counts only (n, alerts, named_correct) - no stored float rate; pct() is tested
# separately below as the one place a percentage is ever computed, for display only.
fixed_losses = np.array(json.loads(sys.argv[2]), dtype=np.float32)
mod.tw.kernel_loss_batch = lambda X, W: fixed_losses
n = len(fixed_losses)
features = np.zeros((n, mod.WINDOW_FEATURES), dtype=np.float32)  # never read by the oracle above
src_ips = np.array(json.loads(sys.argv[3]), dtype=object)
base_tau = float(sys.argv[4])
res = mod.score_cic_block(features, src_ips, np.zeros(10, dtype=np.float32), base_tau,
                           known_attacker_ip=sys.argv[5] if sys.argv[5] != '' else None)
print(json.dumps(res))
`;

    it('computes integer window-level alert and attacker-IP-agreement counts against an independent oracle', () => {
      // base_tau=0.15: a fresh sr.Adaptive(tau=0.15) starts with m=tau*0.75=0.1125, v=(tau*0.15)^2=0.000506,
      // so its very first threshold is max(0.15, 0.1125 + 2.5*sqrt(0.000506)) = max(0.15, 0.1687) = 0.1687.
      // Losses: [0.20 (alerts, attacker), 0.20 (alerts, attacker), 0.05 (no alert; EMA updates toward 0.05),
      //          0.01 (no alert), 0.25 (alerts, non-attacker src)] -> 3 alerts out of 5, 2/3 from the known attacker.
      const losses = [0.2, 0.2, 0.05, 0.01, 0.25];
      const srcIps = ['172.16.0.1', '172.16.0.1', '10.0.0.1', '10.0.0.1', '203.0.113.9'];
      const out = runPython(DRIVER, [SCRIPT_PATH, JSON.stringify(losses), JSON.stringify(srcIps), '0.15', '172.16.0.1']);
      expect(out.n).toBe(5);
      expect(out.alerts).toBe(3);
      expect(out.named_correct).toBe(2);
      expect(out).not.toHaveProperty('alert_rate');
      expect(out).not.toHaveProperty('named_correct_rate');
    });

    it('reports an n=0 bucket (a CIC label never collected) distinctly, with named_correct null not 0', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH, '[]', '[]', '0.15', '172.16.0.1']);
      expect(out.n).toBe(0);
      expect(out.alerts).toBe(0);
      expect(out.named_correct).toBeNull();
    });

    it('omits the named_correct field entirely for a benign (generalization-check) block', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH, '[0.05, 0.3]', '["10.0.0.1", "10.0.0.2"]', '0.15', '']);
      expect(out.n).toBe(2);
      expect(out).not.toHaveProperty('named_correct');
    });

    it('reports named_correct=0 (not null, not a divide-by-zero) when nothing alerts at all', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH, '[0.01, 0.01, 0.01]', '["172.16.0.1", "172.16.0.1", "172.16.0.1"]', '0.9', '172.16.0.1']);
      expect(out.alerts).toBe(0);
      expect(out.named_correct).toBe(0);
    });
  });

  describe('pct (the one place a display percentage is ever computed from the integer counts)', () => {
    const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print(json.dumps(mod.pct(int(sys.argv[2]), int(sys.argv[3]))))
`;
    it('formats a normal ratio to two decimal places', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH, '11561', '20000']);
      expect(out).toBe('57.80%');
    });

    it('reports 0/0 as an explicit n/a, not NaN% or a ZeroDivisionError', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH, '0', '0']);
      expect(out).toBe('n/a (0 windows)');
    });
  });

  describe('score_cic_block resets Adaptive state per call (no cross-condition leakage)', () => {
    const DRIVER = `
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location('m', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
losses = np.array([0.2, 0.2, 0.2, 0.2, 0.2], dtype=np.float32)
mod.tw.kernel_loss_batch = lambda X, W: losses
features = np.zeros((5, 256), dtype=np.float32)
src_ips = np.array([''] * 5, dtype=object)
first = mod.score_cic_block(features, src_ips, np.zeros(10, dtype=np.float32), 0.15)
second = mod.score_cic_block(features, src_ips, np.zeros(10, dtype=np.float32), 0.15)
print(json.dumps({'first_alerts': first['alerts'], 'second_alerts': second['alerts']}))
`;
    it('scores an identical block the same way on a second call (a fresh Adaptive, not one warmed up by the first call)', () => {
      const out = runPython(DRIVER, [SCRIPT_PATH]);
      expect(out.second_alerts).toBe(out.first_alerts);
    });
  });
});
