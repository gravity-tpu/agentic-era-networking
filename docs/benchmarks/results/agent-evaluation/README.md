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
  replies (`scripts/agent-eval.ts`, now streamed); later runs do not have this limit. **Re-run (2026-10-20):** INTENT-1 reasoning-on zero-shot was repeated in full
  with the streaming runner, same prompt, settings and seeds 1 to 50 (`protocol-a-port1-isolation-v1-gemma4-26b-think-true-streaming-rerun`): **6 of 50 admissible**
  (`ERR_HAIRPIN` 21, `ERR_INTENT_LEAK` 9, `ERR_PREREQUISITE` 9, `ERR_SYNTAX` 5), **0 transport failures**, 46 distinct outputs, 5 distinct rule-id sets among the
  admissible ones. That is 6 of 50 against the earlier 5 of 50, so the timeouts did not hide a different rate; which seeds were admissible was not compared.
- **The Jetson model** produced no admissible set: `ERR_SHADOWED` 25, `ERR_SYNTAX` 18 (in many of them an IPv4 field that is not a dotted address, for example a CIDR string),
  `ERR_PREREQUISITE` 1, `TRANSPORT_FAILURE` 6; 32 distinct outputs in the 44 answered trials. It is one 3B model with reasoning off on one
  intent: a cohort entry, not a comparison of sizes.
- Cost, from the recorded timings: reasoning on used 5,900 to 16,500 output tokens per turn and took about 2.1 hours for 50 zero-shot
  trials, against about 5 seconds a trial with it off.

## INTENT-2 to 4, reasoning off (2026-10-19)

`gemma4:26b`, reasoning off, same sampling; each intent has its own prompt (the intent description in `src/sdn/intents.ts`), so the
rows are **not** a difficulty ranking: an intent whose text spells out the policy is easier to transcribe.

| Intent | Zero-shot, N = 50 | With verifier feedback, N = 20 |
| :--- | :--- | :--- |
| INTENT-2 `dns-confinement/v1` (host level) | **50 admissible**; 9 distinct outputs, all 7 rules | **20 admissible**, all at turn 1; 7 distinct outputs |
| INTENT-3 `quarantine-precedence/v1` | 0 admissible: `ERR_HAIRPIN` 33, `ERR_PREREQUISITE` 17; 13 distinct outputs | **3 admissible** (turn 4: 2, turn 5: 1); the other 17 end in `ERR_INTENT_LEAK` 7 or `ERR_SHADOWED` 10 |
| INTENT-4 `tap-return-isolation/v1` | 0 admissible: `ERR_INTENT_LEAK` 26, `ERR_INTENT_MISSING` 24; 10 distinct outputs | **16 admissible** (turn 2: 8, turn 3: 1, turn 4: 7); the other 4 end in leak 1, missing 1, shadowed 2 |

- **INTENT-2's 50 of 50 is transcription, not synthesis.** Its text names the resolver, the allowed paths and "everything else is dropped";
  the admissible outputs are correct policies (one example: intra-segment ARP and resolver IPv4 to the uplink, a tap default, resolver replies
  and ARP back, a drop-all on P2, a tap return). Re-judged under the other intents (no model run), those 50 fail INTENT-1, INTENT-3 and
  INTENT-4, so the check does discriminate; they fail only on content the other intents ask for and this one does not.
- **INTENT-3 fails before it reaches precedence.** Zero-shot proposals die on the hairpin and the missing EtherType, the same slips as
  INTENT-1; with feedback only 3 of 20 produce a quarantine DROP that outranks forwarding and satisfies the whole intent.
- **INTENT-4 needs the tap return that INTENT-1 does not ask for**, and feedback gets 16 of 20 there; the 16 also pass INTENT-1 but fail INTENT-2 and
  INTENT-3 (checked the same way).
- **`ERR_SHADOWED` is a hygiene failure, not necessarily a safety one** (a rule fully covered by higher-priority rules: a dead rule). It is in the
  pre-registered structural list (A5), so it counts as non-admissible, but only 3 trials across these runs fail on it alone; the rest also leak or omit something.

## All four intents, reasoning off against on (`gemma4:26b`, 2026-10-19)

Admissible out of trials, same prompt per intent, strict parse. "Truncated" means the 32768-token cap was hit with no answer (the triage labels it `ERR_SYNTAX`);
"timeout" is the runner's 30-minute turn limit; both are counted as not admissible, not dropped.

