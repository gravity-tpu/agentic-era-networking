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
