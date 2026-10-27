# Proposer evaluation v2: Qwen3.8 27B and Claude Haiku 5.5 (2026-10-26 and 2026-10-27)

The registered runs of plan v2 (`docs/research/evaluation-plan.md` section 10, with amendment 1 in section 10.6), run with prompt v2 on INTENT-1 to 4. Plan v2 was
committed before any of these runs and approved by the owner with Gemma 4 excluded. Abstract evaluation only (RQ1 to RQ3): the verdicts come from
`src/sdn/proposal-triage.ts`; nothing was installed on the switch. **Admissible means the verifier accepts the rule set, not that it is correct on the wire.**
Why a v2 exists, and why these numbers are not merged with the earlier ones: `qwen3.8-27b.md` ("What it does not show") and plan section 9 D12.

## Setup

| Setting | Qwen3.8 27B | Claude Haiku 5.5 |
| :--- | :--- | :--- |
| Where | `qwen3.8:27b` (digest `aaee06c39dcf`, Q4_K_M) through Ollama on the Mac | Anthropic API, effort `low`, `num_predict` 16384, rates 10 and 50 cents per 1M tokens as used for the 2026-10-20 runs (not re-verified) |
| Reasoning | `think: true` (Ollama's default level for the model), `num_predict` 32768 | provider sampling (the Claude arm accepts no seed, plan D4) |
| Sampling | temperature 0.2, top-p 0.95, seeds 1..N | as above |
| Budgets | Protocol A N = 50, Protocol B N = 20 per intent, one run per cell | same |
| Wall time | Protocol A 7 h 55 min, Protocol B 4 h 57 min | about 35 minutes for the valid runs |
| Cost | local, not priced | about 27 cents for the eight valid runs, about 10 cents more for the kept failed and uncorrected attempts (token counts times the rates above) |

| Intent | Specification hash (first 12) | Prompt | Notes |
| :--- | :--- | :--- | :--- |
| INTENT-1 `port1-isolation/v1` | `dbd30d4265ca` | v2 | per-host ARP, as described |
| INTENT-2 `dns-confinement/v1` | `e632d34f157f` | v2 | unchanged specification: the control for the prompt change |
| INTENT-3 `quarantine-precedence/v1` | `0fad17b4c725` | v2 | description corrected by amendment 1 |
| INTENT-4 `tap-return-isolation/v1` | `04bf2c63c9b4` | v2 | description corrected by amendment 1 |

Every summary records `promptVersion` and `intentSha256`; they match the pins in `test/invariants/eval-intents-frozen.test.ts`.

### Qwen3.8 27B, Protocol A (zero-shot), N = 50

| Intent | Admissible (95% interval) | Categories of the rest | Distinct outputs | Transport failures | Run commit |
| :--- | :--- | :--- | ---: | ---: | :--- |
| INTENT-1 `port1-isolation` | 18/50: 24% to 50% | ERR_INTENT_LEAK 29 | 44 | 3 | `c5ba110` |
| INTENT-2 `dns-confinement` | 19/50: 26% to 52% | ERR_INTENT_LEAK 28 | 45 | 3 | `c5ba110` |
| INTENT-3 `quarantine-precedence` | 1/50: 0% to 10% | ERR_SYNTAX 1, ERR_HAIRPIN 1, ERR_INTENT_LEAK 47 | 48 | 0 | `c5ba110` |
| INTENT-4 `tap-return-isolation` | 48/50: 87% to 99% | ERR_HAIRPIN 1 | 45 | 1 | `c5ba110` |
| **All four** | **86/200: 36% to 50%** | | | | |

### Qwen3.8 27B, Protocol B (verifier feedback, up to 5 turns), N = 20

| Intent | Admissible on turn 1 | Within 5 turns (95% interval) | Turn it became admissible | Still failing | Distinct turn-1 outputs | Transport failures |
| :--- | ---: | :--- | :--- | :--- | ---: | ---: |
| INTENT-1 `port1-isolation` | 5/20 | 19/20: 76% to 99% | turn 1: 5, turn 2: 11, turn 3: 3 | none | 18 | 1 |
| INTENT-2 `dns-confinement` | 7/20 | 20/20: 84% to 100% | turn 1: 7, turn 2: 13 | none | 20 | 0 |
| INTENT-3 `quarantine-precedence` | 1/20 | 20/20: 84% to 100% | turn 1: 1, turn 2: 17, turn 3: 2 | none | 20 | 0 |
| INTENT-4 `tap-return-isolation` | 20/20 | 20/20: 84% to 100% | turn 1: 20 | none | 20 | 0 |
| **All four** | **33/80** | **79/80: 93% to 100%** | | | | |

### Claude Haiku 5.5, Protocol A (zero-shot), N = 50

| Intent | Admissible (95% interval) | Categories of the rest | Distinct outputs | Transport failures | Run commit |
| :--- | :--- | :--- | ---: | ---: | :--- |
| INTENT-1 `port1-isolation` | 26/50: 39% to 65% | ERR_INTENT_LEAK 20, ERR_INTENT_MISSING 4 | 48 | 0 | `65760b8` |
| INTENT-2 `dns-confinement` | 44/50: 76% to 94% | ERR_INTENT_LEAK 6 | 50 | 0 | `65760b8` |
| INTENT-3 `quarantine-precedence` | 41/50: 69% to 90% | ERR_INTENT_LEAK 7, ERR_INTENT_MISSING 2 | 50 | 0 | `c5ba110` |
| INTENT-4 `tap-return-isolation` | 50/50: 93% to 100% | none | 50 | 0 | `c5ba110` |
| **All four** | **161/200: 74% to 85%** | | | | |

### Claude Haiku 5.5, Protocol B (verifier feedback, up to 5 turns), N = 20

| Intent | Admissible on turn 1 | Within 5 turns (95% interval) | Turn it became admissible | Still failing | Distinct turn-1 outputs | Transport failures |
| :--- | ---: | :--- | :--- | :--- | ---: | ---: |
| INTENT-1 `port1-isolation` | 11/20 | 20/20: 84% to 100% | turn 1: 11, turn 2: 9 | none | 20 | 0 |
| INTENT-2 `dns-confinement` | 19/20 | 20/20: 84% to 100% | turn 1: 19, turn 2: 1 | none | 20 | 0 |
| INTENT-3 `quarantine-precedence` | 13/20 | 20/20: 84% to 100% | turn 1: 13, turn 2: 6, turn 3: 1 | none | 20 | 0 |
| INTENT-4 `tap-return-isolation` | 20/20 | 20/20: 84% to 100% | turn 1: 20 | none | 20 | 0 |
| **All four** | **63/80** | **80/80: 95% to 100%** | | | | |

### INTENT-2 control: the same specification under prompt v1 and prompt v2

| Model | Protocol A, prompt v1 | Protocol A, prompt v2 | Protocol B within 5 turns, v1 | Protocol B within 5 turns, v2 |
| :--- | :--- | :--- | :--- | :--- |
| Qwen3.8 27B | 21/50: 29% to 56% | 19/50: 26% to 52% | 20/20: 84% to 100% | 20/20: 84% to 100% |
| Claude Haiku 5.5 | 48/50: 87% to 99% | 44/50: 76% to 94% | 20/20: 84% to 100% | 20/20: 84% to 100% |

### Totals

| | Protocol A, zero-shot (200 trials) | Protocol B within 5 turns (80 trials) |
| :--- | :--- | :--- |
| Qwen3.8 27B | 86/200: 36% to 50% | 79/80: 93% to 100%; on turn 1: 33/80 |
| Claude Haiku 5.5 | 161/200: 74% to 85% | 80/80: 95% to 100%; on turn 1: 63/80 |

## What it shows

- **Zero-shot, Haiku is well ahead of Qwen overall** (161/200 against 86/200; the intervals do not overlap), and the gap is uneven. INTENT-4 is near the ceiling for both
  (50/50 and 48/50). INTENT-3 is the large one: Haiku 41/50, Qwen 1/50 (47 of Qwen's 49 failures are `ERR_INTENT_LEAK`). INTENT-2: 44/50 against 19/50. INTENT-1: 26/50 against
  18/50, where the intervals overlap.
- **With verifier feedback both reach the ceiling:** Haiku 80/80, Qwen 79/80, and in Qwen's case the one missing trial is a transport failure, not a model failure (every trial that
  ran was admissible within 5 turns). The difference is how much repair it takes: admissible on turn 1 in 63 of 80 for Haiku and 33 of 80 for Qwen; of Qwen's 79, 41 were repaired on
  turn 2 and 5 on turn 3, none later.
- **The INTENT-2 control did not move detectably.** The same specification under prompt v1 and v2: Qwen 21/50 then 19/50, Haiku 48/50 then 44/50, Protocol B 20/20 in all four cells.
  Every pair of intervals overlaps, so the added ARP field line and host addresses did not visibly change an intent that does not use them. That is absence of a detected effect at this
  N, not proof of none.
- **Amendment 1 did what it was written to do.** Under the uncorrected INTENT-3 and INTENT-4 descriptions Haiku scored 0/50 on each; under the corrected text 41/50 and 50/50.
  Those two uncorrected runs are kept (`*-uncorrected-description`) and are a record of what the model did with that text, not a result for the corrected intents.
- **The outputs are independent samples:** distinct outputs are 44 to 50 of 50 for Protocol A and 18 to 20 of 20 for Protocol B turn 1.

## What it does not show, and what to know when reading it

- **Not on-wire.** An admissible set may still misbehave on the Zodiac FX (RQ4); the cross-intent re-judge of plan D9 was not run on these sets.
- **Qwen's transport failures: 8 trials** (Protocol A: INTENT-1 3, INTENT-2 3, INTENT-4 1; Protocol B: INTENT-1 seed 1). Every one is `fetch failed` at 301 s, Node's 300 s wait for
  response headers; they cluster in time (seeds 23, 25, 27 and 35, 36, 38 in two runs) and the cause was not identified. They are recorded as failed trials, not retried and not counted as
  passes, so the affected cells' admissible counts are lower bounds by up to the number of failed trials. Haiku's valid runs had none. The runner's header wait was not changed while
  the queue ran; a longer one is a follow-up.
- **Commit stamps.** A summary's `gitCommit` is read when the run finishes. The first two Haiku Protocol A runs started and finished under `65760b8`. The Qwen INTENT-1 Protocol A run
  started under `65760b8` and reports `c5ba110`, because the worktree was fast-forwarded while it ran; every later run started under `c5ba110`. Between the two commits only the INTENT-3 and
  INTENT-4 descriptions, their pin test and the plan text changed; INTENT-1 and INTENT-2 have the same specification hashes in both, so no INTENT-1 or INTENT-2 result is affected.
- **Kept attempts, listed as plan section 10.6 promises.** `protocol-a-quarantine-precedence_v1-claude-haiku-5-5-pv2-n50-uncorrected-description` and the same for tap-return-isolation
  (0 of 50 each); and four `protocol-b-*-claude-haiku-5-5-pv2-n20-failed-attempt1-no-credit` runs, where the API account ran out of credit mid-run (73 of 80 trials failed, 7 admissible).
  The failed Protocol B attempts were relaunched once the balance was restored; those relaunched runs are the registered Protocol B results above.
- **One run per cell, one machine, one model build,** and Haiku's sampling is not matched to Qwen's (no seed, provider sampling). Intervals are Wilson intervals on the trials, not on run-to-run variation.
- **Not comparable with the pre-A10 results** in `qwen3.8-27b.md` and the Gemma and Haiku v1 runs for INTENT-1, 3 and 4: the specification and the prompt both changed. Only INTENT-2 compares, in the control above.

## Reading for the question these runs answer

With the task stated so a model can satisfy it, can a local model replace the cloud proposer? **Zero-shot, not on this evidence**: Qwen at 86/200 against Haiku at 161/200, with INTENT-3 (quarantine precedence)
the clearest gap. **Inside a loop with deterministic verifier feedback the two are close** (79/80 and 80/80), at a cost of more repair turns for Qwen (33/80 right first time against 63/80). That statement is
about abstract admissibility only, rests on one run per cell, and says nothing about the hardware.
