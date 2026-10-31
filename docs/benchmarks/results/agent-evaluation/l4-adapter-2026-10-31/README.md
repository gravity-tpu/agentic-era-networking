# Arm L4: a longer-trained proposer adapter on six intents, Protocol A, prompt v3 (2026-10-31)

Plan section 14.2 items 2 and 3 (`docs/research/evaluation-plan.md`), registered by commit `f50adbb` before any of this data; the L4 arm itself was added to the pod pipeline on the run branch (run commit `4fe34b4`, tag `provenance/l4-run-4fe34b4`). Abstract evaluation only (RQ1 to RQ3): verdicts come from `src/sdn/proposal-triage.ts`; nothing was installed on the switch.
**Admissible means the verifier accepts the rule set, not that it is correct on the wire.**

Protocol A, N = 50 per intent, seeds 1 to 50, temperature 0.2, top-p 0.95, `think: true`, `num_predict` 32768, A100 SXM4 80GB Community pods, Ollama 0.34.4; one run per cell.

## The adapter (how much training it actually had)

Same recipe as the 15-step adapter (SFT then DPO, LoRA r = 16, alpha 32, seed 42, 32 verifier-grounded scenario families expanded to 1466 SFT examples and 1434 DPO pairs, hash-disjoint from the benchmark), trained on one Secure Cloud A100 pod with a wall-clock budget of 7800 s. **The budget stopped both stages early** (`training-run-summary.json`): SFT 80 steps (640 of 1466 examples, 44%), DPO 90 steps (720 of 1434 pairs, 50%). It is a longer-trained adapter than L3 (15 steps) but not a completed epoch, as section 14.3 anticipated ("labelled with the steps done"). The adapter's SHA-256 is in `adapter/`. The L4 model was built like L3 (original checkpoint to f16 GGUF, adapter merged in GGUF space with `llama-export-lora`, Q4_K_M; digest `6f52ad4396e1`).

## Results

| Intent | Arm | Admissible (95% Wilson) | Categories of the rest | Distinct outputs | Transport failures | Run commit | Model digest |
| :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- |
| dns-quarantine/v1 | L4 | 45/50: 79% to 96% | ERR_INTENT_LEAK 1 | 33 | 4 | `4fe34b4` | `6f52ad4396e1` |
| per-host-allowlist/v1 | L4 | 29/50: 44% to 71% | ERR_SYNTAX 17 | 35 | 4 | `4fe34b4` | `6f52ad4396e1` |
| port1-isolation/v1 | L4 | 32/50: 50% to 76% | ERR_SYNTAX 17, ERR_AMBIGUITY 1 | 30 | 0 | `4fe34b4` | `6f52ad4396e1` |
| quarantine-precedence/v1 | L4 | 7/50: 7% to 26% | ERR_SYNTAX 25, ERR_TABLE_OVERFLOW 17, ERR_INTENT_MISSING 1 | 24 | 0 | `4fe34b4` | `6f52ad4396e1` |
| quarantine-set/v1 | L4 | 7/50: 7% to 26% | ERR_SYNTAX 39, ERR_TABLE_OVERFLOW 1, ERR_INTENT_LEAK 3 | 30 | 0 | `4fe34b4` | `6f52ad4396e1` |
| uplink-arp-confinement/v1 | L4 | 25/50: 37% to 63% | ERR_SYNTAX 21, ERR_AMBIGUITY 2 | 40 | 2 | `4fe34b4` | `6f52ad4396e1` |

Transport failures are counted as failed trials and not retried. Cell directories (`cells/`) hold `summary.json` and `trials.jsonl` (every verdict and raw output); `pods/` holds each pod's provenance files.

## L4 beside the other arms (separate runs, not merged)

Admissible out of 50, Protocol A, prompt v3. C3 and L3 from `../lora-v3-2026-10-30/` and `../hard-intents-2026-10-31/`; every intent here is one run per cell.

| Intent | C3 (control) | L3 (15 steps) | L4 (80 SFT + 90 DPO steps) |
| :--- | ---: | ---: | ---: |
| port1-isolation (INTENT-1) | 47 | 41 | 32 |
| quarantine-precedence (INTENT-3) | 27 | 40 | 7 |
| quarantine-set (INTENT-5) | 43 | 18 | 7 |
| dns-quarantine (INTENT-6) | 49 | 24 | 45 |
| uplink-arp-confinement (INTENT-7) | 32 | 49 | 25 |
| per-host-allowlist (INTENT-8) | 50 | 50 | 29 |
| Six intents | 248 | 222 | 145 |

## What the numbers say, and no more

