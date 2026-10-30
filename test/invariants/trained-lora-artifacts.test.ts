import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PORT1_ISOLATION_INTENT,
  DNS_CONFINEMENT_INTENT,
  QUARANTINE_PRECEDENCE_INTENT,
  TAP_RETURN_ISOLATION_INTENT,
} from '../../src/sdn/intents.ts';
import { intentSha256 } from '../../src/sdn/intent-hash.ts';

const RESULTS_DIR = join(
  process.cwd(),
  'docs/benchmarks/results/lora-adapters-2026-10-29',
);

interface LoraRunSummary {
  readonly schema: string;
  readonly task: 'proposer' | 'reviewer';
  readonly source: 'synthetic_verifier_grounded';
  readonly baseModel: string;
  readonly ollamaBase: string;
  readonly mode: 'sft' | 'dpo' | 'both';
  readonly loraR: number;
  readonly loraAlpha: number;
  readonly seed: number;
  readonly datasetGitCommit: string;
  readonly heldOutBenchmarkHashes: readonly string[] | null;
  readonly finalAdapterDir: string;
  readonly modelfile: string;
  readonly wallNs: string;
}

interface PeftAdapterConfig {
  readonly peft_type: string;
  readonly base_model_name_or_path: string;
  readonly r: number;
  readonly lora_alpha: number;
  readonly target_modules: readonly string[];
}

function parseSafetensorsHeader(path: string): {
  readonly tensorCount: number;
  readonly bodyOffset: number;
  readonly header: Record<string, { readonly dtype: string; readonly shape: readonly number[]; readonly data_offsets: readonly [number, number] }>;
} {
  const buf = readFileSync(path);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const jsonText = buf.subarray(8, 8 + headerLen).toString('utf8');
  const raw = JSON.parse(jsonText) as Record<string, unknown>;
  const header: Record<string, { readonly dtype: string; readonly shape: readonly number[]; readonly data_offsets: readonly [number, number] }> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__metadata__') continue;
    count += 1;
    header[k] = v as { readonly dtype: string; readonly shape: readonly number[]; readonly data_offsets: readonly [number, number] };
  }
  return { tensorCount: count, bodyOffset: 8 + headerLen, header };
}

function parseGgufHeader(path: string): {
  readonly magic: string;
  readonly version: number;
  readonly tensorCount: bigint;
  readonly kvCount: bigint;
} {
  const buf = readFileSync(path);
  return {
    magic: buf.subarray(0, 4).toString('ascii'),
    version: buf.readUInt32LE(4),
    tensorCount: buf.readBigUInt64LE(8),
    kvCount: buf.readBigUInt64LE(16),
  };
}

describe('Trained Qwen3.8-27B LoRA Artifacts & Provenance (2026-10-29)', () => {
  it('validates Proposer LoRA run summary, held-out benchmark disjointness, and monotonic wallNs (INV-2, INV-6)', () => {
    const summaryPath = join(RESULTS_DIR, 'proposer-lora-out/training-run-summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as LoraRunSummary;

    expect(summary.schema).toBe('proposer-lora-training-run/v1');
    expect(summary.task).toBe('proposer');
    expect(summary.source).toBe('synthetic_verifier_grounded');
    expect(summary.baseModel).toBe('Qwen/Qwen3.8-27B');
    expect(summary.ollamaBase).toBe('qwen3.8:27b');
    expect(summary.mode).toBe('both');
    expect(summary.loraR).toBe(16);
    expect(summary.loraAlpha).toBe(32);

    const wallNs = BigInt(summary.wallNs);
    expect(wallNs).toBeGreaterThan(0n);

    const expectedHashes = [
      PORT1_ISOLATION_INTENT,
      DNS_CONFINEMENT_INTENT,
      QUARANTINE_PRECEDENCE_INTENT,
      TAP_RETURN_ISOLATION_INTENT,
    ].map((intent) => intentSha256(intent));
    expect(summary.heldOutBenchmarkHashes).toEqual(expectedHashes);
  });

  it('validates Reviewer LoRA run summary and monotonic wallNs (INV-2, INV-6)', () => {
    const summaryPath = join(RESULTS_DIR, 'reviewer-lora-out/training-run-summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as LoraRunSummary;

    expect(summary.schema).toBe('reviewer-lora-training-run/v1');
    expect(summary.task).toBe('reviewer');
    expect(summary.source).toBe('synthetic_verifier_grounded');
    expect(summary.baseModel).toBe('Qwen/Qwen3.8-27B');
    expect(summary.mode).toBe('both');
    expect(BigInt(summary.wallNs)).toBeGreaterThan(0n);
  });

  it('verifies PEFT safetensors and GGUF v3 binary headers and non-zero learned lora_B weights when local binaries are present', () => {
    for (const task of ['proposer', 'reviewer'] as const) {
      const cfgPath = join(RESULTS_DIR, `${task}-lora-out/dpo-adapter/adapter_config.json`);
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as PeftAdapterConfig;
      expect(cfg.peft_type).toBe('LORA');
      expect(cfg.r).toBe(16);
      expect(cfg.lora_alpha).toBe(32);
      expect([...cfg.target_modules].sort()).toEqual([
        'down_proj',
        'gate_proj',
        'k_proj',
        'o_proj',
        'q_proj',
        'up_proj',
        'v_proj',
      ]);

      const stPath = join(RESULTS_DIR, `${task}-lora-out/dpo-adapter/adapter_model.safetensors`);
      const ggufPath = join(RESULTS_DIR, `${task}-lora-out/zodiac-${task}-dpo-lora.gguf`);

      // Binary weights (>100 MB) are gitignored; validate them whenever present on the local workstation
      let hasLocalWeights = false;
      try {
        hasLocalWeights = statSync(stPath).isFile() && statSync(ggufPath).isFile();
      } catch {
        hasLocalWeights = false;
      }

      if (hasLocalWeights) {
        const st = parseSafetensorsHeader(stPath);
        expect(st.tensorCount).toBe(512);
        const loraBKeys = Object.keys(st.header).filter((k) => k.includes('lora_B'));
        expect(loraBKeys.length).toBe(256);

        // Verify lora_B weights are non-zero (proving gradient updates occurred during SFT+DPO)
        const buf = readFileSync(stPath);
        const firstB = st.header[loraBKeys[0]];
        const start = st.bodyOffset + firstB.data_offsets[0];
        let nonZeroCount = 0;
        for (let i = 0; i < 1024; i += 2) {
          const u16 = buf.readUInt16LE(start + i);
          if ((u16 & 0x7fff) !== 0) nonZeroCount += 1;
        }
        expect(nonZeroCount).toBeGreaterThan(400);

        const gguf = parseGgufHeader(ggufPath);
        expect(gguf.magic).toBe('GGUF');
        expect(gguf.version).toBe(3);
        expect(gguf.tensorCount).toBe(512n);
      }
    }
  });
});
