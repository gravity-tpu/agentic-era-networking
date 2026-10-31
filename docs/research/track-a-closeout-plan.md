# Track A close-out plan: from abstract verdicts to checked behaviour on the switch (DRAFT, 2026-10-31)

**Status: a draft by the operator (a Claude Code session) for the owner's decision. Nothing here is registered or authorised. In particular no rule set is installed on the switch by anyone but a person who has approved the specific bundle (Invariant 4); the operator prepares, the owner approves and is present. Estimates are marked as estimates.**

Track A's exit criteria (`docs/ROADMAP.md`): A1 to A11 enforced in CI; every rejection returns the violated property and the offending rules; the agent-proposal evaluation published with its method and failure cases. The owner's priority for this close-out is the wire: whether what the verifier accepts does what it is supposed to do on the real switch.

## 1. Where things stand (facts, with their sources)

- **The abstract evaluation is published** (plan sections 10 to 14 and their results directories): eight intents, five arms (Haiku 5.5, library base, control, 15-step adapter, 80/90-step adapter), Protocol A and B. Admissible means the verifier accepts the rule set; it does not mean correct on the wire.
- **A first wire run exists** (`docs/benchmarks/results/conformance/README.md`, 2026-10-20): 58 rule sets, 290 flow checks, 290 agree with the verifier's own model, 0 disagree (95% Wilson interval 98.7% to 100.0%). Only 16 of the 58 were model-proposed (4 per intent, intents 1 to 4, Haiku and earlier arms); the rest were references and surviving mutants. Five flows, UDP and ARP only, one run, one switch (firmware 0.86). **29 of the 38 surviving mutants and 4 of the 16 model sets cannot be told from their reference by those flows**, so agreement there says little. The ROADMAP sentence "nothing yet checked on the wire" and the Track B line "one-command probe not built" were out of date (`scripts/conformance-run.ts` exists and ran); this plan's first commit corrects them.
- **No wire check exists for the four new intents (INTENT-5 to 8) or for any L3/L4 adapter output.** Several of their addresses have no real host (quarantine-set uses 10.0.2.53 and .54; uplink-arp-confinement uses 10.0.2.1 and .254; per-host-allowlist uses a file server at 10.0.2.20). The testbed hosts are 10.0.2.50 (node-01), .51 (rpi-hailo), .52 (node-02), the Mac and the Jetson (`.agents/network-context.md`).
- **The pool is large.** Across all recorded cells there are 5,785 admissible trials and 4,250 distinct admissible rule sets (INTENT-1 513, 2 1,108, 3 937, 4 917, 5 179, 6 193, 7 201, 8 202; counted by `parseProposal` over every `trials.jsonl`, canonicalised and de-duplicated per intent). Only 16 have been on the wire.
- **Open verifier items** (ROADMAP track A): A3 (default drop is read back, not enforced by the install path), A8 (unverifiable for the deployed table without a declared target), A10 (uplink to workload direction not deployed), A9 closed by decision.

## 2. What a wire result would and would not prove

It shows, for the flows sent, whether the packets the model predicts appear at the observation points (O3 on the Zodiac P2 link, O2 on P3, a listener for port 1), and whether the intent's own expectation holds there. Agreement on a finite flow set is evidence against a disagreement on those flows, not a proof for the rule set; a flow set that cannot separate a rule set from its reference says nothing about that rule set. Disagreement is a finding about the model, the firmware or the harness and becomes a test.

## 3. Plan

### Phase 0: no hardware (operator, about one session; estimate)

