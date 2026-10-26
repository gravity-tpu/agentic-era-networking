# Qwen3.8 27B as the rule-set proposer (2026-10-25 and 2026-10-26)

The same evaluation as the Gemma 4 and Claude Haiku 5.5 results in this directory, run with `qwen3.8:27b`: Protocol A (zero-shot) at N = 50
and Protocol B (verifier feedback, up to 5 turns) at N = 20, on all four intents. Abstract evaluation only (RQ1 to RQ3): the verdicts come from
`src/sdn/proposal-triage.ts`; nothing was installed on the switch, so this says nothing about RQ4. **Admissible means the verifier accepts the
rule set. It does not mean the rules are correct on the wire.**

## Setup

| Setting | Value |
| :--- | :--- |
| Model | `qwen3.8:27b`, digest `aaee06c39dcf`, 27.3B parameters, Q4_K_M, through Ollama on the Mac (Apple M5 Pro, 64 GB) |
| Reasoning | `think: true`, so Ollama's default level for this model (`medium`, from `ollama show`); `num_predict` 32768 (thinking counts toward it) |
| Sampling | temperature 0.2, top-p 0.95, seeds 1..N |
| Prompt | identical to the Gemma 4 and Haiku runs: `promptSha256` matches for every intent across all three models |
| Code | commit `18148de` (clean worktree; the runner refuses a dirty tree). Runs are in `*-qwen3.8-27b-think-true-n50` and `-n20`; `-n10` is an earlier N = 10 pilot of Protocol A |
| Wall time | Protocol A 5 h 49 min for 200 trials; Protocol B 3 h 6 min for 80 trials. Local inference: no API cost (electricity not measured) |

## Protocol A, zero-shot, N = 50 per intent

| Intent | Admissible (95% interval) | Categories of the rest | Distinct first outputs | Transport failures |
| :--- | :--- | :--- | ---: | ---: |
| INTENT-1 `port1-isolation/v1` | 37/50: 60% to 84% | ERR_INTENT_LEAK 13 | 43 | 0 |
| INTENT-2 `dns-confinement/v1` | 21/50: 29% to 56% | ERR_INTENT_LEAK 29 | 47 | 0 |
| INTENT-3 `quarantine-precedence/v1` | 5/50: 4% to 21% | ERR_HAIRPIN 1, ERR_AMBIGUITY 1, ERR_INTENT_LEAK 43 | 49 | 0 |
| INTENT-4 `tap-return-isolation/v1` | 50/50: 93% to 100% | none | 49 | 0 |
| **All finished intents** | **113/200: 50% to 63%** | | | |

## Protocol B, verifier feedback, up to 5 turns, N = 20 per intent

| Intent | Admissible on turn 1 | Admissible within 5 turns (95% interval) | Turn it became admissible | Still failing | Distinct turn-1 outputs | Transport failures |
| :--- | ---: | :--- | :--- | :--- | ---: | ---: |
| INTENT-1 `port1-isolation/v1` | 16/20 | 20/20: 84% to 100% | turn 1: 16, turn 2: 3, turn 3: 1 | none | 18 | 0 |
| INTENT-2 `dns-confinement/v1` | 9/20 | 20/20: 84% to 100% | turn 1: 9, turn 2: 11 | none | 20 | 0 |
| INTENT-3 `quarantine-precedence/v1` | 3/20 | 20/20: 84% to 100% | turn 1: 3, turn 2: 13, turn 3: 4 | none | 20 | 0 |
| INTENT-4 `tap-return-isolation/v1` | 20/20 | 20/20: 84% to 100% | turn 1: 20 | none | 20 | 0 |
| **All finished intents** | **48/80** | **80/80: 95% to 100%** | | | | |

## The same intents and prompts for the other models, from the committed runs

| Intent | Gemma 4 26B, A | Gemma 4 26B, B | Claude Haiku 5.5, A | Claude Haiku 5.5, B |
| :--- | :--- | :--- | :--- | :--- |
| INTENT-1 `port1-isolation/v1` | 5/50: 4% to 21% | 20/20: 84% to 100% | 45/50: 79% to 96% | 20/20: 84% to 100% |
| INTENT-2 `dns-confinement/v1` | 29/50: 44% to 71% | 18/20: 70% to 97% | 48/50: 87% to 99% | 20/20: 84% to 100% |
| INTENT-3 `quarantine-precedence/v1` | 4/50: 3% to 19% | 18/20: 70% to 97% | 48/50: 87% to 99% | 20/20: 84% to 100% |
| INTENT-4 `tap-return-isolation/v1` | 32/50: 50% to 76% | 19/20: 76% to 99% | 50/50: 93% to 100% | 20/20: 84% to 100% |


