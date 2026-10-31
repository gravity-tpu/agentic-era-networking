/**
 * eval-l4-arm.test.ts
 * The L4 arm of scripts/runpod/eval-lora-pod.sh (plan section 14): the properly trained adapter, built exactly like L3 (GGUF-space merge from the
 * original checkpoint), with the adapter GGUF either uploaded or converted on the evaluation pod. Pure content checks: the script runs on a pod.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const POD = readFileSync(path.resolve(__dirname, '../../scripts/runpod/eval-lora-pod.sh'), 'utf8');

describe('eval-lora-pod.sh L4 arm', () => {
  it('has an L4 arm that builds the model with the same route as L3 and evaluates it under an explicit tag', () => {
    expect(POD).toMatch(/L4\) L4_GGUF=\$\(l4_adapter_gguf\); build_arm L4 "\$L4_GGUF"; run_arm L4 zodiac-L4:q4_k_m ;;/);
    expect(POD).toMatch(/L3\) build_arm L3 \/workspace\/in\/proposer-adapter\/zodiac-proposer-dpo-lora\.gguf; run_arm L3 zodiac-L3:q4_k_m ;;/);
  });
  it('resolves the adapter path with an assignment so a failure stops the script (set -e ignores a failing command substitution used as an argument)', () => {
    expect(POD).toContain('L4_GGUF=$(l4_adapter_gguf)');
    expect(POD).not.toMatch(/build_arm L4 "\$\(l4_adapter_gguf\)"/);
  });
  it('prefers the uploaded GGUF, falls back to converting the PEFT adapter, and fails closed when neither exists', () => {
    const fn = POD.slice(POD.indexOf('l4_adapter_gguf() {'), POD.indexOf('build_arm() {'));
    expect(fn.indexOf('zodiac-proposer-dpo-lora.gguf')).toBeLessThan(fn.indexOf('convert_lora_to_gguf.py'));
    expect(fn).toContain('neither an adapter GGUF nor a PEFT adapter found');
    expect(fn).toContain('return 1');
  });
  it('rejects an unknown arm', () => {
    expect(POD).toContain('*) echo "unknown arm $arm"; exit 2 ;;');
  });
});
