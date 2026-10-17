# Zodiac — Roadmap

**Goal.** A real-hardware testbed and verifier for agent-proposed SDN policy: measure what a cheap OpenFlow switch can actually do, prove proposed rules are safe against that model, and test them against a live adversary.

**Positioning.** Software-driven networking from a software-engineering angle: policy as typed code, verified before it ships, measured against hardware, gated in CI. The project is not a network operating system, not autonomous, and not a production appliance.

This replaces the original "autonomous, verifiable SDN control plane" roadmap, archived at [`archive/ROADMAP-2026-10-autonomous-appliance.md`](archive/ROADMAP-2026-10-autonomous-appliance.md).

---

## 1. Why the scope changed

Measurements on the actual hardware ([whitepaper](benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)) set the limits the original plan had not accounted for:

- The Zodiac FX evaluates its flow table in software on a 120 MHz MCU: about 58 µs per packet fixed plus 4.24 µs per rule. The old 20,800 pps budget is not reachable at any depth.
- Overload at 1.3 to 2.3 times capacity drops the OpenFlow session and the whole table. Fast, rich, trustworthy actuation, which autonomy needs, is not available.
- The table holds 128 rules, so any verifier or optimizer works on a small, finite problem. That makes verification tractable and large-scale autonomy irrelevant.

Autonomy is therefore reframed as *agent-assisted, human-approved, machine-verified*. The route-loop verifier is replaced as the centerpiece by property checks over the flow table, because a static flow table has no routing loops to find.

### The Research Thesis: Why Constrained Silicon is an Unfair Advantage

Rather than a handicap, the strict physical limitations of the 120 MHz Zodiac FX define the core scientific contribution:

