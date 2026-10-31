# Track A close-out plan: from abstract verdicts to checked behaviour on the switch (DRAFT, 2026-10-31)

**Status: the owner approved this plan's shape on 2026-10-31 and answered the seven questions in section 4. Nothing here authorises an install on the switch by anyone but a person who has approved the specific bundle (Invariant 4): the operator (a Claude Code session) prepares, the owner approves each bundle by hash and is generally present. Estimates are marked as estimates. Plan section 16 (the pre-registration of the wire runs) is not yet written; no wire run starts before a commit registers it.**

Track A's exit criteria (`docs/ROADMAP.md`): A1 to A11 enforced in CI; every rejection returns the violated property and the offending rules; the agent-proposal evaluation published with its method and failure cases. The owner's priority for this close-out is the wire: whether what the verifier accepts does what it is supposed to do on the real switch.

## 1. Where things stand (facts, with their sources)

- **The abstract evaluation is published** (plan sections 10 to 14 and their results directories): eight intents, five arms (Haiku 5.5, library base, control, 15-step adapter, 80/90-step adapter), Protocol A and B. Admissible means the verifier accepts the rule set; it does not mean correct on the wire.
- **A first wire run exists** (`docs/benchmarks/results/conformance/README.md`, 2026-10-20): 58 rule sets, 290 flow checks, 290 agree with the verifier's own model, 0 disagree (95% Wilson interval 98.7% to 100.0%). Only 16 of the 58 were model-proposed (4 per intent, intents 1 to 4, Haiku and earlier arms); the rest were references and surviving mutants. Five flows, UDP and ARP only, one run, one switch (firmware 0.86). **29 of the 38 surviving mutants and 4 of the 16 model sets cannot be told from their reference by those flows**, so agreement there says little. The ROADMAP sentence "nothing yet checked on the wire" and the Track B line "one-command probe not built" were out of date (`scripts/conformance-run.ts` exists and ran); this plan's first commit corrects them.
- **No wire check exists for the four new intents (INTENT-5 to 8) or for any L3/L4 adapter output.** Several of their addresses have no real host (quarantine-set uses 10.0.2.53 and .54; uplink-arp-confinement uses 10.0.2.1 and .254; per-host-allowlist uses a file server at 10.0.2.20). The testbed hosts are 10.0.2.50 (node-01), .51 (rpi-hailo), .52 (node-02), the Mac and the Jetson (`.agents/network-context.md`).
- **The pool is large.** Across all recorded cells there are 5,785 admissible trials and 4,250 distinct admissible rule sets by text (INTENT-1 513, 2 1,108, 3 937, 4 917, 5 179, 6 193, 7 201, 8 202), **750 distinct by behaviour** (priority, outputs and match, ignoring rule ids and order: 46, 307, 86, 47, 63, 72, 51 and 78; `docs/benchmarks/results/wire-flows-2026-10-31/README.md`). Only 16 have been on the wire.
- **Open verifier items** (ROADMAP track A): A3 (default drop is read back, not enforced by the install path); A8 (no target declared); A10 uplink to workload: **deployed 2026-10-27 with an empty peer list (`ZODIAC_UPLINK_ARP_PEERS=none`), chosen from an idle 24-hour capture; not shown: that the NETGEAR switch's management broadcast is actually dropped, a non-peer-host test, and a peer list measured under real use** (the ROADMAP summary row still says "not deployed"; corrected with this plan's decisions); A9 closed by decision.

## 2. What a wire result would and would not prove

It shows, for the flows sent, whether the packets the model predicts appear at the observation points (O3 on the Zodiac P2 link, O2 on P3, a listener for port 1), and whether the intent's own expectation holds there. Agreement on a finite flow set is evidence against a disagreement on those flows, not a proof for the rule set; a flow set that cannot separate a rule set from its reference says nothing about that rule set. Disagreement is a finding about the model, the firmware or the harness and becomes a test.

## 3. Plan

### Phase 0: no hardware (operator, about one session; estimate)

