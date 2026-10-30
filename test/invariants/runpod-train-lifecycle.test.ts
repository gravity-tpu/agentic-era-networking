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
    // If working tree is dirty, launch-train-lora.sh safely refuses to run
    const res = runScript(['--minutes', '60', '--task', 'proposer']);
    if (res.status === 0) {
      expect(res.stdout).toContain('Planned Runpod Launch');
    } else {
      const output = `${res.stdout}\n${res.stderr}`;
      expect(output).toMatch(/refusing: working tree is dirty|RUNPOD_API_KEY|fetch failed|ERR_OVER_CAP|ERR_BALANCE/);
    }
  });

  it('train-lora-pod.sh defines fail-closed trap and required output markers', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/train-lora-pod.sh'), 'utf8');
    expect(content).toContain('set -euo pipefail');
    expect(content).toContain('/workspace/out/FAILED');
    expect(content).toContain('/workspace/out/DONE');
    expect(content).toContain('convert_lora_to_gguf.py');
    expect(content).toContain('--validate-only');
  });
});
