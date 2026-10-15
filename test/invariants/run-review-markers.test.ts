/**
 * run-review-markers.test.ts
 * scripts/run-review.sh is the CI review runner: warnings are advisory, critical issues and "never reviewed" fail.
 * These tests execute it against a stub `npm`, pin the two log lines it classifies on, and pin the workflow
 * property the advisory policy depends on: deploy is gated by the deterministic `verify` job.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = readFileSync('scripts/run-review.sh', 'utf8');
const reviewer = readFileSync('scripts/ai-reviewer.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/ai-review.yml', 'utf8');

/** Every `grep -q "..."` pattern the runner uses to classify an exit-1. */
const markers = [...runner.matchAll(/grep -q "([^"]+)"/g)].map((m) => m[1] ?? '');

let stubDir = '';
beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'run-review-stub-'));
});
afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

/** Runs the real script with `npm` replaced by a stub that prints `output` and exits with `code`. */
function runRunner(code: number, output: string): { status: number | null; out: string } {
  const stub = join(stubDir, 'npm');
  writeFileSync(stub, `#!/usr/bin/env bash\necho "stub npm $*"\ncat <<'EOT'\n${output}\nEOT\nexit ${code}\n`);
  chmodSync(stub, 0o755);
  const r = spawnSync('bash', ['scripts/run-review.sh', 'ccie:review:last', 'Review'], {
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('run-review.sh behaviour', () => {
  it('passes without --strict, so the reviewer cannot block on warnings', () => {
    const r = runRunner(0, '## Warnings\n- a warning');
    expect(r.status).toBe(0);
    expect(r.out).toContain('stub npm run ccie:review:last');
    expect(r.out).not.toContain('--strict');
  });

  it('treats exit 2 (warnings only) as advisory if it ever appears', () => {
    const r = runRunner(2, 'warnings');
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning::');
  });

  it('fails and says "not reviewed" when no model produced a verdict', () => {
    const r = runRunner(1, 'x failed: nothing. Fail-closed verification enforced.');
    expect(r.status).toBe(1);
    expect(r.out).toContain('NOT reviewed');
  });

  it('fails and says "critical issues" when the reviewer rejected the change', () => {
    const r = runRunner(1, 'Critical Issues must be resolved before pushing.');
    expect(r.status).toBe(1);
    expect(r.out).toContain('critical issues');
  });

  it('fails on an unrecognised exit 1, and passes any other non-zero status through', () => {
    const crash = runRunner(1, 'boom');
    expect(crash.status).toBe(1);
    expect(crash.out).toContain('NOT reliably reviewed');
    expect(runRunner(137, '').status).toBe(137);
  });
});

describe('log markers the runner classifies on', () => {
  it('extracts the markers it relies on', () => {
    expect(markers).toEqual(['Fail-closed verification enforced', 'Critical Issues must be resolved']);
  });

  it.each(markers)('ai-reviewer.mjs still prints "%s"', (marker) => {
    expect(reviewer).toContain(marker);
  });
});

describe('the advisory policy rests on a deterministic deploy gate', () => {
  /** The text of one top-level job in the workflow. */
  const jobBlock = (name: string): string => {
    const m = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`));
    expect(m, `job ${name} exists`).not.toBeNull();
    return m?.[1] ?? '';
  };

  it('deploy needs the verify job and nothing else', () => {
    expect(jobBlock('deploy')).toMatch(/needs:\s*\[verify\]/);
  });

  it('verify runs types, build and tests with a strict install', () => {
    const v = jobBlock('verify');
    expect(v).toContain('npm run check-types');
    expect(v).toContain('npm run build');
    expect(v).toContain('npm run test');
    expect(v).toMatch(/run:\s*npm ci\s*\n/);
    expect(v).not.toContain('npm install');
  });

  it('the AI review jobs use the runner and are not dependencies of deploy', () => {
    expect(workflow).toContain('bash scripts/run-review.sh');
    expect(jobBlock('deploy')).not.toMatch(/needs:[^\n]*(review|ccie-review)/);
  });
});
