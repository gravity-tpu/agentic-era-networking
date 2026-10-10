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

## 2. Tracks

### Track A: Policy verifier (core)

Check an agent-proposed or human-proposed rule set against a model of the real switch before it is installed.

**Starting point (exists):** `buildPort1IsolationPolicy`, `verifyPort1Isolation` and `verifyIsolationReadback` in `src/sdn/port1-isolation.ts`, with tests.

**Properties to check**, each with a failing test before the check is written:

| Id | Property | State |
| :--- | :--- | :--- |
| A1 | Isolation: nothing from the workload port reaches the uplink except explicitly allowed traffic | Implemented |
| A2 | No hairpin: no rule outputs to its own ingress port | Implemented |
| A3 | Default drop: a lowest-priority table-miss DROP exists | Partly (readback only) |
| A4 | Quarantine precedence: every DROP quarantine outranks every allow | Constants only; needs a check. **Conflicts with A9** (see below) |
| A5 | No shadowed rules: no rule is fully covered by a higher-priority rule | Not started |
| A6 | No overlapping rules with conflicting actions at equal priority | Not started |
| A7 | Rule budget: count within the 128-rule table, with headroom for quarantine | Not started |
| A8 | Capacity budget: modeled pps at the rule count and layout meets a declared target | Not started; needs the cost model (track B) |
| A9 | Layout: forwarding rules ordered per the measured cheap layout | Not started. **Conflicts with A4** (see below) |
| A10 | ARP confinement: no ARP forwarded across P1 and P2 unless explicitly allowed | Blocked on verifying `ARP_SPA`/`ARP_TPA` support in firmware 0.86 |

**Also in this track:**

- **Resolve the A4 versus A9 tension first.** The measured cheap layout installs forwarding rules above quarantine rules (1.3 µs versus 4.24 µs per rule, up to 2.6x more capacity), so a quarantined source that also matches a forwarding rule would still be forwarded. The benchmark gets away with it because its quarantine rules match addresses that never appear on the wire. Candidate resolutions to test: forwarding rules that exclude quarantined sources, a small block of high-priority quarantine rules above the forwarding rules with the rest below, or accepting quarantine-first cost. Each trades capacity against containment, and the choice should be measured and reported, not assumed.
- Parse output actions in flow-stats readback so readback proves forwarding intent, not just match fields (today's documented gap).
- Property-based tests: generate random rule sets and packets, and check the verifier's abstract evaluation against an independent reference evaluator.
- **Agent-proposal evaluation.** Have an LLM propose rule sets for a set of intents (for example "let the workload reach DNS but nothing else"). Record the fraction rejected, by which property, and whether the verifier-accepted sets behave correctly on hardware. This is the project's central empirical result.

**Exit criteria:** A1 to A9 enforced in CI; every rejection returns the violated property and the offending rules; the agent-proposal evaluation is published with its method and failure cases.

### Track B: Hardware model and conformance

Turn the benchmark from a report into an input to the verifier, and check that the switch behaves as modeled.

- Encode the fitted cost model (`t_packet = 38.5 µs + 0.0348 µs x (B - 64) + 4.24 µs x N`, base layout; 1.3 µs per rule for forwarding-first) as a pure function with tests against the stored artifacts. Feeds A8.
- **Conformance probe.** For a set of generated packets, compute the model's verdict, send them from the workload node, and observe what actually crosses each port. Ground truth is the independent uplink capture (O3) and the NETGEAR mirror (O1); the Zodiac P3 tap (O2) is a copy chosen by the flow rules under test and is not ground truth. Any disagreement is a finding about the model or the firmware.
- Close the open measurement items from the whitepaper: drop-path capacity (needs a mirror capture), direct CPU observation, and unexplained session losses.
- Replicate the single-round layouts (3 or more rounds) before treating them as distributions.

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
                             │  Uplink mirror switch   │  NEW (any cheap mirror-capable switch)
                             └──┬───────────────────┬──┘
                          to Zodiac P2         mirror of the P2 link
                                │                   │
                                │                   └────► Jetson USB NIC #2   [O3 egress ground truth]  NEW
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
| Sensor and classifier | `rpi-hailo` (Pi 5 + Hailo-8), fed by O1 | Passive; verdicts go to the controller, and any quarantine still passes the verifier and a human gate |
| LLM proposer and evaluation harness | Mac (Gemma 4 26B); Jetson Qwen as a cheaper comparison | Off the measurement path |
| Adversary | `agentic-node-01` (Pi 3B+) | |
| Legitimate client | `agentic-node-02` (Pi 3B+, `10.0.2.52`, NETGEAR P1) | Provisioned 2026-10-09: Raspberry Pi OS Lite 64-bit, key-only SSH, Tailscale |

Observation points: **O1** is the NETGEAR hardware mirror of the workload uplink (everything the workload sent, before the DUT). **O2** is the Zodiac P3 policy-derived copy. **O3** is a mirror on the P2 link captured by the Jetson (what actually crossed the uplink); it does not exist today and is what makes the conformance probe independent.

**End-to-end scenario (the integration test).** A local model proposes a rule set for a stated intent; the verifier checks it and a person approves; the controller installs it and reads the table back; the adversary attacks while the client sends legitimate traffic; O1 and O3 capture ground truth; both detectors score the traffic; any quarantine passes the verifier again. Report detection and quarantine times, false positives, and model-versus-wire agreement.

**Open items for the topology:**

- Out-of-band management of the workload nodes without a lab-LAN path (for example a second Jetson NIC on a management VLAN, or scheduled `wlan0` windows).
- Verify that the Jetson has the USB ports and bandwidth for NIC #2 (parking the Coral TPUs should free some).
- Test whether `agentic-node-01`'s extra `10.0.1.50/24` address on `eth0` (control subnet) gives the untrusted segment a path to the controller; `agentic-node-02` was configured without it.

**Hailo-8 entry criteria.** The Hailo is parked as a sensor until (a) the Jetson detector has measured precision and recall on labelled captures from track C, and (b) a model for it compiles to a `.hef` with the Hailo Dataflow Compiler on an x86 Linux host (op support for the detector's convolutions is unverified). Until then it contributes nothing to the tracks. Its other candidate role, an adversary-side surrogate model for evasion testing, is research-heavy and deferred.

---

## 4. Sequence

1. **A1, A2 and A3 hardening, plus a failing test for the ARP spoof (C1).** Establishes whether the current policy actually has the ARP gap suspected in the README.
2. **B cost model as a function; A7 and A8.** The first place the hardware changes what the verifier accepts.
3. **A5 and A6 (shadowing, conflicts), then action-level readback.**
4. **B conformance probe**, after the O3 uplink observer is cabled (the NETGEAR mirror O1 can be used first).
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
| Coral Edge TPUs | Parked | They run a stock model whose output is not consumed; no trained classifier exists. Revisit with the Hailo entry criteria |
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
- Mirror-tap ingestion and the Coral and Jetson anomaly detector with live quarantine flow-mods (present; accuracy not yet measured).
- Provenance-checked telemetry and the invariant test suite.
