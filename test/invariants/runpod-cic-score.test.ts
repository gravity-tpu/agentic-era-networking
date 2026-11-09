/**
 * runpod-cic-score.test.ts
 * Invariants for scripts/runpod/launch-cic-score.sh and cic-score-pod.sh (docs/research/detector-evaluation-plan.md section 8):
 * the launcher fails closed on bad arguments, is a dry run without --yes, always terminates its pod and bounds its poll loop;
 * the pod script verifies every download against the mirror's size and sha256 and reports failure instead of continuing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runCliScript } from '../helpers/run-cli-script.ts';

const ROOT = path.resolve(__dirname, '../..');
const LAUNCHER = path.join(ROOT, 'scripts/runpod/launch-cic-score.sh');
const POD = path.join(ROOT, 'scripts/runpod/cic-score-pod.sh');
const run = (args: string[]) => runCliScript('bash', [LAUNCHER, ...args], { cwd: ROOT, timeout: 30_000 });

describe('launch-cic-score.sh', () => {
  it('fails closed when --minutes is missing or not a positive integer', () => {
    expect(run([]).stderr).toContain('--minutes is required');
    for (const bad of ['0', '-5', 'x', '1.5']) {
      const r = run(['--minutes', bad]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--minutes must be a positive integer');
    }
  });

  it('rejects unknown arguments', () => {
    expect(run(['--minutes', '10', '--bogus']).stderr).toContain('unknown arg');
  });

  it('is a dry run unless --yes is given, always terminates its pod, and bounds the poll loop', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    expect(src).toMatch(/if \[ -z "\$YES" \]; then[\s\S]*?exit 0/);
    expect(src).toContain("trap cleanup EXIT");
    expect(src).toContain('"${RP[@]}" terminate "$POD"');
    expect(src).toContain('MAX_POLLS=');
    expect(src).toMatch(/\[ "\$POLL_COUNT" -lt "\$MAX_POLLS" \]/);
    expect(src).toContain('refusing: working tree is dirty');
  });

  it('uploads only the repo bundle (no adapter) and runs the CIC pod script', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    expect(src).not.toContain('ADAPTER_SRC');
    expect(src).toContain('cic-score-pod.sh');
  });
});

describe('cic-score-pod.sh', () => {
  const src = readFileSync(POD, 'utf8');
  it('fails closed: set -e with ERR and EXIT traps that leave a FAILED marker', () => {
    expect(src).toContain('set -Eeuo pipefail');
    expect(src).toMatch(/trap .*ERR/);
    expect(src).toContain('/workspace/out/FAILED');
  });
  it('verifies size and sha256 of every download against the mirror metadata', () => {
    expect(src).toContain('hashlib.sha256');
    expect(src).toContain('sha256 mismatch');
    expect(src).toContain('os.path.getsize');
  });
  it('runs each day with errexit in the child shell and refuses to combine after a failed day', () => {
    expect(src).toMatch(/score_day\(\) \{[^}]*set -Eeuo pipefail/);
    expect(src).toContain('a day failed; not combining');
  });
  it('uses the unmodified adapter and the scorer, and never the Hugging Face token', () => {
    expect(src).toContain('scripts/cic-ids2017-adapter.py');
    expect(src).toContain('scripts/cic-score-windows.py');
    expect(src).not.toMatch(/HF_TOKEN|HUGGING_FACE_HUB_TOKEN/);
  });
});
