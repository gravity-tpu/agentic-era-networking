# Trained `Qwen3.8-27B` LoRA Adapters & Runpod SFT+DPO Pipeline (2026-10-29)

This directory stores the provenance metadata, PEFT configurations, and `Modelfile` templates for the two verifier-grounded `Qwen/Qwen3.8-27B` (`Qwen3_5ForConditionalGeneration`) LoRA adapters trained on **2026-10-29** via an ephemeral Runpod A100 SXM 80GB instance (`US-KS-2`).

---

## 1. Motivation (For Posterity)

### Why We Needed Prompt `v3` and Verifier-Grounded LoRA Alignment

In the registered Plan v2 evaluation ([`docs/benchmarks/results/agent-evaluation/proposer-v2-qwen3.8-haiku-5-5.md`](../agent-evaluation/proposer-v2-qwen3.8-haiku-5-5.md)), local `qwen3.8:27b` scored **86 / 200 (43.0%)** zero-shot under `promptVersion: 'v2'` against Claude Haiku 5.5's **161 / 200 (80.5%)**:

- The gap was concentrated on **`INTENT-3` (`quarantine-precedence/v1`)**, where `qwen3.8:27b` scored **1 / 50 (2.0%)** zero-shot (`47 / 49` failures were `ERR_INTENT_LEAK`), yet reached **20 / 20 (100%)** within 3 turns once given deterministic verifier feedback (`Protocol B`).
- **Root-cause diagnosis of the `47` `ERR_INTENT_LEAK` failures:** When the intent description asks for quarantine `DROP` rules at priority `65535` above the baseline isolation rules, `qwen3.8:27b` under `pv2` focused on the quarantine rules and omitted either `srcIp` or `dstIp` on the Port 1 intra-segment forwarding rule (`inPort: 1, etherType: 0x0800 -> [2, 3]`), or forgot the priority-150 tap-only catch-all (`inPort: 1 -> [3]`), leaking non-segment traffic onto `P2` (`p1-everything-else` violation).
- A second recurring error mode was over-constraining the `P2 -> P1` return rule (`inPort: 2, etherType: 0x0800, dstIp: <subnet> -> [1]`) with `srcIp: <subnet>`, which fails `ERR_INTENT_MISSING` because external uplink sources returning traffic to the workload segment do not carry a workload `srcIp`.

### Two-Layer Remedy

1. **`PROPOSER_SYSTEM_PROMPT_V3` (`src/sdn/proposer-prompt.ts`):**
   - Explicitly states the Port 1 two-tier forwarding invariant (specific `srcIp` + `dstIp` + per-host `arpSpa` allow rules at priority `200` to `[2, 3]`, paired with an unconstrained `inPort: 1` catch-all at priority `150` to `[3]` only) and the `P2 -> P1` return-traffic rule (`dstIp` only, no `srcIp` restriction).
   - On a 3-seed pilot on `quarantine-precedence/v1`, `v3` immediately eliminated the `p1-everything-else` leak in **3 / 3 seeds** and raised zero-shot admissibility from `2.0%` (`1/50`) to `33.3%` (`1/3`).
2. **Verifier-Grounded SFT + DPO LoRA Adapters (`src/sdn/proposer-lora-dataset.ts`, `src/sdn/reviewer-lora-dataset.ts`, `scripts/train-proposer-lora.py`):**
   - Because `triageProposal` (`src/sdn/proposal-triage.ts`) is an exact, $< 5\text{ ms}$ formal verifier over packet-class equivalence classes (`enumeratePacketClasses`), we can generate **mathematically verified preference pairs (DPO) and multi-turn repair traces (SFT)** without human labeling or teacher-model distillation.
   - **Strict Benchmark Disjointness (Invariant 4 & 6):** `assertDisjointFromBenchmark` enforces that zero training intents share a SHA-256 hash with `INTENT-1..4` and zero training rules reference the held-out `10.0.2.0/24` benchmark subnet. All `32` training scenarios use disjoint RFC 1918 / CGNAT subnets (`10.10.0.0/16`–`198.18.0.0/15`).
   - **Dual-Adapter Specialization:**
     - **Proposer LoRA (`zodiac-proposer-dpo-lora`):** Trained on `1,466` SFT examples (`32` zero-shot + `1,434` 2-turn verifier repairs) and `1,434` DPO preference pairs across all 6 failure categories (`ERR_INTENT_LEAK`, `ERR_INTENT_MISSING`, `ERR_QUARANTINE_PRECEDENCE`, `ERR_SHADOWED`, `ERR_CONFLICT_OVERLAP`, `ERR_HAIRPIN`).
     - **Reviewer LoRA (`zodiac-reviewer-dpo-lora`):** Trained on `26` SFT + `26` DPO preference pairs covering repository invariants `INV-1..6` and network engineering principles `NET-001..006`, `NET-010`.

---

## 2. How the Architecture & Runpod Pipeline Are Wired Together

