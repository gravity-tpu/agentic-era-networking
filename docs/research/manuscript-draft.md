# Verifying Agent-Proposed SDN Policy Against a Measured Switch: A Real-Hardware Testbed Study

**DRAFT 0.1, 2026-11-08.** Every number in this draft is copied from a result file in this repository and cited by path in the artifact section. Nothing has been re-run for the draft. The reviewer of the policy and property list is the author, and no one outside the project has reviewed either. The author notes at the end list what must be checked or decided before submission.

**Authors:** (to be completed)

## Abstract

Language models can now propose network policy faster than a person can audit it, so verification, not generation, is the scarce step. Prior work checks LLM-generated configurations against software simulators, and prior hardware studies measure switches without synthesizing policy. We join the two on a physical device. Zodiac is a testbed built around a low-cost OpenFlow 1.3 switch (Zodiac FX, 128-rule table, software lookup on a 120 MHz microcontroller). A deterministic verifier checks agent-proposed rule sets for isolation, shadowing, conflicts, quarantine precedence, table budget, and exact intent compliance, and takes the switch's measured per-packet cost as an input. A person approves every install. Independent mirror taps then compare what the switch does with what the verifier predicted.

On this switch, per-packet cost is `80.0 µs + 5.42 µs` per quarantine rule on the deployed policy, and overload at 1.3 to 2.3 times capacity drops the OpenFlow session and the whole flow table. Across eight intents, local and hosted models satisfied the verifier zero-shot in 43% to 98% of trials depending on model, prompt and intent, and with verifier feedback reached 79/80 to 80/80 within five turns for the local 27B and hosted arms (75/80 for a local 26B model; a 3B model never produced an admissible set). Fine-tuned adapters did not replace verification. Across 128 rule sets, 611 of 611 flow checks on the real switch agreed with the verifier's model; one finding about the switch path (self-addressed IPv4 frames are dropped although the model predicts forwarding) came from a harness validation run that excluded those frames. A live adversary found that a policy the verifier accepted leaked ARP (now closed by a new property), and that a host-level ARP misconfiguration had been masking a result. We report these as measurements on one switch, one firmware, and one run per cell, not as general claims.

## 1. Introduction

Generating network configuration is cheap. Auditing it is not. A model can emit a plausible flow table in seconds, and a person reading it has no assurance that it isolates what it should, leaves out what it should not, or fits on the device.

Two bodies of work address parts of this. Verifiers such as Header Space Analysis, VeriFlow and Batfish decide reachability and isolation over an abstract model of the network [HSA, VeriFlow, Batfish]. Work on LLM configuration synthesis shows that models produce plausible but wrong configurations and that verifier feedback repairs many of them, evaluated against Batfish or software parsers [Mondal23, NetConfEval]. Neither knows what the target device can do. Measurement studies of OpenFlow switches show that real devices deviate from the specification, bottlenecked by embedded CPUs, with table-overflow degradation and control-plane behavior that differs by firmware [OFLOPS, Kuzniar15, Tango]. Those studies do not synthesize policy.

The gap matters most on cheap hardware. A rule set that passes an abstract verifier can still exceed the table, push a microcontroller into software lookup latency it cannot sustain, or drop the controller session and with it the configuration. On such a device a mistake in an agent's proposal becomes a physical failure rather than a logged warning.

We make four contributions, each bounded by the limits in Section 8:

1. **A verifier that takes measured hardware cost as an input.** Table budget and capacity are checked properties, alongside isolation, shadowing, conflicts, quarantine precedence and exact intent compliance (Section 3).
2. **A hardware characterization of the device, including a pre-registered prediction that failed.** The deployed-table cost per quarantine rule came out 28% above the fitted model's value (Section 4).
3. **An evaluation of model-proposed policy against that verifier, with on-wire conformance.** We pre-registered the protocol, report per-intent results for five arms, and checked 128 rule sets on the real switch against independent captures (Section 5).
4. **A record of where model, host and environment disagreed with the wire.** Several results looked correct until a physical observation contradicted them (Section 6). We argue this is the practical value of putting the loop on hardware.

The system is deliberately not autonomous. Agents propose, deterministic code decides admissibility, and a person approves each install. One narrow exception, detector-driven quarantine inside a pre-approved envelope, is described in Section 3.4.

## 2. Background and Related Work

**Network verification.** Header Space Analysis treats headers as points in a geometric space and devices as transformation functions [HSA]. VeriFlow and NetPlumber check invariants incrementally over equivalence classes and rule dependency graphs [VeriFlow, NetPlumber]. Anteater uses SAT [Anteater]. Batfish derives a data-plane model from multi-vendor configurations [Batfish]. These assume the device implements the model. Our verifier uses the same idea of partitioning the header space into packet classes, which is exact here because the table holds at most 128 rules on four ports, but adds the device's measured limits.

**LLMs for network configuration.** Mondal et al. pair GPT-4 with Batfish and report that localized verifier feedback cuts the number of human prompts several-fold [Mondal23]. NetConfEval benchmarks configuration synthesis across protocols and shows accuracy falling with topological complexity [NetConfEval]. Mani et al. find that generating verifiable intermediate code is more reliable than manipulating topologies directly [Mani23]. We adopt the closed-loop protocol of Mondal et al. (our Protocol B) and the typed-output principle (agents emit structured flow-mod records, never free-form configuration), and change the target from a simulator to a switch.

**Switch characterization.** OFLOPS measures flow-mod latency and packet-processing overhead and shows CPU bottlenecks [OFLOPS]. Kuźniar et al. document specification-versus-hardware discrepancies, including barrier replies sent before rules are active [Kuzniar15]. Tango infers switch properties so a controller can act safely [Tango]. Our benchmark harness follows the OFLOPS approach, and Tango's premise (device properties as controller inputs) is the premise of our cost-model-in-the-verifier.

**Data-plane testing.** Monocle and ATPG generate probes to exercise rules in hardware and compare with controller expectations [Monocle, ATPG]. SOFT finds implementation differences by differential testing [SOFT]. Our conformance run is closest to these: the verifier's model predicts the ports where each flow appears, and independent captures check it. Because the table is small, we enumerate packet classes exhaustively for the model and choose a finite set of flows for the wire.

**Where this work sits.** Verifiers check logic without the device. Benchmarks measure the device without synthesized policy. LLM studies synthesize policy without the device. This study combines the three on one piece of hardware, at the price of a narrow scope (one switch, one firmware).

## 3. System Design

### 3.1 Architecture

The system couples a closed-loop verification pipeline with a physical three-switch testbed instrumented across three independent observation vantage points. Figure 1 details the control loop and physical wiring.

