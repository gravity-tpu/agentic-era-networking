/**
 * agent-eval-partial-log.test.ts
 * scripts/agent-eval.ts writes trials.jsonl only when a run ends, so a pod killed by its time limit lost every finished trial (seen 2026-10-30).
 * Each trial of the sequential loop is now also appended to trials.partial.jsonl the moment it finishes. The behaviour itself was checked end to
 * end against a fake Ollama server (a clean tree is required to run the script, so it cannot run inside this test); this pins where it happens.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.resolve(__dirname, '../../scripts/agent-eval.ts'), 'utf8');

describe('agent-eval trials.partial.jsonl', () => {
  it('appends each finished trial of the sequential loop, right after it is recorded and before the progress line', () => {
    const push = SRC.indexOf("lines.push(JSON.stringify(record));\n      // Salvage log");
    const append = SRC.indexOf("fs.appendFile(path.join(args.out, 'trials.partial.jsonl')");
    const progress = SRC.indexOf('process.stderr.write(`seed ${seed}/${args.n}');
    expect(push).toBeGreaterThan(0);
    expect(append).toBeGreaterThan(push);
    expect(progress).toBeGreaterThan(append);
  });
  it('still writes the complete trials.jsonl and summary.json at the end', () => {
    expect(SRC).toContain("path.join(args.out, 'trials.jsonl')");
    expect(SRC).toContain("path.join(args.out, 'summary.json')");
  });
});
