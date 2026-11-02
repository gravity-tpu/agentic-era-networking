/**
 * layout-capacity-harness-revisions.test.ts
 * Every stored layout-capacity run records the hash of the harness that produced it. The table in HARNESS-REVISIONS.md maps each hash to a commit, so a run can be
 * tied to its code after the harness changes. A run whose hash is missing from the table cannot be tied to anything, and the harness on disk must be listed too.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DIR = 'docs/benchmarks/results/layout-capacity';
const TABLE = readFileSync(path.join(DIR, 'HARNESS-REVISIONS.md'), 'utf-8');
const PREFIX_LEN = 16;

function provenanceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return provenanceFiles(p);
    return name === 'provenance.json' ? [p] : [];
  });
}

describe('layout-capacity harness revisions', () => {
  const files = provenanceFiles(DIR);

  it('finds the stored runs', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it('lists the harness hash recorded by every stored run', () => {
    for (const f of files) {
      const rec = JSON.parse(readFileSync(f, 'utf-8')) as { harnessSha256?: string };
      expect(rec.harnessSha256, f).toMatch(/^[0-9a-f]{64}$/);
      expect(TABLE, `${f} records a harness hash that is not in HARNESS-REVISIONS.md`).toContain(`\`${(rec.harnessSha256 as string).slice(0, PREFIX_LEN)}\``);
    }
  });

  it('lists the harness as it is on disk, so the next run can be tied to its code', () => {
    const now = createHash('sha256').update(readFileSync('scripts/layout-capacity-run.py')).digest('hex').slice(0, PREFIX_LEN);
    expect(TABLE).toContain(`\`${now}\``);
  });

  it('can fail: a hash that is not in the table is reported as missing', () => {
    expect(TABLE).not.toContain('`0000000000000000`');
  });
});