```text
========================================================================================================================
PART A: CLOSED-LOOP VERIFICATION, APPROVAL, AND DATA-PLANE CONFORMANCE PIPELINE
========================================================================================================================

  [1. Proposer]                     [2. Deterministic Verifier]                 [3. Human Gate / Envelope]
  Human operator or                 verifyFlowTable() / admitInstall()          Policy never self-installs:
  LLM agent (local / cloud)         Evaluates 11 formal properties (< 5 ms):    Explicit operator hash sign-off.
          │                         • A1 (Isolation), A2 (No Hairpins)                         │
          │ candidate JSON          • A3 (Prio-0 Guard), A4 (Precedence)                       │ approved
          │ flow-mod rules          • A5/A6 (Prereq & Control), A7 (128 Cap)                   │ rule set
          ▼                         • A8 (Measured Hardware Cost Model)                        ▼
  ┌───────────────┐                 • A10 (ARP SPA), A11 (Exact Intent)        ┌───────────────────────────────┐
  │  Proposer LLM │───rule set─────►│  196/196 mutant tests caught             │      Human Approval Gate      │
  └───────▲───────┘                 └──────────────────┬───────────────────────┘│  (or pre-approved Quarantine  │
          │                                            │                        │   Envelope: k<=8, TTL<=300s)  │
          │         Protocol B Feedback (<= 5 turns)   │ rejected               └──────────────┬────────────────┘
          └───────── Rejection property + rule IDs ────┘                                       │
                                                                                               │ install
                                                                                               ▼
  [5. Physical Wire Conformance]            [4. OpenFlow 1.3 Actuator]             ┌───────────────────────────┐
  Independent capture taps                  NVIDIA Jetson Orin Nano Super          │      OpenFlow Actuator    │
  cross-check switch silicon:               • TCP 6633 controller on enP8p1s0 ◄────┤   (zodiac-bridge :3003)   │
  • O1: Pre-DUT workload ingress            • br-sim OVS reference model           └──────────────┬────────────┘
  • O2: Policy-derived mirror tap           • Action-level OFPMP_FLOW readback                    │ OFPFC_ADD
  • O3: Independent post-DUT egress         • Damped A3 auto-repair (3 bad -> resend)              ▼
  611/611 flow checks agreed (Track B)      • CDC-ACM /dev/ttyACM0 hardware telemetry   ┌───────────────────────┐
  7 live adversary scenarios (Track C)      Zero silent drop / instruction strip        │    Zodiac FX Switch   │
                                                                                        │    (Firmware 0.86)    │
                                                                                        └───────────────────────┘

========================================================================================================================
PART B: PHYSICAL SWITCH STACK WIRING, 802.1Q VLAN ISOLATION, AND PASSIVE CAPTURE POINTS
========================================================================================================================

                                    ┌────────────────────────────────────────────────────────┐
                                    │                WAN / Internet Gateway                  │
                                    └───────────────────────────┬────────────────────────────┘
                                                                │
                                    ┌───────────────────────────┴────────────────────────────┐
                                    │      ISP Wi-Fi Router & Extender (10.0.0.1/24)         │
                                    └───────────────────────────┬────────────────────────────┘
                                                                │ RJ45
                                                                ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ TIER 3 (TOP OF STACK): NETGEAR GS105Ev2 #2 — Uplink & O3 Mirror Switch (192.168.0.240)    │
 ├─────────────────────────────────────────┬───────────────────────────┬─────────────────────┤
 │ VLAN 1 (Lab LAN / Mgmt):                │ VLAN 2 (Isolated Uplink): │ VLAN 3 (O3 Tap):    │
 │ • P1: agentic-node-01 eth1 (10.0.0.56)  │ • P4: Zodiac FX Port 2    │ • P3: Mirror Dest   │
 │ • P2: agentic-node-02 eth0 (10.0.0.87)  │   (Hardware mirror source │   (Isolated 1-port  │
 │ • P5: ISP Extender RJ45 (10.0.0.1)      │    Rx+Tx copied to P3)    │    VLAN, zero frame │
 │ (Out-of-band management segment)        │ • 802.3x Flow Control ON  │    injection)       │
 └─────────────────────────────────────────┴─────────────┬─────────────┴──────────┬──────────┘
                                                         │                        │
                                            Zodiac Port 2│RJ45 (100M)             │P3 Mirror to O3
                                                         ▼                        ▼
 ┌───────────────────────────────────────────────────────────────────────┐ ┌────────────────────────┐
 │ DEVICE UNDER TEST (BOTTOM OF STACK): Zodiac FX Switch (Firmware 0.86) │ │ Jetson NIC #3 (USB 3.0)│
 ├───────────────────────────────────────────────────────────────────────┤ │ enx9c69d39ddcc0        │
 │ SAM4E8E 120 MHz ARM Cortex-M4 MCU · KSZ8795CLX 4x100BASE-TX           │ │ [O3] Independent      │
 │ 128-Rule Software Flow Table · OpenFlow 1.3                           │ │ Egress Ground Truth    │
 ├───────────────────┬───────────────────┬───────────────┬───────────────┤ └────────────────────────┘
 │ Port 1 (Workload) │ Port 2 (Uplink)   │ Port 3 (Tap)  │ Port 4 (Ctrl) │
 │ OF VLAN 100       │ OF VLAN 100       │ OF VLAN 100   │ Native VLAN200│
 └─────────┬─────────┴───────────────────┴───────┬───────┴───────┬───────┘
           │                                     │               │
           │                                     │P3 Tap to O2   │TCP 6633 Control
           │Zodiac Port 1 RJ45 (100M)            ▼               ▼
           │                         ┌───────────────────────┐ ┌───────────────────────────┐
           │                         │Jetson NIC #1 (USB 3.0)│ │Jetson Onboard NIC         │
           │                         │enx9c69d39dd0a6        │ │enP8p1s0 (10.0.1.8/24)     │
           │                         │[O2] Policy-Derived Tap│ │Dedicated OF 1.3 Control   │
           │                         └───────────────────────┘ └───────────────────────────┘
           ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ TIER 2 (MIDDLE OF STACK): NETGEAR GS105Ev2 #1 — Workload & O1 Mirror Switch (192.168.0.239)│
 ├─────────────────────────────────────────────────────────────────────┬─────────────────────┤
 │ 802.1Q VLAN 1 (Untrusted Workload Segment 10.0.2.0/24):             │ VLAN 2 (O1 Tap):    │
 │ • P5: Uplink to Zodiac Port 1 (100M; Rx+Tx mirrored to P2)          │ • P2: Mirror Dest   │
 │ • P1: agentic-node-02 (RPi 3B+, 10.0.2.52) — Legitimate Client      │   (Isolated 1-port  │
 │ • P3: agentic-node-01 (RPi 3B+, 10.0.2.50) — Hardware Adversary     │    VLAN, zero frame │
 │ • P4: rpi-hailo eth0  (RPi 5 + Hailo-8, 10.0.2.51) — Sensor Node    │    injection)       │
 │ Host hygiene: wlan0 down; arp_filter=1; 95 Mbit/s fq pacing; 802.3x │                     │
 └─────────────────────────────────────────────────────────────────────┴──────────┬──────────┘
                                                                                  │
                                                                                  │P2 Mirror to O1
                                                                                  ▼
                                                               ┌─────────────────────────────┐
                                                               │ rpi-hailo USB-GbE (eth1)    │
                                                               │ [O1] Pre-DUT Ground Truth   │
                                                               │ (clsact ingress drop qdisc) │
                                                               └─────────────────────────────┘
```

