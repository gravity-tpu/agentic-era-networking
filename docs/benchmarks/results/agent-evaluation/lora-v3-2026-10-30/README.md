# Verifier-grounded LoRA proposer, prompt v3: Qwen3.8 27B on four intents (2026-10-30)

The runs of plan section 11 (`docs/research/evaluation-plan.md`), registered on 2026-10-29 before any v3 data. Abstract evaluation only (RQ1 to RQ3): the verdicts come from
`src/sdn/proposal-triage.ts`; nothing was installed on the switch. **Admissible means the verifier accepts the rule set, not that it is correct on the wire.**
All runs used Protocol A (zero-shot), prompt v3, N = 50, temperature 0.2, top-p 0.95, seeds 1 to 50, `think: true`, `num_predict` 32768, on one NVIDIA A100 SXM4 80GB per pod (Runpod Community Cloud), Ollama 0.34.4.

## Arms

| Arm | Weights | How it was built |
| :--- | :--- | :--- |
| B3 (base) | `qwen3.8:27b` from the Ollama library, digest `aaee06c39dcf` | `ollama pull` |
| L3 (adapter) | `Qwen/Qwen3.8-27B` with the DPO proposer adapter (`zodiac-proposer-dpo-lora`, 15 training steps, trained 2026-10-29) | original checkpoint converted to f16 GGUF, adapter GGUF merged with `llama-export-lora`, then Q4_K_M; see deviation 1 |
| C3 (pipeline control) | `Qwen/Qwen3.8-27B`, no adapter | the same steps as L3 without the merge |

The built models are identified by the digests in the table below. The Q4_K_M GGUF checksums are in each cell's `*-q4_k_m.sha256`.

## Results

| Intent | Arm | Admissible (95% Wilson) | Categories of the rest | Distinct outputs | Transport failures | Run commit | Model digest |
| :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- |
| port1-isolation/v1 (INTENT-1) | B3 | 47/50: 84% to 98% | ERR_INTENT_MISSING 3 | 39 | 0 | `02ec648` | `aaee06c39dcf` |
| port1-isolation/v1 (INTENT-1) | C3 | 47/50: 84% to 98% | ERR_INTENT_LEAK 3 | 38 | 0 | `02ec648` | `7986293b452a` |
| port1-isolation/v1 (INTENT-1) | L3 | 41/50: 69% to 90% | ERR_INTENT_LEAK 9 | 37 | 0 | `02ec648` | `addcb4deef85` |
| dns-confinement/v1 (INTENT-2) | B3 | 50/50: 93% to 100% | none | 45 | 0 | `02ec648` | `aaee06c39dcf` |
| dns-confinement/v1 (INTENT-2) | C3 | 50/50: 93% to 100% | none | 46 | 0 | `02ec648` | `7986293b452a` |
| dns-confinement/v1 (INTENT-2) | L3 | 46/50: 81% to 97% | ERR_INTENT_LEAK 4 | 37 | 0 | `02ec648` | `addcb4deef85` |
| quarantine-precedence/v1 (INTENT-3) | B3 | 27/50: 40% to 67% | ERR_SYNTAX 1, ERR_INTENT_LEAK 5, ERR_INTENT_MISSING 17 | 50 | 0 | `4b2a73c` | `aaee06c39dcf` |
| quarantine-precedence/v1 (INTENT-3) | C3 | 27/50: 40% to 67% | ERR_INTENT_LEAK 7, ERR_INTENT_MISSING 16 | 50 | 0 | `02ec648` | `7986293b452a` |
| quarantine-precedence/v1 (INTENT-3) | L3 | 40/50: 67% to 89% | ERR_INTENT_LEAK 10 | 48 | 0 | `9a60311` | `addcb4deef85` |
| tap-return-isolation/v1 (INTENT-4) | B3 | 50/50: 93% to 100% | none | 45 | 0 | `02ec648` | `aaee06c39dcf` |
| tap-return-isolation/v1 (INTENT-4) | C3 | 50/50: 93% to 100% | none | 48 | 0 | `02ec648` | `7986293b452a` |
| tap-return-isolation/v1 (INTENT-4) | L3 | 49/50: 90% to 100% | ERR_INTENT_MISSING 1 | 39 | 0 | `02ec648` | `addcb4deef85` |

