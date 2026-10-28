/**
 * test/invariants/docs-only-skip-paths.test.ts
 * Pins that the pre-push hook's docs-only AI-review skip (.agents/hooks/pre-push,
 * `is_docs_only_push`) and CI's docs-only skip (.github/workflows/ai-review.yml's `paths-ignore`)
 * stay in sync. They are two separately-written path lists meant to express the same policy
 * ("a documentation-only change does not need an AI review call"); if one changes without the
 * other, local pushes and CI silently diverge on which pushes get reviewed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

interface AiReviewWorkflow {
  on: {
    push: { 'paths-ignore': string[] };
    pull_request: { 'paths-ignore': string[] };
  };
}

function isAiReviewWorkflow(doc: unknown): doc is AiReviewWorkflow {
  if (!doc || typeof doc !== 'object') return false;
  const on = (doc as Record<string, unknown>).on;
  if (!on || typeof on !== 'object') return false;
  const push = (on as Record<string, unknown>).push;
  const pullRequest = (on as Record<string, unknown>).pull_request;
  const pushIgnore = push && typeof push === 'object' ? (push as Record<string, unknown>)['paths-ignore'] : undefined;
  const prIgnore = pullRequest && typeof pullRequest === 'object' ? (pullRequest as Record<string, unknown>)['paths-ignore'] : undefined;
  return Array.isArray(pushIgnore) && Array.isArray(prIgnore);
}

function workflowPathsIgnore(): string[] {
  const doc = parseYaml(readFileSync(path.resolve(REPO_ROOT, '.github/workflows/ai-review.yml'), 'utf-8'));
  if (!isAiReviewWorkflow(doc)) {
    throw new Error('.github/workflows/ai-review.yml did not parse into the expected on.push/on.pull_request paths-ignore shape -- the workflow may have been restructured; update this test.');
  }
  const pushIgnore = doc.on.push['paths-ignore'];
  const prIgnore = doc.on.pull_request['paths-ignore'];
  expect(prIgnore).toEqual(pushIgnore); // the workflow itself should not already be inconsistent
  return pushIgnore;
}

/** Extracts the glob list from the bash `case "$f" in *.md|.gitignore|scratch/*|.env*) ;; *) return 1 ;; esac`
 * pattern in is_docs_only_push, without a bash parser -- the case arm is a single pipe-delimited line. */
function prePushDocsOnlyGlobs(): string[] {
  const hook = readFileSync(path.resolve(REPO_ROOT, '.agents/hooks/pre-push'), 'utf-8');
  const match = hook.match(/is_docs_only_push\(\)[\s\S]*?case "\$f" in\s*\n\s*(\S+)\)\s*;;/);
  if (!match) throw new Error('Could not find the is_docs_only_push case-pattern arm in .agents/hooks/pre-push -- the function may have been restructured; update this test\'s regex.');
  return match[1].split('|');
}

/** Normalizes a GitHub Actions paths-ignore glob to the equivalent bash extglob-free case pattern
 * used in is_docs_only_push (both lists express the same policy with different glob dialects).
 * Supports only the two forms currently in paths-ignore: a leading `**\/` (directory-agnostic
 * match, e.g. `**\/*.md`) and a trailing `**` (prefix match, e.g. `scratch/**`); a mid-path `**`
 * would need another rule here and is not currently used by either list. */
function normalize(glob: string): string {
  return glob.replace(/^\*\*\//, '').replace(/\*\*$/, '*');
}

describe('Docs-only AI-review skip: pre-push hook and CI workflow must agree', () => {
  it('is_docs_only_push (.agents/hooks/pre-push) covers the same paths as paths-ignore (.github/workflows/ai-review.yml)', () => {
    const workflowGlobs = workflowPathsIgnore().map(normalize).sort();
    const hookGlobs = prePushDocsOnlyGlobs().sort();
    expect(hookGlobs).toEqual(workflowGlobs);
  });
});
