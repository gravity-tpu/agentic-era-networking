/**
 * test-typecheck-config.test.ts
 * The tests are type-checked: `npm run check-types` (the pre-push gate and CI both run it) includes tsconfig.test.json. That config keeps every safety flag of the main
 * one and relaxes only the three lint-style flags below; a test that loosened the config to make an error go away would defeat Invariant 1 (fix the type, do not mask it).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface TsConfig { extends?: string; compilerOptions?: Record<string, unknown>; include?: string[]; exclude?: string[] }
const read = (p: string): TsConfig => JSON.parse(readFileSync(p, 'utf-8')) as TsConfig;

const MAIN = read('tsconfig.json');
const TEST = read('tsconfig.test.json');

/** The only options the test config may set differently from the main one for the sake of the tests: no emit, the DOM lib and vitest globals, importing .ts, JS imports, no declaration output. */
const MAY_DIFFER_FOR_TOOLING = ['noEmit', 'rootDir', 'lib', 'types', 'allowImportingTsExtensions', 'allowJs', 'checkJs', 'declaration', 'declarationMap', 'sourceMap'];
/** Lint-style flags relaxed for tests, and nothing else. */
const RELAXED = ['noPropertyAccessFromIndexSignature', 'noUnusedLocals', 'noUnusedParameters'];

describe('the test type-check configuration', () => {
  it('extends the main config and checks the test files as well as the source', () => {
    expect(TEST.extends).toBe('./tsconfig.json');
    expect(TEST.include).toEqual(expect.arrayContaining(['src/**/*', 'test/**/*']));
    expect(TEST.exclude ?? []).not.toContain('test/**/*');
  });

  it('keeps every safety flag of the main config: it only relaxes the lint-style flags, set to false', () => {
    const own = TEST.compilerOptions ?? {};
    for (const [k, v] of Object.entries(own)) {
      if (MAY_DIFFER_FOR_TOOLING.includes(k)) continue;
      expect(RELAXED, `unexpected option ${k} in tsconfig.test.json`).toContain(k);
      expect(v, k).toBe(false);
    }
    // And the main config really is strict, so inheriting it means something.
    for (const k of ['strict', 'noImplicitAny', 'strictNullChecks', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) expect(MAIN.compilerOptions?.[k], k).toBe(true);
  });

  it('is part of check-types, which the gate and CI run', () => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf-8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['check-types']).toContain('tsconfig.test.json');
  });
});
