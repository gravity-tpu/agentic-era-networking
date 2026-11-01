/**
 * test/invariants/runpod-eval-lifecycle.test.ts
 *
 * Invariant tests for scripts/runpod/launch-eval-lora.sh:
 * - Verifies argument parsing fails closed (Invariant 3).
 * - Verifies the incremental partial-result pull fix: a pod that becomes UNREACHABLE (preempted, hits the
 *   in-container `timeout`, loses network) must not lose every trial since the launch began. Before this fix,
 *   the only download was a single scp after the poll loop exited, which fails outright once the pod is actually
 *   unreachable -- losing every trial scripts/agent-eval.ts had already appended to trials.partial.jsonl.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [path.join(REPO_ROOT, 'scripts/runpod/launch-eval-lora.sh'), ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('Runpod LoRA Eval Lifecycle Invariants', () => {
  it('fails closed when --minutes is missing', () => {
    const res = runScript([]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--minutes is required');
  });

  it('pulls results incrementally during the poll loop, not only once at the end', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-eval-lora.sh'), 'utf8');
    expect(content).toMatch(/pull_results\(\)\s*\{/);

    const pollLoopStart = content.indexOf('while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]; do');
    const pollLoopEnd = content.indexOf('\ndone', pollLoopStart);
    expect(pollLoopStart).toBeGreaterThan(-1);
    expect(pollLoopEnd).toBeGreaterThan(pollLoopStart);
    const loopBody = content.slice(pollLoopStart, pollLoopEnd);
    expect(loopBody).toMatch(/^\s*pull_results\s*$/m);

    // Must NOT be gated on state != UNREACHABLE: the one SSH health check that reported UNREACHABLE can itself
    // be a transient glitch, and skipping the pull in exactly that case defeats the point of this fix.
    expect(loopBody).not.toMatch(/if \[ "\$state" != UNREACHABLE \]; then/);

    // $OUT must be created before the loop starts (the old code only mkdir'd it after the loop exited, which is
    // too late for an in-loop pull to have anywhere to land).
    const mkdirIndex = content.indexOf('mkdir -p "$OUT"');
    expect(mkdirIndex).toBeGreaterThan(-1);
    expect(mkdirIndex).toBeLessThan(pollLoopStart);

    // Called once more after the loop exits (covers the final DONE/FAILED/UNREACHABLE transition).
    const afterLoop = content.slice(pollLoopEnd);
    expect(afterLoop).toMatch(/^pull_results$/m);
  });

  it('surfaces the real scp error instead of discarding it with 2>/dev/null', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-eval-lora.sh'), 'utf8');
    const fnStart = content.indexOf('pull_results() {');
    const fnEnd = content.indexOf('\n}', fnStart);
    const fnBody = content.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('2>/dev/null');
    expect(fnBody).toContain('2>&1');
  });

  it('validates --minutes is a positive integer before using it in poll-loop arithmetic', () => {
    const res = runScript(['--minutes', 'not-a-number']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--minutes must be a positive integer');
  });

  it('bounds the poll loop (Invariant 5: no unbounded wait), matching launch-train-lora.sh\'s pattern', () => {
    // Before this fix, launch-eval-lora.sh polled in a bare `while true` with no iteration ceiling of its own --
    // launch-train-lora.sh already had a MAX_POLLS bound (ported in the same effort as the GPU-retry logic), and
    // this closes the asymmetry the pre-push review caught.
    const content = readFileSync(path.join(REPO_ROOT, 'scripts/runpod/launch-eval-lora.sh'), 'utf8');
    expect(content).not.toMatch(/while true; do/);
    expect(content).toMatch(/MAX_POLLS=\$\(\( \(MINUTES \* 60 \/ POLL_SECONDS\) \+ 15 \)\)/);
    expect(content).toMatch(/while \[ "\$POLL_COUNT" -lt "\$MAX_POLLS" \]; do/);
  });
});