| Intent | Zero-shot, reasoning off | Zero-shot, reasoning on | Feedback, reasoning off | Feedback, reasoning on |
| :--- | :--- | :--- | :--- | :--- |
| INTENT-1 `port1-isolation/v1` | 0 of 50 | 5 of 50 (2 timeouts at 301 s, old runner); re-run with the streaming runner 6 of 50, 0 timeouts | 2 of 20 | **20 of 20** |
| INTENT-2 `dns-confinement/v1` | **50 of 50** | 29 of 50 (16 truncated) | 20 of 20 | 18 of 20 (2 truncated) |
| INTENT-3 `quarantine-precedence/v1` | 0 of 50 | 4 of 50 | 3 of 20 | **18 of 20** (2 timeouts) |
| INTENT-4 `tap-return-isolation/v1` | 0 of 50 | **32 of 50** (16 truncated) | 16 of 20 | 19 of 20 (1 truncated) |

Reading it: reasoning makes the biggest difference where the policy has to be derived (INTENT-1, INTENT-4 zero-shot; INTENT-3 and INTENT-1 with feedback) and none or a
negative one where the intent text already states the policy (INTENT-2, where reasoning off scores 50 of 50 and reasoning on loses a third of its trials to truncation).
Each intent has its own wording, so the rows are not a ranking of intent difficulty; the columns are comparable within a row. Every cell is one model, one quantization,
one prompt wording and a single run of N trials, and the reasoning-on cells have the truncation and timeout limits above.

## INTENT-2 to 4, reasoning on: detail (2026-10-19)

`gemma4:26b`, reasoning on, 32768-token budget per turn, streamed runner. All six runs (Protocol A and B for each intent) finished.

| Intent | Zero-shot, N = 50 | With verifier feedback, N = 20 |
| :--- | :--- | :--- |
| INTENT-2 `dns-confinement/v1` | **29 admissible**; 16 truncated (no answer), 4 `ERR_INTENT_LEAK`, 1 `ERR_PREREQUISITE` | **18 admissible** (turn 1: 14, turn 2: 2, turn 4: 1, turn 5: 1); 2 `ERR_SYNTAX`, both **truncated** (below) |
| INTENT-3 `quarantine-precedence/v1` | **4 admissible**; `ERR_HAIRPIN` 37, `ERR_SYNTAX` 4 (3 truncated, 1 malformed), `ERR_INTENT_LEAK` 4, `ERR_PREREQUISITE` 1 | **18 admissible** (turn 1: 1, turn 2: 12, turn 3: 5); 2 `TRANSPORT_FAILURE`, both the runner's 30-minute turn timeout on the first turn (seeds 10 and 11) |
| INTENT-4 `tap-return-isolation/v1` | **32 admissible**; 16 truncated (no answer), 1 `ERR_INTENT_LEAK`, 1 `ERR_HAIRPIN` | **19 admissible** (turn 1: 11, turn 2: 4, turn 3: 3, turn 5: 1); 1 `ERR_SYNTAX`, a **truncation** on all five turns (seed 8) |

- **Truncation is a limit of this condition.** The 2 non-admissible INTENT-2 trials are not format errors: on all five turns each stopped at the 32768-token cap
  (`done_reason` `length`) with no answer, so the triage saw empty text and labelled it `ERR_SYNTAX`. Across the 20 trials, **16 of 37 turns hit the cap**
  (10 of those are the two failing trials; the other 6 were in trials that recovered after the feedback message said no JSON was found). The INTENT-1
  reasoning-on runs had none (0 of 89 turns). So on INTENT-2 the model sometimes spends its whole budget reasoning; a larger budget might change the 2
  failures and was not tried.
- 14 of 20 trials were admissible on turn 1 with no feedback at all, and the 18 admissible final outputs are all distinct.
- **INTENT-2 zero-shot: reasoning on is worse than off here, because of truncation.** 29 of 50 are admissible with reasoning on, against 50 of 50 with it off. The
  16 trials that are not admissible and not wrong are the 16 that hit the 32768-token cap on their only turn and returned nothing (the triage labels them
  `ERR_SYNTAX`; none is a malformed answer). Of the 34 trials that did answer, 29 are admissible and 5 are not (4 leaks, 1 missing EtherType). So the model reasons itself out of
  an answer in about a third of the trials, which reasoning off never does on this intent. It is a budget effect: a larger cap was not tried, and "29 of 50" would
  change with it. The 29 admissible sets are 27 distinct rule-id sets.
