/**
 * test/helpers/run-cli-script.ts
 * Shared helper for tests that invoke a CLI script as a subprocess and assert on its exit code,
 * stdout and stderr. Node's execFileSync throws an object with status/stdout/stderr attached on a
 * non-zero exit, but TypeScript's Error type does not model that shape -- a bare `as { status?,
 * stdout?, stderr? }` cast on the caught `unknown` value is a loose cast that bypasses the type
 * system (Invariant 1: no suppression). This narrows with a real type guard instead, and an
 * unrecognized error shape is re-thrown rather than silently treated as "the script exited 1".
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ExecFileSyncError {
  readonly status?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

// Requires all three fields, not just one: Node's execFileSync always attaches status, stdout AND stderr
// together on a non-zero exit, so requiring all three (rather than any one) narrows this to that specific,
// well-known error shape instead of matching any incidental object that happens to carry one of the names.
function isExecFileSyncError(err: unknown): err is ExecFileSyncError {
  return typeof err === 'object' && err !== null && 'status' in err && 'stdout' in err && 'stderr' in err;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return '';
}

/** Runs `command args...` and returns its result; a non-zero exit is captured, not thrown, so callers
 * can assert on stdout/stderr/status directly. An error shape execFileSync does not actually produce
 * (no status/stdout/stderr at all) is re-thrown -- that is a real, unexpected failure (e.g. the binary
 * itself is missing), not a script-level exit the test should treat as a normal failure case. */
export function runCliScript(command: string, args: readonly string[], options: ExecFileSyncOptions = {}): CliResult {
  try {
    const stdout = execFileSync(command, args as string[], { encoding: 'utf8', ...options });
    return { status: 0, stdout: toText(stdout), stderr: '' };
  } catch (err: unknown) {
    if (!isExecFileSyncError(err)) throw err;
    const status = typeof err.status === 'number' ? err.status : 1;
    return { status, stdout: toText(err.stdout), stderr: toText(err.stderr) };
  }
}
