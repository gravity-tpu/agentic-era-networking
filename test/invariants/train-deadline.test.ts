/**
 * train-deadline.test.ts
 * The wall-clock deadline of scripts/train-proposer-lora.py and the failure ordering of scripts/runpod/train-lora-pod.sh (Invariants 2, 3, 5).
 * A pod time limit must not be able to destroy a long training run, and an optional conversion must not be able to destroy a finished one.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const TRAINER = path.join(ROOT, 'scripts/train-proposer-lora.py');
const POD = readFileSync(path.join(ROOT, 'scripts/runpod/train-lora-pod.sh'), 'utf8');
const LAUNCH = readFileSync(path.join(ROOT, 'scripts/runpod/launch-train-lora.sh'), 'utf8');

function py(code: string): string {
  return execFileSync('python3', ['-I', '-c', code], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
}

const LOAD = `
import importlib.util
spec = importlib.util.spec_from_file_location("trainer", "scripts/train-proposer-lora.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Base:
    def __init__(self): pass
class Control:
    should_training_stop = False
`;

describe('make_deadline_callback', () => {
  it('does not stop before the deadline, stops at it, and stays stopped (injected monotonic clock)', () => {
    const out = py(`${LOAD}
now = [0]
cb = m.make_deadline_callback(Base, 100, clock=lambda: now[0])
res = []
for t in (0, 99, 100, 101):
    now[0] = t
    c = Control()
    cb.on_step_end(None, None, c)
    res.append((t, c.should_training_stop, cb.stopped))
print(res)`);
    expect(out.trim()).toBe('[(0, False, False), (99, False, False), (100, True, True), (101, True, True)]');
  });
  it('the check can fail: a deadline already in the past stops on the first step', () => {
    const out = py(`${LOAD}
cb = m.make_deadline_callback(Base, 0, clock=lambda: 5)
c = Control(); cb.on_step_end(None, None, c); print(c.should_training_stop)`);
    expect(out.trim()).toBe('True');
  });
  it('the SFT stage gets a named integer share of the budget, the DPO stage the rest', () => {
    const out = py(`${LOAD}
print(m.SFT_BUDGET_SHARE_PERCENT, m.MAX_TIME_BUDGET_SECONDS)`);
    expect(out.trim()).toBe('45 86400');
  });
});

describe('--time-budget-seconds', () => {
  const run = (v: string) => {
    try {
      execFileSync('python3', ['-I', TRAINER, '--dataset-dir', '/nonexistent', '--out-dir', '/tmp/train-deadline-test', '--validate-only', '--time-budget-seconds', v], { encoding: 'utf8', cwd: ROOT, stdio: 'pipe', timeout: 30_000 });
      return '';
    } catch (e) {
      return (e as { stderr?: string }).stderr ?? '';
    }
  };
  it('rejects a negative budget and one above the ceiling, before touching any dataset', () => {
    expect(run('-1')).toContain('--time-budget-seconds must be 0 to 86400');
    expect(run('86401')).toContain('--time-budget-seconds must be 0 to 86400');
  });
  it('accepts a valid budget (fails later, on the missing dataset)', () => {
    expect(run('7800')).not.toContain('--time-budget-seconds');
  });
});

describe('train-lora-pod.sh ordering and failure handling', () => {
  it('upgrades the Python packages instead of leaving an older transformers in place', () => {
    expect(POD).toMatch(/pip install -q -U transformers peft trl/);
  });
  it('passes the budget through to the trainer', () => {
    expect(POD).toContain('--time-budget-seconds "$TIME_BUDGET_SECONDS"');
    expect(LAUNCH).toContain("TIME_BUDGET_SECONDS='$TIME_BUDGET_SECONDS'");
    expect(LAUNCH).toContain('--time-budget-seconds) TIME_BUDGET_SECONDS=');
  });
  it('stages the trained adapter before the GGUF conversion runs', () => {
    expect(POD.indexOf('cp -r "$work_dir/dpo-adapter" "$target_out/"')).toBeGreaterThan(0);
    expect(POD.indexOf('cp -r "$work_dir/dpo-adapter" "$target_out/"')).toBeLessThan(POD.indexOf('convert_lora_to_gguf.py'));
  });
  it('a failed conversion is not fatal but is never silent: it writes an explicit marker and a log line', () => {
    expect(POD).toMatch(/if python3 "\$W\/llama\.cpp\/convert_lora_to_gguf\.py"/);
    expect(POD).toContain('GGUF-CONVERSION-FAILED-${role}');
    expect(POD).toContain('WARN: GGUF conversion failed');
  });
  it('still fails closed on a training failure and writes DONE only at the end', () => {
    expect(POD).toMatch(/set -E?euo pipefail/);
    expect(POD).toContain("trap 'echo \"step failed at line $LINENO\" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR");
    expect(POD.lastIndexOf('touch "$OUT/DONE"')).toBeGreaterThan(POD.indexOf('train_and_convert "proposer"'));
  });
});
