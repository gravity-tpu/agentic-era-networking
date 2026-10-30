import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProposerLoraDataset } from '../../src/sdn/proposer-lora-dataset.js';
import { buildReviewerLoraDataset } from '../../src/sdn/reviewer-lora-dataset.js';
import crypto from 'node:crypto';

function writeDatasetBundle(dir: string): void {
  const dataset = buildProposerLoraDataset();
  fs.mkdirSync(dir, { recursive: true });
  const sftZeroShotBody = dataset.sftZeroShot.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const sftRepairBody = dataset.sftRepair.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const sftCombinedBody = sftZeroShotBody + sftRepairBody;
  const dpoPairsBody =
    dataset.dpoPairs
      .map((p) =>
        JSON.stringify({
          id: p.id,
          scenarioId: p.scenarioId,
          failureCategory: p.failureCategory,
          operator: p.operator,
          prompt: p.prompt,
          chosen: [{ role: 'assistant', content: p.chosen }],
          rejected: [{ role: 'assistant', content: p.rejected }],
          verifierDetails: p.verifierDetails,
        }),
      )
      .join('\n') + '\n';

  fs.writeFileSync(path.join(dir, 'sft-zero-shot.jsonl'), sftZeroShotBody);
  fs.writeFileSync(path.join(dir, 'sft-repair.jsonl'), sftRepairBody);
  fs.writeFileSync(path.join(dir, 'sft-combined.jsonl'), sftCombinedBody);
  fs.writeFileSync(path.join(dir, 'dpo-pairs.jsonl'), dpoPairsBody);

  const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
  const summary = {
    ...dataset.summary,
    gitCommit: '0000000000000000000000000000000000000000',
    wallNs: '1000',
    files: {
      'sft-zero-shot.jsonl': { rows: dataset.sftZeroShot.length, sha256: sha(sftZeroShotBody) },
      'sft-repair.jsonl': { rows: dataset.sftRepair.length, sha256: sha(sftRepairBody) },
      'sft-combined.jsonl': {
        rows: dataset.sftZeroShot.length + dataset.sftRepair.length,
        sha256: sha(sftCombinedBody),
      },
      'dpo-pairs.jsonl': { rows: dataset.dpoPairs.length, sha256: sha(dpoPairsBody) },
    },
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

describe('scripts/train-proposer-lora.py pre-flight verification & Modelfile generation', () => {
  it('validates a clean dataset bundle and emits an Ollama Modelfile under --validate-only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zodiac-lora-ok-'));
    const outDir = path.join(tmpDir, 'out');
    try {
      writeDatasetBundle(tmpDir);
      const stdout = execFileSync(
        'python3',
        ['scripts/train-proposer-lora.py', '--dataset-dir', tmpDir, '--out-dir', outDir, '--validate-only'],
        { encoding: 'utf-8' },
      );
      const res = JSON.parse(stdout) as { ok: boolean; modelfile: string };
      expect(res.ok).toBe(true);
      const modelfileContent = fs.readFileSync(path.join(outDir, 'Modelfile.proposer-lora'), 'utf-8');
      expect(modelfileContent).toContain('FROM qwen3.8:27b');
      expect(modelfileContent).toContain('ADAPTER ');
      expect(modelfileContent).toContain('PARAMETER temperature 0.2');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the pre-flight check can fail: rejects a bundle with a SHA-256 mismatch or a leaked 10.0.2.x address', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zodiac-lora-bad-'));
    const outDir = path.join(tmpDir, 'out');
    try {
      writeDatasetBundle(tmpDir);
      // Corrupt sft-zero-shot.jsonl by appending a space (breaks SHA-256)
      fs.appendFileSync(path.join(tmpDir, 'sft-zero-shot.jsonl'), ' ');
      expect(() =>
        execFileSync(
          'python3',
          ['scripts/train-proposer-lora.py', '--dataset-dir', tmpDir, '--out-dir', outDir, '--validate-only'],
          { encoding: 'utf-8', stdio: 'pipe' },
        ),
      ).toThrow(/sha256/i);

      // Restore valid bundle, then inject a 10.0.2.50 leak and update SHA-256 so only the contamination guard catches it
      writeDatasetBundle(tmpDir);
      const leakedBody =
        fs.readFileSync(path.join(tmpDir, 'sft-zero-shot.jsonl'), 'utf-8').replace('10.10.0.11', '10.0.2.50');
      fs.writeFileSync(path.join(tmpDir, 'sft-zero-shot.jsonl'), leakedBody);
      const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, 'summary.json'), 'utf-8')) as {
        files: Record<string, { rows: number; sha256: string }>;
      };
      summary.files['sft-zero-shot.jsonl']!.sha256 = crypto
        .createHash('sha256')
        .update(leakedBody)
        .digest('hex');
      fs.writeFileSync(path.join(tmpDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

      expect(() =>
        execFileSync(
          'python3',
          ['scripts/train-proposer-lora.py', '--dataset-dir', tmpDir, '--out-dir', outDir, '--validate-only'],
          { encoding: 'utf-8', stdio: 'pipe' },
        ),
      ).toThrow(/10\.0\.2\./);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates a reviewer dataset bundle under --task reviewer and emits Modelfile.reviewer-lora', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zodiac-reviewer-lora-ok-'));
    const outDir = path.join(tmpDir, 'out');
    try {
      const dataset = buildReviewerLoraDataset();
      fs.mkdirSync(tmpDir, { recursive: true });
      const sftBody = dataset.sftExamples.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const dpoBody =
        dataset.dpoPairs
          .map((p) =>
            JSON.stringify({
              id: p.id,
              invariantId: p.invariantId,
              prompt: p.prompt,
              chosen: [{ role: 'assistant', content: p.chosen }],
              rejected: [{ role: 'assistant', content: p.rejected }],
            }),
          )
          .join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, 'sft-reviewer.jsonl'), sftBody);
      fs.writeFileSync(path.join(tmpDir, 'dpo-reviewer.jsonl'), dpoBody);
      const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
      const summary = {
        ...dataset.summary,
        gitCommit: '0000000000000000000000000000000000000000',
        wallNs: '1000',
        files: {
          'sft-reviewer.jsonl': { rows: dataset.sftExamples.length, sha256: sha(sftBody) },
          'dpo-reviewer.jsonl': { rows: dataset.dpoPairs.length, sha256: sha(dpoBody) },
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

      const stdout = execFileSync(
        'python3',
        [
          'scripts/train-proposer-lora.py',
          '--task',
          'reviewer',
          '--dataset-dir',
          tmpDir,
          '--out-dir',
          outDir,
          '--validate-only',
        ],
        { encoding: 'utf-8' },
      );
      const res = JSON.parse(stdout) as { ok: boolean; task: string; modelfile: string };
      expect(res.ok).toBe(true);
      expect(res.task).toBe('reviewer');
      const modelfileContent = fs.readFileSync(path.join(outDir, 'Modelfile.reviewer-lora'), 'utf-8');
      expect(modelfileContent).toContain('FROM qwen3.8:27b');
      expect(modelfileContent).toContain('PARAMETER temperature 0.0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