All four intents: B3 174/200 (82% to 91%), C3 174/200 (82% to 91%), L3 176/200 (83% to 92%).
Stage 1 (INTENT-3) is in `stage1/`, Stage 2 (INTENT-1, 2, 4) in `stage2/`. Each cell directory holds `summary.json`, `trials.jsonl` (every raw model output and verdict) and the provenance files of its pod.

## What the numbers say, and no more

- **Adapter effect (L3 against C3, the comparison section 11.2 defines).** On INTENT-3, the intent the adapter was built for, L3 is 40/50 against 27/50 (intervals 67% to 89% and 40% to 67%, touching at 67%). On the three intents where C3 was already at 47 to 50 of 50, L3 is lower: 41 against 47 (INTENT-1), 46 against 50 (INTENT-2), 49 against 50 (INTENT-4). The intervals overlap on those three. Over all 200 trials the two differ by 2 (176 against 174). This is one run per cell, so a small loss on the easy intents cannot be separated from run-to-run variation, and a gain on INTENT-3 comes from a single run too.
- **The kind of failure changed.** B3 and C3 fail mostly with `ERR_INTENT_MISSING` (an omitted rule: 20 and 16 of 26 failures). L3's failures are almost all `ERR_INTENT_LEAK` (23 of 24; the verifier found traffic permitted that the intent forbids). Both are rejected by the verifier; the leak direction is the one that would matter without it.
- **Quantization route (B3 against C3).** Identical admissible counts on all four intents (47, 50, 27, 50). Re-quantizing outside the Ollama library made no difference in this experiment.
- **Prompt effect (v2 to v3), reported separately and not merged with the section 10 data.** The registered v2 runs of the same library model scored 18, 19, 1 and 48 of 50 on INTENT-1 to 4 (`proposer-v2-qwen3.8-haiku-5-5.md`); B3 under v3 scores 47, 50, 27 and 50. That comparison is confounded: the platform changed (the Mac workstation with one stream, against a Runpod A100 with three streams for Stage 2), and prompt v3 was written after the v2 failures on these same intents were read.

## Deviations from the registered protocol and incidents

Section 11.4 requires a deviation or an infrastructure rerun to be listed. Everything below happened; none changed an arm's settings, prompts, seeds or the verifier.

