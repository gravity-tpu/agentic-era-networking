/**
 * test/invariants/runpod-train-lifecycle.test.ts
 *
 * Invariant tests for the Runpod LoRA training launch lifecycle:
 * - Verifies that training placement strictly mandates Secure Cloud On-Demand (Invariant 4).
 * - Verifies argument parsing and fail-closed bounds on launch-train-lora.sh (Invariant 3).
 * - Verifies train-lora-pod.sh syntax and fail-closed error trapping.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { placementFor } from '../../src/infra/runpod-budget.ts';

const REPO_ROOT = path.resolve(__dirname, '../..');

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [path.join(REPO_ROOT, 'scripts/runpod/launch-train-lora.sh'), ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('Runpod LoRA Training Lifecycle Invariants', () => {
  it('enforces that training placement policy is strictly Secure Cloud On-Demand (Invariant 4)', () => {
    const placement = placementFor('train');
    expect(placement.cloud).toBe('secure');
    expect(placement.interruptible).toBe(false);
  });

  it('fails closed when --minutes is missing', () => {
    const res = runScript([]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--minutes is required');
  });

  it('fails closed on invalid --task argument', () => {
    const res = runScript(['--minutes', '60', '--task', 'invalid-task']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--task must be proposer, reviewer, or both');
  });

  it('dry-run execution without --yes plans the training launch safely', () => {
    // If the working tree is dirty, or there is no .env.local (a fresh worktree or CI), launch-train-lora.sh stops before any API call
    const res = runScript(['--minutes', '60', '--task', 'proposer']);
    if (res.status === 0) {
      expect(res.stdout).toContain('Planned Runpod Launch');
    } else {
      const output = `${res.stdout}\n${res.stderr}`;
      expect(output).toMatch(/refusing: working tree is dirty|RUNPOD_API_KEY|\.env\.local: not found|fetch failed|ERR_OVER_CAP|ERR_BALANCE/);
    }
  });

  it('train-lora-pod.sh defines fail-closed trap and required output markers', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/train-lora-pod.sh'), 'utf8');
    expect(content).toMatch(/set -E?euo pipefail/);
    expect(content).toContain('/workspace/out/FAILED');
    expect(content).toContain('/workspace/out/DONE');
    expect(content).toContain('convert_lora_to_gguf.py');
    // llama.cpp's convert_lora_to_gguf.py takes --outfile, not -o (the adapter GGUF conversion failed on that flag, 2026-10-31).
    expect(content).toMatch(/convert_lora_to_gguf\.py[\s\S]{0,300}--outfile/);
    expect(content).not.toMatch(/convert_lora_to_gguf\.py[\s\S]{0,300}\s-o\s/);
    expect(content).toContain('--validate-only');
  });

  it('launch-train-lora.sh pulls partial results on every exit path, not just final success', () => {
    // Before this fix, the FAILED, unexpected-terminal-status, and poll-budget-exhausted branches all exited 1
    // without ever downloading /workspace/out -- losing every training checkpoint even though the pod was still
    // reachable at the moment of the check. `pull_partial` must be defined and called from all four exit sites:
    // the per-iteration poll, the TERMINATED/EXITED/CANCELLED branch, the poll-budget-exhausted branch, and the
    // final success path (the FAILED branch relies on the per-iteration pull immediately preceding its check).
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-train-lora.sh'), 'utf8');
    expect(content).toMatch(/pull_partial\(\)\s*\{/);
    const callSites = content.match(/^\s*pull_partial\s*$/gm) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    // mkdir -p "$OUT" must happen before the polling loop starts, not only after it (the old final-only download
    // created $OUT right before its one scp call, which is too late for any of the incremental pulls to land in).
    const mkdirIndex = content.indexOf('mkdir -p "$OUT"');
    const loopIndex = content.indexOf('while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]');
    expect(mkdirIndex).toBeGreaterThan(-1);
    expect(mkdirIndex).toBeLessThan(loopIndex);
  });

  it('surfaces the real scp error instead of discarding it with 2>/dev/null, and bounds the connection', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-train-lora.sh'), 'utf8');
    const fnStart = content.indexOf('pull_partial() {');
    const fnEnd = content.indexOf('\n}', fnStart);
    const fnBody = content.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('2>/dev/null');
    expect(fnBody).toContain('2>&1');
    expect(fnBody).toContain('ConnectTimeout');
  });

  it('GPU retry loop guards against an empty IP/port from ssh-target and uses a monotonic SSH-readiness deadline', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-train-lora.sh'), 'utf8');
    expect(content).toMatch(/read -r IP PORT < <\("\$\{RP\[@\]\}" ssh-target "\$POD"\) && \[ -n "\$IP" \] && \[ -n "\$PORT" \]/);
    // $(date +%s) as the deadline arithmetic is wall-clock and not monotonic (NTP steps can shift it); SECONDS is
    // a monotonic bash counter. (A prose mention of "date +%s" in an explanatory comment is fine and must not
    // trip this -- only the old buggy arithmetic form, `$(date +%s)`, is checked for.)
    expect(content).not.toMatch(/ssh_ready\(\)[\s\S]{0,400}\$\(date \+%s\)/);
    expect(content).toMatch(/ssh_ready\(\)[\s\S]{0,200}\$SECONDS/);
  });

  it('dry-run exits non-zero if every GPU candidate was refused, instead of always exiting 0', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-train-lora.sh'), 'utf8');
    const dryRunStart = content.indexOf('if [ -z "$YES" ]; then');
    const dryRunEnd = content.indexOf('\nfi', dryRunStart);
    const dryRunBody = content.slice(dryRunStart, dryRunEnd);
    expect(dryRunBody).toMatch(/any_ok=1/);
    expect(dryRunBody).toMatch(/\[ "\$any_ok" = 1 \] \|\|.*exit 1/);
  });
});