- **INTENT-4 zero-shot: reasoning on turns 0 of 50 into 32 of 50.** The intent asks for the tap copy and return that INTENT-1 only permits; with reasoning off every trial
  leaks or omits something (26 and 24). With it on, 32 are admissible, 16 are truncated (all 16 `ERR_SYNTAX` turns are truncations), and only 2 of the 34 that answered fail (1 leak, 1
  hairpin). The admissible sets are 6 rules (31 of 32) and converge on 17 distinct rule-id sets: many are the hand-written six-rule reference's shape.
- **INTENT-3 zero-shot: reasoning barely moves it.** 4 of 50 admissible with reasoning on, against 0 of 50 with it off; 37 of the 50 are still the hairpin (intra-segment
  traffic sent back out its ingress port), the same slip as INTENT-1. 48 distinct outputs in 50 trials, so this is not one answer repeated; the 4 admissible sets are 4
  distinct rule-id sets of 7 rules. Only 3 trials hit the token cap. A model that reasons for 9,000 to 32,000 tokens still does not get the hairpin right on its own.
- **INTENT-3 against reasoning off.** With feedback and reasoning on, 18 of 20 reach a quarantine DROP that outranks forwarding and satisfies the intent, against 3 of 20
  with reasoning off. Only one trial was right on turn 1 (the first-turn failures were mostly the hairpin, 11, and a leak, 4), so for this intent the gain comes
  from the feedback loop with reasoning, not from a better first answer. The 18 admissible sets use 7 or 8 rules and are 18 distinct rule-id sets. One turn in 40
  hit the token cap, none of them last turns.
- **INTENT-4 against reasoning off.** 19 of 20 with reasoning on, against 16 of 20 with it off. Here, unlike INTENT-3, reasoning also helps the first answer:
  11 of 20 are admissible on turn 1 with no feedback, against 0 of 20 with reasoning off. All 7 first-turn `ERR_SYNTAX` results are truncations (token cap, no answer), and
  16 of 38 turns hit the cap; the one non-admissible trial (seed 8) was truncated on every turn. In the INTENT-2 and INTENT-4 reasoning-on runs every
  `ERR_SYNTAX` turn is a truncation (16 of 16 in each), not a malformed answer; in INTENT-3 only 1 of its 3 is (the other 2 are malformed answers). The INTENT-1
  reasoning-on runs had no truncations. The 19 admissible sets use 6 or 7 rules but only 9 distinct rule-id
  sets: many converge on the same six-rule shape as the hand-written reference.
- **The 2 INTENT-3 failures are time, not content.** Seeds 10 and 11 produced no answer within the runner's 30-minute turn limit (`TURN_TIMEOUT_MS`, one first turn each), so they
  count as transport failures; the run is 18 of 20 admissible, 2 not scored, not 18 of 18.

### The Jetson model on INTENT-2 to 4 (`qwen2.5:3b`, reasoning off, zero-shot, N = 50 each)

**0 admissible in all three (and 0 of 200 across the four intents).**

| Intent | Result (50 trials) | Distinct outputs |
| :--- | :--- | ---: |
| INTENT-2 | `ERR_SYNTAX` 50 | 35 |
| INTENT-3 | `ERR_SYNTAX` 38, `ERR_SHADOWED` 11, `ERR_PREREQUISITE` 1 | 35 |
| INTENT-4 | `ERR_SYNTAX` 50 | 42 |