## Totals

| | Protocol A, zero-shot (200 trials) | Protocol B, within 5 turns (80 trials) |
| :--- | :--- | :--- |
| Qwen3.8 27B | 113/200 (56%, interval 50% to 63%) | 80/80 (100%, interval 95% to 100%); admissible on turn 1: 48/80 |
| Gemma 4 26B, reasoning on | 70/200 (35%, interval 29% to 42%) | 75/80 (94%, interval 86% to 97%) |
| Claude Haiku 5.5 | 191/200 (96%, interval 92% to 98%) | 80/80 (100%, interval 95% to 100%) |

## What it shows

- **Zero-shot, Qwen is well above Gemma 4 and well below Haiku.** The intervals for Qwen and Gemma do not overlap in total; Qwen and Haiku are far apart.
  The gap is not even across intents: on INTENT-4 (tap return) Qwen matches Haiku (50/50), and on INTENT-3 (quarantine precedence) Qwen and Gemma both
  fail (5/50 and 4/50) while Haiku passes (48/50). The failures are almost all `ERR_INTENT_LEAK`: valid rule sets that forward something the intent does not
  permit. Across all 200 trials there were 2 other failures (1 `ERR_HAIRPIN`, 1 `ERR_AMBIGUITY`) and no syntax errors.
- **With verifier feedback, all three get to or near the ceiling.** Qwen and Haiku are 80/80; Gemma is 75/80. These intervals overlap, so this run cannot separate them.
  For Qwen, 32 of 80 trials needed at least one repair turn (27 at turn 2, 5 at turn 3, 0 later). INTENT-3 needed the most (3/20 first try, 20/20 by turn 3).
- **The outputs are independent samples, not repeats.** Distinct first-turn outputs are 43 to 49 of 50 for Protocol A and 18 to 20 of 20 for Protocol B,
  unlike the earlier reasoning-off Gemma run, where 50 trials produced 11 distinct outputs.
- **Transport failures:** 0 across the N = 50 and N = 20 runs. The earlier N = 10 pilot had 1: a `fetch failed` at 301 s on one INTENT-1 trial, the same wait as the
  300 s header timeout noted in the review-tier work. It was recorded as a failed trial and not retried.

## What it does not show

- **Not an on-wire result.** An admissible set may still misbehave on the Zodiac FX (RQ4), and the cross-intent check was not run on these sets.
- **Comparability is partial.** The prompts match, but the verifier did not stand still: Gemma and Haiku were judged at commits from 2026-10-19 and 2026-10-20
  (`748f43d`, `aac36f3`, `3fb0ec6`, `e132118`, `72152f3`); Qwen at `18148de`, which includes the A10 batch 1 and 2 modelling of the ARP fields. The same output could
  get a different verdict. Re-judging the older runs with the current code would settle it and has not been done.
- **INTENT-1 here is the pre-A10 intent.** `18148de` predates the per-host ARP confinement (PR #114). The current `PORT1_ISOLATION_INTENT` has per-host ARP clauses
  and a different description, so these INTENT-1 numbers do not apply to it; that needs a rerun.
- **Haiku is not sampling-matched.** The Claude arm accepts no seed and was run at its lowest effort setting (`docs/benchmarks/results/agent-evaluation/frontier-selection/README.md`).
- **One run per cell, one model build, one machine.** Single runs, no repeats of the whole experiment; the intervals are Wilson intervals on the trials, not on run-to-run variation.
- **Cost is not like for like.** Haiku is paid per token through the API (measured cost per admissible set is in `frontier-selection/README.md`); Qwen cost hours of the Mac's time, which is unpriced here.

## Reading for the question this was run to answer

Can a local model replace the cloud proposer? **Zero-shot, not on this evidence** (113/200 against 191/200). **Inside a loop with deterministic verifier feedback, it is
indistinguishable from Haiku here** (80/80 each), which is the way the project uses an agent anyway: the agent proposes, the verifier decides, a person approves. That second
statement is about abstract admissibility only and rests on one run per cell.