- **L4 is below the control on all six intents and below L3 on five of six.** Its total is 145 of 300 against 248 for the control. Only dns-quarantine is near the control (45 against 49), and it is the one intent where L4 is clearly above L3 (45 against 24). These are one run per cell; the gaps to the control on the other five (7 to 36 trials of 50) are mostly well outside the few-trial run-to-run variation of section 12, the smallest (uplink, 7) less clearly.
- **The failures are mostly malformed output, not rejected policy.** Of 300 trials, 119 were `ERR_SYNTAX` on turn 1 (quarantine-set 39, quarantine-precedence 25, uplink 21, per-host 17, port1 17), while the failures of the section 11 arms (B3, C3, L3) were `ERR_INTENT_LEAK` and `ERR_INTENT_MISSING` with one `ERR_SYNTAX` in all. In 107 of them the verifier found no JSON array (`no JSON found`): 99 ended with Ollama's stop reason `stop` (96 of those with an unclosed array, the model stopping mid-list) and 8 hit the token limit. Twelve were parsed rule sets rejected for a duplicated id or an unknown match field, several with ids that repeat a token (`p1-ipv4-ipv4-ipv4`). `ERR_TABLE_OVERFLOW` accounts for 17 of the 50 quarantine-precedence trials and 1 of quarantine-set.
- **What that does and does not say.** The adapter's output, when it parses, is often admissible; the loss is concentrated in output that is cut off or degenerates. This is an observation about this one half-trained adapter. No experiment here separates a cause (the stopped-early SFT/DPO schedule, the merge-then-quantize route, the repeated-token pattern, or something else), and I do not claim one.
- **It does not replace the L3 finding.** The 15-step adapter's gains (INTENT-3, INTENT-7) and losses (INTENT-5, 6) are in the earlier READMEs; L4 here shows that more steps of this recipe did not make the adapter better, and that it was not stable across the steps taken.

## Follow-up observations (no new runs, measured 2026-10-31)

Measured afterwards on the recorded cells (`cells/*/trials.jsonl`) and on the training set regenerated with `scripts/build-proposer-lora-dataset.ts` at main. They are measurements, not tests of a cause.

- **The 119 `ERR_SYNTAX` trials fall into three shapes.** 94 are long outputs (more than 1,300 characters, median about 14,500, maximum about 35,000); 22 are empty (the model generated 5,000 to 25,000 tokens, presumably thinking, then stopped with no answer); 3 are short. Of the 69 long outputs that contain at least two rule ids, 60 are heavily repetitive: the median ratio of distinct ids to ids written is 0.08, so a few rules are repeated until the generation ends. Admissible L4 outputs on port1-isolation and dns-quarantine are short (median about 1,100 characters).
- **The training set is small in distinct content.** It has 32 scenarios: 32 zero-shot rows and 1,434 repair rows that reuse the same 32 prompts. L4 saw 640 SFT examples, so each scenario about 20 times, at a learning rate of 2e-4.
- **The targets differ from the evaluation setting in two ways.** Every training target is a final answer of at most 1,211 characters (median 883) with no thinking block, while the evaluation ran with `think: true` and the harder intents need answers of about 2,000 characters. The training system prompt is the v2 text (`src/sdn/proposer-lora-dataset.ts`), the evaluation used v3 (v2 plus the anti-spoofing line).
- **What this does not say.** These facts are consistent with an adapter overfitted to a few scenarios, but no run here varies the data, the learning rate, the thinking setting or the prompt, so none of them is established as the cause. They are the reason plan section 15 (a draft) proposes a changed design and not a longer run of this one.

## Deviations from the registered protocol and incidents

None changed an arm's prompts, seeds, sampling or the verifier.

1. **Training stopped by its budget** (above): 44% of SFT data and 50% of DPO pairs seen.
2. **GGUF conversion of the adapter failed on the training pod** (the llama.cpp converter takes `--outfile`, not `-o`; the training script on main still passes `-o`). The evaluation pods converted the PEFT adapter themselves; the same flag was wrong in that fallback and was fixed on the run branch (`4fe34b4`) before any L4 trial. The training pod's log tail is `adapter/train-pod-log-tail.txt`.
3. **First attempt of three intents lost.** The first pod for port1-isolation, quarantine-precedence and quarantine-set (three streams) was about 111 of 150 trials in when it reached its 200-minute limit and became unreachable: results are written only when a cell finishes, so nothing was downloaded. The cause is mine: I paused to ask the owner whether to extend past the 5 USD per-run cap and the answer arrived about 4.5 hours later, after the limit. Spend about 5 USD, no data used. Per plan section 14.3 the three cells were rerun as three single-intent pods (single stream each, run commit `4fe34b4`, same model build). Partial verdict counts seen before the loss (not used): 40 `ERR_SYNTAX` and 13 `ERR_TABLE_OVERFLOW` among 92 trials, the same pattern as the rerun.
4. **Scheduling differs between cells.** dns-quarantine, uplink-arp-confinement and per-host-allowlist ran concurrently on one pod (three streams); the other three ran one per pod. Seeded outputs are not guaranteed identical under concurrent batching.
5. **Transport failures:** dns-quarantine 4, per-host-allowlist 4, uplink-arp-confinement 2 (counted as failed, not retried).

Cost (Runpod): training about 3.9 USD; evaluation pod B about 4 USD; lost first pod A about 5 USD; the three reruns about 7.1 USD in total (about 2.4 USD each, measured from the account balance, 41.04 to 33.95 USD). About 20 USD for L4 in all.

## What this does not show

- That a fully trained adapter (a complete epoch) would behave the same: this one saw about half of its data.
- Why the output is cut off or degenerates.
- Anything about INTENT-2 and 4 (not run for L4), Protocol B, or the wire (RQ4).
- Any difference of a few trials; one run per cell.