1. Correct the stale ROADMAP and README statements (first commit of this branch).
2. **Flow feasibility table. Done 2026-10-31** (`docs/benchmarks/results/wire-flows-2026-10-31/README.md`, `src/sdn/wire-flows.ts`): 3 to 7 flows per intent separate every set the model can tell from the reference; only 4 to 9 of each intent's 6 to 18 surviving mutants are separable at all (the rest are equivalent over the modelled fields); tap-return-isolation has nothing to separate; injection into port 3 from the O2 capture NIC would separate more sets but changes the ground-truth arrangement (decision 8). The original step text follows.
   **Flow feasibility table.** For each of the eight intents, derive the flows from its exact packet classes (A11) that the testbed can send and observe, as the owner approves: where an address has no real host, either an IP alias on a workload node (reversible, documented) or a frame with a forged source sent from a workload NIC (the untrusted segment; needs the owner's explicit approval per intent). Extend the flow set beyond the five of 2026-10-20 to include ICMP and TCP SYN and, for the uplink-facing intents, uplink-side senders, until each reference is separable from its mutants on at least the classes the intent names. Report how many sets each flow separates, as the 2026-10-20 report did.
3. **Bundle selection. Done 2026-10-31** (seed 20261031, 132 rule sets, `docs/benchmarks/results/conformance/bundle-2026-10-31/`, reproduced by a test; registered as plan section 16, confirmed by the owner 2026-10-31). The original step text follows.
   **Bundle selection, fixed before any wire data.** Per intent: the reference; up to 8 distinct model-admissible sets drawn by a seeded rule stratified over arms (every arm that has an admissible set, including L3 and L4); and the surviving mutants of the reference. The seed and the resulting `index.json` hash are recorded in a new plan section 16 (registered by its commit, before any wire run).
4. **Pre-register** in plan section 16: flows, bundle rule, the two measures (agreement with the verifier's model; observed behaviour against the intent's own expectation), repeats, stopping rules, and the approval step.

### Phase 1: bench readiness (owner present; estimate half a day)

Read-only flow probe (`npm run probe:flows`), capture NICs linked at 5000M, the mirror-port ingress re-tests (VLAN isolation re-tested after any switch change), bridge idle with no attention flag, the SSH tunnel and experiment token, the harness `--dry-run`, then the four references on the wire as a smoke test. The smoke run measures the real time per rule set (the 2026-10-20 run did not record its duration).

### Phase 2: the wire runs (owner approves each session's bundle by its `index.json` hash and is present)

Each rule set goes through the guarded experiment endpoint (bounds, A5/A6/A7 re-checks, table-miss drop, readback, bridge time limit and switch-side hard timeout) and the isolation policy is restored and read back after each. A non-restored state, a readback mismatch or an unexpected bridge attention flag stops the session. A subset of 20 sets is repeated three times to measure ordering and timing effects. The safety backstops tested on 2026-10-20 are re-run once at the start (`safety-backstops/`).

### Phase 3: analysis and write-up

Agreement per flow and per arm with Wilson intervals; the separate measure of observed behaviour against the intent's expectation (a verifier-admitted set that fails the intent on the wire would be a verifier bug); how much of the pool the flows can separate; every disagreement as a numbered finding with a new test, and a new property in track A where it needs one. Written up in `docs/benchmarks/results/conformance/`, with the limits of section 2.

### Phase 4: close the open properties (software, in parallel with 2 and 3; each starts with a failing test)

- **A3:** enforced by the install path, not only read back.
- **A8, target determined by the operator (owner's instruction 2026-10-31).** The deployed-table model gives 12,500 pps at 0 quarantines and 8,106 pps at the envelope's full depth of 8 (`t = 80.0 us + 5.42 us x k`, 572 B). The same source records that the switch lost its OpenFlow session at about 1.3 to 2.3 times capacity, so load is only comfortably safe below about 1/1.3 = 77% of capacity. **Target: 6,000 pps at 572 B** (74% of the k = 8 capacity, below that bound, and about half of the k = 0 capacity). Workload demand is unmeasured; the target is a ceiling guard, not a demand estimate, and must be revisited only with a new measurement. **Consequence to settle before setting it on the live bridge:** declaring a target makes the install gate refuse (as `unverifiable`) any allow-route table the cost model does not cover, which today is every table but the deployed shape, so every novel agent-proposed set would be refused. The target is therefore recorded now but declared on the live bridge only together with an extended cost model (a measured cost per rule for the proposal shapes, with its domain stated), or after the owner accepts that consequence; until then A8 stays advisory and is recorded as such.
- **A10, uplink to workload:** already deployed (above). Remaining: a peer list measured under real use (the 2026-10-26 capture was an idle day), a capture showing the NETGEAR management broadcast is dropped, and the non-peer-host test; an experiment with an uplink-side 10.0.2.x host needs that host listed as a peer while it runs.
- A test that every rejection returns the violated property and the offending rules; the A1 to A11 CI list written out against the exit criterion.

### Phase 5: review and exit

Independent review of the policy and property list by a network engineer before publishing (ROADMAP sequence step 7; the owner arranges it); the exit checklist (A1 to A11 enforced in CI, rejection detail, published evaluation with failure cases, wire results as above); ROADMAP and README status lines updated.

### Phase 6: Track C scenarios (in scope by the owner's decision)

Scenarios 2 (MAC and IP spoofing inside the workload segment), 4 (flood to session loss), 5 (evasion: crafted traffic, fragmentation, table exhaustion) and 6 (address aliasing from the uplink side) are scripted with the adversary node, each through `scripts/adversary-bind.py` (the interface-binding guard), reported with detection and containment times, and each defeat becomes a new verifier property. Scenario 4 can drop the OpenFlow session and scenario 5 exhausts the table: both run only with the owner present, inside the quarantine envelope, with the isolation policy restored and read back afterwards, and are pre-registered in the same section 16 or a section 17. Scenarios 1 and 3 are done; scenario 7 stays a regression test.

## 4. Decisions (answered by the owner, 2026-10-31)

1. Plan shape and the pre-registration step before any wire run: approved.
2. Flow feasibility: IP aliases on the workload nodes and forged-source frames from workload NICs are acceptable (each use is listed in the pre-registration).
3. Availability: the owner is generally present; each session's bundle is still approved by hash before it is installed.
4. A8: the operator determines the target (6,000 pps at 572 B, derivation in Phase 4), with the consequence noted there.
5. A10 uplink to workload: deploy. It is already deployed (empty peer list); the remaining work is in Phase 4.
6. Independent review: the owner.
7. Track C scenarios 2, 4 and 5 are part of this close-out (Phase 6; scenario 6 with them).

8. Injecting frames into port 3 from the O2 capture NIC (to test how rule sets treat frames from the tap): **not approved for now** (owner, 2026-10-31); port 3 ingress stays untested and is reported as such.

## 5. What this plan will not deliver

Exhaustive correctness on the wire; a result on traffic other than the flows chosen; more than one switch and one firmware; a measured duration or cost for the wire sessions (none exists yet: model and pod costs are zero for them, the cost is the owner's time and the testbed's). The adapter question (plan section 15) is separate and not needed for the wire results: the existing 4,250 admissible sets are enough.
