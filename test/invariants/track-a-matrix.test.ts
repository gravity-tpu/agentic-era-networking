/**
 * test/invariants/track-a-matrix.test.ts
 * docs/research/track-a-ci-matrix.md names, for each Track A property, source modules and tests. This test fails if a file it names does not exist,
 * if a property A1 to A11 has no row, or if a row names no test (except A9, a decision and not a check).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MATRIX = readFileSync(path.join(ROOT, 'docs/research/track-a-ci-matrix.md'), 'utf8');
const rowsOf = (text: string): string[] => text.split('\n').filter((l) => /^\| A\d+ /.test(l));
const filesIn = (text: string): string[] => [...text.matchAll(/`((?:src|test)\/[A-Za-z0-9_./-]+\.ts)`/g)].map((m) => m[1] as string);
const missingFiles = (text: string): string[] => filesIn(text).filter((f) => !existsSync(path.join(ROOT, f)));
const rows = rowsOf(MATRIX);
const PROPERTIES = Array.from({ length: 11 }, (_, i) => `A${i + 1}`);

describe('track-a CI matrix', () => {
  it('has a row for every property A1 to A11, in order', () => {
    expect(rows.map((r) => /^\| (A\d+) /.exec(r)?.[1])).toEqual(PROPERTIES);
  });

  it('every file named in a row exists', () => {
    expect(filesIn(MATRIX).length).toBeGreaterThan(20);
    expect(missingFiles(MATRIX)).toEqual([]);
  });

  it('every row except A9 (a decision) names at least one test', () => {
    for (const r of rows) {
      const id = /^\| (A\d+) /.exec(r)?.[1];
      if (id === 'A9') continue;
      expect(/`test\/invariants\/[A-Za-z0-9_.-]+\.test\.ts`/.test(r), `${id} names no test`).toBe(true);
    }
  });

  it('can fail: the same checker finds a missing file and a missing row in a broken copy of the matrix', () => {
    const broken = MATRIX.replace('`src/sdn/install-gate.ts`', '`src/sdn/no-such-module.ts`');
    expect(missingFiles(broken)).toContain('src/sdn/no-such-module.ts');
    expect(rowsOf(MATRIX.split('\n').filter((l) => !l.startsWith('| A5 ')).join('\n')).length).toBe(PROPERTIES.length - 1);
  });
});
