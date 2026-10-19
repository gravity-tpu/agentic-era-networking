# Agent-proposal evaluation, first results: INTENT-1 (2026-10-18 and 2026-10-19)

First execution of the pre-registered protocol in [`docs/research/evaluation-plan.md`](../../../research/evaluation-plan.md),
one intent and one model. Abstract evaluation only (RQ1 to RQ3): the verdicts come from `src/sdn/proposal-triage.ts`,
which calls the existing checks (table budget, hygiene A5/A6, prerequisites, hairpin, exact intent evaluation A11). Nothing
here was installed on the switch, so it says nothing about RQ4 (what the hardware does).

Runner: `scripts/agent-eval.ts`. Each directory holds `summary.json` (settings, model digest, prompt hash, git commit,
counts) and `trials.jsonl` (the raw model output and the verdict for every trial, nothing dropped).

| Setting | Value |
| :--- | :--- |
| Intent | `port1-isolation/v1` for every result in this file. INTENT-2 to 4 are now defined in code (`src/sdn/intents.ts`; INTENT-2 weakened to host level, see `baselines/README.md`); their runs are separate directories |
| Models | `gemma4:26b`, **Q4_K_M** quantization (the plan says 8-bit; this is what was available), via Ollama on the Mac; `qwen2.5:3b` (1.9 GB) via Ollama on the Jetson, reasoning off, as a small "embedded edge" entry (the plan had dropped that cohort unless re-planned) |
| Sampling | temperature 0.2, top-p 0.95, seeds 1..N |
| Reasoning mode | A recorded choice, not in the plan. **Off** (`think: false`) for the first results; **on** (`think: true`, 32768-token budget) for the 2026-10-19 results. On with the original 8192-token budget returned nothing in 3 of 3 pilot trials (the budget went to reasoning) |
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

## Reasoning on, and a small model on the Jetson (2026-10-19, INTENT-1)

Same intent, prompt and sampling; only the reasoning mode (and, for the last row, the model) changes.

| Condition | Zero-shot, N = 50 | With verifier feedback, N = 20 |
| :--- | :--- | :--- |
| `gemma4:26b`, reasoning **off** | 0 admissible | 2 admissible |
| `gemma4:26b`, reasoning **on** | **5 admissible** (10%) | **20 admissible** (all 20 within 3 turns) |
| `qwen2.5:3b` on the Jetson, reasoning off | 0 admissible | not run |

Reasoning on, zero-shot: `ERR_HAIRPIN` 21, `ERR_INTENT_LEAK` 13, `ERR_PREREQUISITE` 8 (an IPv4 match without the EtherType),
`ERR_SYNTAX` 1, `ADMISSIBLE` 5, `TRANSPORT_FAILURE` 2. With feedback, first-turn category: hairpin 7, prerequisite 7, leak 4, admissible 2;
admissible at turn 1: 2 trials, turn 2: 15, turn 3: 3. Feedback fixed what it named: the leak and the hairpin that never moved with
reasoning off did move with it on.

- **The outputs are far more varied with reasoning on**: 45 distinct outputs in the 48 answered zero-shot trials (most repeated: 4), and
  20 distinct final outputs in 20 feedback trials, against 11 distinct in 50 with reasoning off. N = 50 therefore means more here.
- **What "admissible" is.** The admissible sets are 5 or 6 rules: intra-segment IPv4 and ARP to the uplink, everything else from P1 to the
  tap, and the uplink-to-workload rules. None includes the tap-to-workload return rule, which INTENT-1 permits but does not require.
  Re-judged under the other intents (no model run, `proposal-triage`): all 27 admissible outputs fail INTENT-2 and INTENT-3 (leak) and INTENT-4
  (the required tap return is missing). So "admissible under INTENT-1" is a statement about INTENT-1's text; it does not transfer.
- **Transport failures are a bias, not noise.** The 2 reasoning-on failures and the Jetson run's 6 are all timeouts at about 301 s: Node's
  fetch gives up when no response header arrives within 300 s, and a non-streamed reply sends none until generation ends. They are the
  longest generations, so they are the trials most likely to be hardest or most elaborate. These runs were made before the runner streamed its
  replies (`scripts/agent-eval.ts`, now streamed); later runs do not have this limit. The affected seeds were not re-run.
- **The Jetson model** produced no admissible set: `ERR_SHADOWED` 25, `ERR_SYNTAX` 18 (in many of them an IPv4 field that is not a dotted address, for example a CIDR string),
  `ERR_PREREQUISITE` 1, `TRANSPORT_FAILURE` 6; 32 distinct outputs in the 44 answered trials. It is one 3B model with reasoning off on one
  intent: a cohort entry, not a comparison of sizes.
- Cost, from the recorded timings: reasoning on used 5,900 to 16,500 output tokens per turn and took about 2.1 hours for 50 zero-shot
  trials, against about 5 seconds a trial with it off.

## What this does and does not show

- For this model, this prompt and this intent: zero-shot was never admissible with reasoning off and 5 of 50 with it on; feedback rescued
  2 of 20 with reasoning off and all 20 with it on. These are results about one model at one quantization and one prompt wording.
- It does **not** compare prompts or models other than the three rows above. INTENT-2 to 4 are separate. The hairpin-versus-leak split in
  particular may depend on the wording of the one prompt used.
- The leak is a failure to express "everything except the segment": OpenFlow cannot negate a match, so the correct policy relies on
  priorities (a higher-priority intra-segment rule, a lower-priority tap-only default). Gemma keeps adding an uplink rule for
  non-segment destinations instead.
- Triage categories `ERR_SHADOWED` and `ERR_UNCHECKABLE` are additions to the pre-registered taxonomy (see the module header).
- Protocol A was run with an earlier version of the runner (record shape `agent-eval/v1`, one response per trial); Protocol B
  uses `agent-eval/v2` (a `turns` array). The check and the prompt are the same.
- Baselines (reference policy and single-point mutations) for all four intents are in `baselines/`.
- Not done in this file: INTENT-2 to 4 model runs (queued, in their own directories), frontier-API models, re-running the timed-out seeds, and RQ4.
