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
