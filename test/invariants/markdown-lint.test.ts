import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('Invariant: Markdown Documentation Quality & Linting', () => {
  it('ensures all repository markdown files strictly pass markdownlint with zero errors', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    let output = '';
    try {
      output = execFileSync(
        'npx',
        ['markdownlint', '-c', '.markdownlint.json', '**/*.md', '--ignore', 'node_modules'],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message: string };
      const combined = `${execError.stdout || ''}\n${execError.stderr || ''}`;
      throw new Error(`Markdown linting violations detected:\n${combined || execError.message}`);
    }

    expect(output.trim()).toBe('');
  });
});
