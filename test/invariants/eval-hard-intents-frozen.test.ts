import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { intentSha256 } from '../../src/sdn/intent-hash.js';
import { HARD_INTENTS } from '../../src/sdn/intents-hard.js';

/**
 * The four additional intents of plan section 13, pinned the moment they were registered (2026-10-31), before any model saw them. If this test fails
 * you have changed a specification that results will be recorded against: do not just update the hash. A changed intent needs a new plan version
 * (docs/research/evaluation-plan.md); agent-eval summaries record `intentSha256` so a result says which version of the question it answered.
 */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  ['quarantine-set/v1', '4ffb9034c07ddaf36270b2f4aba139bfa42f5a64dd8ce45e8703c69b8486b3cc'],
  ['dns-quarantine/v1', '901373f347bf3016dca51f94dc5b774adcc9738a225d588768f84cbf847ea63f'],
  ['uplink-arp-confinement/v1', '7edbe5b9f8eac5f880732c442954f8ed6c39c3589db177306147b90bdd2adc6a'],
  ['per-host-allowlist/v1', '5f63de59f58257e391df6cd4ffca0479a8ba6a0464ab5f62ce9aa29378d3a526'],
];

describe('the additional intents are pinned', () => {
  it('there are exactly four, in plan order', () => {
    expect(HARD_INTENTS.map((s) => s.id)).toEqual(PINNED.map(([id]) => id));
  });
  for (const [id, hash] of PINNED) {
    it(`${id} still has the pinned specification`, () => {
      const spec = HARD_INTENTS.find((s) => s.id === id)!;
      expect(intentSha256(spec)).toBe(hash);
    });
  }
  it('the pin can fail: changing a description or the clause order changes the hash', () => {
    const spec = HARD_INTENTS[0]!;
    expect(intentSha256({ ...spec, description: spec.description + ' ' })).not.toBe(intentSha256(spec));
    expect(intentSha256({ ...spec, clauses: spec.clauses.slice().reverse() })).not.toBe(intentSha256(spec));
  });
});

describe('scripts/agent-eval.ts knows the additional intents (checked before any network or git call)', () => {
  function run(intent: string): string {
    try {
      execFileSync('node', ['--experimental-strip-types', '--no-warnings', 'scripts/agent-eval.ts', '--intent', intent, '--n', '1', '--out', '/tmp/agent-eval-hard-intent-test'], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
      return '';
    } catch (e) {
      return (e as { stderr?: string }).stderr ?? '';
    }
  }
  for (const [id] of PINNED) {
    it(`accepts ${id} (fails later, on a missing required argument, exactly as an evaluated intent does)`, () => {
      const err = run(id);
      expect(err).not.toContain('unknown intent');
      expect(err).toMatch(/missing --(host|model)/);
    });
  }
  it('still rejects an unknown intent and lists the known ones, including the new ones', () => {
    const err = run('quarantine-set/v2');
    expect(err).toContain('unknown intent quarantine-set/v2');
    for (const [id] of PINNED) expect(err).toContain(id);
  });
});