The syntax errors are mostly one habit: writing `srcIp` as a CIDR string (`"10.0.2.0/24"`) although the prompt says a dotted address plus a separate
prefix length (INTENT-2: 44 of 50 first errors; INTENT-3: 18 of the 38 syntax errors; INTENT-4: 40 of 50), then `outputPorts` that are not a list
of ports 1 to 4 (INTENT-3: 13, INTENT-4: 10), and a few `dstIp` strings. The strict parser is the pre-registered "malformed field types" category; a lenient parser that accepted
CIDR strings would have scored these differently, and the choice is mine, not the plan's. The model also copies the schema's placeholder MAC
address (`aa:bb:cc:dd:ee:ff`) into rules: a possible prompt effect (the prompt's example format is being echoed), not tested. These three runs had no
transport failures (they ran after the INTENT-1 run, on a model that stayed loaded).

**Lenient re-score** (`scripts/rescore-lenient.ts`, `rescore-lenient-jetson.json`; no model call, the strict scoring above is unchanged). Re-parsing the saved
responses with two named, opt-in transforms (a CIDR string is split into address and prefix length; a numeric string is read as an integer) still gives
**0 admissible in all four intents**. The failures move: INTENT-2 becomes `ERR_SHADOWED` 25, `ERR_PREREQUISITE` 21, `ERR_HAIRPIN` 2, `ERR_SYNTAX` 2;
INTENT-3 `ERR_SHADOWED` 32, `ERR_HAIRPIN` 10, `ERR_SYNTAX` 6, `ERR_PREREQUISITE` 2; INTENT-1 `ERR_SHADOWED` 38, `ERR_HAIRPIN` 2, `ERR_SYNTAX` 3,
`ERR_PREREQUISITE` 1 (6 transport failures unchanged); INTENT-4 stays mostly syntax (45 of 50: a `srcMac` that is not a MAC address in 31 trials, and IP
forms the two transforms do not cover in 11). So the small model's failure is not only format: once the format slips are forgiven the rule sets are still
wrong (dead rules, a missing EtherType, hairpins). The lenient parse is a diagnostic, not a scoring rule.

### The small model with verifier feedback (`qwen2.5:3b`, up to 5 turns, N = 20 per intent)

Run on the **Mac**, not the Jetson: the Jetson queue was stopped by its memory guard at 05:15 (available memory 304 MB with the longer feedback
conversations; the Jetson recovered with no out-of-memory kill and the interrupted run wrote nothing). It is the same model file (digest `357c53fb659c`), so the
verdicts do not depend on the hardware, though the run is not on the embedded device. `rescore-lenient-mac-b.json` is the lenient re-score.

| Intent | Strict, after 5 turns | Lenient re-score of the last turn |
| :--- | :--- | :--- |
| INTENT-1 | **0 admissible**: `ERR_SYNTAX` 13, `ERR_HAIRPIN` 5, `ERR_SHADOWED` 2 | `ERR_HAIRPIN` 8, `ERR_SYNTAX` 5, `ERR_SHADOWED` 4, `ERR_PREREQUISITE` 3 |
| INTENT-2 | **0 admissible**: `ERR_SYNTAX` 19, `ERR_PREREQUISITE` 1 | `ERR_PREREQUISITE` 12, `ERR_SYNTAX` 5, `ERR_SHADOWED` 3 |
| INTENT-3 | **0 admissible**: `ERR_SYNTAX` 17, `ERR_SHADOWED` 2, `ERR_HAIRPIN` 1 | `ERR_SYNTAX` 9, `ERR_SHADOWED` 8, `ERR_HAIRPIN` 2, `ERR_INTENT_LEAK` 1 |
| INTENT-4 | **0 admissible**: `ERR_SYNTAX` 20 | `ERR_SYNTAX` 16, `ERR_SHADOWED` 3, `ERR_PREREQUISITE` 1 |

- Every trial used all 5 turns (none stopped early), with 19, 17, 19 and 20 distinct final outputs. The first-turn category was already mostly syntax
  (12, 19, 16 and 20 of 20), and it stays mostly syntax at turn 5: the feedback message (up to 12 lines of verifier detail) does not make this model
  change its output format. In INTENT-1 a few trials moved from syntax errors to hairpins, which is a different failure, not a fix.
- Forgiving the two format slips still gives 0 admissible: the rule sets are wrong as well as badly formatted.
- For comparison on INTENT-1 with feedback: `gemma4:26b` reasoning off 2 of 20, reasoning on 20 of 20. This model is a much smaller model with no reasoning
  mode; the comparison is across model size and reasoning together, not either alone.

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
- Not done in this file: frontier-API models, a larger token budget for the truncated reasoning-on trials, re-running the timed-out INTENT-1 seeds with
  the streaming runner, other prompt wordings (so the intents' wording effects cannot be separated from their difficulty), the small model at other sizes, repeated runs of any
  cell (every cell is one run), and RQ4 (nothing here was installed on the switch).