1. **Merge route.** Section 11.2 describes a bf16 merge of the adapter. A transformers merge-and-save drops this model's trailing next-token-prediction layer (`blk.64`), and Ollama then cannot load the GGUF (`tensor 'blk.64.attn_norm.weight' not found`). L3 was therefore built in GGUF space: the original checkpoint converted to f16, the training adapter GGUF merged with `llama-export-lora`, then Q4_K_M. llama.cpp's commit is in `llama-cpp-commit.txt`. The discarded first L3 build left `L3-merge-record.json` in the Stage 1 pod output; it describes the transformers merge that was not used and was left out of this directory.
2. **L3, Stage 1: run by hand.** The first L3 pod (the transformers-merged GGUF) failed with 30 consecutive `TRANSPORT_FAILURE`s before the run was stopped; its log is `stage1/.../manual-eval-L3-failed-attempt1-unloadable-model.log` and no trial from it is used. The model was then rebuilt in GGUF space on the same pod (`l3-manual.log`) and the 50 trials were run by hand with the same `agent-eval.ts` command the scripts use; only the model name (`zodiac-L3:q4_k_m`) differs.
3. **C3, Stage 1: first attempt lost, rerun.** The first complete C3 INTENT-3 run finished 50 trials, but I edited the launcher script while that launcher was running; the launcher died and its exit handler terminated the pod before the results were downloaded. The data is gone. I had seen the per-seed verdicts of seven of its trials (seeds 7, 8, 9, 10, 11, 43, 44) and never the totals. The cell was rerun (`stage1/.../manual-eval-C3-stage1-rerun.log`, on the Stage 2 C3 pod, same model and command). The rerun's verdicts for those seven seeds matched what I had seen, but the later Protocol B runs showed that the same seed usually does not give the same output in a different run (see deviation 4), so that match says little. Treat the rerun as a fresh sample of the cell, not a replica of the lost run. The lost attempt's result is unknown and not reported; only the rerun is.
4. **Scheduling.** The three Stage 1 cells ran one process at a time. Stage 2 ran the three intents of an arm concurrently against one Ollama server (three streams). Seeded outputs are not guaranteed identical under concurrent batching, so Stage 1 and Stage 2 cells are not strictly comparable in scheduling, and the comparisons above are only made within a stage. Distinct-output counts are lower for L3 in Stage 2 (37 to 39 of 50) than in Stage 1 (48 of 50); this was not investigated. The Protocol B write-up (`lora-v3-protocol-b-2026-10-31/README.md`, branch `feat/protocol-b-lora`) later measured how far same-seed runs differ: for seeds 1 to 20, a Protocol B turn-1 output was identical to the Protocol A output of the same seed in 0 or 1 of 20 trials in seven of eight cells (19 of 20 for L3 on INTENT-3), and the control passed 9 of 20 on INTENT-3 in Protocol A against 12 of 20 on turn 1 in Protocol B. Run-to-run variation at N = 20 is therefore a few trials per cell, and the per-intent differences above should be read with that in mind.
5. **Different run commits per arm.** B3 Stage 1 ran at `4b2a73c`, L3 Stage 1 at `9a60311`, and C3's rerun and all of Stage 2 at `02ec648`. `scripts/agent-eval.ts` and `src/sdn/` are identical across the three commits (checked with `git diff`); only `scripts/runpod/*` differs.
6. **Stage gate.** Stage 2 pods were launched early so their model builds overlapped the end of Stage 1, and were held before any trial until `GO` was created, after Stage 1 (including the C3 rerun) was complete (`GO received` lines in each `pod-log-filtered.txt`). No Stage 2 trial ran before Stage 1 completed.
7. **Pod lifetimes extended by hand.** Three concurrent streams made Stage 2 slower than planned, so I suspended the in-pod `timeout` process on the three Stage 2 pods to keep them past their 150-minute limit (the L3 pod ran about 3 minutes past it, the C3 pod about 19 minutes; B3 finished inside its limit). Each pod stayed under the 5 USD per-run cap (the longest was about 3.9 USD). No trial was affected.
8. **Hardware.** Every pod reported an A100 SXM4 80GB (`gpu.txt`; the Stage 1 B3 pod predates that file and showed an A100 SXM4 80GB in `nvidia-smi` during the run). Earlier attempts on other GPUs were discarded before any trial.

Cost: Runpod balance went from 16.47 USD, plus a 50 USD top-up, to 46.87 USD, about 19.6 USD in total, including every failed attempt and idle time at the stage gate.

## What this does not show

- Whether any difference is more than run-to-run variation (one run per cell, one seed set, one adapter, one training run of 15 steps).
- Anything about prompt v3 held out from the benchmark: v3 was written after the v2 failures on these intents were read; only the adapter's training scenarios are hash-disjoint from them.
- That the merge-then-quantize adapter equals the adapter served at run time (`llama-server --lora`); that route was not tested.
- On-wire behaviour (RQ4) and Protocol B.
- That a DPO reward accuracy of 100% on verifier-generated pairs (the training statistic) predicts anything about these intents; the L3 results on INTENT-1 and INTENT-2 are lower than the control.
