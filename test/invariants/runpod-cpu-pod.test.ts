/**
 * test/invariants/runpod-cpu-pod.test.ts
 *
 * Invariant tests for scripts/runpod.ts's CPU Pod support (--kind compile, --cpu-flavor, --vcpu-count):
 * Docker-in-Docker, which the Hailo Dataflow Compiler pipeline needs to load and run the Hailo AI
 * Software Suite image, is documented as supported on Runpod CPU Pods only, never GPU Pods -- these
 * tests pin that --kind compile and --cpu-flavor are mutually required, and that GPU-only flags/kinds
 * reject a --cpu-flavor rather than silently ignoring it (which would risk a surprise GPU-priced pod).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { placementFor } from '../../src/infra/runpod-budget.ts';
import { runCliScript, type CliResult } from '../helpers/run-cli-script.ts';

const REPO_ROOT = path.resolve(__dirname, '../..');

function runScript(args: string[]): CliResult {
  return runCliScript('node', ['--experimental-strip-types', path.join(REPO_ROOT, 'scripts/runpod.ts'), ...args], {
    cwd: REPO_ROOT,
    timeout: 15_000,
    env: { ...process.env, RUNPOD_API_KEY: '' },
  });
}

describe('src/infra/runpod-budget.ts: compile placement is always Secure Cloud, never spot', () => {
  it('places compile on Secure Cloud, not interruptible', () => {
    const placement = placementFor('compile');
    expect(placement.cloud).toBe('secure');
    expect(placement.interruptible).toBe(false);
  });

  it('rejects --on-demand and --spot for compile (CPU Pods have no community rate or spot option)', () => {
    expect(() => placementFor('compile', { onDemand: true })).toThrow(/ERR_PLACEMENT/);
    expect(() => placementFor('compile', { spot: true })).toThrow(/ERR_PLACEMENT/);
  });
});

describe('scripts/runpod.ts: --kind compile and --cpu-flavor are mutually required', () => {
  it('rejects --kind compile without --cpu-flavor', () => {
    const res = runScript(['plan', '--kind', 'compile', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--kind compile requires --cpu-flavor');
  });

  it('rejects --cpu-flavor on a non-compile kind, rather than silently ignoring it', () => {
    const res = runScript(['plan', '--kind', 'score', '--cpu-flavor', 'cpu5c', '--gpu', 'fake-gpu', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--cpu-flavor is only valid with --kind compile');
  });

  it('accepts --kind compile with --cpu-flavor (reaches the CPU pricing network call, not a usage error)', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('RUNPOD_API_KEY is not set');
  });

  it('rejects --gpu together with --cpu-flavor instead of silently ignoring --gpu', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--gpu', 'fake-gpu', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--gpu is not valid with --cpu-flavor');
  });
});

describe('scripts/runpod.ts: --vcpu-count is bounded (Invariant 5)', () => {
  it('rejects --vcpu-count 0', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--vcpu-count', '0', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--vcpu-count must be in 1..64');
  });

  it('rejects --vcpu-count above the documented ceiling', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--vcpu-count', '65', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--vcpu-count must be in 1..64');
  });

  it('rejects a non-integer --vcpu-count', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--vcpu-count', 'lots', '--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--vcpu-count must be a positive integer');
  });

  it('RUNPOD_MAX_VCPU_COUNT raises the ceiling (Invariant 5: configurable, not just bounded)', () => {
    const res = runScript(['plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--vcpu-count', '100', '--minutes', '30']);
    expect(res.stderr).toContain('--vcpu-count must be in 1..64');
    const raised = runCliScript('node', ['--experimental-strip-types', path.join(REPO_ROOT, 'scripts/runpod.ts'), 'plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--vcpu-count', '100', '--minutes', '30'], {
      cwd: REPO_ROOT,
      timeout: 15_000,
      env: { ...process.env, RUNPOD_API_KEY: '', RUNPOD_MAX_VCPU_COUNT: '128' },
    });
    expect(raised.stderr).not.toContain('--vcpu-count must be in');
    expect(raised.stderr).toContain('RUNPOD_API_KEY is not set'); // passed validation, reached the network call
  });

  it('RUNPOD_MAX_VCPU_COUNT rejects a non-positive-integer override', () => {
    const res = runCliScript('node', ['--experimental-strip-types', path.join(REPO_ROOT, 'scripts/runpod.ts'), 'plan', '--kind', 'compile', '--cpu-flavor', 'cpu5c', '--minutes', '30'], {
      cwd: REPO_ROOT,
      timeout: 15_000,
      env: { ...process.env, RUNPOD_API_KEY: '', RUNPOD_MAX_VCPU_COUNT: 'not-a-number' },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('RUNPOD_MAX_VCPU_COUNT must be a positive integer');
  });
});

// The --image-required-for-compile guard (cmdCreate) only runs after buildPlan's network calls and the --yes
// gate, both of which need real or mocked API responses this test suite has no infrastructure for yet. Rather
// than keep a source-text-only assertion standing in for a behavioral test (flagged twice by the pre-push
// review as providing false confidence), it's removed here; the guard itself is short and directly readable
// in scripts/runpod.ts. Revisit with a real fetch-mocking harness if this script grows enough to warrant one.