1. Correct the stale ROADMAP and README statements (first commit of this branch).
2. **Flow feasibility table.** For each of the eight intents, derive the flows from its exact packet classes (A11) that the testbed can send and observe, as the owner approves: where an address has no real host, either an IP alias on a workload node (reversible, documented) or a frame with a forged source sent from a workload NIC (the untrusted segment; needs the owner's explicit approval per intent). Extend the flow set beyond the five of 2026-10-20 to include ICMP and TCP SYN and, for the uplink-facing intents, uplink-side senders, until each reference is separable from its mutants on at least the classes the intent names. Report how many sets each flow separates, as the 2026-10-20 report did.
3. **Bundle selection, fixed before any wire data.** Per intent: the reference; up to 8 distinct model-admissible sets drawn by a seeded rule stratified over arms (every arm that has an admissible set, including L3 and L4); and the surviving mutants of the reference. The seed and the resulting `index.json` hash are recorded in a new plan section 16 (registered by its commit, before any wire run).
4. **Pre-register** in plan section 16: flows, bundle rule, the two measures (agreement with the verifier's model; observed behaviour against the intent's own expectation), repeats, stopping rules, and the approval step.

### Phase 1: bench readiness (owner present; estimate half a day)

Read-only flow probe (`npm run probe:flows`), capture NICs linked at 5000M, the mirror-port ingress re-tests (VLAN isolation re-tested after any switch change), bridge idle with no attention flag, the SSH tunnel and experiment token, the harness `--dry-run`, then the four references on the wire as a smoke test. The smoke run measures the real time per rule set (the 2026-10-20 run did not record its duration).

### Phase 2: the wire runs (owner approves each session's bundle by its `index.json` hash and is present)

Each rule set goes through the guarded experiment endpoint (bounds, A5/A6/A7 re-checks, table-miss drop, readback, bridge time limit and switch-side hard timeout) and the isolation policy is restored and read back after each. A non-restored state, a readback mismatch or an unexpected bridge attention flag stops the session. A subset of 20 sets is repeated three times to measure ordering and timing effects. The safety backstops tested on 2026-10-20 are re-run once at the start (`safety-backstops/`).

### Phase 3: analysis and write-up

Agreement per flow and per arm with Wilson intervals; the separate measure of observed behaviour against the intent's expectation (a verifier-admitted set that fails the intent on the wire would be a verifier bug); how much of the pool the flows can separate; every disagreement as a numbered finding with a new test, and a new property in track A where it needs one. Written up in `docs/benchmarks/results/conformance/`, with the limits of section 2.

### Phase 4: close the open properties (software, in parallel with 2 and 3; each starts with a failing test)

A3 enforced by the install path, not only read back; A8: the owner declares a capacity target or records the item as unverifiable by decision; A10 uplink to workload: build is done offline, the owner decides whether to deploy, and if so it is confirmed on hardware as the other direction was; a test that every rejection returns the violated property and the offending rules; the A1 to A11 CI list written out against the exit criterion.

### Phase 5: review and exit

Independent review of the policy and property list by a network engineer before publishing (ROADMAP sequence step 7; the owner arranges it); the exit checklist (A1 to A11 enforced in CI, rejection detail, published evaluation with failure cases, wire results as above); ROADMAP and README status lines updated.

## 4. Decisions needed from the owner

1. Approve this plan's shape and the pre-registration step before any wire run.
2. Flow feasibility: IP aliases acceptable on the workload nodes; forged-source frames from workload NICs acceptable (per intent)?
3. Availability: who is present for the bench sessions and when; each session's bundle is approved by hash.
4. A8: declare a capacity target, or record it as unverifiable by decision.
5. A10 uplink to workload: deploy it, or record it as open.
6. Who does the independent review, and when.
7. Whether Track C scenarios 2, 4 and 5 are part of this close-out or stay a separate track (this plan assumes separate).

## 5. What this plan will not deliver

Exhaustive correctness on the wire; a result on traffic other than the flows chosen; more than one switch and one firmware; a measured duration or cost for the wire sessions (none exists yet: model and pod costs are zero for them, the cost is the owner's time and the testbed's). The adapter question (plan section 15) is separate and not needed for the wire results: the existing 4,250 admissible sets are enough.
