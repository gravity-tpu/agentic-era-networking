# Agent-proposal evaluation, first results: INTENT-1, `gemma4:26b` (2026-10-18)

First execution of the pre-registered protocol in [`docs/research/evaluation-plan.md`](../../../research/evaluation-plan.md),
one intent and one model. Abstract evaluation only (RQ1 to RQ3): the verdicts come from `src/sdn/proposal-triage.ts`,
which calls the existing checks (table budget, hygiene A5/A6, prerequisites, hairpin, exact intent evaluation A11). Nothing
here was installed on the switch, so it says nothing about RQ4 (what the hardware does).

Runner: `scripts/agent-eval.ts`. Each directory holds `summary.json` (settings, model digest, prompt hash, git commit,
counts) and `trials.jsonl` (the raw model output and the verdict for every trial, nothing dropped).

| Setting | Value |
| :--- | :--- |
| Intent | `port1-isolation/v1` (the only intent defined in code; INTENT-2 to 4 in the plan are not yet formalized) |
| Model | `gemma4:26b`, **Q4_K_M** quantization (the plan says 8-bit; this is what was available), via Ollama on the Mac |
| Sampling | temperature 0.2, top-p 0.95, seeds 1..N |
| Reasoning mode | **off** (`think: false`). With it on, the model spent its whole 8192-token budget reasoning and returned nothing in 3 of 3 pilot trials. The plan does not specify this; it is a recorded choice and the reasoning-on condition is **not evaluated** |
| Prompt | one fixed wording (`promptSha256` in each summary): the rule schema, port layout and the intent description from `intents.ts`; no example rule |

## Protocol A: zero-shot, N = 50

**0 of 50 admissible.** Primary category: `ERR_HAIRPIN` 39, `ERR_INTENT_LEAK` 11. Every trial leaks: in all 50 the
proposal forwards workload IPv4 to the uplink without confining the destination, and 39 also send intra-segment traffic back
out its ingress port (a hairpin) and so fail to deliver it to the uplink as the intent requires.

**The 50 trials are not 50 independent samples.** There are 11 distinct outputs, and one output accounts for 24 trials.

## Protocol B: verifier feedback, up to 5 turns, N = 20

| Outcome after at most 5 turns | Trials |
| :--- | ---: |
| Admissible | **2** (at turn 3 and turn 5) |
| Still `ERR_INTENT_LEAK` | 15 |
| `ERR_SYNTAX` on the last turn | 2 |
| `ERR_SHADOWED` on the last turn | 1 |

First-turn primary category: `ERR_HAIRPIN` 15, `ERR_INTENT_LEAK` 5. Feedback removes the hairpin (no trial ends in it) but
the leak survives: the same rules (`p1_to_uplink_ipv4` and variants) keep leaking across turns. The two syntax endings are the
model writing a destination prefix length of 0 to mean "anywhere"; the encoder supports 1 to 32, so that rule cannot be
expressed. Two admissible trials is 2 of 20: a rate of 10%, from two distinct outputs, with no interval worth quoting.

## What this does and does not show

- For this model, this prompt and this intent, a zero-shot proposal was never admissible and feedback rescued 2 of 20. That is a
  result about one model at one quantization with reasoning off.
- It does **not** compare models, prompts, reasoning on versus off, or intents. The hairpin-versus-leak split in particular may
  depend on the wording of the one prompt used.
- The leak is a failure to express "everything except the segment": OpenFlow cannot negate a match, so the correct policy relies on
  priorities (a higher-priority intra-segment rule, a lower-priority tap-only default). Gemma keeps adding an uplink rule for
  non-segment destinations instead.
- Triage categories `ERR_SHADOWED` and `ERR_UNCHECKABLE` are additions to the pre-registered taxonomy (see the module header).
- Protocol A was run with an earlier version of the runner (record shape `agent-eval/v1`, one response per trial); Protocol B
  uses `agent-eval/v2` (a `turns` array). The check and the prompt are the same.
- Not done: the mutation baseline run, the reference policy as a recorded baseline, other models, INTENT-2 to 4, and RQ4.
