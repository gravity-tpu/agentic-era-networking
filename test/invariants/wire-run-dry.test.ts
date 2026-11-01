/**
 * test/invariants/wire-run-dry.test.ts
 * The conformance harness v2 (plan section 16) run end to end with no hardware, on the committed bundle: a perfect-switch rig must agree with the
 * model on every flow (M1) and every admissible set's predicted behaviour must satisfy its intent (M2: A11 and the wire measure are consistent). And
 * the script must refuse to touch the switch without the owner's approval hash.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const BUNDLE = path.join(ROOT, 'docs/benchmarks/results/conformance/bundle-2026-10-31');
const SCRIPT = path.join(ROOT, 'scripts/conformance-run-v2.ts');
const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('conformance-run-v2 --dry-run on the committed bundle', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'wire-dry-'));
  const r = run(['--bundle', BUNDLE, '--out', out, '--dry-run']);
  const summary = JSON.parse(r.stdout) as { ruleSets: number; flowsSent: number; m1Disagree: number; m2NonCompliant: number; stoppedBecause: string | null; bundleIndexSha256: string };
  const index = JSON.parse(readFileSync(path.join(BUNDLE, 'index.json'), 'utf8')) as unknown[];

  it('runs every rule set of the bundle and stops for no reason', () => {
    expect(r.status).toBe(0);
    expect(summary.ruleSets).toBe(index.length);
    expect(summary.flowsSent).toBeGreaterThan(0);
    expect(summary.stoppedBecause).toBeNull();
  });
  it('M1: a perfect switch agrees with the model on every flow', () => {
    expect(summary.m1Disagree).toBe(0);
  });
  it('M2: every admissible set in the bundle predicts intent-compliant behaviour on every chosen flow', () => {
    expect(summary.m2NonCompliant).toBe(0);
  });
  it('records the hash of the bundle it ran', () => {
    expect(summary.bundleIndexSha256).toBe(createHash('sha256').update(readFileSync(path.join(BUNDLE, 'index.json'))).digest('hex'));
  });
});

describe('conformance-run-v2 refuses to touch the switch without the owner\'s approval hash', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'wire-refuse-'));
  it('refuses with no --approve', () => {
    const r = run(['--bundle', BUNDLE, '--out', out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to touch the switch/);
  });
  it('refuses with a hash that is not the bundle\'s', () => {
    const r = run(['--bundle', BUNDLE, '--out', out, '--approve', '0'.repeat(64)]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to touch the switch/);
  });
  it('does not refuse on the hash when it is the bundle\'s (it then fails on the missing tunnel, not on approval)', () => {
    const hash = createHash('sha256').update(readFileSync(path.join(BUNDLE, 'index.json'))).digest('hex');
    const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', SCRIPT, '--bundle', BUNDLE, '--out', out, '--approve', hash, '--limit', '1'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CONFORMANCE_BRIDGE_URL: 'http://127.0.0.1:1' } });
    expect(r.stderr).not.toMatch(/refusing to touch the switch/);
    expect(r.status).not.toBe(0); // no bridge at that address: the run fails closed
  });
});

describe('conformance-run-v2 --ids-file (plan 16.5 repeats)', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'wire-ids-'));
  it('runs exactly the 20 sets of repeats.json', () => {
    const r = run(['--bundle', BUNDLE, '--out', out, '--dry-run', '--ids-file', path.join(BUNDLE, 'repeats.json')]);
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout) as { ruleSets: number; m1Disagree: number; m2NonCompliant: number };
    expect(s.ruleSets).toBe(20);
    expect(s.m1Disagree).toBe(0);
    expect(s.m2NonCompliant).toBe(0);
  });
  it('refuses when the file lists a set that is not in the bundle (nothing is run)', () => {
    const bad = path.join(out, 'bad-ids.json');
    writeFileSync(bad, JSON.stringify({ sets: [{ intent: 'port1-isolation/v1', id: 'no-such-set' }] }));
    const r = run(['--bundle', BUNDLE, '--out', path.join(out, 'bad'), '--dry-run', '--ids-file', bad]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not in the bundle/);
  });
  it('refuses --ids-file combined with --only or --limit, and a file that is not a repeats file', () => {
    const ids = path.join(BUNDLE, 'repeats.json');
    expect(run(['--bundle', BUNDLE, '--out', path.join(out, 'c1'), '--dry-run', '--ids-file', ids, '--only', 'port1']).stderr).toMatch(/cannot be combined/);
    expect(run(['--bundle', BUNDLE, '--out', path.join(out, 'c2'), '--dry-run', '--ids-file', ids, '--limit', '3']).stderr).toMatch(/cannot be combined/);
    const malformed = path.join(out, 'malformed.json');
    writeFileSync(malformed, JSON.stringify({ nope: true }));
    const r = run(['--bundle', BUNDLE, '--out', path.join(out, 'c3'), '--dry-run', '--ids-file', malformed]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a repeats file/);
  });
});
