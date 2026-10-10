# Zodiac

> **A real-hardware testbed and verifier for agent-proposed SDN policy.**
> Measure what a cheap OpenFlow switch can actually do, prove proposed rules are safe against that model, and test them against a live adversary.

Software-driven networking, approached as a software engineering problem: network policy is code, so it should be typed, tested, verified before it ships, and measured against real hardware instead of assumed.

Hosted at: [github.com/gravity-tpu/agentic-era-networking](https://github.com/gravity-tpu/agentic-era-networking)

---

## 1. Why this exists

Agents can now generate network policy (flow rules, ACLs, DNS filters) faster than anyone can review it. Generation is cheap; **verification is the scarce part**. Most work in this area is validated in simulation. This repository has a physical OpenFlow switch, a mirror tap, an instrumented controller and a hostile workload node, so claims can be checked against silicon.

The question the project answers: **can an agent safely propose network policy, and what does "safely" have to mean on hardware this constrained?**

## 2. Approach

```text
  Proposer            Verifier                 Actuator            Conformance
  (human or LLM)      (static, deterministic)  (OpenFlow 1.3)      (hardware truth)

  rule set  ───────►  property checks     ───►  human approval ──►  install on     ──►  read table back,
                      + hardware cost model     (explicit gate)     Zodiac FX           compare to intent
                      reject on any violation                                             │
                                                                                          ▼
                                                                    probe on the wire via mirror tap:
                                                                    does the switch behave as the model says?
                                                                                          │
                                                                                          ▼
                                                                    adversarial run from the Pi 5:
                                                                    spoof, scan, flood, evade → measure
```

Three ideas carry the design:

1. **Verify properties of the rule set, not routes.** A static L2/L3 flow table has no routing loops to find. The useful checks are isolation, shadowed rules, hairpins, default-drop, quarantine precedence and rule/capacity budget.
2. **Verify against a measured hardware model.** The switch's CPU, not its ports, is the bottleneck, and rule layout changes capacity by up to 2.6x. A policy that is logically correct can still take the switch down, so capacity is a checked property.
3. **Close the loop on the wire.** Reading the table back proves intent was installed; only traffic through the tap proves behavior. Model-versus-hardware disagreement is a finding, not noise.

Agents are in the loop as *proposers*. A human approves, and deterministic code decides admissibility. The project does not claim autonomous operation.

## 3. Status

| Capability | State | Evidence |
| :--- | :--- | :--- |
| Port-1 isolation policy builder and static verifier | Implemented, unit-tested | `src/sdn/port1-isolation.ts`, `test/invariants/port1-isolation.test.ts` |
| Switch readback verification (match fields) | Implemented | `verifyIsolationReadback`; output actions are not yet parsed |
| Hardware cost model and data-plane benchmark harness | Measured, documented | [Whitepaper](docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md), `scripts/zodiac-dataplane-bench.ts` |
| Telemetry with provenance (no simulated data shown as live) | Implemented | `scripts/check-provenance.ts`, `test/invariants/goodharts-law-provenance.test.ts` |
| Anomaly detector and quarantine path (Coral TPU, Jetson GPU) | Present; precision and recall **not measured** | `scripts/gpu-sdn-anomaly-sentinel.py`, `src/sdn/zodiac-controller.ts` |
| Verifier consumes the cost model (capacity budget check) | Planned | [Roadmap](docs/ROADMAP.md), track A |
| Shadowed-rule and action-level analysis | Planned | Roadmap, track A |
| Model-versus-wire conformance probe | Planned | Roadmap, track B |
| Repeatable adversarial suite (ARP spoofing, scan, flood, evasion) | Planned | Roadmap, track C |
| Evaluation of LLM-proposed rule sets against the verifier | Planned | Roadmap, track A |

## 4. What has been measured

On a Zodiac FX (firmware 0.86), one switch, one workload node, one receiver path:

- Per-packet cost is `38.5 µs + 34.8 ns per payload byte above 64 + 4.24 µs per rule`. The limit is the switch microcontroller, not the 100 Mbit/s ports.
- A 600-byte stream capacity falls from about 17,800 pps with an empty table to 8,055 with 16 rules and 1,711 with 126.
- Installing forwarding rules first and at the highest priority cuts the per-rule cost to 1.3 µs (1.6x to 2.6x more capacity).
- Offered load of 1.3 to 2.3 times capacity makes the switch drop its OpenFlow session and flow table. This is the fragile part.

Full method, data and limitations: [benchmark whitepaper](docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md).

## 5. Known gaps

- **ARP crosses the P1 to P2 boundary.** The isolation policy forwards ARP between the workload and the lab LAN because firmware 0.86 `ARP_SPA`/`ARP_TPA` matching is unverified. This is documented in the code as address disclosure only; it is also a spoofing surface (a workload can send ARP claiming a LAN address). Testing this is the first item in track C.
- **The policy has had no independent network-engineer review.** The verifier encodes the author's reading of L2 and flow-table semantics.
- **Cost versus containment.** The cheapest measured layout (forwarding rules first) ranks forwarding above quarantine, so a quarantined source that also matches a forwarding rule would still be forwarded. Resolving this is the first verifier design question (roadmap A4 versus A9).
- **Removed on 2026-10-09:** `SymbolicRouteVerifier` (its call sites passed hop lists that could not fail), the unused `AdaptiveFlowController`, and the dashboard's "Live Invariant Verification Playground" (hardcoded numbers shown as live). The verifier is the set of property checks in `port1-isolation.ts` and `verifyPlanAdmissible`.
- **Single switch, single run set.** Many benchmark layouts are single rounds; see the whitepaper's limitations.
- **Confinement is address-based.** The isolation policy admits IPv4 whose source and destination are in `10.0.2.0/24`, and source addresses are forgeable. A host on the uplink side that takes a `10.0.2.x` address can reach the workload nodes; the Mac's benchmark alias does exactly this by design. Testing it is a track C scenario.
- **No claim of production readiness.** This is a lab system on a 100 Mbit/s MCU switch.

## 6. Hardware

| Role | Device |
| :--- | :--- |
| Device under test | Northbound Networks Zodiac FX: SAM4E8E MCU, KSZ8795 switch IC, 4 x 100BASE-TX, 128-rule table, OpenFlow 1.3 |
| Controller, benchmark host, detector | NVIDIA Jetson Orin Nano Super (Coral Edge TPU x2 for inference) |
| Hostile workload and traffic generator | Raspberry Pi 5 with Hailo-8 (`rpi-hailo`) |
| Untrusted client workloads | Two Raspberry Pi 3B+ (`agentic-node-01`, `agentic-node-02`) |
| Workload aggregation | NETGEAR GS105Ev2 (802.1Q, port mirror) |
| Operator and local model host | Apple Silicon workstation |

```text
   Lab LAN / Internet (ISP extender)
              │ P2 uplink
        ┌─────┴──────┐  P3 mirror tap ───────► Jetson (tap NIC → detector)
        │ Zodiac FX  │  P4 OpenFlow 1.3 ◄────► Jetson (controller :6633)
        └─────┬──────┘
              │ P1 workload (policy: isolate)
        ┌─────┴──────┐
        │ NETGEAR    │── rpi-hailo: Pi 5 + Hailo-8 (adversary)
        │ GS105Ev2   │── agentic-node-01, -02: Pi 3B+ (workload)
        └────────────┘
```

A reassessed target topology (independent uplink observer, Pi 5 as passive sensor, workload `wlan0` off during runs) is in the [roadmap](docs/ROADMAP.md#3-target-topology-and-hardware-roles); the diagram above is today's rack.

Addresses, VLAN matrix, port assignments and the NETGEAR management path are kept in [`.agents/network-context.md`](.agents/network-context.md). Wiring detail and the management-plane hierarchy are in [`docs/design/physical-sdn-edge-tpu.md`](docs/design/physical-sdn-edge-tpu.md).

## 7. Engineering invariants

These are enforced by tests, CI and the pre-push gate:

1. **No suppression of errors.** No `@ts-ignore`, no loose `any` casts, no empty `catch`. Errors are handled at the protocol and state boundary.
2. **Integer accounting.** Packet, byte, rate and SLA counters are 64-bit integers (`BigInt`); timestamps come from the monotonic clock (`process.hrtime.bigint()`).
3. **Fail closed.** Ambiguous or unrecognized packets, rules or tenant context are dropped or quarantined, never forwarded.
4. **Verify before actuating.** Nothing an agent proposes reaches the data plane without passing deterministic checks and a human gate. Checks must be able to fail, and must say what they do not prove.
5. **Configurable, bounded, damped limits.** No buried magic numbers; adaptive loops are damped and exercised on real traffic before they are called adaptive.
6. **Provenance.** Telemetry without physical or cryptographic provenance is not shown as live. Disconnected hardware reports zero rates, `null` thermals and an offline status. Synthetic data is allowed only in declared sandboxes (`source: 'cloud_snapshot'`) with a visible disclaimer.

The numbering matches [`AGENTS.md`](AGENTS.md), which code comments cite ("Invariant 3"). The long-form rulebooks and review checklists are in [`.agents/`](.agents/rules/determinism-and-alignment.md); they are review tooling, not system architecture.

## 8. Repository map

| Path | Contents |
| :--- | :--- |
| `src/sdn/` | OpenFlow server, flow table, isolation policy and verifier, serial client, benchmark logic |
| `src/core/` | Telemetry primitives and state machine |
| `src/dns/`, `src/db/`, `src/security/`, `src/telemetry/` | DNS wire handling, telemetry storage, request attestation and rate limiting, Prometheus export |
| `api/`, `public/` | Serverless read-only API and operator dashboard |
| `scripts/` | Benchmark harness, inference daemons, provenance check, review tooling |
| `deploy/` | systemd units and setup for Jetson, Pi 5 and macOS |
| `test/invariants/` | Invariant and behavior tests |
| `docs/design/` | Zodiac whitepaper (PDF), hardware blueprint, benchmark runbook, shared fonts |
| `docs/benchmarks/` | Benchmark whitepaper, analysis, and physical-run artifacts |
| `docs/archive/` | Superseded plans and the Sentinel design material (original roadmap, Sentinel design doc and PDF, GPU workload roadmap) |

Deferred tracks (not on the current roadmap): the Sentinel bot and crawler module ([`docs/SENTINEL-ROADMAP.md`](docs/SENTINEL-ROADMAP.md)), the DNS reverse proxy, multi-agent routing stability and the agent intent firewall.

## 9. Quick start

Prerequisites: Node.js 22 (see `.nvmrc`) and Git.

```bash
npm install
npm run setup-hooks     # git hooks: type check, invariant tests, determinism scan
npm run check-types     # zero-defect compile check
npm test                # invariant and behavior tests
cp .env.example .env.local
```

Hardware benchmarks (`npm run bench:dataplane`) require the physical bench. They wipe the flow table and saturate Port 2; see the [benchmark runbook](docs/design/zodiac-fx-dataplane-benchmark.md).

## 10. Operations

- **Telemetry history (Jetson).** The bridge server writes 30-day JSONL history to `/var/lib/zodiac/history/` (falling back to `~/zodiac-history` or `/tmp/zodiac-history`), at about 2 points per minute. Ranges such as `?range=6h` are served from local disk with no internet dependency. After a restart (`sudo systemctl restart zodiac-bridge`) history resumes accumulating.
- **Cloud relay (optional).** Provision a Neon project and set `DATABASE_URL` in `.env.local` and the GitHub repository secrets. Link the repository to a Vercel project and add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`; the CI deploy job skips itself until configured. The public layer is read-only: it has no path to mutate the switch.

## 11. Development tooling: AI code review

Pre-push and CI run a multi-model review (Gemini, then Claude, then OpenAI as fallbacks) with a rubric derived from the invariants above. It flags critical issues, warnings and suggestions, and blocks on `CHANGES REQUESTED`. It is a second reader, not a verifier: model output is not evidence of correctness.

```bash
npm run review          # staged changes
npm run review:last     # last commit
npm run review:head     # all working-tree changes
```

## 12. Documents

- [Roadmap](docs/ROADMAP.md): goals, tracks, exit criteria, what is deferred.
- [Zodiac whitepaper (PDF)](docs/design/zodiac-whitepaper.pdf): the testbed, measured hardware model, verifier design and evaluation plan. Rebuild with `python3 scripts/build-zodiac-whitepaper.py` (needs matplotlib and Chrome).
- [Benchmark whitepaper](docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md): packet-rate limits of an OpenFlow edge switch under rule-table load.
- [Benchmark archive](docs/benchmarks/README.md): runs, artifacts and analysis scripts.
- [Hardware blueprint](docs/design/physical-sdn-edge-tpu.md): wiring, interfaces, management plane, detector and verifier components.