```text
  Mac Workstation (Edge / Repo)                              Runpod Ephemeral A100 SXM 80GB Pod
  ─────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────
  1. npm run lora:dataset:proposer                           4. Upload /tmp/zodiac-lora-upload.tar.gz via SCP
     → src/sdn/proposer-lora-dataset.ts                         Unpack to /workspace/zodiac-{proposer,reviewer}-lora
     → verifies every chosen rule set ADMISSIBLE via
       triageProposal() and every rejected mutant            5. scripts/train-proposer-lora.py (--mode both)
       INADMISSIBLE; checks benchmark disjointness.             • Loads Qwen/Qwen3.8-27B (Qwen3_5ForConditionalGeneration)
                                                                • Stage 1: TRL SFTTrainer (r=16, alpha=32, 7 linear proj)
  2. npm run lora:dataset:reviewer                              • Stage 2: TRL DPOTrainer (beta=0.1, chosen vs rejected)
     → src/sdn/reviewer-lora-dataset.ts                         • Exports PEFT safetensors (BF16) + Modelfile + summary
     → builds INV-1..6 & NET-001..010 diff-review pairs.
                                                             6. llama.cpp/convert_lora_to_gguf.py (--outtype f16)
  3. Runpod MCP (@runpod/mcp-server via .env.local)             • Exports 512-tensor GGUF v3 LoRA adapters (152 MB each)
     → create-pod (1× A100 80GB, US-KS-2, $1.79/hr)          7. Download compact bundle to Mac & delete-pod (204)
```

> [!TIP]
> **Runpod Cost Optimization — Spot vs. On-Demand:**
>
> - **Community Cloud / Spot Instances:** Use for quick data-scoring, short pilot validations, or hyperparameter sweeps (~40% cheaper).
> - **Secure Cloud On-Demand:** Reserve strictly for longer, multi-epoch fine-tuning runs where instance interruptions would waste base-model download and checkpointing time.

---

## 3. Training Run Summary (2026-10-29)

| Metric | Reviewer LoRA (`reviewer-lora-out/`) | Proposer LoRA (`proposer-lora-out/`) |
| :--- | :--- | :--- |
| **Base Model** | `Qwen/Qwen3.8-27B` (`fc05daec18b0`) | `Qwen/Qwen3.8-27B` (`fc05daec18b0`) |
| **LoRA Rank / Alpha** | `r = 16`, `lora_alpha = 32`, `512` tensors | `r = 16`, `lora_alpha = 32`, `512` tensors |
| **Target Modules** | `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj` | `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj` |
| **Dataset Size** | `26` SFT + `26` DPO pairs | `1,466` SFT + `1,434` DPO pairs (`--max-steps 15 --grad-accum 4`) |
| **SFT Loss / Token Accuracy** | `2.139` / `60.30%` | `0.739` / `94.11%` |
| **DPO Loss / Token Accuracy** | `0.3166` / `75.84%` | `0.2568` / `98.57%` |
| **DPO Reward Accuracy / Margin** | `67.31%` / `+1.526` | **`100.0%`** / **`+3.713`** |
| **Monotonic Wall Time (`wallNs`)** | `1,056,070,418,972 ns` (`17.6 min`) | `850,158,421,071 ns` (`14.2 min`) |
| **Provenance Tag** | `synthetic_verifier_grounded` | `synthetic_verifier_grounded` |

---

## 4. What Is Checked Into Git vs. Ignored

To keep the Git repository fast and below GitHub's `100 MB` file limit:

- **Committed to Git (Tracked & Tested by `test/invariants/trained-lora-artifacts.test.ts`):**
  - `proposer-lora-out/training-run-summary.json` & `reviewer-lora-out/training-run-summary.json`
  - `proposer-lora-out/dpo-adapter/adapter_config.json` & `reviewer-lora-out/dpo-adapter/adapter_config.json`
  - `proposer-lora-out/Modelfile.proposer-lora` & `reviewer-lora-out/Modelfile.reviewer-lora`
- **Gitignored (`*.gguf`, `*.safetensors` — stored locally on the Mac workstation in this directory):**
  - `proposer-lora-out/dpo-adapter/adapter_model.safetensors` (`152 MB`, `BF16`, `512` tensors)
  - `proposer-lora-out/zodiac-proposer-dpo-lora.gguf` (`152 MB`, `F16` GGUF v3, `512` tensors)
  - `reviewer-lora-out/dpo-adapter/adapter_model.safetensors` (`152 MB`, `BF16`, `512` tensors)
  - `reviewer-lora-out/zodiac-reviewer-dpo-lora.gguf` (`152 MB`, `F16` GGUF v3, `512` tensors)

> [!NOTE]
> **Serving Note (Ollama `0.34.4` vs. `llama.cpp`):** Ollama `0.34.x` removed runtime `ADAPTER` loading in `ollama create`. To serve the `.gguf` LoRA adapters at runtime without merging `55 GB` of base weights, pass `--lora docs/benchmarks/results/lora-adapters-2026-10-29/proposer-lora-out/zodiac-proposer-dpo-lora.gguf` to `llama-server` (`brew install llama.cpp`), or merge `dpo-adapter/adapter_model.safetensors` into `Qwen/Qwen3.8-27B` on an 80GB GPU and quantize with `ollama create -q q4_K_M`.