**Figure 1. Zodiac Testbed Architecture.** Part A shows the closed-loop verification pipeline with verifier feedback (Protocol B) and human governance. Part B shows the physical 3-switch vertical stack, port wiring, 802.1Q VLAN isolation, and the three passive capture points (O1 pre-DUT, O2 policy-derived tap, O3 independent post-DUT egress).

The device under test is a Northbound Networks Zodiac FX: SAM4E8E microcontroller (120 MHz), KSZ8795 port fabric, four 100BASE-TX ports, 128-rule table, OpenFlow 1.3, firmware 0.86. Port 1 faces an untrusted workload segment (`10.0.2.0/24`) through an aggregation switch, port 2 faces the uplink, port 3 is a mirror tap, and port 4 carries OpenFlow to a Jetson Orin Nano controller. Three capture points give ground truth: O1 mirrors the workload link before the device, O2 is the policy-derived copy on port 3 (a product of the rules under test, so not ground truth), and O3 mirrors the port 2 link and records what actually left. Traffic comes from Raspberry Pi hosts on the workload segment. Mirror destination ports on both aggregation switches were found to accept ingress and are isolated in their own VLANs (Section 6).

### 3.2 Policy and properties

The deployed policy has six rules plus a table-miss DROP: intra-segment IPv4 from port 1 to the uplink and tap; ARP from port 1 allowed only from each known workload host's own address; everything else from port 1 to the tap only; IPv4 from the uplink to the segment; and a tap return. Table 1 lists the properties the verifier checks.

**Table 1. Verifier properties (Track A). "Label" is the stated enforcement point.**

| Id | Property | Label |
| :--- | :--- | :--- |
| A1 | Isolation: nothing from the workload port reaches the uplink except explicitly allowed traffic | Enforced before install, when an intent is given |
| A2 | No hairpin: no rule outputs to its own ingress port | Enforced before install |
| A3 | Default drop: a lowest-priority table-miss DROP exists | Priority 0 reserved before install; presence checked at readback only, with a damped auto-repair |
| A4 | Quarantine precedence: every quarantine DROP outranks every forwarding rule that can match the same packet | Enforced before install |
| A5 | No shadowed rules | Enforced before install |
| A6 | No overlapping rules with conflicting actions at equal priority | Enforced before install (firmware tie-breaking unmeasured) |
| A7 | Rule budget within 128 entries, with headroom for quarantines | Enforced before install |
| A8 | Capacity: modeled packet rate at the rule count and layout meets a declared target | Enforced only when a target is declared; a measurement over a stated domain |
| A9 | Forwarding-first layout for cost | Decided not needed (A4 wins) |
| A10 | ARP confinement across the workload and uplink ports | Enforced through the deployed policy and the intent checks |
| A11 | Intent compliance: exact packet-class evaluation shows zero leaks and zero missing deliveries | Enforced before install, when an intent is given |

We label each property by where it is enforced rather than claiming all eleven are "enforced." Three cannot hold literally: A3 cannot be proven at the moment of a packet, only at the last readback; A9 was resolved by a decision; and A8 and A10 describe one policy on one firmware. Each refusal returns the violated property and the offending rules, and a test checks this over every mutant of the reference policies. The verifier's intent checker enumerates packet classes over the modeled match fields (ports, EtherType, MACs, IPv4 and ARP addresses), so it is exact over those fields and silent about any other.

The tension between A4 and A9 deserves a note. Installing forwarding rules ahead of quarantine rules cuts per-rule cost from 4.24 to 1.3 µs but lets a quarantined source that matches a forwarding rule through. We decided that containment wins, measured the consequence (Section 4), and keep quarantine DROPs above every forwarding rule.

### 3.3 Measured cost as a verifier input