1. **The *Drosophila* Principle (Magnified Microarchitectural Penalties):** High-end merchant silicon (Broadcom Tomahawk, Intel Tofino) executes TCAM lookups in 4 ns, masking agent inefficiencies, priority inversions, and rule bloat behind gigabit over-provisioning. On the Zodiac FX, flow evaluation happens in software on an embedded MCU: an extra 100 rules adds 424 µs of lookup latency, rule reordering changes capacity by up to 2.6x (1.3 µs vs 4.24 µs/rule), and minor overload drops the control plane entirely. Every mistake in an agent's proposal manifests as an immediate, physical failure on the wire.
2. **Tractable and Exact Formal Verification:** In large enterprise topologies, Header Space Analysis and SAT/SMT verifiers face state space explosion, requiring heuristics or timeouts. With 128 rules and 4 ports, packet-class equivalence partitioning (`enumeratePacketClasses`) is mathematically complete, exact, and executes in $< 5\text{ ms}$ in CI without approximations.
3. **Closing the Sim-to-Real Gap:** Prior literature (Mondal et al., HotNets '23; NetConfEval) evaluates LLM configuration synthesis against Batfish or software parsers. These simulators assume infinite, frictionless silicon—a mathematically valid rule set with 150 rules passes Batfish, but bricks constrained hardware. Zodiac tests whether generative agents can synthesize policies that are *physically admissible* within tight silicon and latency budgets.

### Core Claims

1. **Simulators assume infinite, frictionless silicon; hardware enforces physics.** Logical reachability is a necessary but insufficient condition for safe networking. Hardware limits (table capacity, MCU lookup overhead, buffer cliff) must be formal inputs to the policy verifier.
2. **Generative models synthesize without consequence; deterministic verification provides the guardrail.** Unverified LLM proposals lead to table wipeouts and packet leaks. Grounded verification (A1–A11) with explicit error diagnostics enables self-correction without compromising data-plane safety.
3. **Wire observation on physical mirror taps is the sole ground truth.** Software readback proves what was written to the control plane; only packet captures across independent taps (Uplink O3, NETGEAR mirror O1) prove forwarding behavior. Discrepancy between the verifier model and physical wire observation is a scientific finding about switch microarchitecture.

## 2. Tracks

### Track A: Policy verifier (core)

Check an agent-proposed or human-proposed rule set against a model of the real switch before it is installed.

**Starting point (exists):** `buildPort1IsolationPolicy`, `verifyPort1Isolation` and `verifyIsolationReadback` in `src/sdn/port1-isolation.ts`, with tests.

**Properties to check**, each with a failing test before the check is written:

| Id | Property | State |
| :--- | :--- | :--- |
| A1 | Isolation: nothing from the workload port reaches the uplink except explicitly allowed traffic | Implemented |
| A2 | No hairpin: no rule outputs to its own ingress port | Implemented |
| A3 | Default drop: a lowest-priority table-miss DROP exists | Partly: readback confirms the entry exists and, because firmware 0.86 reports instructions (measured 2026-10-15, one switch), that it outputs nowhere. Not yet a check the install path enforces |
| A4 | Quarantine precedence: every DROP quarantine outranks every allow | Constants only; needs a check. **Conflicts with A9** (see below) |
| A5 | No shadowed rules: no rule is fully covered by a higher-priority rule | Implemented as a check (`checkRuleHygiene`, `src/sdn/rule-hygiene.ts`): exact over in_port, eth_type, MACs and IPv4 src/dst, including coverage by several rules together. Not yet called from the bridge install path |
| A6 | No overlapping rules with conflicting actions at equal priority | Implemented as a check (same module): equal-priority overlaps with different outputs, plus identical match and priority (the switch replaces, so the second ADD would silently overwrite the first). How the firmware actually resolves ties is unmeasured |
| A7 | Rule budget: count within the 128-rule table, with headroom for quarantine | Implemented as a check (`checkRuleBudget`, `src/sdn/capacity-budget.ts`): rules + table-miss + a declared quarantine reserve must fit 128 entries. Not yet called from the bridge install path |
| A8 | Capacity budget: modeled pps at the rule count and layout meets a declared target | Implemented as a check (`checkCapacityBudget`), but **returns `unverifiable` for the deployed isolation policy**: the cost model was measured on two in_port-only forwarding rules plus /32 DROP rules, and the deployed policy (six rules with IPv4 confinement, ARP and tap rules) has not been measured. `unverifiable` is not a pass. Not yet called from the bridge install path |
| A9 | Layout: forwarding rules ordered per the measured cheap layout | Not started. **Conflicts with A4** (see below) |
| A10 | ARP confinement: no ARP forwarded across P1 and P2 unless explicitly allowed | Blocked on verifying `ARP_SPA`/`ARP_TPA` support in firmware 0.86 |
| A11 | Intent compliance: exact packet-class evaluation confirms zero leaks and zero missing deliveries | Implemented (`src/sdn/intent-spec.ts`, `test/invariants/intent-spec.test.ts`) |

**Also in this track:**

- **Resolve the A4 versus A9 tension first.** The measured cheap layout installs forwarding rules above quarantine rules (1.3 µs versus 4.24 µs per rule, up to 2.6x more capacity), so a quarantined source that also matches a forwarding rule would still be forwarded. The benchmark gets away with it because its quarantine rules match addresses that never appear on the wire. Candidate resolutions to test: forwarding rules that exclude quarantined sources, a small block of high-priority quarantine rules above the forwarding rules with the rest below, or accepting quarantine-first cost. Each trades capacity against containment, and the choice should be measured and reported, not assumed.
- **Done and measured (2026-10-14 to 2026-10-15).** Flow-stats readback parses the instruction block (`src/sdn/flow-actions.ts`) and `verifyIsolationReadback` returns an `actions` verdict (`src/sdn/action-readback.ts`): `confirmed`, `mismatch` or `unobservable`, plus a table-miss check and `provenForwarding`. **Measured on the live switch on 2026-10-15** with the read-only probe (`GET /api/zodiac/flows/probe`, `npm run probe:flows`): firmware 0.86 **does** report the instruction block. All six isolation rules came back with output ports equal to the policy and byte-for-byte identical to what the controller encoded, and the table-miss carries no instructions (an empty action set, which OpenFlow 1.3 defines as a drop; whether the firmware honours that is a wire question). Evidence: `docs/benchmarks/results/flow-probe/flow-probe-2026-10-15T05-25-07-405Z.json` (+ sidecar; origin `physical_readback`), pinned by `test/invariants/flow-probe-real-capture.test.ts`. Limits: one switch, one firmware (declared 0.86 by the operator, not read by the probe), one capture of the intended steady state. It says nothing about how the switch behaves after a rule is lost or altered, and a clean readback is still not an on-wire proof (O1/O3 captures remain the ground truth). Wired into the bridge's isolation status on 2026-10-16 (`src/sdn/isolation-status.ts`): `GET /api/zodiac/flows` now returns `port1Isolation.actions` and `provenForwarding`, a reported action mismatch (or a table-miss that outputs) makes the state `mismatch`, and the install log says whether the verification is match level only. Re-verified periodically from 2026-10-16 (`src/sdn/isolation-recheck.ts`; default every 60 s, configurable 10 s to 1 h, `0` disables): a read-only re-read of the flow table through the same verifier, damped so it cannot flap (a definitive mismatch is recorded at once; two failed reads in a row make a verified status unknown but never replace a mismatch; recovery takes two clean readbacks). Still open: show it on the dashboard; decide what, if anything, should act on a mismatch.
- Property-based tests: generate random rule sets and packets, and check the verifier's abstract evaluation against an independent reference evaluator (powered by local Open vSwitch 2.17.12 `br-sim` on Jetson port 6634, supporting bounded 10,000-rule evaluation without physical switch MCU exhaustion).
- **Agent-proposal evaluation.** Have an LLM propose rule sets for a set of intents (for example "let the workload reach DNS but nothing else"). Record the fraction rejected, by which property, and whether the verifier-accepted sets behave correctly on hardware. This is the project's central empirical result. The experimental methodology is pre-registered in [docs/research/evaluation-plan.md](research/evaluation-plan.md), evaluated against the deterministic mutation baseline in `src/sdn/rule-mutations.ts`, and grounded in surveyed prior art in [docs/research/prior-art.md](research/prior-art.md).

**Exit criteria:** A1 to A11 enforced in CI; every rejection returns the violated property and the offending rules; the agent-proposal evaluation is published with its method and failure cases.

### Track B: Hardware model and conformance

Turn the benchmark from a report into an input to the verifier, and check that the switch behaves as modeled.

- **Done (2026-10-14): the fitted cost model is a pure, integer-only function** (`src/sdn/zodiac-cost-model.ts`; `t_packet = 38.5 µs + 0.0348 µs x (B - 64) + 4.24 µs x N` for the base layout, 1.3 µs per rule for forwarding-first). `test/invariants/zodiac-cost-model.test.ts` re-reads the stored ladder artifacts: all 12 saturated points are within 1.23% of the model, the tolerance it claims is 2%, and a model with the per-rule cost off by 5% fails the test. It throws outside the measured domain (0 to 128 rules; `base` at 64 to 1470 B; `forward_first` at 572 B only, with no payload term borrowed from the base layout), because extrapolating would be an unverified claim. Limits: most layouts have one round; it says nothing about session loss, which began at about 1.3 to 2.3 times capacity. Feeds A8, which is not yet implemented.
- **Conformance probe.** For a set of generated packets, compute the model's verdict, send them from the workload node, and observe what actually crosses each port. Ground truth is the independent uplink capture (O3) and the NETGEAR mirror (O1); the Zodiac P3 tap (O2) is a copy chosen by the flow rules under test and is not ground truth. Any disagreement is a finding about the model or the firmware.
- **Measure the deployed isolation policy** (six rules: IPv4 confinement, ARP, tap-only, tap return) with the existing ladder harness at several quarantine depths. Until this exists, A8 cannot say anything about the policy that is actually installed. Include the /16 DROP layout (4.39 µs per rule, 2 to 3% off the current model) if it is to be accepted.
- Close the open measurement items from the whitepaper: drop-path capacity (needs a mirror capture), direct CPU observation, and unexplained session losses.
- Replicate the single-round layouts (3 or more rounds) before treating them as distributions.

**First manual conformance run (2026-10-12).** Observation points: O3 on the uplink (switch #2 P4 mirrored to P3) and O2 (the Zodiac P3 tap). Traffic was generated by hand; counts are testbed ICMP or ARP between the named hosts.

| Test | Traffic | Observed | Model prediction | Match |
| :--- | :--- | :--- | :--- | :--- |
| T1 allowed | Mac pings `10.0.2.52` (5) | O3: 10 ICMP (= 5 requests + 5 replies); a control capture with no ping: 0 | Crosses P2 to P1, so it appears at O3 | yes |
| T2 blocked | `agentic-node-01` pings `10.0.0.1` from `eth0` (5) | 100% loss; O3: 0 ICMP toward the gateway | Policy drops it | yes |
| T2b ARP | Same host, neighbor entry flushed first | `who-has 10.0.0.1 tell 10.0.2.50`: 6 at O3 and 6 at O2, both with provenance sidecars (repeated run; the first run gave the same counts) | ARP is forwarded P1 to P2 (documented residual) | yes |
| T3 local | `node-01` pings `node-02` (stays inside the workload switch) | O3 and O2: 0 ICMP between them, while the same window captured 20 Mac-to-`node-02` ICMP at O3 | Never reaches the Zodiac | yes |
| T4 two vantage points | Mac pings `node-02` once (5), O2 and O3 captured together | O3: 10 ICMP (= 5 requests + 5 replies); O2: 5 replies, 0 requests, both with provenance sidecars (a first run with two ping runs in the window gave 20 and 10 respectively) | O2 is a copy of P1 ingress only | yes |

Limits: ICMP and ARP only; small samples (five pings per run); one switch, firmware 0.86. All O3 and, after the repeat on 2026-10-12, all O2 captures used for the results carry a provenance sidecar (origin `physical_capture`, interface, MAC, declared mirror configuration, SHA-256); the earlier O2 captures from plain `tcpdump` are kept only as history. No row disagreed with the model. This is not yet the one-command automated probe, so it does not establish an agreement rate.

**Exit criteria:** the cost model is a tested dependency of the verifier; the conformance probe runs in one command and reports agreement over a stated packet set; open items are either resolved or recorded as unresolved with evidence.

### Track C: Adversarial testing on hardware

Use the adversary node (the Pi 3B+ in the target topology) as the red team against the live policy and report what happens. Workload `wlan0` interfaces are off during runs, otherwise the lab-LAN Wi-Fi path bypasses the isolation policy being tested.

Scenarios, each repeatable by script and reported with detection and containment times:

1. ARP spoofing across P1 and P2 (claim the gateway's address toward the lab LAN).
2. MAC and IP spoofing inside the workload segment.
3. Port scan and low-rate scan.
4. Flood to the point of session loss (what an attacker can do to the control plane).
5. Evasion: traffic crafted to fit allowed rules, fragmentation, rule-table exhaustion.
6. Address aliasing from the uplink side: a lab-LAN host takes a `10.0.2.x` address and reaches the workload nodes. Observed 2026-10-09: the Mac's benchmark alias `10.0.2.119` reaches `10.0.2.50` to `10.0.2.52` in about 10 ms (the intended receiver path; flow counters not yet read to confirm). Confinement is address-based and the source address is forgeable, so this tests whether anything on the uplink side can reach workloads by choosing an address.
7. Injection through the mirror destination port: observed to work on both switches before the VLAN isolation (a frame sent from the capture NIC reached the traffic side); mitigated, and re-tested with untagged, single-tagged and double-tagged frames. Keep as a regression test.

Report per scenario: contained or not, time to detect, time to quarantine, false positives, and whether the verifier or the detector would have prevented it. The detectors under test are the Jetson GPU autoencoder and, once it exists, a Hailo-8 classifier on the Pi 5 sensor (section 3). Their precision and recall are unmeasured today and become a result of this track; the attack runs also produce the labelled captures needed to train a classifier.

**Exit criteria:** scenarios 1 to 4 scripted and reproducible; results table published; any scenario that defeats the policy produces a new verifier property in track A.

### Track D: Provenance and telemetry (maintain)

Keep what already differentiates the project: telemetry with provenance, integer counters, monotonic clocks and fail-closed defaults, enforced by `scripts/check-provenance.ts` and the invariant tests. No new scope here; changes are to keep the invariants true as the other tracks land.

## 3. Target topology and hardware roles

Reassessed 2026-10-09. The current rack has four problems for the experiments above:

1. **Workload nodes are dual-homed to the lab LAN.** Both Pis keep `wlan0` on `10.0.0.0/24` as an out-of-band path, which bypasses the P1 to P2 isolation policy.
2. **No independent observer of Zodiac P2 egress.** The P3 tap shows what the flow rules choose to copy, so it derives from the policy under test. The benchmark receiver was the Mac over Wi-Fi, which is a confound.
3. **The Pi 5 is adversary and observer.** Its capture NIC shares a host with the traffic generator, so attacker CPU load can drop captured packets.
4. **The Jetson is overloaded.** Controller, verifier, GPU detector and the Qwen proposer share 7.6 GB of memory and one GPU (96% load during inference), which distorts detector-latency measurements.

Target topology (**NEW** marks changes from today):

```text
                         Lab LAN / Internet (ISP extender, 10.0.0.1)
                                          │
                             ┌────────────┴────────────┐
                             │  Uplink switch #2       │  GS105Ev2, built 2026-10-09: P5 = ISP mesh, P4 = Zodiac P2
                             └──┬───────────────────┬──┘
                          to Zodiac P2         mirror of P4  (not yet configured)
                                │                   │
                                │                   └────► Jetson third USB NIC   [O3 egress ground truth]  live 2026-10-12
                                │
                   ┌────────────┴────────────┐
                   │    Zodiac FX  (DUT)     │── P3 policy-derived copy ─► Jetson tap NIC  [O2]
                   │                         │── P4 OpenFlow 1.3 ◄──────► Jetson enP8p1s0 (:6633)
                   └────────────┬────────────┘
                                │ P1 workload (100M, isolation policy)
                   ┌────────────┴────────────┐
                   │   NETGEAR GS105Ev2      │
                   │  P5 uplink              │
                   │  P3 ── Pi 3B+  (adversary)              wlan0 OFF during runs
                   │  P1 ── agentic-node-02 (legit client)   provisioned 2026-10-09, wlan0 OFF during runs
                   │  P2 ◄─ mirror of P5 ── Pi 5 capture NIC   [O1 pre-DUT]
                   └─────────────────────────┘
                                                  rpi-hailo (Pi 5 + Hailo-8) = SENSOR
                                                  (passive capture, classifier, verdicts
                                                   sent to the Jetson over the mgmt network)
```

| Role | Hardware | Notes |
| :--- | :--- | :--- |
| Device under test | Zodiac FX | |
| Controller, verifier, approval gate, install, readback | Jetson (CPU) | No GPU contention |
| Cross-check detector | Jetson GPU, fed by O2 | Compared with the Hailo verdicts on the same runs |
| Sensor and classifier | `rpi-hailo` (Pi 5 + Hailo-8), fed by O1 | Passive; verdicts go to the controller, and any quarantine stays inside the human-approved envelope (`src/sdn/quarantine-envelope.ts`: scope, protected hosts, cap, time limit); anything wider or longer needs a person |
| LLM proposer and evaluation harness | Mac (Gemma 4 26B); Jetson Qwen as a cheaper comparison | Off the measurement path |
| Adversary | `agentic-node-01` (Pi 3B+) | |
| Legitimate client | `agentic-node-02` (Pi 3B+, `10.0.2.52`, NETGEAR P1) | Provisioned 2026-10-09: Raspberry Pi OS Lite 64-bit, key-only SSH, Tailscale |

Observation points: **O1** is the NETGEAR hardware mirror of the workload uplink (everything the workload sent, before the DUT). **O2** is the Zodiac P3 policy-derived copy. **O3** is a mirror of the Zodiac P2 link captured by the Jetson (what actually crossed the uplink). The uplink switch (a second GS105Ev2, installed 2026-10-09; ISP mesh on its P5, Zodiac P2 on its P4) mirrors its P4 to its P3, where the Jetson's third USB NIC (`enx9c69d39ddcc0`) captures it. O3 has been live since 2026-10-12 and is what makes the conformance probe independent.

**Why O3 is not the detector's feed.** O3 only shows what crossed Zodiac P2, so traffic the policy blocked never appears there. That is what makes it good for conformance (a blocked packet appearing at O3 is a leak; absence means the block held) and useless for detection, because the attacks the detector should flag are the ones that never reach it. The detector needs O1 (pre-DUT) or O2 (the policy-derived copy).

**Capture interface for O3.** The Jetson has three wired interfaces with separate jobs: the onboard NIC is the OpenFlow control channel to Zodiac P4, the first USB NIC is O2 on Zodiac P3, and the third USB NIC is O3 on switch #2 P3. O1, O2 and O3 therefore run live together with no cable swaps, and the earlier time-share plan is retired. This Tegra kernel has no `cls_matchall`, so the O3 NIC drops egress with a root blackhole qdisc (ledger caveat 10). Do not share one NIC across both switches with VLANs: it would mix two vantage points in one capture and make provenance ambiguous.

**End-to-end scenario (the integration test).** A local model proposes a rule set for a stated intent; the verifier checks it and a person approves; the controller installs it and reads the table back; the adversary attacks while the client sends legitimate traffic; O1 and O3 capture ground truth; both detectors score the traffic; any quarantine stays inside the approved envelope. Run it once with automatic quarantine and once with a person approving each one: the difference in time to quarantine is the measured cost of the human step. Report detection and quarantine times, false positives, and model-versus-wire agreement.

**Open items for the topology:**

- Out-of-band management of the workload nodes without a lab-LAN path (for example a second Jetson NIC on a management VLAN, or scheduled `wlan0` windows).
- Done 2026-10-12: with the Corals removed, both capture NICs link at 5000M on the SuperSpeed hub. An earlier plug negotiated 480M on a USB 2.0 hub port, so use a USB 3 port and check `lsusb -t`.
- Done 2026-10-12: switch #2 management address `192.168.0.240`, mirror P4 to P3, 802.3x flow control on P4 and P5, and the O3 NIC fail-closed on egress and persistent across reboots.
- Found and mitigated 2026-10-12: the mirror destination ports on **both** switches **accepted ingress** (a frame sent from the capture NIC came back through the mirror), contradicting the documented claim; on switch #1 that port holds the untrusted Pi 5's capture NIC. Each switch now isolates its mirror port in its own VLAN (switch #2: VLAN 1 = P4, P5; VLAN 2 = P1, P2, P3. Switch #1: VLAN 1 = P1, P3, P4, P5; VLAN 2 = P2). Re-tests for untagged, 802.1Q VID 1 and VID 2 tagged, and double-tagged (outer 0x8100 and 0x88a8) frames were negative on both, the mirrors still work, and the workload network is healthy. Remaining: confirm the PVIDs in both UIs, include the ingress tests in the automated conformance probe and re-run them after any switch configuration change, and build the one-command automated probe.
- Upgrade path (not scheduled): replace the switch mirrors for O1 and O3 with passive 100BASE-TX taps. A passive tap has no transmit path onto the monitored link, so injection is physically impossible and the VLAN workaround and the qdisc drop stop being load-bearing. It needs two capture NICs per tap (one per direction), and both monitored links run at 100 Mbit, so it fits. Until then the VLAN isolation is the control, re-tested after any switch configuration change.
- Cheap check (not done): with three NICs on the Jetson, look at interrupt load and consider pinning the onboard NIC's IRQs (the OpenFlow control channel) to a dedicated core so capture traffic cannot add control-plane latency.
- Test whether `agentic-node-01`'s extra `10.0.1.50/24` address on `eth0` (control subnet) gives the untrusted segment a path to the controller; `agentic-node-02` was configured without it.

**Hailo-8 entry criteria.** The Hailo is parked as a sensor until (a) the Jetson detector has measured precision and recall on labelled captures from track C, and (b) a model for it compiles to a `.hef` with the Hailo Dataflow Compiler on an x86 Linux host (op support for the detector's convolutions is unverified). Until then it contributes nothing to the tracks. Its other candidate role, an adversary-side surrogate model for evasion testing, is research-heavy and deferred.

---

## 4. Sequence

1. **A1, A2 and A3 hardening, plus a failing test for the ARP spoof (C1).** Establishes whether the current policy actually has the ARP gap suspected in the README.
2. **B cost model as a function; A7 and A8.** The first place the hardware changes what the verifier accepts. Done 2026-10-14 as pure checks (A7 passes the deployed policy with a reserve of 24; A8 is `unverifiable` for it, see track B). Wiring into the bridge install path is not done.
3. **A5 and A6 (shadowing, conflicts), then action-level readback.** A5 and A6 done 2026-10-14 as pure checks (not yet in the install path); action-level readback done the same day (parser and verdict on fixtures; live firmware behaviour unmeasured). The read-only probe was run on the live switch on 2026-10-15: firmware 0.86 reports actions and all six rules plus the table-miss drop were confirmed. The action verdict is now in the bridge status and re-verified periodically (not yet on the dashboard). Next: show it on the dashboard, and decide what acts on a mismatch.
4. **B conformance probe**: the first manual run was done on 2026-10-12 (T1 to T4, all matched, see track B); next is the one-command automated probe over a larger packet set.
5. **A agent-proposal evaluation**, once the verifier has enough properties for the result to mean something.
6. **C scenarios 2 to 6**, then the end-to-end scenario in section 3.
7. **Independent review of the policy and the property list by a network engineer**, before publishing results. This can happen earlier; it should not happen later.

## 5. Deferred or dropped

| Item | Decision | Reason |
| :--- | :--- | :--- |
| Sentinel (bot and crawler mitigation, nftables enforcement) | Frozen; see [SENTINEL-ROADMAP.md](SENTINEL-ROADMAP.md); design doc, PDF and figures archived in [`archive/sentinel/`](archive/sentinel/README.md) | A different problem (origin protection) that does not use the OpenFlow switch's strengths |
| Zero-config DNS reverse proxy engine (old Phase 1) | Deferred | DNS wire handling exists (`src/dns/`); a proxy product is out of scope |
| Pointer-network routing and multi-agent flap prevention (old Phase 4) | Dropped | There is no dynamic routing on this data plane to stabilize |
| Autonomous agent intent firewall (old Phase 5) | Dropped | Needs application-layer visibility the hardware does not give |
| `AdaptiveFlowController` | Removed 2026-10-09 | Exported but on no data path; its fixed 25% and 5% steps contradicted its own "no magic constants" claim |
| `SymbolicRouteVerifier` | Removed 2026-10-09; replaced by `verifyPlanAdmissible` and track A checks | Its call sites passed hop lists that cannot fail, so it proved nothing |
| Coral Edge TPUs | Parked: both removed from the Jetson on 2026-10-11; one is on `rpi-hailo` (USB 3, idle: no Edge TPU runtime), one is a spare | They run a stock model whose output is not consumed; no trained classifier exists. Revisit with the Hailo entry criteria. If revived, prefer `rpi-hailo` (USB 3.0, a trusted sensor host in the target topology) over the Pi 3B+ workload nodes (USB 2.0 shared with their Ethernet, and untrusted hosts); the `libedgetpu` runtime on Debian 13 is unverified |
| Hailo-8 | Parked until entry criteria in section 3 are met | Overlaps the Jetson GPU for CNN inference; its value is isolation and a separate vantage point, which needs a trained detector first |
| Full GPU workload series (old workloads 3 and 4) | Deferred; roadmap archived | No data path needs them yet |
| Token ledger, local-model review plane, Link 9 tether work | Tooling, not scope | Maintained as development infrastructure only |

## 6. Non-goals

- Production deployment or any availability claim.
- Line-rate forwarding. The hardware cannot do it, and the measurements say so.
- Replacing a network engineer's judgment. The project's claim is narrower: deterministic checks catch classes of mistakes cheaply, and measured hardware limits turn policy bugs into predictable failures.

## 7. Completed foundation (kept)

Work from the earlier plan that the new tracks build on, all present in the repository:

- Physical telemetry bridge, serial register stream, authenticated read-only cloud relay and 30-day history (`src/sdn/zodiac-bridge-server.ts`, `src/db/`).
- OpenFlow 1.3 controller with session handling, flow-mod installation and flow-stats readback (`src/sdn/openflow-server.ts`, `src/sdn/flow-readback.ts`).
- Port-1 isolation policy with static verification and readback comparison.
- Data-plane benchmark harness and archive (`scripts/zodiac-dataplane-bench.ts`, `docs/benchmarks/`), and the [Zodiac whitepaper](design/zodiac-whitepaper.pdf) (`scripts/build-zodiac-whitepaper.py`).
- Mirror-tap ingestion and the Jetson anomaly detector with live quarantine flow-mods (present; accuracy not yet measured; the Corals were removed on 2026-10-11).
- Intent-compliance exact evaluator and machine-readable intent specs (`src/sdn/intent-spec.ts`, `src/sdn/intents.ts`).
- Deterministic mutation baseline and scoring engine (`src/sdn/rule-mutations.ts`).
- Observation point capture calibration harness (`src/sdn/capture-calibration.ts`, `scripts/calibrate-capture.ts`).
- Pre-registered evaluation plan and prior-art taxonomy (`docs/research/evaluation-plan.md`, `docs/research/prior-art.md`).
- Provenance-checked telemetry and the invariant test suite.
