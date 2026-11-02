/**
 * test/invariants/runpod-network-volume.test.ts
 *
 * Invariant tests for scripts/runpod.ts's network-volume support (`volume-create`, and `create`'s
 * --network-volume-id handling): argument validation must fail closed before any network call, since
 * a network volume has no `timeout`-enforced end the way a pod does -- there is no automatic backstop
 * if a malformed request were ever allowed through to the API.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runCliScript, type CliResult } from '../helpers/run-cli-script.ts';

const REPO_ROOT = path.resolve(__dirname, '../..');

function runScript(args: string[]): CliResult {
  return runCliScript('node', ['--experimental-strip-types', path.join(REPO_ROOT, 'scripts/runpod.ts'), ...args], {
    cwd: REPO_ROOT,
    timeout: 15_000,
    env: { ...process.env, RUNPOD_API_KEY: '' }, // force the no-key path on commands that do reach a network call
  });
}

describe('scripts/runpod.ts volume-create: fails closed on missing/invalid args, before any network call', () => {
  it('requires --name', () => {
    const res = runScript(['volume-create']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--name is required');
  });

  it('requires --size-gb to be a positive integer', () => {
    const res = runScript(['volume-create', '--name', 'x', '--size-gb', 'not-a-number', '--datacenter', 'EU-RO-1']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--size-gb must be a positive integer');
  });

  it('rejects a --size-gb above the documented ceiling', () => {
    const res = runScript(['volume-create', '--name', 'x', '--size-gb', '999999', '--datacenter', 'EU-RO-1']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--size-gb must be in 1..4000');
  });

  it('requires --datacenter', () => {
    const res = runScript(['volume-create', '--name', 'x', '--size-gb', '100']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--datacenter is required');
  });

  it('is dry-run by default: valid args without --yes print the plan and create nothing (no network call)', () => {
    // A network volume has no `timeout`-enforced end, so a mistyped --size-gb/--datacenter here is harder
    // to undo than a bad `create` -- dry-run-by-default is more important here, not less.
    const res = runScript(['volume-create', '--name', 'x', '--size-gb', '100', '--datacenter', 'EU-RO-1']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('dry run: pass --yes to create');
  });
});

describe('scripts/runpod.ts create --network-volume-id: accepts the flag without a usage error', () => {
  it('reaches a network call rather than rejecting --network-volume-id as an unknown flag', () => {
    // This only confirms --network-volume-id parses as a valid flag; it cannot exercise the
    // network-volume lookup itself (networkVolume()) without real credentials, since buildPlan's own
    // GPU-pricing lookup runs first and fails closed on the missing API key before reaching it.
    const res = runScript(['create', '--gpu', 'fake-gpu', '--kind', 'score', '--minutes', '10', '--label', 'x', '--network-volume-id', 'bogus123']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('RUNPOD_API_KEY is not set');
  });
});