The verifier takes the number of rules and layout and computes modeled capacity from the fitted cost function (Section 4). A target is declared by the operator (6,000 packets per second at 572 bytes on the live bridge). The check refuses an install when the target is not met, and reports `unverifiable`, never a pass, for any table shape or payload the model does not cover. This is conservative: with a target declared, every allow-rule table outside the measured shapes is refused. The 6,000 pps figure is a declared ceiling derived from the model and the session-loss margin (74% of capacity at the quarantine envelope's full depth), not a measured workload requirement.

### 3.4 Approval, quarantine and the envelope

A person approves each agent-proposed install by hash of the exact rule bundle. Detector-driven quarantine is different: a person approving each event would take minutes against a detector's milliseconds. A quarantine may therefore proceed without a person only inside an envelope a person approved in advance: a single in-segment source address, never an address on a protected list, at most eight active at once, and a time limit (default 300 s) after which a bridge sweep lifts the rule, backed by a switch-side hard timeout. Every action is audited and releasable by hand. The envelope limits the damage of a wrong or steered decision, since source addresses are forgeable on the untrusted segment. It does not make the detection correct, and we have not measured the detectors' precision or recall.

## 4. Hardware Characterization

All measurements are from one Zodiac FX, firmware 0.86. A rate ladder holds a fixed offered packet rate for 45 s per step, then raises it; below capacity the switch forwards what it is offered, and above it the forwarded rate flattens.

**Per-packet cost.** For a UDP payload of `B` bytes and `N` quarantine rules in the base layout (quarantine rules first, priority 65535), per-packet time is `38.5 µs + 34.8 ns × (B − 64) + 4.24 µs × N`. The equation was fitted on the 64-byte and 572-byte ladders only and predicts the independent 1470-byte ladder at 16, 32 and 64 rules within −0.8%, −0.9% and −1.1%. At 600 bytes the capacity falls from about 17,800 pps with an empty table to 8,055 with 16 rules and 1,711 with 126 (Table 2). Forwarding rules installed first at the highest priority cost 1.3 µs per rule and raise capacity by 1.6× to 2.6×; changing priority alone or install order alone does not help. The limit is the microcontroller, not the 100 Mbit/s ports: port speed binds only for large packets with almost no rules.

**Table 2. Capacity at 600-byte packets (pps).**

| Quarantine rules | Base layout | Forwarding first |
| ---: | ---: | ---: |
| 0 | ~17,800 (modeled) | ~17,200 (modeled) |
| 16 | 8,055 | 12,693 |
| 32 | 5,272 | 10,000 |
| 64 | 3,091 | 7,078 |
| 126 | 1,711 | 4,497 |

```text
  Forwarded Rate (pps at 600 B)
  20,000 ┼
         │   [17,800]*   [17,200]*
  17,500 ┼   ████        ▒▒▒▒
         │   ████        ▒▒▒▒
  15,000 ┼   ████        ▒▒▒▒
         │   ████        ▒▒▒▒
  12,500 ┼   ████        ▒▒▒▒             [12,693] (+58%)
         │   ████        ▒▒▒▒             ▒▒▒▒
  10,000 ┼   ████        ▒▒▒▒             ▒▒▒▒           [10,000] (+90%)
         │   ████        ▒▒▒▒  [8,055]    ▒▒▒▒           ▒▒▒▒
   7,500 ┼   ████        ▒▒▒▒  ████       ▒▒▒▒           ▒▒▒▒            [7,078] (+129%)
         │   ████        ▒▒▒▒  ████       ▒▒▒▒  [5,272]  ▒▒▒▒            ▒▒▒▒
   5,000 ┼   ████        ▒▒▒▒  ████       ▒▒▒▒  ████     ▒▒▒▒            ▒▒▒▒            [4,497] (+163%)
         │   ████        ▒▒▒▒  ████       ▒▒▒▒  ████     ▒▒▒▒   [3,091]  ▒▒▒▒            ▒▒▒▒
   2,500 ┼   ████        ▒▒▒▒  ████       ▒▒▒▒  ████     ▒▒▒▒   ████     ▒▒▒▒   [1,711]  ▒▒▒▒
         │   ████        ▒▒▒▒  ████       ▒▒▒▒  ████     ▒▒▒▒   ████     ▒▒▒▒   ████     ▒▒▒▒
       0 ┴───┴───────────┴─────┴──────────┴─────┴────────┴──────┴────────┴──────┴────────┴────────►
             Empty Table (N=0)    N = 16 rules   N = 32 rules    N = 64 rules    N = 126 rules

  Legend:  ██ Base Layout (quarantines first, 4.24 µs/rule)    ▒▒ Forwarding-First (1.30 µs/rule)
           * = Modeled intercept (empty-table baseline); all N>=16 points measured on hardware.
```

**Figure 2. 600-Byte UDP Capacity vs. Rule Depth (Base vs. Forwarding-First Layout).** Reordering rules to evaluate forwarding matches before quarantine DROPs reduces traversal time from 4.24 µs to 1.30 µs per rule, raising capacity by 1.6× to 2.6×.

**A pre-registered prediction that failed.** The cost model was fitted on a two-rule forwarding shape plus `/32` DROPs, not on the deployed six-rule policy. Before measuring the deployed policy we registered a prediction of 4.24 µs per quarantine, accepted within 3.4 to 5.1 µs. The measurement, with `k` quarantines installed above the deployed policy (two rounds per `k`, offered load never above 1.2× the capacity found), gave `80.0 µs + 5.42 µs × k`, 28% above the prediction. Capacity was 12.5 to 12.7 kpps at `k = 0` and 8.1 kpps at `k = 8`, reproducible between rounds to within 0.5% to 1.6%. One round was excluded as a transient stall under a classification rule written after seeing it, which we state; the slope does not depend on it. The decision to let quarantine win was not contradicted, but its cost was understated: eight quarantines leave about 36% less capacity than none (the decision record had estimated 24% below the forwarding-first layout from the fitted model; the two baselines differ, so the figures are not a like-for-like correction).

```text
  Capacity (pps at 572 B UDP)
  14,000 ┼
         │  ● 12,563 pps (k=0)
  12,000 ┼───\
         │    \
  10,000 ┼     \───● 10,951 pps (k=2)
         │          \
   8,000 ┼───────────\───● 9,837 pps (k=4)
         │                \═════════════════════════════════  Allow-Rule Floor >= 7,765 pps
         │                 \───● 8,115 pps (k=8)              (1..8 allow rules @ k=8)
   6,000 ┼───────────────────────┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈  A8 Live Target Ceiling = 6,000 pps
         │                                                    (74% of k=8 capacity)
   4,000 ┼
         │   ▲ Overload / Session-Loss Zone: 1.3x to 2.3x capacity (e.g. 25,000 pps)
   2,000 ┼   drops OpenFlow TCP session and wipes hardware flow table (NET-002 fail closed)
         │
       0 ┴───┬───────────────────┬───────────────────┬───────────────────┬───────────────────►
            k=0                 k=2                 k=4                 k=8
            Active Priority-65535 Quarantine DROP Rules (k)

  Model Fit: t_packet = 80.0 µs + 5.42 µs × k   (Pre-registered 4.24 µs prediction failed by +28%)
```

**Figure 3. Deployed 6-Rule Policy Capacity Curve & A8 Admission Boundary.** The measured slope (5.42 µs/quarantine) exceeds the pre-registered prediction (4.24 µs) by 28%. The operating envelope bounds active quarantines to `k <= 8` (8,115 pps capacity) and allow rules to `1..8` (floor ≥7,765 pps), maintaining a safe margin above the live A8 target ceiling of 6,000 pps.

**Control-plane fragility.** At 1.3 to 2.3 times capacity the switch drops its OpenFlow session and its whole flow table in every base-layout ladder. Recovery takes about 2 to 3 s when the table can be re-sent, and under sustained overload it could not be restored. Over three one-hour working-window runs, the switch was unavailable 0.05% to 0.17% of the time. Eight session losses occurred spontaneously across those hours, all below modeled capacity, and their cause is unexplained.

**Loss of the controller.** When the bridge is stopped, the switch clears its entire flow table: a read-only probe found 0 entries when a controller reconnected, down from 7, and 0 of 48,000 and 0 of 24,000 workload frames were delivered during outages. Only the bridge's re-send at session start restores forwarding. A bridge outage is therefore a blackout that also erases the configuration.

**Table-miss behavior.** An injected fault (bounded, acknowledged, always ended by one DROP) put the table-miss into a forwarding, an absent and four unrecognised states. In every state tried, no unmatched frame reached the workload side, across eight frame classes and up to 8,000 pps of unmatched frames for the normal DROP. A table-miss built to forward reached only the tap, and only 9 to 22 frames per 10 s under load. A damped auto-repair that re-sends only the approved default DROP after three bad readings repaired each state, and stopped after its per-hour budget against a repair that did not take.

## 5. Evaluation

### 5.1 Research questions and protocol

We pre-registered the protocol before any result [evaluation-plan]. **RQ1** asks what fraction of model-proposed rule sets the verifier accepts. **RQ2** asks which property categories account for the failures. **RQ3** asks how verifier feedback compares with zero-shot generation and a deterministic mutation baseline. **RQ4** asks whether accepted rule sets behave as modeled on the switch. Protocol A is zero-shot (N = 50 per intent, temperature 0.2, top-p 0.95, seeds 1 to 50). Protocol B returns the verifier's structured diagnostics to the model for up to five turns (N = 20 per intent). A trial is counted *admissible* only if the verifier accepts the rule set for the stated intent. Transport failures count as failures and are not retried. The four original intents are port isolation, DNS confinement, quarantine precedence, and tap-return isolation; four harder intents (quarantine set, DNS plus quarantine, uplink ARP confinement, per-host allowlist) were added later, chosen by structure before any model saw them.

**Mutation baseline.** Single-point mutations (drop a rule, widen a prefix, remove a match field, add or remove an output, raise priority) of the hand-written reference policies calibrate the verifier. For port isolation, 29 of 40 mutants are rejected; the 11 accepted look permitted by the intent on a by-hand reading (a lost tap copy the intent does not require, or a priority raise that shadows nothing), so the number is a lower bound on what the checks catch and says the intent, not the checker, is permissive there.

### 5.2 Model-proposed policy against the verifier (RQ1 to RQ3)

Arms: a local 26B model (`gemma4:26b`) and a local 27B model (`qwen3.8:27b`), both at Q4_K_M with reasoning on; a hosted model (`claude-haiku-5-5`, lowest effort); and the 27B model with a 15-step and an 80/90-step LoRA adapter trained on verifier-generated data. Settings differ across arms (Section 8).

**Table 3. Zero-shot admissibility (Protocol A), abstract evaluation, one run per cell.**

| Setting | Arm | Intents | Admissible |
| :--- | :--- | :--- | ---: |
| Prompt v1, pre-A10 intent text | gemma4:26b | 1–4 | 70/200 |
| Prompt v1, pre-A10 intent text | qwen3.8:27b | 1–4 | 113/200 |
| Prompt v2, A10 intent text | qwen3.8:27b | 1–4 | 86/200 |
| Prompt v2, A10 intent text | Claude Haiku 5.5 | 1–4 | 161/200 |
| Prompt v3 | qwen3.8:27b library base (B3) | 1–4 | 174/200 |
| Prompt v3 | pipeline control, no adapter (C3) | 1–4 | 174/200 |
| Prompt v3 | 15-step adapter (L3) | 1–4 | 176/200 |
| Prompt v3 | Claude Haiku 5.5 (H3) | 5–8 | 196/200 |
| Prompt v3 | B3 / C3 / L3 | 5–8 | 165 / 174 / 141 of 200 |
| Prompt v3 | C3 / L4 (80 SFT, 90 DPO steps) | 1,3,5–8 | 248 / 145 of 300 |

Rows with different prompt versions or intent texts are not comparable. The pre-A10 intent text predates the policy change that confined ARP, so prompt v1 and v2 rows describe different tasks for three of the four intents.

**Verifier feedback closes what zero-shot leaves open.** Under feedback (Protocol B), the larger arms reached the ceiling: 79/80 for the local 27B model under prompt v2 (the missing trial was a transport failure), 80/80 for Haiku, and 80/80 for both the control and the 15-step adapter within two turns under prompt v3, and 40/40 on the two harder intents where the control was not saturated. The local 26B model reached 75/80, and small 3B models (tried on the Jetson and later dropped) produced no admissible set even with feedback, mostly from format errors. At the ceiling, Protocol B does not discriminate between the larger arms. It does show the verifier's diagnostics suffice for these models to repair their own proposals in a turn or two, including the failures that matter most (intent leaks).

**Failure categories.** Zero-shot failures are mostly semantic. Under prompt v3 the base and control arms fail mostly with `ERR_INTENT_MISSING` (an omitted rule), while the 15-step adapter fails almost only with `ERR_INTENT_LEAK` (23 of 24), the direction that would matter without a verifier. Hairpins and missing EtherType prerequisites dominate earlier runs. Haiku's non-admissible trials were all leaks or missing deliveries and never syntax errors.

**Adapters did not replace verification.** The 15-step adapter helped the intents whose structure matched its training families (`INTENT-3`, 40/50 against 27/50; `INTENT-7`, 49/50 against 32/50) and regressed on multi-host composition (`INTENT-5`, 18/50 against 43/50; `INTENT-6`, 24/50 against 49/50). The longer-trained adapter scored 145/300 against 248/300 for the control, and 119 of its failures were `ERR_SYNTAX`, mostly output that stops mid-list or repeats a few rule ids. We observe that the training set has 32 distinct scenarios and each was seen about 20 times, and that training targets had no reasoning block while evaluation used reasoning, but no run varied data, learning rate, reasoning setting or prompt, so we establish no cause. We treat adapter training as a negative result.

**Noise.** Seeded outputs do not reproduce across runs. For seeds 1 to 20, a Protocol B first-turn output was identical to the Protocol A output of the same seed in 0 or 1 of 20 trials in seven of eight cells. On the same intent the control passed 9 of 20 in Protocol A and 12 of 20 on the first turn of Protocol B with the same seeds. Run-to-run variation is therefore a few trials per cell at N = 20, and differences of that size should not be read as effects. Larger differences (the adapter's 17 to 25-trial swings) are well outside it.

**Prompt drift.** Prompt v3 was written after the v2 failures on these same intents were read, and the platform changed between v2 and v3 (a laptop with one stream against a rented GPU with several). The rise from 86/200 (v2) to 174/200 (v3) for the same base model is therefore confounded and is not evidence for a prompt effect.

**Cost.** Hosted Haiku cost about 0.0008 USD per admissible set and about 35 minutes of wall time for the valid v2 runs, against about 13 hours for the local 27B model on a laptop. Local arms cost hours of laptop time and no API fee. These are descriptive; hardware, serving stack and concurrency differ.

### 5.3 Accepted policy on the wire (RQ4)

A bundle of 132 rule sets over the eight intents was fixed before any wire data by seed and the SHA-256 of its index: per intent, the reference, the surviving mutants that a chosen flow can tell from the reference, up to eight model-proposed sets drawn round-robin over the models, and four equivalence controls. 128 ran (one intent had no separating flows). Each set went through a guarded experiment endpoint, with the isolation policy restored and read back after each, and a runner that stops on any unverified restore. The owner approved the bundle by hash and the sessions ran unattended under written permission.

Two measures were scored per flow. M1 asks whether the ports where a frame was observed equal the ports the verifier's own match function predicts. M2 asks whether the observation satisfies the intent's own clause for that packet. Frames entering port 1 were raw frames with the flow's exact header fields from a workload NIC. Frames entering port 2 were raw frames from a node whose second NIC the owner moved to an isolated uplink segment for the run (restored afterwards). Frames into port 3 were not sent.

**Result.** 611 of 611 flow checks agreed with the model (95% Wilson interval 99.4% to 100.0%), and 611 of 611 met the intent, across 143 set-runs (eight references ran in three sessions). Twenty separable sets repeated in three sessions were observed identically on every flow. One finding concerned the switch path: IPv4 frames whose source and destination addresses are identical are not forwarded, although the model predicts forwarding (finding F1). The direction is the safe one, since the hardware forwards less than the model says. It resembles land-attack protection, but where the frame is dropped (the sender's NIC, the aggregation switch, or the Zodiac) is not established. The verifier over-predicts for these frames and they are excluded from the candidate flows.

```text
========================================================================================================================
PART A: 128-RULE-SET WIRE CONFORMANCE EXECUTION MATRIX & FLOW CHECK ACCURACY (RQ4)
========================================================================================================================

  Bundle: 132 sets (seed 20261031) │ 128 Distinct Sets Run │ 143 Set-Runs │ 611 Flow Checks │ 611/611 (100.0%) M1 & M2

  Rule-Set Category            Sets   Set-Runs  Flows Sent   M1 Model Match (95% Wilson)     M2 Intent Met
  ──────────────────────────   ────   ────────  ──────────   ───────────────────────────     ─────────────
  Model-Admissible (5 arms)     56       56        224       224 / 224  (98.3% – 100.0%)     224 / 224 (100%)
  Surviving-Mutant              36       36        149       149 / 149  (97.5% – 100.0%)     149 / 149 (100%)
  Reference Baselines            8       23        126       126 / 126  (97.0% – 100.0%)     126 / 126 (100%)
  Equivalence-Control (Model)   14       14         56        56 /  56  (93.6% – 100.0%)      56 /  56 (100%)
  Equivalence-Control (Mutant)  14       14         56        56 /  56  (93.6% – 100.0%)      56 /  56 (100%)
  ──────────────────────────   ────   ────────  ──────────   ───────────────────────────     ─────────────
  TOTAL CAMPAIGN               128      143        611       611 / 611  (99.4% – 100.0%)     611 / 611 (100%)

  Repeats: 20 of 20 separable sets repeated in 3 separate sessions -> 20/20 (100.0%) observed identically.

========================================================================================================================
PART B: SESSION-BY-SESSION FLOW VOLUME ACROSS THE EIGHT INTENTS
========================================================================================================================

  Session Name                     Sets  Flows  Flow Distribution (each █ = 4 flows)                  Agreement
  ───────────────────────────────  ────  ─────  ───────────────────────────────────────────────────   ─────────
  coverage-references                 8     70  ██████████████████ (70)                                70 / 70
  smoke-references                    8     28  ███████ (28)                                          28 / 28
  intent-dns-confinement_v1          17     51  █████████████ (51)                                    51 / 51
  intent-dns-quarantine_v1           18     54  ██████████████ (54)                                   54 / 54
  intent-per-host-allowlist_v1       20    120  ██████████████████████████████ (120)                 120 / 120
  intent-port1-isolation_v1          18     72  ██████████████████ (72)                                72 / 72
  intent-quarantine-precedence_v1    18     72  ██████████████████ (72)                                72 / 72
  intent-quarantine-set_v1           18     72  ██████████████████ (72)                                72 / 72
  intent-uplink-arp-confinement_v1   18     72  ██████████████████ (72)                                72 / 72

========================================================================================================================
PART C: PRE-CAMPAIGN SMOKE GATE VALIDATION FUNNEL & FINDING F1
========================================================================================================================

  [1. first-smoke (28 flows)] ──────► 11 / 28 M1 Disagreements
                                      │
                                      ├─► Root Cause 1: `tcpdump -p` on Jetson O2 tap NIC disabled
                                      │   promiscuous mode, dropping all unicast mirror frames.
                                      │   Fix: removed `-p`, verified promiscuous capture.
                                      ▼   [-7 disagreements resolved]
  [2. smoke-fixed-capture (28 fl)] ─► 4 / 28 M1 Disagreements
                                      │
                                      ├─► Root Cause 2: All 4 remaining disagreements were one flow:
                                      │   IPv4 frame with src === dst (self-addressed packet).
                                      ▼
  [3. diagnostic-self-addressed] ───► Diagnostic run on port1-isolation:
                                      • 3 self-addressed frames: dropped by switch path (safe)
                                      • 2 normal different-host frames: forwarded as predicted
                                      Finding F1: self-addressed frames dropped before O2/O3;
                                      excluded from candidate test suite as degenerate flows.
                                      ▼   [-4 degenerate flows excluded]
  [4. smoke-final (28 flows)] ──────► 0 / 28 Disagreements (Gate Passed) ──► Unlocks 143-run Campaign (611/611)
```

**Figure 4. On-Wire Conformance Run Breakdown (RQ4) & Smoke Gate Validation Funnel.** Part A summarizes flow check results across 128 distinct rule sets and 5 categories. Part B shows flow check distribution across the 9 wire sessions. Part C details the smoke gate validation funnel that caught the `-p` non-promiscuous capture bug and discovered Finding F1 (switch-path drop of self-addressed IPv4 frames).

**What this shows and does not.** Agreement on a finite flow set is evidence against a disagreement on those flows, not a proof for the rule set. The flows were chosen, not all traffic. The uplink side was exercised only for the references with forged frames from an isolated segment, and frames from the tap not at all. The equivalence controls (four per intent) are by construction indistinguishable from the reference by the chosen flows, so agreement there tests only the model's equivalence claim. Earlier, a first conformance run (58 rule sets, 290 flow checks, five flows) was also all-agreeing, but 29 of 38 surviving mutants were indistinguishable from their reference by those flows, and we regard its agreement as weak.

### 5.4 A live adversary (Track C)

Scenarios ran from an untrusted workload node bound to its workload interface by a preflight that refuses to send if another interface could reach the lab network, since a bypass path would defeat the experiment.

**Table 4. Adversarial results.**

| Scenario | Result |
| :--- | :--- |
| 1. ARP spoofing across ports 1 and 2 | The first run defeated the policy: 3 of 3 spoofed frames crossed to the uplink. This became property A10. After deploying exact-address ARP rules, 0 of 7 crossed. |
| 3. Fast and low-rate port scan | A fast scan (0.8 s) was detected by the GPU sentinel at 0.85 s on run 1, missed on one re-test try, and detected on the next. A rate rule missed both scans. For the low-rate scan the live process reported no hits while an offline replay of the same documented math flagged 37 of 141 windows; unresolved. |
| 4. Flood to session loss | At 25,000 pps (2× deployed capacity, 572 B, 10 s) 2 of 5 valid trials dropped the OpenFlow session; both recovered unaided within the polling resolution (at most 4 s and 6 s). 0 leaks in any of 13 valid trials. The fallback restart path never fired on hardware. |
| 5. Evasion and tag handling | 18 workload-side frame classes (non-IPv4, IPv6, fragments, options, runts, near-MTU) produced 0 breaches. The switch matches IPv4 allow rules through an 802.1Q tag, which the model does not track. A quarantine DROP also matches single-tagged frames: 0 of 40 left port 2 (VID 100 and 200). |
| 6. Uplink-side address aliasing | The 2026-10-09 observation did not reproduce. A host-level ARP misconfiguration on a workload node (see Section 6) had been intercepting the traffic before the switch. The switch's own rule was never exercised. |
| 7. Mirror-port injection | A frame sent from the capture NIC reached the traffic side on both aggregation switches. Mitigated by VLAN isolation and re-tested for untagged, single-tagged and double-tagged frames; kept as a regression test. |

Scenario 2 (spoofing inside the workload segment) was reclassified out of scope because that traffic stays on the aggregation switch and never reaches the device.

## 6. Where the Model, the Host and the Environment Disagreed With the Wire

We consider these the most transferable results.

**A check that proved nothing.** A first table-miss experiment reported zero frames at the workload observer. The observing node had no `tcpdump`, so its capture never ran and its zeros were evidence of nothing. Observers must now prove they ran. The same class of error returned in Scenario 4: a capture helper read at most 2 MB of text, silently truncating a 250,000-frame capture; the validity check caught the mismatch and failed the run closed.

**A harness defect that looked like a switch bug.** The first wire run of the conformance harness disagreed with the model on 11 flows. Capturing with `tcpdump -p` left the capture NIC out of promiscuous mode, so it dropped every unicast frame not addressed to it. Removing the flag cut the disagreements to 4, and excluding self-addressed frames (finding F1) cut them to 0, so the smoke gate passed.

**A confound bigger than the policy.** While debugging a spurious Scenario 1 hit, we found that a convenience change to the uplink aggregation switch's VLANs had given both workload nodes a second, switch-bypassing path onto the segment under test. A harness bug (matching the adversary's MAC anywhere in the capture line) had also produced a false positive. Both were fixed before the result that we report.

**A host-level leak masking a result.** Re-running Scenario 6, a ping from a lab-LAN host to a workload node failed 100% and looked like containment. Tracing ARP showed that a workload node's lab-facing NIC answered for the address of its workload NIC (`arp_filter=0`, Linux's weak host model), so traffic never reached the switch. A switch-side VLAN table could not detect this, because the host answered correctly from the switch's point of view. After setting `arp_filter=1` and bringing the Wi-Fi interface down on both nodes, the address no longer resolves at all, and the switch rule remains unexercised. A noisy table-miss counter had briefly appeared to confirm the original reading; we retract that inference in the write-up.

**A containment path blocked by configuration drift.** In Scenario 3 the sentinel attributed 939 anomalies correctly to the scanning node, and every one of 1,543 quarantine requests was refused with 403 because that node was still on the protected-host list from an earlier role. The detector could not have quarantined the adversary however well it worked. After the list was fixed, an end-to-end proposal reached the bridge in propose mode.

**Model against switch.** The IPv4-through-802.1Q matching and the self-addressed-frame drop are the two cases where the wire disagreed with the verifier's model on the traffic classes we sent. Both are on the safe side for isolation in the cases tested, but the first shows the model's blind spot (VLAN) is real.

## 7. Discussion

**What the evidence supports.** On one cheap switch, measured hardware cost and exact verification over a small packet-class space are workable as a pre-install gate. Deterministic diagnostics let local and hosted models repair their own proposals within two turns on the intents we tried. The verifier's model matched the switch on every flow checked, with two disagreement classes found by looking.

**What it does not support.** Admissibility is not correctness: the verifier, the intents and the reference policies are the author's. We do not show that fine-tuning cannot help, only that our adapters did not. We do not show detector accuracy. Generalization beyond this device is not claimed: the 5.42 µs slope, the table-wipe on controller loss, the land-attack-like drop and the tag matching are properties of a firmware, and on a different device they may not exist.

**Why the cheap device is useful here.** Merchant silicon masks inefficiencies behind over-provisioning. On a 120 MHz microcontroller, 100 extra rules add about 424 µs of lookup latency, reordering changes capacity by up to 2.6×, and modest overload drops the controller session. An agent's mistake becomes visible quickly. The same property limits generality, because a policy admitted here would not be stress-tested on a device with ample headroom.

**Practical lesson.** A passing result that depends on an observer, a host configuration or a switch VLAN table must be checked at the observation, not only at the policy. Four of the findings in Section 6 would have passed unchallenged in a simulator.

## 8. Limitations and Threats to Validity

- **One switch, one firmware (0.86), one workload segment, four ports.** No replication on other units or firmware.
- **One run per cell** in the model evaluation, a few-trial run-to-run spread, and a measured same-seed non-reproducibility.
- **Authorship of the oracle.** The verifier, intents and reference policies share an author, who also reviewed them. No outside reviewer has examined the policy or the property list.
- **Prompt and intent drift.** Prompt v3 was written after the v2 failures were read, intent text changed with the ARP policy (A10), and some arms differ in platform, concurrency, quantization (Q4_K_M, not the planned 8-bit), reasoning mode and sampling (the hosted arm takes no seed). Cross-arm comparisons are approximate. Selection of the hosted model was not blind.
- **Abstract admissibility versus the wire.** The model evaluation measures acceptance by the verifier. Only 128 rule sets were checked on the wire, with chosen flows (not all traffic), uplink ingress only for the references, and tap ingress not at all.
- **Unmodeled fields.** VLAN tags, L4 ports (the DNS intent is host-level because the match model has no L4 fields), IPv6 and anything outside the packet-class fields. The wire result for 802.1Q shows the gap is real.
- **Declared, not derived, capacity target.** The 6,000 pps target is a ceiling guard, not a workload requirement.
- **Unexplained and unverified items:** spontaneous session losses; the cause of the self-addressed-frame drop; the live-versus-replay discrepancy in the low-rate scan; the fallback restart path on real hardware; direct observation of the switch CPU; drop-path capacity.
- **Detectors are out of scope:** their precision and recall are unmeasured, and the quarantine envelope depends on detection.
- **Supervised experiments** were run by the owner or under written permission, and each is a single supervised run.

## 9. Conclusion

We built a verifier whose inputs include a measured hardware cost model, evaluated model-proposed policy against it, checked accepted policy on a real switch against independent captures, and attacked it live. The results are measurements on one switch. What generalizes, we argue, is the method: put the policy loop on hardware, pre-register the claims, and treat disagreements between model, host and wire as findings. The failed cost prediction, the masked scenario, the vacuous observer and the blocked containment path are the kind of result a simulator cannot produce.

## Artifact availability

All claims trace to files in the repository `gravity-tpu/agentic-era-networking`:

- Pre-registered protocol and amendments: `docs/research/evaluation-plan.md`; related work: `docs/research/prior-art.md`; models, cost and limits: `docs/research/models.md`.
- Property labels and tests: `docs/research/track-a-ci-matrix.md`; owner review record: `docs/research/owner-review-packet.md`; roadmap and exit criteria: `docs/ROADMAP.md`.
- Hardware characterization: `docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md` and `docs/benchmarks/results/layout-capacity/README.md`.
- Evaluation: `docs/benchmarks/results/agent-evaluation/README.md` and its per-campaign reports; baselines in `docs/benchmarks/results/agent-evaluation/baselines/README.md`.
- Wire conformance: `docs/benchmarks/results/conformance/wire-run-2026-10-31/README.md` and `docs/benchmarks/results/conformance/validation-2026-10-31/README.md`.
- Adversarial runs: `docs/benchmarks/results/track-c-scenario1-arp-spoof/`, `track-c-scenario3-portscan/`, `scenario4-session-loss/`, `scenario5-workload-frames/`, `scenario5-tag-quarantine/` and `scenario6-address-aliasing/` under `docs/benchmarks/results/`.

## References

Citations below are taken from `docs/research/prior-art.md` and have not been re-checked against the originals. Keys are placeholders for a BibTeX file.

- [HSA] P. Kazemian, G. Varghese, N. McKeown. Header Space Analysis: Static Checking for Networks. USENIX NSDI 2012.
- [VeriFlow] A. Khurshid, X. Zou, W. Zhou, M. Caesar, P. B. Godfrey. VeriFlow: Verifying Network-Wide Invariants in Real Time. USENIX NSDI 2013.
- [NetPlumber] P. Kazemian, M. Chang, H. Zeng, G. Varghese, N. McKeown, S. Whyte. Real Time Network Policy Checking using Header Space Analysis. USENIX NSDI 2013.
- [Anteater] H. Mai, A. Khurshid, R. Agarwal, M. Caesar, P. B. Godfrey, S. T. King. Debugging the Data Plane with Anteater. ACM SIGCOMM 2011.
- [Batfish] A. Fogel, S. Fung, L. Pedrosa, M. Walraed-Sullivan, R. Govindan, R. Mahajan, T. Millstein. A General Approach to Network Configuration Analysis. USENIX NSDI 2015.
- [Mondal23] R. Mondal, A. Tang, R. Beckett, T. Millstein, G. Varghese. What do LLMs need to Synthesize Correct Router Configurations? ACM HotNets 2023.
- [NetConfEval] C. Wang, M. Scazzariello, A. Farshin, S. Ferlin, D. Kostić, M. Chiesa. NetConfEval: Can LLMs Generate Network Configurations? ACM CoNEXT 2024.
- [Mani23] S. K. Mani, Y. Zhou, K. Hsieh, S. Segarra, et al. Enhancing Network Management Using Code Generated by Large Language Models. ACM HotNets 2023.
- [OFLOPS] C. Rotsos, N. Sarrar, S. Uhlig, R. Sherwood, A. W. Moore. OFLOPS: An Open Framework for OpenFlow Switch Evaluation. PAM 2012.
- [Kuzniar15] M. Kuźniar, P. Perešíni, D. Kostić. What You Need to Know About SDN Flow Tables. PAM 2015.
- [Tango] A. Lazaris, D. Tahara, X. Huang, et al. Tango: Simplifying SDN Control with Automatic Switch Property Inference, Abstraction, and Optimization. ACM CoNEXT 2014.
- [Monocle] P. Perešíni, M. Kuźniar, D. Kostić. Monocle: Dynamic, Fine-Grained Data Plane Monitoring. ACM CoNEXT 2015.
- [ATPG] H. Zeng, P. Kazemian, G. Varghese, N. McKeown. Automatic Test Packet Generation. ACM CoNEXT 2012.
- [SOFT] M. Kuźniar, P. Perešíni, M. Canini, D. Venzano, D. Kostić. A SOFT Way for OpenFlow Switch Interoperability Testing. ACM CoNEXT 2012.
- [evaluation-plan] This repository, `docs/research/evaluation-plan.md`.

---

## Author notes (not part of the manuscript)

These are open items in the draft, not text for submission.

1. **Venue and form.** The draft is written as a workshop or short-paper length study with a testbed-and-measurement framing. Pick a venue and trim or expand accordingly. The core diagrams—Figure 1 (Architecture and testbed wiring), Figure 2 (Base vs. forwarding-first capacity curves), Figure 3 (Deployed policy capacity and A8 boundary), and Figure 4 (RQ4 on-wire conformance run breakdown and smoke gate validation funnel)—are now integrated directly into Sections 3, 4, and 5.
2. **Numbers to re-verify against source before submission.** The draft was assembled from result READMEs and not regenerated. In particular: the claim "43% to 98%" in the abstract (it spans the v2 local arm to the harder-intent hosted arm, which differ in prompt and intent set; consider a tighter statement); the mutation counts (the baselines README predates the A10 intent change, and the rejection-detail test pins 196 mutants over four references, which differs from the 178 in the baselines tables); and the 2,303 of 2,400 hosted-arm figure in `models.md`, which is omitted here because its prompt version is not stated there.
3. **Claims the data does not support, left out on purpose:** that LoRA fine-tuning cannot help; that prompt v3 improved the model; any detector precision or recall; any generalization to other firmware.
4. **Missing outside review.** The strongest single change would be one network engineer reading the policy, the property list and the intents, and a second author who did not write them.
5. **Optional experiment named in the re-scope.** Repeating the local Qwen arms to put a spread on the headline zero-shot rates (about 5 USD per pod run, owner decision needed). The draft states one run per cell throughout.
6. **Whitepaper PDF.** `docs/design/zodiac-whitepaper.pdf` predates most of these results and should be regenerated or retired.
7. **Citations.** Check each reference against the original; the list is taken from `prior-art.md`, which cites by author and venue without DOIs. Verify, for example, the NetConfEval and NetPlumber titles before the references go into a bibliography.
