# Agent-Proposal Evaluation: Pre-Registered Empirical Protocol

This document pre-registers the empirical evaluation protocol for **Track A: Policy Verifier (Agent-Proposal Evaluation)**. By specifying the research questions, evaluated models, intent benchmark suite, prompts, metrics, and failure taxonomies in advance, we eliminate post-hoc analytical bias and ensure that published findings meet scientific standards for reproducibility.

---

## 1. Research Questions

- **RQ1 (Admissibility Rate):** What proportion of OpenFlow rule sets synthesized by state-of-the-art language models satisfy deterministic safety invariants and stated network intents without human intervention?
- **RQ2 (Error Distribution):** Which invariant categories (e.g., OpenFlow 1.3 prerequisites, hairpin avoidance, table capacity, intent leakage, intent omission) account for model failures?
- **RQ3 (Comparative Leverage):** How does iterative verifier feedback (in the style of Mondal et al.'s *Verified Prompt Programming*) compare in sample efficiency and correctness to zero-shot generation and deterministic mutation baselines?
- **RQ4 (Data-Plane Fidelity):** Do rule sets accepted by the static verifier execute faithfully on physical silicon without triggering packet leakage, buffer drops, or control-plane session crashes?

---

## 2. Experimental Baselines

To provide rigorous context for model rejection rates, the evaluation compares LLM outputs against two deterministic baselines:

1. **Human-Engineered Reference Policy:**  
   Hand-crafted minimal rule sets developed by a network engineer (`buildPort1IsolationPolicy`), providing the gold-standard upper bound for admissibility and intent compliance.
2. **Deterministic Single-Point Mutation Baseline:**  
   Generated via `src/sdn/rule-mutations.ts`. Applies 6 mutation operators (`drop-rule`, `widen-prefix`, `remove-match-field`, `add-output`, `remove-output`, `raise-priority`) to the reference policy. This measures the verifier's mutation score (ability to catch plausible slips) and provides a calibrated baseline of flawed policies.

---

## 3. Standardized Intent Benchmark Suite

Each benchmark trial prompts the model with a natural-language intent specification. The verifier checks proposals against a corresponding formal machine-readable `IntentSpec` (defined in `src/sdn/intents.ts` and evaluated by `src/sdn/intent-spec.ts`):

| Intent ID | Description | Key Constraints |
| :--- | :--- | :--- |
| **INTENT-1** (`port1-isolation/v1`) | Isolate untrusted workload segment (`10.0.2.0/24`) on Port 1 from the uplink (Port 2). | Only intra-subnet IPv4 and ARP cross P1/P2. All other P1 frames divert to P3 (tap). |
| **INTENT-2** (`dns-confinement/v1`) | Restrict workload on Port 1 to DNS resolution via gateway (`10.0.2.1:53`), blocking all other Internet traffic. | UDP dstPort=53 permitted; all other outbound IP traffic dropped; ARP permitted. |
| **INTENT-3** (`quarantine-precedence/v1`) | Workload isolation policy with dynamic high-priority quarantine blocks. | High-priority DROP for specific host addresses (`10.0.2.51`) must preempt forwarding rules. |
| **INTENT-4** (`tap-return-isolation/v1`) | Bidirectional policy permitting deep packet inspection loop via Port 3. | Frames from Port 3 may return to Port 1, but must never leak to Port 2 or loop back to Port 3. |

---

## 4. Evaluated Model Cohort

To decouple the data plane from inference load, model inference executes off the measurement host (the Jetson Orin Nano CPU runs only the controller and verifier):

1. **Workstation Local Model:**  
   `Gemma 4 26B` (Apple Silicon Mac workstation via Ollama/local runner, 8-bit quantized).
2. **Embedded Edge Model:**  
   None at present. The Jetson's `Qwen 2.5` was removed on 2026-10-16 (it could not load under shared-memory pressure and added no measured value over the deterministic summary), so the small-local-model comparison is dropped unless it is re-planned with its own memory budget.
3. **Frontier Reference Models (API Baselines):**  
   - `Claude 3.5 Sonnet` / `Claude 3.7 Sonnet`
   - `GPT-4o`

---

## 5. Prompting Protocols and Trial Budget

### Protocol A: Zero-Shot Synthesis

The model receives the system prompt (OpenFlow 1.3 JSON schema and port layout) and the task intent. No examples or verifier feedback are provided.

- **Budget:** 50 independent trials per intent per model ($N = 50$).
- **Sampling Parameters:** Temperature = 0.2, Top-P = 0.95, Seed = deterministic sequence `[1..50]`.

### Protocol B: Iterative Verifier Feedback (Closed Loop)

If the model's proposal violates an invariant, the verifier's structured diagnostic error (`PlanInadmissibleError` or `IntentVerdict.violations`) is returned to the model in the conversation context.

- **Max Iterations:** 5 turns per trial.
- **Budget:** 20 independent runs per intent per model ($N = 20$).

---

## 6. Evaluation Metrics

For each trial, the evaluation records:

1. **Syntactic Validity:** Does the output parse into valid `FlowModOptions[]` JSON without schema errors?
2. **Structural Admissibility:** Does the proposal satisfy all structural invariants (A1–A7, A10)?
   - A1 (Isolation)
   - A2 (No Hairpin)
   - A3 (Default Drop)
   - A4 (Quarantine Precedence)
   - A5 (No Shadowed Rules)
   - A6 (No Overlapping Conflicts)
   - A7 (Table Budget $\le 128$)
3. **Intent Compliance (A11):** Does the exact packet-class evaluator (`checkIntent`) confirm zero leaks and zero missing deliveries?
4. **Hardware Cost Budget (A8):** Does the modeled packet lookup latency satisfy the throughput constraint ($t_{\text{packet}} \le \text{budget}$)?
5. **On-Wire Conformance:** For verifier-accepted rule sets, does physical traffic on the testbed match the predicted forwarding table without unexpected packet loss or switch disconnection?

---

## 7. Failure Taxonomy

Every rejected rule set is categorized by its primary failure mode:

- `ERR_SYNTAX`: Invalid JSON or malformed field types.
- `ERR_PREREQUISITE`: Violation of OpenFlow 1.3 match prerequisites (e.g. matching IPv4 address without `etherType = 0x0800`).
- `ERR_TABLE_OVERFLOW`: Proposal specifies $> 128$ rules.
- `ERR_HAIRPIN`: Rule outputs to its own ingress port (`in_port == out_port`).
- `ERR_AMBIGUITY`: Overlapping rules at equal priority with conflicting action lists.
- `ERR_INTENT_LEAK`: Allowed packet reaches an unpermitted egress port.
- `ERR_INTENT_MISSING`: Required traffic class is dropped or unforwarded.
- `ERR_COST_OVERFLOW`: Modeled MCU processing delay exceeds line-rate budget.
- `ERR_WIRE_DISCREPANCY`: Physical switch behavior diverges from model predictions.

---

## 8. Artifact and Provenance Archival

All evaluation runs must be executed with a clean git working tree (`scripts/zodiac-dataplane-bench.ts --allow-dirty` is rejected for evaluation runs). Raw JSON logs containing prompt inputs, model outputs, token latencies, verifier diagnostic traces, and pcap checksums are archived under:

```text
docs/benchmarks/results/agent-evaluation/
```

---

## 9. Deviations from this plan (recorded 2026-10-20)

The sections above are the plan as written and are left unedited. This section lists where the work done so far departs from it, so the plan can be read against the results. Each entry says what the plan said, what was done, and why. It was written after the runs, from the run records (`summary.json`, the READMEs under `docs/benchmarks/results/`) and the git history; it is a record of changes, not a claim that they were agreed in advance.

| # | Plan said | What was done | Why, and what it affects |
| - | --------- | ------------- | ------------------------ |
| D1 | Section 4: Gemma 4 26B, 8-bit | `gemma4:26b` at **Q4_K_M** (4-bit class), via Ollama on the Mac | That quantization was what was available. Results are about this quantization and may differ at 8-bit. |
| D2 | Section 4: embedded edge model not planned (dropped 2026-10-16) | `qwen2.5:3b` was run on the Jetson, then on the Mac, as a small-model entry; three more small models (`qwen3:4b-instruct-2507`, `phi4-mini`, `llama3.2:3b`) were screened on the Jetson. All were 0 admissible. | The owner then ruled the **Jetson small-model tests out of the evaluation** (the hardware cannot run them with enough memory, and a user-level Ollama was needed to finish runs). The screens are kept under `jetson-screens-excluded/` and are not part of any claim; the `qwen2.5:3b` Protocol A and B runs remain in the parent README as a small-model data point. `qwen2.5:3b` was removed from the Jetson again on 2026-10-20. |
| D3 | Section 4: Claude 3.5 / 3.7 Sonnet and GPT-4o | **Claude Haiku 5.5** (low effort) was chosen by a cheapest-first selection among 12 Gemini and Claude models; Fable 5.1 and Opus 5.5 declined (`refusal:cyber`) and are not scored. GPT-4o and the 3.x Sonnets were not run. | The owner asked for "the cheapest model that can execute the task", with a $50 spend cap (about $5 was spent). The selection was **not blind**: thresholds were set after part of the pilot table had been seen, and the pilot (N=3) is too small to rank models (see `frontier-selection/README.md`). Only the fresh post-selection trials support an accuracy claim; those were 3 repeats of Protocol A at N=200 per intent (2,400 fresh trials), after an earlier Protocol A N=50 per intent used in the selection, plus Protocol B N=20 per intent. |
| D4 | Section 5: temperature 0.2, top-p 0.95, seeds 1..N for every model | Gemma and Gemini used those settings. **The Claude models accept no seed, and Fable 5.1 accepts no temperature or top-p**, so the Claude arm used the provider sampling (the Claude summaries recorded before 2026-10-20 still carry 0.2 / 0.95, which were not sent; the Claude arm's sampling was the model's own, and the runner now records `null` and `provider-default` for it). Claude ran at its lowest effort setting; Gemini at default thinking. | API limits. Repeated Claude trials are not seed-reproducible, and the price gap between arms is partly a settings gap. |
| D5 | Not in the plan | A **reasoning mode** was added as a recorded choice for Gemma: off for the first results, on (32,768-token budget) for the 2026-10-19 results. A budget of 8,192 returned nothing in 3 of 3 pilot trials. | Reasoning changes the result a lot (INTENT-1: 0/50 off, 5/50 on zero-shot), so it is reported as its own arm. |
| D6 | Section 7: the taxonomy as listed | Two categories were **added**: `ERR_SHADOWED` (A5) and `ERR_UNCHECKABLE` (fail closed when a check cannot be evaluated). Also a `refusal:<category>` outcome for model refusals and `TRANSPORT_FAILURE` for failed calls. | They were needed to classify real outputs without folding them into another category. `ERR_COST_OVERFLOW` and `ERR_WIRE_DISCREPANCY` have **never been produced**: the cost model (A8) is `unverifiable` for most proposed shapes and is not applied by the triage, and the on-wire run found no discrepancy. |
| D7 | Section 3: INTENT-2 as defined | INTENT-2 (DNS confinement) was **weakened from "UDP port 53" to "the resolver host"**. The rule model has no layer-4 fields (in_port, eth_type, MACs and IPv4 src and dst only), so a port-53 restriction cannot be written, proposed or checked (`src/sdn/intents.ts`). | Results for INTENT-2 are for the weakened intent: it confines the workload to one host and does not prove that only DNS reaches it. |
| D8 | Section 6: structural admissibility counts a parsed output | An **opt-in lenient parse** (CIDR strings split, numeric strings read as integers) was added and used only as a separate re-score (`rescore-lenient.ts`); it does not change any verdict. | To separate "cannot do the task" from "cannot follow the output format". For the small models it still found 0 admissible. |
| D9 | Section 6.2: A1 to A7 and A10 as the admissibility test | Admissible outputs were also **re-judged against the other intents** (cross-intent check), and the number of **distinct outputs** is recorded per run. | Shows the check discriminates (an INTENT-1 set can fail INTENT-4) and avoids counting repeats as independent samples. Not a change to the verdict. |
| D10 | Section 6.5 and RQ4: on-wire conformance for accepted sets | Done as a single run: 58 rule sets (4 references, 38 surviving mutants, 16 Haiku-admissible sets), 290 flow checks, 5 flows (UDP and ARP only, observed on two taps), 290 agree. | The flows cannot tell 29 of the 38 surviving mutants from their references, no port-3 ingress was tested, and the switch-side hard timeout is not separated from the bridge sweep. This tests the verifier's model on the forwarding fields the flows can see; it says nothing about capacity or cost. |
| D11 | Section 8: raw logs and a clean tree for every run | Held for the runs, but several pushes carrying the harness used `--no-verify` (listed with outcomes in `.agents/audit-log.md` section 4). | Process deviation, recorded there. |
| D12 | Section 3: the four intents as defined | INTENT-1, INTENT-3 and INTENT-4 were **changed in place** by the A10 policy work (commit `992f3ca`, 2026-10-25): INTENT-1's ARP clause became one clause per workload host, and INTENT-3 and INTENT-4 are built from `...PORT1_ISOLATION_INTENT.clauses`, so they changed with it. INTENT-2 did not change. | Found 2026-10-26 by re-judging every recorded first turn with the current verifier (`rejudge-recorded-runs-2026-10-26.json`): INTENT-2, 0 of 210 verdicts change; for INTENT-1, 3 and 4 no set that was admissible when the runs were made is admissible now. Results for those three intents hold for the specifications of 2026-10-18 to 2026-10-25 (the prior state is `992f3ca^` in git) and say nothing about today's. The plan's own rule is that a changed intent needs a new plan version; section 10 is that version, and `test/invariants/eval-intents-frozen.test.ts` now pins the four specifications so this cannot happen silently again. |
| D13 | Section 4: Gemma 4 26B and the frontier references | **Qwen3.8 27B** (`qwen3.8:27b`, Q4_K_M, local, reasoning on) was run on all four intents, N = 50 for Protocol A and N = 20 for Protocol B: 113 of 200 zero-shot and 80 of 80 with feedback (`qwen3.8-27b.md`). | The owner asked whether a local model could replace the cloud proposer. Abstract admissibility only; one run per cell. |
| D14 | Section 10.2: INTENT-3 and INTENT-4 "at their current specifications" | The **descriptions** of INTENT-3 and INTENT-4 were corrected to state the per-host ARP rule (amendment 1, section 10.6). | The A10 change rewrote their clauses to require per-host ARP but left their descriptions telling the model to allow ARP generally, so a model that followed the text could not pass. Found from the first registered Haiku runs (0 of 50 on each, every failure an unconfined ARP rule the description asked for). |

**Not yet done from the plan:** the hardware cost check (A8) is not applied; no intent exercises the 128-entry table limit, so `ERR_TABLE_OVERFLOW` has never fired on a model output; each intent has a single prompt wording; the plan's Protocol B budget (N=20) was run for Gemma, `qwen2.5:3b` and Haiku, one run per cell.

## 10. Plan v2 addendum (pre-registered 2026-10-26, before any v2 data)

Section 9 D12 explains why this exists. Nothing in sections 1 to 9 is edited. This section is written, and committed, before any run it describes.

### 10.1 What changes

- **Prompt v2** (`src/sdn/proposer-prompt.ts`). Prompt v1 never told the model that `arpSpa` and `arpTpa` exist or which addresses are the workload hosts, so no model could have satisfied the per-host ARP requirement that INTENT-1, 3 and 4 now carry. v2 is v1 plus one line naming the two ARP fields (exact host only, with `etherType` 2054) and one line in the user message listing the known workload host addresses (`10.0.2.50`, `10.0.2.52`). Nothing else in the wording changes. A test reproduces the recorded v1 hashes, so earlier results stay explainable.
- **Every summary records `promptVersion` and `intentSha256`** (a hash of the canonical intent specification), and the four specifications are pinned by a test.

### 10.2 Cohort, intents, budgets

| Item | Value |
| :--- | :--- |
| Models | `qwen3.8:27b` through Ollama on the Mac (reasoning on, `num_predict` 32768) and Claude Haiku 5.5 (effort low, the Claude arm's provider sampling, a spend cap of 200 cents per run). Gemma 4 26B is run only if the owner asks, with its earlier settings. |
| Intents | INTENT-1, INTENT-3 and INTENT-4 at their current specifications (hashes pinned), plus INTENT-2, whose specification is unchanged, as a **control for the prompt change alone**: its v2 results are compared with its v1 results for the same model. |
| Protocols and budgets | As sections 5 and 9: Protocol A N = 50 and Protocol B N = 20 per intent per model, temperature 0.2, top-p 0.95, seeds 1..N where the provider accepts them (D4), one run per cell. |
| Pilot | One Protocol A run of N = 3 per intent with Qwen under v2, to check the harness runs and the prompt can express the task. It is excluded from every result and kept in `pilot-v2-excluded/`. |

**Pilot outcome** (recorded 2026-10-26 after the pilot ran and before any registered run; the four runs are in `docs/benchmarks/results/agent-evaluation/pilot-v2-excluded/`): 12 trials, 2 admissible (both INTENT-1) and 10 `ERR_INTENT_LEAK` (INTENT-1 1, INTENT-2 3, INTENT-3 3, INTENT-4 3), no syntax errors, no transport failures, each summary recording `promptVersion` v2 and the pinned `intentSha256`. It shows the harness runs and that a model can express and satisfy the per-host ARP requirement under v2 (INTENT-1). Three trials per intent say nothing about rates, and **neither the prompt nor this plan was changed because of the pilot**. It is not part of any result.

### 10.3 Analysis, fixed in advance

- The same metrics as section 6 (admissible counts with 95% Wilson intervals, the category of every failure, distinct outputs, transport failures), plus the cross-intent re-judge of D9.
- INTENT-2 v1 against INTENT-2 v2, per model, reports whether the prompt change alone moved a result.
- No prediction is made about direction or size. The earlier v1 numbers are not a target.
- A run is relaunched only for an infrastructure failure (the process died, the host went to sleep), with both attempts kept and listed. No cell is re-run to improve a number, and a failed cell is reported as failed.
- The results are reported next to the pre-A10 numbers with the specification change stated, never merged with them.

### 10.4 What this will still not show

On-wire behaviour (RQ4), run-to-run variation (one run per cell), and anything about a model or quantization not in the table. The verifier was not frozen between 2026-10-18 and now apart from the specification change, which D12's re-judge measured for INTENT-2 only.

### 10.5 Cost and time, estimated from the runs already made

Qwen: about 9 to 10 hours of the Mac's time for the 4 intents (the 2026-10-25 and 2026-10-26 runs took 5 h 49 min for Protocol A and 3 h 6 min for Protocol B). Haiku: under 2 hours of wall time; measured API cost was a small fraction of a cent per trial in the earlier selection, so the 200-cent cap per run is far above the expected spend and exists only to stop a runaway.

### 10.6 Amendment 1 (2026-10-26, before any Qwen run on INTENT-3 or INTENT-4)

**What was found.** Haiku's registered Protocol A runs finished first. INTENT-3 and INTENT-4 came back 0 of 50 each, all `ERR_INTENT_LEAK` with the same detail (`p1-everything-else via p1-arp-to-uplink ... reaches [2]`). The descriptions of those two intents still said ARP from P1 may reach the uplink (INTENT-3: "intra-segment IPv4 and ARP with the uplink"; INTENT-4: "ARP from P1 must also reach the uplink") while their clauses, inherited from INTENT-1 by `...PORT1_ISOLATION_INTENT.clauses`, require one clause per workload host and forbid the rest. INTENT-1's description had been updated to say "ARP only when claiming one of its own known addresses"; the other two had not. A model that follows the text cannot pass, so those cells measured whether a model ignores its instruction, not the task.

**What changes.** The two descriptions now use INTENT-1's wording for the ARP rule (the clauses are unchanged), their pinned hashes are updated in `test/invariants/eval-intents-frozen.test.ts`, and a new test requires any intent with per-host ARP clauses to say so in its description. INTENT-1 and INTENT-2 are unchanged (their hashes are the ones pinned in section 10.1).

**What happens to the runs already made.** Haiku's INTENT-3 and INTENT-4 Protocol A runs under the uncorrected text are kept, renamed with the suffix `-uncorrected-description`, and reported as such: they are valid records of what the model did with that text, not a result for the corrected intents. They are not merged with the corrected runs. The corrected runs use the same N, seeds and settings, and are the registered result for INTENT-3 and INTENT-4. Reason for re-running: a defect in the instrument, stated above, not a number to improve; the rule in section 10.3 (no cell re-run to improve a number) stands.

**Haiku Protocol B (infrastructure).** All four Haiku Protocol B runs failed on 2026-10-26 because the API account ran out of credit mid-run (`Your credit balance is too low to access the Anthropic API`): 73 of 80 trials are `TRANSPORT_FAILURE` with zero tokens, and the 7 trials that ran (INTENT-1, seeds 1 to 7) were admissible. That is an infrastructure failure under section 10.3: the four failed attempts are kept, renamed `-failed-attempt1-no-credit`, and listed here; the runs are relaunched once the balance is restored.

### 10.7 Results

The registered runs finished on 2026-10-27 and are reported in `docs/benchmarks/results/agent-evaluation/proposer-v2-qwen3.8-haiku-5-5.md`, with the analysis fixed in section 10.3: the same metrics as section 6, the INTENT-2 v1 against v2 control, and the earlier numbers kept separate. Nothing in sections 1 to 10.6 was edited after the runs began, apart from amendment 1 (section 10.6), which was written before any Qwen run on INTENT-3 or INTENT-4.

## 11. Plan v3 addendum: verifier-grounded LoRA proposer (pre-registered 2026-10-29, approved by the owner, before any v3 data)

Nothing in sections 1 to 10 is edited. This section is written, and committed, before any run it describes. Runs happen on an ephemeral Runpod pod (`scripts/runpod.ts`, per-run cap 5 USD), not on the Mac.

### 11.1 Question

Does the proposer adapter trained on 2026-10-29 (`docs/benchmarks/results/lora-adapters-2026-10-29/`, 1,466 SFT examples and 1,434 DPO pairs, 15 training steps, training scenarios hash-disjoint from INTENT-1 to 4) raise zero-shot admissibility over the same base model under the same prompt? Abstract evaluation only (RQ1 to RQ3): verdicts come from `src/sdn/proposal-triage.ts`; admissible means the verifier accepts the rule set, not that it is correct on the wire.

### 11.2 Arms (Protocol A, N = 50 per intent, temperature 0.2, top-p 0.95, seeds 1..50, `think: true`, `num_predict` 32768, prompt v3 for every arm)

| Arm | Weights | Serving |
| :--- | :--- | :--- |
| B3 (base) | `qwen3.8:27b` from the Ollama library (digest recorded in every summary) | Ollama 0.34.4 on the pod |
| L3 (adapter) | `Qwen/Qwen3.8-27B` bf16 with the DPO adapter merged, converted and quantized to Q4_K_M with llama.cpp | Ollama 0.34.4 on the pod, the library Modelfile's TEMPLATE, RENDERER, PARSER and PARAMETER lines kept, FROM replaced |
| C3 (pipeline control) | `Qwen/Qwen3.8-27B` bf16 with no adapter, through the same convert and quantize steps as L3 | as L3 |

L3 against C3 is the adapter effect. B3 against C3 is the effect of re-quantizing outside the Ollama library, reported so that a quantization difference is not credited to the adapter. B3 is also the arm comparable with the registered v2 data (sections 10.2 and 10.7), which used prompt v2: the prompt effect (v2 to v3) is reported separately and never merged.

### 11.3 Scope and stages (each stage needs the owner's approval of its cost before launch)

- **Stage 1:** INTENT-3 (`quarantine-precedence/v1`, where the v2 gap was 1/50), arms B3, L3 and C3, N = 50.
- **Stage 2, only if Stage 1 ran to completion:** INTENT-1, 2 and 4, same arms and N.
- Protocol B is not run in this addendum.

### 11.4 Analysis, fixed in advance

Admissible counts with 95% Wilson intervals, the category of every failure, distinct outputs and transport failures per cell (section 6); L3 against C3 and B3 against C3 per intent. No prediction is made about direction or size. A cell is relaunched only for an infrastructure failure, with both attempts kept and listed; no cell is re-run to improve a number. A run cut short by its time limit is reported with its `trialsRun`, never as a full cell.

### 11.5 What this will not show

- Prompt v3 was written after the v2 failures on these same intents were read (README of the adapter directory), so v3 results are not held out in prompt terms; only the adapter's training data is disjoint (checked by `assertDisjointFromBenchmark`).
- A 15-step run is a small training run, one seed, one adapter. A DPO reward accuracy of 100% on verifier-generated pairs is a training statistic, not evidence about INTENT-1 to 4.
- Merging then quantizing can lose part of a LoRA delta, so L3 may understate the adapter; the runtime-adapter route (llama.cpp `--lora`) is not tested here.
- On-wire behaviour (RQ4), and run-to-run variation (one run per cell).

### 11.6 Results and deviations (recorded 2026-10-30, after the runs)

Sections 11.1 to 11.5 are unchanged. The runs are reported in `docs/benchmarks/results/agent-evaluation/lora-v3-2026-10-30/README.md`, with the metrics fixed in section 11.4. Stage 1 (INTENT-3) completed for all three arms before Stage 2 (INTENT-1, 2, 4) ran any trial. Departures from the text above, each with its evidence in that README:

- **Merge route.** The adapter was merged in f16 GGUF space with `llama-export-lora`, not in bf16: a transformers merge-and-save drops the model's trailing next-token-prediction layer and the GGUF then fails to load in Ollama.
- **Infrastructure reruns (section 11.4).** The first L3 build produced an unloadable model (no trial used); L3 Stage 1 was run by hand on the rebuilt model. The first complete C3 INTENT-3 run was lost when a launcher failed before download, and the cell was rerun; both attempts are listed.
- **Scheduling.** Stage 1 cells ran one stream at a time, Stage 2 cells three concurrent streams per server, so results are compared within a stage only.
- **Run commits differ per arm** (`scripts/agent-eval.ts` and `src/sdn/` are identical across them).

## 12. Plan v4 addendum: Protocol B for the adapter (requested by the owner 2026-10-31, registered by this commit before any Protocol B data)

Sections 1 to 11 are unchanged. Section 11.3 left Protocol B out; this section adds it for the two arms that isolate the adapter. Runs happen on ephemeral Runpod pods (`scripts/runpod/`, per-run cap 5 USD).

### 12.1 Question

The adapter was trained mostly on verifier repair traces (1,434 of its examples, `src/sdn/proposer-lora-dataset.ts`). Given the deterministic verifier's feedback, does the adapted model (L3) repair a rejected proposal faster or more often than the same pipeline without the adapter (C3)? Abstract evaluation only (RQ1 to RQ3); admissible means the verifier accepts the rule set, not that it is correct on the wire.

### 12.2 Design

| Item | Value |
| :--- | :--- |
| Arms | L3 and C3 as in section 11.2, built the way section 11.6 records for the Stage 1 and 2 runs (GGUF-space merge from the original checkpoint, Q4_K_M, Ollama 0.34.4). B3 is not run. |
| Protocol | B of section 5: up to 5 turns, the verifier's detail lines (at most 12) returned after each rejected turn (`scripts/agent-eval.ts`) |
| Prompt, sampling | prompt v3, temperature 0.2, top-p 0.95, `think: true`, `num_predict` 32768, seeds 1 to 20 |
| Intents and budget | INTENT-1 to 4, N = 20 per intent per arm (the section 10.2 budget), one run per cell: 80 trials per arm |
| Scheduling | one pod per arm, the four intents running concurrently against one Ollama server; identical for both arms |

### 12.3 Metrics, fixed in advance

Per cell and over all 80 trials per arm: admissible on turn 1; admissible within 5 turns (95% Wilson interval); for the trials that became admissible, the turn at which they did; trials still failing after 5 turns, with the final category; distinct turn-1 outputs; transport failures. The primary comparison is L3 against C3 on admissible within 5 turns. The secondary comparison is the distribution of the turn of repair among eventually admissible trials (mean turns to admissibility).

### 12.4 Analysis rules

No prediction is made about direction or size. A cell is relaunched only for an infrastructure failure, with both attempts kept and listed. Results are never merged with Protocol A or with the section 10 data. The registered v2 Protocol B run of the base model reached 79 of 80 within 5 turns (section 10.7), so a ceiling is likely under v3: if both arms are near 80 of 80, the primary comparison will not discriminate and the secondary measure is the informative one. That is stated here so that it is not discovered afterwards.

### 12.5 What this will not show

One run per cell, one seed set, one adapter; prompt v3 was written after the v2 failures on these intents were read; turn-1 outputs for seeds 1 to 20 repeat the Protocol A conditions only if seeded runs reproduce; the adapter served at run time (`llama-server --lora`) is not tested; on-wire behaviour (RQ4) is not tested.

### 12.6 Results (recorded 2026-10-31, after the runs)

Sections 12.1 to 12.5 are unchanged. The runs are reported in `docs/benchmarks/results/agent-evaluation/lora-v3-protocol-b-2026-10-31/README.md`. Both arms were admissible on 80 of 80 trials within 5 turns, so the ceiling stated in section 12.4 was reached and the primary comparison does not discriminate; no trial needed more than 2 turns. No departure from the registered design.

## 13. Plan v5 addendum: four additional intents (requested by the owner 2026-10-31, registered by this commit before any model has seen them)

Sections 1 to 12 are unchanged; the four evaluated intents (INTENT-1 to 4) stay frozen. Section numbering assumes the results sections of the open pull requests for plan sections 11.6 and 12 are merged; renumber at merge if they are not.

### 13.1 Why

Under prompt v3 the three intents INTENT-1, 2 and 4 are at or near the ceiling: the control arm (C3) reached 47, 50 and 50 of 50 in Protocol A, and Protocol B reached 80 of 80 within 5 turns for both arms (results of sections 11 and 12). A benchmark that all arms pass cannot tell them apart. The additional intents add interacting constraints, so that a result on them can differ between arms.

### 13.2 The intents, chosen by structure

They are defined in `src/sdn/intents-hard.ts` with hand-written reference policies in `src/sdn/intent-references-hard.ts`. **They were chosen for their structure before any model saw them, none is dropped whatever a model scores, and an intent on which every arm scores 47 or more of 50 is reported as saturated, not removed.** Every description is built from the same parameters as its clauses, and a test requires it to name every address its clauses use (the contradiction amendment 1 fixed). All addresses lie in 10.0.2.0/24, the held-out benchmark subnet, so no training scenario can contain them.

| Id | What it adds | Clauses | Reference rules | Priority tiers | Named addresses |
| :--- | :--- | ---: | ---: | ---: | ---: |
| quarantine-set/v1 (INTENT-5) | INTENT-3 with three quarantined hosts, both directions: six DROPs that must outrank every forwarding rule | 13 | 13 | 4 | 3 |
| dns-quarantine/v1 (INTENT-6) | DNS confinement with one host quarantined, so the resolver exception and the quarantine overlap | 9 | 8 | 4 | 2 |
| uplink-arp-confinement/v1 (INTENT-7) | isolation with ARP from the uplink allowed only for two named peers (A10's second direction) | 9 | 8 | 3 | 2 |
| per-host-allowlist/v1 (INTENT-8) | two workload hosts with different destination allowlists and a return path that is asymmetric per source | 11 | 10 | 3 | 2 |

For comparison the same measures for the evaluated four (pinned by `test/invariants/hard-intents.test.ts`): INTENT-1 7, 7, 3, 0; INTENT-2 7, 6, 3, 1; INTENT-3 9, 9, 4, 1; INTENT-4 7, 7, 3, 0. INTENT-5 and 8 are larger than every evaluated intent on clauses and reference rules; INTENT-6 and 7 are larger than INTENT-1, 2 and 4 and comparable to INTENT-3. These measures are crude proxies: structural size is not a claim about difficulty for a model, which is what the evaluation measures.

### 13.3 What a verdict proves

The same as for the evaluated intents (section 7 and `src/sdn/proposal-triage.ts`): over every packet class the rules and the intent can distinguish, the rule set has no hairpin, no equal-priority conflict, no shadowed rule and no leak or omission. Each reference policy is accepted by the verifier, a set of targeted breakages per intent is rejected, and between 73% and 82% of the mutants of each reference are rejected (the survivors are mostly neutral: a priority raised on a rule that is already on top, a tap copy removed where the intent only says a rule may make it).

### 13.4 Evaluation proposed (not yet run: launching needs the owner's approval of the cost)

Protocol A, prompt v3, N = 50 per intent (seeds 1 to 50), temperature 0.2, top-p 0.95, `think: true`, `num_predict` 32768, on the arms B3, C3 and L3 of section 11.2, one run per cell: 200 trials per arm, 600 in all. One Runpod pod per arm with the four intents running concurrently (four streams per server), the same scheduling for every arm. Cost estimated from the section 11 and 12 runs at about 4.6 USD per pod for a 200-minute limit (the per-run cap is 5 USD), about 14 USD in all; this is an estimate, not a measurement for this workload.

### 13.5 Analysis, fixed in advance

The metrics of section 6 (admissible counts with 95% Wilson intervals, the category of every failure, distinct outputs, transport failures), reported per intent and per arm; L3 against C3 is the adapter effect and B3 against C3 the quantization route, as in section 11.2. No prediction is made about direction or size. A cell is relaunched only for an infrastructure failure, with both attempts kept and listed. Results are never merged with the earlier sections' data. Run-to-run variation measured in section 12 (same-seed runs differ by a few trials per cell at N = 20) is a stated limit on any per-intent difference of a few trials.

### 13.6 What this will not show

That structural size means difficulty for a model; anything about intents outside this one switch topology and these ten addresses; whether verifier-accepted rule sets behave correctly on the wire (RQ4); one run per cell; the reference policies are the author's, and the verifier is the only judge.

## 14. Plan v6 addendum: a frontier baseline, a properly trained adapter, and a conditional Protocol B (requested by the owner 2026-10-31, registered by this commit before any of these runs)

Sections 1 to 13 are unchanged. The owner left the sequencing of these runs to the operator (a Claude Code session) within the limits in section 14.6.

### 14.1 Why

- **The adapter evaluated so far is a smoke-test adapter.** It was trained with `--max-steps 15 --grad-accum 4` at batch size 1: about 60 of its 1,466 SFT examples and 60 of its 1,434 DPO pairs (about 4%). Sections 11 and 12 therefore say what a 4% adapter does, not what the adapter idea does.
- **There is no frontier arm under prompt v3.** The registered Haiku runs of section 10 used prompt v2 on four intents.

### 14.2 Runs

1. **Haiku 5.5 under prompt v3 (arm H3).** Claude Haiku 5.5 through the Message Batches API, Protocol A, prompt v3, N = 50 per intent on all eight intents (INTENT-1 to 8), effort `low`, `num_predict` 16384, no seed (the Claude arm accepts none), one run per cell, a spend cap of 100 cents per run (priced at the non-batch rates of section 10.2, so the cap is conservative). Compared with the other arms only descriptively: its sampling differs (section 9, D4).
2. **A trained adapter (arm L4).** The same dataset, builder, base model and hyperparameters as the section 11 adapter (`Qwen/Qwen3.8-27B`, LoRA r = 16, alpha = 32, batch size 1, gradient accumulation 8, seed 42), but trained for up to one epoch of SFT (183 steps) and one of DPO (179 steps) instead of 15 steps, under a wall-clock budget so a pod time limit cannot destroy the result: training stops gracefully when the budget is reached, the adapter is saved, and the steps actually completed are recorded and reported. The training data stays disjoint from every benchmark intent (hash and subnet checks, `assertDisjointFromBenchmark`). L4 is built for evaluation exactly as L3 is (section 13 pipeline: GGUF-space merge from the original checkpoint, Q4_K_M).
3. **L4 evaluation.** Protocol A, prompt v3, N = 50 per intent, on INTENT-1, INTENT-3, INTENT-5, INTENT-6, INTENT-7 and INTENT-8 (the two intents where L3 differed most from the control, and the four new ones): 300 trials, one run per cell, two pods of three intents each. The comparisons are L4 against C3 (the adapter effect) and L4 against L3 (the effect of training length), using the C3 and L3 cells already recorded in sections 11 and 13.
4. **Conditional Protocol B on the new intents (section 12 design).** Run only if, for at least one of INTENT-5 to 8, the C3 cell of section 13 is below 47 of 50 (the saturation threshold of section 13.2), and only for the intents that meet that condition: arms L3 and C3, N = 20 per intent, prompt v3. If no new intent meets it, it is not run and the saturation is reported.

### 14.3 Analysis, fixed in advance

The metrics of section 6 per cell (admissible counts with 95% Wilson intervals, failure categories, distinct outputs, transport failures); for Protocol B the metrics of section 12.3. No prediction is made about direction or size. A cell is relaunched only for an infrastructure failure, with both attempts kept and listed. Results are never merged with those of other sections. Run-to-run variation (section 12: same-seed runs differ by a few trials per cell) is a stated limit on any difference of a few trials. If L4 is trained for fewer steps than planned because of the wall-clock budget, it is still evaluated and labelled with the steps done.

### 14.4 What this will not show

One adapter, one training run, one seed set; Haiku's sampling differs from the local arms; the adapter served at run time (`llama-server --lora`) is not tested; on-wire behaviour (RQ4); whether any intent is hard for a model for reasons other than the structure measured in section 13.2.

### 14.5 Cost and time (estimates, not measurements for these workloads)

Haiku: well under 2 USD of API credit (the eight valid section 10 Haiku runs cost about 0.27 USD). L4 training: a Secure Cloud pod at 1.79 USD per hour for up to 165 minutes, about 4.9 USD at most. L4 evaluation: two Community pods of about 4.1 USD each. Conditional Protocol B: about 4 USD per arm.

### 14.6 Limits

Runpod spend stays within the owner's total of 50 USD and the 5 USD per-run cap; Claude API spend stays within the per-run caps above. If a step would exceed the 50 USD total, it is not started and the situation is reported instead (in particular the conditional Protocol B, which needs about 8 USD beyond the rest).

## 15. Plan v7 addendum (DRAFT, not registered): an adapter trained on a changed design

**Status: a draft by the operator (a Claude Code session), written after the L4 follow-up observations (`docs/benchmarks/results/agent-evaluation/l4-adapter-2026-10-31/README.md`). Nothing in this section is registered or authorised: no run starts until the owner approves it and a commit registers the final text before any data. Sections 1 to 14 are unchanged. The dataset generator changes in 15.2 are not implemented.**

### 15.1 Why

L4 (80 SFT and 90 DPO steps, about half the data) scored 145 of 300 against 248 for the control (section 14 results). Afterwards measured: 60 of 69 long failed outputs are repetition loops (median ratio of distinct ids 0.08) and 22 of 119 syntax failures are empty answers after long generation; the training set has 32 distinct scenarios seen about 20 times each, no thinking in any target, and the v2 system prompt while the evaluation used v3. A full epoch of the same recipe would show the same 32 scenarios about twice as often as L4 did. None of these is established as the cause; the design below varies them so that a result is interpretable.

### 15.2 Design

1. **Dataset v2 (to be implemented, tested first).** At least 256 distinct scenarios (addresses, ports, host counts and clause counts varied within the existing four families and two or three added compositions), the v3 system prompt, the same verifier-grounded filtering and the same disjointness checks (`assertDisjointFromBenchmark`, the benchmark's subnets and intent hashes; the structural similarity to the families is by design and is reported). The generator must reject any example the verifier does not accept as the target.
2. **Thinking handling (the owner chooses before registration):** (a) evaluate both the adapter and its control with `think: false`, which needs a new control arm because every earlier cell used `think: true`; or (b) keep `think: true` and train on targets that include thinking, obtained by rejection sampling from the base model (outputs the verifier accepted, thinking kept), which needs a new sampling run and its cost. This draft recommends (a) for the first experiment: it changes one thing, costs less and needs no new data collection.
3. **Arms.** L5: SFT only, learning rate 1e-4 (named and bounded, not adapted), at most one epoch of dataset v2, evaluated before any DPO stage. C5: the same pipeline without the adapter under the same thinking setting. DPO is a second experiment, started only if the stopping rule in 15.3 passes.
4. **Smoke gate before any 300-trial evaluation.** After SFT, 20 zero-shot samples on training-family scenarios and 20 on three held-out-from-training scenarios: if more than 10% of the 40 are syntax failures the run is reported as failed to train and not evaluated further (L4's rate was 119 of 300).
5. **Evaluation.** Protocol A, prompt v3, N = 50 per intent, the six intents of section 14.2 item 3, one run per cell, single-stream pods (section 14 results: concurrency gains nothing per pod), a lifetime extension within the cap decided before launch and never by a blocking question while a pod is running.

### 15.3 Analysis and stopping rules, fixed in advance

The metrics of section 6 per cell, plus the share of syntax failures and the repetition ratio of long outputs (as measured in the L4 addendum) so that the failure mode is compared and not only the count. L5 is compared with C5 (the adapter effect) and, descriptively, with L3 and L4. The experiment stops, and the owner decides whether to continue, when any of the following holds: the smoke gate fails; the six-intent total of L5 is below C5's by more than the run-to-run margin of section 12; or spend reaches 25 USD for this section. No campaign continues without that decision.

### 15.4 What this will not show

One adapter, one seed, one run per cell; whether the adapter helps under `think: true` (if option (a) is chosen); whether DPO helps; any result on the wire (RQ4).

### 15.5 Cost and time (estimates from the L4 runs, not measurements for this workload)

Training: the L4 pod cost about 3.9 USD for 130 minutes (1.79 USD per hour); a larger dataset under a 130-minute budget costs the same, and one epoch of dataset v2 may need more. Evaluation: about 2.4 USD per single-intent pod (L4 reruns), so about 14 USD for L5 on six intents and as much again for C5 (about 28 USD), which is above this section's 25 USD limit: L5 and C5 on the three intents where L3 and C3 differed most would cost about 14 USD and is the proposed first step.

### 15.6 Limits

Runpod spend within the owner's total and the 5 USD per-run cap (a pod needing more is split before launch); the 25 USD limit of 15.3; the named decision-maker for continuing is the owner.

### 15.7 Decisions needed from the owner

The thinking option in 15.2 item 2; whether dataset v2 generator work is worth building before any run; whether the first step is the three-intent subset of 15.5.

## 16. Plan v8 addendum (DRAFT until the owner confirms): the on-wire conformance run of the evaluation's rule sets (RQ4)

**Status: a draft by the operator (a Claude Code session) for the owner's confirmation. It becomes the pre-registration when the owner confirms it in the session and a commit records that; no wire run starts before then. Sections 1 to 15 are unchanged. The conformance harness changes in 16.8 are not implemented. Nothing here installs anything: each session installs only a bundle the owner has approved by hash, with the owner present (Invariant 4).**

### 16.1 Question

Does the switch do what the verifier's model says it does for the rule sets the evaluation produced, and does it do what the intent says? Two measures, kept apart. **M1, agreement with the model:** for each rule set and flow, the ports where a frame is observed against the ports the verifier's own match function predicts (`predictOutcome`, `src/sdn/wire-flows.ts`, the same priority-order semantics as `scripts/conformance-run.ts`). **M2, behaviour against the intent:** for each flow, the first intent clause that matches the packet gives the ports it must reach and may reach (`src/sdn/intent-spec.ts`); the observation is compliant if every must-reach port that the testbed can observe was seen and nothing outside may-reach was seen. A verifier-admitted set that fails M2 on the wire while agreeing on M1 would mean the intent's own reading of the model is wrong; one that fails M1 means the model or the firmware differs from what the verifier assumes.

### 16.2 The bundle, fixed before any wire data

`scripts/select-wire-bundle.ts` with seed 20261031 over the recorded cells of `docs/benchmarks/results/agent-evaluation/` (reproduced by `test/invariants/wire-bundle.test.ts`): **132 rule sets** in `docs/benchmarks/results/conformance/bundle-2026-10-31/`, `index.json` SHA-256 `4bb9a7bdf27d503eacc2bd4c0f0d32bab24d1d93b4b2db191de940b68f7fa7dc`. Per intent: the reference; every surviving mutant that some chosen flow can tell from the reference; up to 8 recorded model-proposed sets that a chosen flow can tell from the reference, drawn round-robin over the models that produced them; and 2 surviving mutants and 2 recorded sets that no flow can tell from the reference (equivalence controls: they test only that the switch agrees with the model's equivalence, and are reported separately). tap-return-isolation has no separable set, so it contributes its reference and four controls.

### 16.3 The flows

`flows.json` of the same directory (SHA-256 `ce9637fe846f6054feca9b5716741ae56e30f0a4b8334ff160420a94f205376d`): 3 to 6 flows per intent, chosen by a greedy cover from candidates the testbed can send: a real host's own address, an alias on a workload node, or a forged frame from a workload NIC (all accepted by the owner, 2026-10-31). **No frame is injected into port 3** (owner, 2026-10-31): how rule sets treat frames arriving from the tap is not tested and is reported as untested. Each sender capability is a declaration to be validated at the bench in Phase 1; a flow that cannot be sent is removed by a recorded amendment commit before any rule set goes on the wire, and the sets only it separated are then reported as separable by no testable flow.

### 16.4 Procedure

Per rule set: install through the guarded experiment endpoint (`POST /api/experiment/install`: bounds, A5/A6/A7 re-checks, table-miss drop, readback, bridge time limit and switch-side hard timeout), send each flow (5 UDP datagrams, or the kernel's 3 ARP requests), capture at O2, O3 and the port 1 listener, restore the isolation policy and read it back. Raw captures with SHA-256 and a provenance record are kept for every set. The session's bundle is approved by the owner by `index.json` hash and the owner is present.

### 16.5 Repeats

20 rule sets, drawn by the same seed from the bundle's separable sets, are run three times in different sessions, to measure ordering and timing effects. A set whose three runs disagree with each other is a finding about the harness or the firmware before it is a finding about the model.

### 16.6 Analysis, fixed in advance

M1 and M2 per flow and per rule set, with 95% Wilson intervals on the per-flow agreement rate; counts split by kind (reference, surviving mutant, model-admissible by the model that produced it, equivalence control); every disagreement as a numbered finding with the capture that shows it. A disagreement becomes a test and, where the verifier needs it, a new property in track A. The earlier run (2026-10-20) had 290 of 290 flow checks in agreement; no direction is predicted here, and an all-agree result is stated with its interval, not as a proof about the switch.

### 16.7 Stopping rules and limits

A session stops, with the isolation policy restored and read back, on: a restore or readback that does not verify, a bridge attention flag, an unexpected change in the O3 capture's baseline, or the owner's call. A disagreement is data and does not stop a session. No rule set outside the approved bundle is installed. The total number of sessions is not capped here: each continues only with the owner present.

### 16.8 What must be built first (not done)

`scripts/conformance-run.ts` has five hard-coded flows (F1 to F5) and predicts with its own copy of the match function; it must read `flows.json`, use `predictOutcome`, send IPv4 and ARP flows from aliases and forged sources, compute M2, and set up and tear down the workload aliases reversibly. It is tested offline against a fake bridge before it touches the switch.

### 16.9 What this will not show

Exhaustive correctness on the wire; behaviour on traffic outside the chosen flows (L4 ports and VLAN are not modelled); frames arriving from the tap; more than one switch and one firmware (0.86); the time and cost of a session (unmeasured: the Phase 1 smoke run measures it).
