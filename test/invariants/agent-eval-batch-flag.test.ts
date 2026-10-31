/**
 * agent-eval-batch-flag.test.ts
 * Pins scripts/agent-eval.ts's --batch flag validation: batch mode is scoped to --provider anthropic and
 * --protocol A only (see the module docstring's "Batch mode" section for why), and that scope check must run
 * before any network call or billable action. These three cases all throw from parseArgs(), before the script's
 * git-clean-working-tree check, so they run regardless of the repo's working-tree state at test time.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

function runAgentEval(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync('node', ['--experimental-strip-types', 'scripts/agent-eval.ts', ...args], { encoding: 'utf8', timeout: 15_000 });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? '' };
  }
}

describe('scripts/agent-eval.ts --batch: scope validation runs before any network/git check', () => {
  it('rejects --batch with --provider gemini', () => {
    const { status, stderr } = runAgentEval(['--provider', 'gemini', '--batch', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test', '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--batch is only implemented for --provider anthropic');
  });

  it('rejects --batch with --provider ollama', () => {
    const { status, stderr } = runAgentEval(['--provider', 'ollama', '--batch', '--intent', 'dns-confinement/v1', '--n', '1', '--host', 'http://127.0.0.1:1', '--out', '/tmp/agent-eval-batch-test']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--batch is only implemented for --provider anthropic');
  });

  it('rejects --batch with --provider llama', () => {
    const { status, stderr } = runAgentEval(['--provider', 'llama', '--batch', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--batch is only implemented for --provider anthropic');
  });

  it('rejects --batch with --protocol B without --allow-multi-round', () => {
    const { status, stderr } = runAgentEval(['--provider', 'anthropic', '--protocol', 'B', '--batch', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test', '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--batch requires --protocol A');
  });

  it('accepts --batch with --protocol B when --allow-multi-round is specified', () => {
    const { stderr } = runAgentEval(['--provider', 'anthropic', '--protocol', 'B', '--batch', '--allow-multi-round', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test', '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(stderr).not.toContain('--batch requires --protocol A');
    expect(stderr).toContain('missing --model');
  });

  it('accepts --provider llama with default host (fails later on missing --model)', () => {
    const { stderr } = runAgentEval(['--provider', 'llama', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test']);
    expect(stderr).not.toContain('--provider must be');
    expect(stderr).toContain('missing --model');
  });

  it('accepts --batch with --provider anthropic and the default --protocol A (fails later, on --model, not on scope)', () => {
    const { stderr } = runAgentEval(['--provider', 'anthropic', '--batch', '--intent', 'dns-confinement/v1', '--n', '1', '--out', '/tmp/agent-eval-batch-test', '--price-in-cents', '1', '--price-out-cents', '1', '--max-cents', '1', '--price-note', 'x']);
    expect(stderr).not.toContain('--batch is only implemented for');
    expect(stderr).not.toContain('--batch requires --protocol A');
    expect(stderr).toContain('missing --model'); // confirms scope validation passed; failed on the next missing arg instead
  });
});
