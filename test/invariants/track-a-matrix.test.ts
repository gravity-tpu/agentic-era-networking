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
const LABELS = ['enforced before install', 'checked at readback only', 'decided not needed'];
const labelOf = (row: string): string => (row.split('|')[2] ?? '').trim();
const labelProblem = (row: string): string | null => (LABELS.some((l) => labelOf(row).startsWith(l)) ? null : `label is not one of: ${LABELS.join('; ')}`);
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

  it('every row carries one of the three labels, so no property is described as enforced without saying where', () => {
    for (const r of rows) {
      const id = /^\| (A\d+) /.exec(r)?.[1];
      expect(labelProblem(r), `${id}: ${labelOf(r)}`).toBeNull();
    }
    expect(MATRIX.split('\n').find((l) => l.startsWith('| Property '))).toContain('| Label |');
  });

  it('A9 is the only property labelled decided not needed, and A3 and A8 say what their label does not cover', () => {
    const labels = Object.fromEntries(rows.map((r) => [/^\| (A\d+) /.exec(r)?.[1], labelOf(r)]));
    expect(Object.entries(labels).filter(([, l]) => l.startsWith('decided not needed')).map(([k]) => k)).toEqual(['A9']);
    expect(labels['A3']).toMatch(/readback/);
    expect(labels['A8']).toMatch(/target is declared/);
  });

  it('can fail: a row with no label, or one outside the vocabulary, is reported', () => {
    expect(labelProblem(rows[0]!.replace(labelOf(rows[0]!), ''))).not.toBeNull();
    expect(labelProblem(rows[0]!.replace(labelOf(rows[0]!), 'mostly enforced'))).not.toBeNull();
  });

  it('can fail: the same checker finds a missing file and a missing row in a broken copy of the matrix', () => {
    const broken = MATRIX.replace('`src/sdn/install-gate.ts`', '`src/sdn/no-such-module.ts`');
    expect(missingFiles(broken)).toContain('src/sdn/no-such-module.ts');
    expect(rowsOf(MATRIX.split('\n').filter((l) => !l.startsWith('| A5 ')).join('\n')).length).toBe(PROPERTIES.length - 1);
  });
});
