# The four additional intents (INTENT-5 to 8): four arms, Protocol A, prompt v3 (2026-10-31)

The runs of plan sections 13 and 14 (`docs/research/evaluation-plan.md`), registered by commits `fffcbcd` (the local arms' run commit; tag `provenance/hard-intents-run-fffcbcd`) and `f50adbb` (Haiku; tag `provenance/haiku-v3-run-f50adbb`) before any of this data. Abstract evaluation only (RQ1 to RQ3): verdicts come from
`src/sdn/proposal-triage.ts`; nothing was installed on the switch. **Admissible means the verifier accepts the rule set, not that it is correct on the wire.**
Protocol A (zero-shot), prompt v3, N = 50 per intent, one run per cell. The four intents were chosen by structure before any model saw them (section 13.2).

## Arms

| Arm | What | How it ran |
| :--- | :--- | :--- |
| B3 | `qwen3.8:27b` from the Ollama library (digest `aaee06c39dcf`) | A100 SXM4 80GB, Ollama 0.34.4, temperature 0.2, top-p 0.95, seeds 1 to 50, `think: true`, `num_predict` 32768; the four intents ran concurrently on one pod |
| C3 | the same base, no adapter, built like L3 (original checkpoint to f16 GGUF, Q4_K_M) | as B3; the `per-host-allowlist` cell ran on its own single-stream pod (see deviation 2) |
| L3 | the same, with the 15-step DPO proposer adapter merged in GGUF space (about 4% of its training data) | as B3 |
| H3 | Claude Haiku 5.5 through the Message Batches API, effort `low`, `num_predict` 16384, no seed (the Claude arm accepts none) | one batch of 50 requests per intent; the whole baseline cost 0.376 USD |

## Results

| Intent | Arm | Admissible (95% Wilson) | Categories of the rest | Distinct outputs | Transport failures | Run commit | Model digest |
| :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- |
| dns-confinement/v1 | H3 | 50/50: 93% to 100% | none | 50 | 0 | `f50adbb` | `Claude Haiku` |
| dns-quarantine/v1 | B3 | 48/50: 87% to 99% | none | 44 | 2 | `fffcbcd` | `aaee06c39dcf` |
| dns-quarantine/v1 | C3 | 49/50: 90% to 100% | none | 50 | 1 | `fffcbcd` | `7986293b452a` |
| dns-quarantine/v1 | H3 | 50/50: 93% to 100% | none | 50 | 0 | `f50adbb` | `Claude Haiku` |
| dns-quarantine/v1 | L3 | 24/50: 35% to 61% | ERR_HAIRPIN 1, ERR_INTENT_LEAK 25 | 49 | 0 | `fffcbcd` | `addcb4deef85` |
| per-host-allowlist/v1 | B3 | 48/50: 87% to 99% | ERR_INTENT_LEAK 1 | 47 | 1 | `fffcbcd` | `aaee06c39dcf` |
| per-host-allowlist/v1 | C3 | 50/50: 93% to 100% | none | 46 | 0 | `946099c` | `7986293b452a` |
| per-host-allowlist/v1 | H3 | 50/50: 93% to 100% | none | 50 | 0 | `f50adbb` | `Claude Haiku` |
| per-host-allowlist/v1 | L3 | 50/50: 93% to 100% | none | 40 | 0 | `fffcbcd` | `addcb4deef85` |
| port1-isolation/v1 | H3 | 30/50: 46% to 72% | ERR_INTENT_MISSING 20 | 49 | 0 | `f50adbb` | `Claude Haiku` |
| quarantine-precedence/v1 | H3 | 41/50: 69% to 90% | ERR_INTENT_LEAK 1, ERR_INTENT_MISSING 8 | 50 | 0 | `f50adbb` | `Claude Haiku` |
| quarantine-set/v1 | B3 | 36/50: 58% to 83% | ERR_INTENT_LEAK 4, ERR_INTENT_MISSING 10 | 49 | 0 | `fffcbcd` | `aaee06c39dcf` |
| quarantine-set/v1 | C3 | 43/50: 74% to 93% | ERR_INTENT_LEAK 2, ERR_INTENT_MISSING 5 | 49 | 0 | `fffcbcd` | `7986293b452a` |
| quarantine-set/v1 | H3 | 46/50: 81% to 97% | ERR_INTENT_MISSING 4 | 50 | 0 | `f50adbb` | `Claude Haiku` |
| quarantine-set/v1 | L3 | 18/50: 24% to 50% | ERR_INTENT_LEAK 32 | 47 | 0 | `fffcbcd` | `addcb4deef85` |
| tap-return-isolation/v1 | H3 | 50/50: 93% to 100% | none | 50 | 0 | `f50adbb` | `Claude Haiku` |
| uplink-arp-confinement/v1 | B3 | 33/50: 52% to 78% | ERR_INTENT_LEAK 17 | 47 | 0 | `fffcbcd` | `aaee06c39dcf` |
| uplink-arp-confinement/v1 | C3 | 32/50: 50% to 76% | ERR_INTENT_LEAK 17 | 49 | 1 | `fffcbcd` | `7986293b452a` |
| uplink-arp-confinement/v1 | H3 | 50/50: 93% to 100% | none | 50 | 0 | `f50adbb` | `Claude Haiku` |
| uplink-arp-confinement/v1 | L3 | 49/50: 90% to 100% | ERR_INTENT_LEAK 1 | 46 | 0 | `fffcbcd` | `addcb4deef85` |

Each cell directory holds `summary.json`, `trials.jsonl` (every raw output and verdict) and, for the local arms, the pod's provenance files. Admissible counts exclude transport failures, which are listed in their own column and counted as failed trials.

All four new intents together (admissible out of 200, 95% Wilson interval):

| Arm | Admissible |
| :--- | :--- |
| H3 (Haiku 5.5) | 196/200: 95% to 99% |
| B3 (library base) | 165/200: 77% to 87% |
| C3 (control) | 174/200: 82% to 91% |
| L3 (15-step adapter) | 141/200: 64% to 76% |

## What the numbers say, and no more

- **Two of the four intents separate the arms; two are saturated.** The control (C3) is 49 of 50 on INTENT-6 and 50 of 50 on INTENT-8, and Haiku is 50 of 50 on INTENT-6, 7 and 8: under the saturation threshold of section 13.2 (47 of 50) INTENT-6 and 8 are reported as saturated. INTENT-5 (C3 43) and INTENT-7 (C3 32) are not, which triggers the conditional Protocol B of section 14.2 (reported separately).
- **The 15-step adapter is a specialist.** Against the control it gains 17 trials on INTENT-7 (49 against 32) and loses 25 on INTENT-5 (18 against 43) and 25 on INTENT-6 (24 against 49); INTENT-8 is level. Its failures on INTENT-5 and 6 are almost all `ERR_INTENT_LEAK` (32 and 25 of the failures): the quarantined hosts still reach the network. Together with section 11 (INTENT-3 +13, INTENT-1 -6, INTENT-2 -4, INTENT-4 -1) it wins where the structure matches what it was trained on and loses where intents compose it differently.
- **How that fits the training data (an observation, not a tested cause).** The adapter's 32 training scenarios come in four families (`src/sdn/proposer-lora-dataset.ts`): segment isolation, service confinement, quarantine override (exactly one quarantined host per scenario) and bidirectional ARP with a tap (one uplink ARP peer per scenario). INTENT-7 has the structure of the last family with two peers instead of one, so its gain is not evidence of generalisation to a new kind of intent; INTENT-5 stretches the quarantine family to three hosts, and INTENT-6 combines the service-confinement and quarantine families, which no training scenario does: the two where it collapses. The addresses are disjoint from the benchmark's (`assertDisjointFromBenchmark`); the structures are not, by design of the families.
- **Haiku is the strongest arm on these intents** (196 of 200 against 174 for the control) while it was the weakest on INTENT-1 in the section 14 runs (30 of 50 against 47). Its sampling differs from the local arms (no seed, a different provider), so it is compared only descriptively.
- **Run-to-run variation** at N = 50 is a few trials per cell (section 12 measured it at N = 20), so differences of a few trials, such as B3 against C3 on INTENT-5 (36 against 43), should not be read as effects; the 17 to 25 trial differences of the adapter are well outside that.

## Deviations from the registered protocol and incidents

None changed an arm's settings, prompts, seeds or the verifier. All are reported here as section 13.5 and 14.3 require.

1. **Pod lifetimes extended by hand.** Measured throughput was about one trial per minute per pod, slower than estimated, so the B3 and C3 pods would have reached their 200-minute limit before finishing, and a pod killed by its limit loses every cell it has not written (the harness writes a cell only when its 50 trials finish). I suspended the in-pod `timeout` process on those two pods and bounded the extension at the 5 USD per-run cap (hard stop at 215 minutes). No trial was affected.
2. **C3 `per-host-allowlist` ran on a separate pod.** Even with the extension, the C3 pod's projected finish (about 05:49Z) was past its cap-bounded stop (about 05:39Z), so that intent was moved to its own pod (single stream, 50 trials) and its process on the original pod was killed once the new pod's first trial landed (the original launcher therefore ended `FAILED`, expected; its three finished cells were downloaded, and the killed cell's empty directory was not kept). The cell ran at commit `946099c` instead of `fffcbcd`: a review-fix commit that changes only how two quarantine clause ids are built and the tests; the specification and its pinned hash are identical. About 16 trials of that intent were run and discarded on the original pod.
3. **Scheduling.** B3, C3 and L3 ran the four intents concurrently on one pod (four streams); that C3 cell ran as a single stream. Seeded outputs are not guaranteed identical under concurrent batching (section 12), so the cells are comparable only approximately in scheduling.
4. **Transport failures.** B3 had 2 on dns-quarantine and 1 on per-host-allowlist, C3 1 on dns-quarantine and 1 on uplink-arp-confinement; they are counted as failed trials and not retried (section 6).
5. **L3 and C3 were built in GGUF space** (the adapter merged with `llama-export-lora` into the f16 conversion of the original checkpoint, then Q4_K_M), not the bf16 merge section 11.2 describes (deviation 1 of the section 11 results).
6. **Haiku** used the Message Batches API with prices of the non-batch rates of section 10.2 for its spend cap (conservative), `--thinking low`, and no seed.

Cost: the local arms about 4 USD to 5 USD per pod (three pods plus the split pod), Haiku 0.376 USD.

## What this does not show

- Why the adapter fails on INTENT-5 and 6: the family structure above fits, but no experiment here separates it from other explanations (for example, the adapter having seen only about 4% of its data).
- Anything about a longer-trained adapter: that is arm L4 of section 14, evaluated separately.
- That structural size means difficulty for a model: INTENT-8 is the largest after INTENT-5 and is saturated for every arm.
- Whether verifier-accepted rule sets behave correctly on the wire (RQ4); one run per cell; the references and the verifier are the author's.
