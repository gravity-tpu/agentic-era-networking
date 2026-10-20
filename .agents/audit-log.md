# Institutional Memory — Decision & Audit Log

**Repository:** gravity-tpu/agentic-era-networking  
**Scope (from 2026-10-09):** real-hardware testbed and verifier for agent-proposed SDN policy; see [ROADMAP.md](../docs/ROADMAP.md). Earlier entries refer to the superseded "Council" persona framing and are kept as history.
**Local Network Context Manager:** [network-context.md](network-context.md)

---

## 1. Architectural Decisions & Non-Reversible Invariants

| Date | ID | Decision / Invariant | Status | Rationale |
| ------ | ---- | ---------------------- | -------- | ----------- |
| 2026-09-12 | INV-001 | BigInt & Integer Only for Telemetry Counters | Active | Floating-point IEEE-754 precision issues cause packet/byte counter divergence under continuous load. |
| 2026-09-12 | INV-002 | Fail-Closed Default (Default Drop) | Active | All unmatched routing rules, DNS records, and SDN flow lookups must reject/drop by construction. |
| 2026-09-12 | INV-003 | Zero Error Suppression Rule | Active | No empty catch blocks or `@ts-ignore` to mask networking or compiler errors. |
| 2026-09-12 | INV-004 | Multi-Model Fallback for AI Code Review | Active | Google Gemini (primary) → Anthropic Claude → OpenAI GPT-4o ensures resilient CI code reviews. |
| 2026-09-12 | INV-005 | Single Source of Truth for Runtime | Active | `.nvmrc` pins Node 22 universally across local dev, CI, and Vercel. |
| 2026-09-12 | INV-006 | DB Migration Guard for Prisma | Active | Structural changes to `prisma/schema.prisma` in PRs must include SQL migrations under `prisma/migrations/`. |
| 2026-09-12 | INV-007 | Physical Co-Design & Edge TPU Hardware Integration | Active | Zodiac FX Switch + Google Coral USB Accelerator provide physical ground-truth data plane and sub-4ms INT8 inference directly on host DisplayLink dock without intermediate SBC hops. |
| 2026-09-13 | INV-008 | Dual-Plane Zodiac FX Hardware Controller | Active | Out-of-band Serial CDC ACM (/dev/cu.usbmodem*) + OpenFlow 1.3 TCP (10.0.1.8:6633) with BigInt wire serialization and SymbolicRouteVerifier loop gate. |
| 2026-09-13 | INV-009 | Goodhart's Law & Epistemic Telemetry Provenance | Active | Anti-Simulation Law: Telemetry without verified physical provenance is fiction. Prohibit agents from synthesizing BigInt metrics to game UI/tests. Disconnected links must evaluate to 0 rates and null thermals; sandbox data must carry explicit disclaimers. |
| 2026-10-02 | INV-010 | Documentation Integrity & Automated Markdown Quality Enforcement | Active | markdownlint configuration, Vitest invariant test, pre-commit/pre-push git hooks, and CI/CD workflow mathematically eliminate formatting defects and broken AST parsing. |
| 2026-10-03 | NET-001 | Strict Data Plane vs. Control Plane Separation | Active | Forwarding hot path executes in kernel/ASIC (< 1 µs). Slow-path daemons run strictly out-of-band with CoPP rate-limiting. |
| 2026-10-03 | NET-002 | TCAM & FIB Hardware Budget Consciousness | Active | Hardware table capacity bounded (128 rules on Zodiac FX). Must enforce hierarchical CIDR aggregation (/24 or /16) to prevent exhaustion. |
| 2026-10-03 | NET-003 | End-to-End Principle & Fate-Sharing | Active | Origin traffic never shares fate with autonomous sidecar agents. Fail-open for clean traffic; log observation strictly out-of-band via inotify. |
| 2026-10-03 | NET-004 | Loop-Free Forwarding & Flap Prevention | Active | All flow updates formally verified as Directed Acyclic Graphs (DAGs). Exponential backoff hysteresis damping on dynamic ACL quarantine. |
| 2026-10-03 | NET-005 | Buffer Dynamics & Anti-Bufferbloat Dropping | Active | Drops executed in netfilter PREROUTING before socket buffer allocation. Token-bucket rate meters used on sister-site burst traffic. |
| 2026-10-03 | NET-006 | L2/L3 Boundary Discipline & MTU/MSS Integrity | Active | 802.1Q VLAN separation across untrusted, mirror tap, and controller domains. TCP MSS clamped to 1460 bytes across tunneling overlays. |
| 2026-10-03 | NET-007 | Elevation to CCIE Network Architecture & Forensics Rigor | Active | Upgraded networking custodian from CCNP to CCIE level. Enforces ASIC match-action pipeline modeling, TCAM ternary bitmasking, sub-millisecond convergence bounds, microsecond wire-timing forensics, and byte-exact encapsulation budgeting. |
| 2026-10-03 | NET-008 | CCIE Gap Remediation: Bidirectional Transit, CoPP Token Bucket & RFC 1035 Boundary Guards | Active | Remediated bridge server forwarding redirect to full bidirectional transit with tap mirror [2, 3]; enforced token-bucket Control Plane Policing on OFPT_PACKET_IN with drop telemetry; enforced RFC 1035 label length <= 63 and QNAME <= 255 byte limits. |
| 2026-10-03 | NET-009 | Physical Data-Plane Forwarding Validation & Mac Benchmark Endpoint Attestation | Active | Validated end-to-end L2/L3 data-plane transit (RPi 10.0.2.50 -> Zodiac Port 1 <-> Port 2 -> Extender -> Mac 10.0.2.119) with 0 switch drops, 94.9 Mbit/s UDP MTU wire saturation, and 0 packet forwarding deficit. Configured direct link-scoped routing on en0 to bypass overlay gateways. |
| 2026-10-04 | NET-010 | Multi-Tenant Workload Aggregation & Rate Mismatch Bounds via NETGEAR GS105Ev2 | Active | Integrated 5-port Gigabit smart managed switch between Zodiac Port 1 and RPi 3B+ (Port 4); enforced IEEE 802.3x Flow Control backpressure across 1000M->100M transition; bounded 128KB packet buffer with host-level fq pacing (`95mbit`); and closed telemetry blind spot via host-to-Zodiac packet reconciliation. |
| 2026-10-05 | NET-011 | Parallel CCIE Network Engineering Council Review in CI/CD | Active | Integrated parallel CCIE Network Engineering Council review (Clark, Jacobson, Perlman, McKeown, Floyd, Rexford) into GitHub Actions workflow alongside the Technical Staff Council to enforce physical network invariants prior to deployment. |
| 2026-10-06 | NET-012 | Bare-Metal Attestation & Multi-Tenant Provisioning of RPi 5 + Hailo-8 (26 TOPS) | Active | Provisioned Raspberry Pi 5 (`agentic-node-02`) with Hailo-8 26 TOPS INT8 NPU over PCIe Gen 3.0 x1 (`/dev/hailo0`, HailoRT 4.20) as autonomous adversarial agent on NETGEAR GS105Ev2 Port 2 (`10.0.2.51/24`), moved RPi 3B+ to Port 3 (`10.0.2.50/24`); verified 1000 Mb/s full-duplex auto-negotiation, OOB management isolation (`10.0.0.179`), sub-millisecond L2 transit, and zero-loss Zodiac OpenFlow transit to Mac (`10.0.2.119`). |
| 2026-10-07 | NET-013 | FastAPI Neural Inference Microservice Daemonization on RPi 5 + Hailo-8 | Active | Implemented, deployed, and daemonized high-throughput FastAPI microservice (`/opt/hailo-service`, `hailo-inference.service`) on RPi 5 (`10.0.0.179:8000` / `10.0.2.51:8000`); verified sub-11ms single-frame PCIe DMA latency, 306.7 FPS hardware streaming benchmark, pure monotonic nanosecond accounting (INV-2), epistemic silicon thermals (INV-6), and fail-closed Pydantic request validation (INV-3). |
| 2026-10-07 | NET-014 | Raspberry Pi 5 + Hailo-8 Appliance Observability Tier in Zodiac Dashboard UI | Active | Integrated dedicated RPi 5 (`agentic-node-02`) appliance monitoring tier in dashboard (`index.html`, `zodiac-app.js`) matching Jetson/Workstation depth: 5 KPI cards (BCM2712 compute, Hailo-8 26 TOPS inference velocity, eth0 GbE wire rate, silicon thermals, LPDDR4X RAM), primary network throughput canvas (eth0 vs RTL8153 mirror tap vs wlan0), compute canvas, Hailo-8 coprocessor status panel, thermals canvas, physical interfaces table, and hardware inventory grid. Enforced fail-closed physical truth (INV-6) and BigInt accounting (INV-2). |
| 2026-10-07 | NET-015 | Epistemic Physical Kernel Network Telemetry & Hailo-8 Ingress Bottleneck Remediation | Active | Resolved RPi 5 interfaces showing offline DOWN by eliminating stale control plane snapshot reuse and extracting live `/proc/net/dev`, `/sys/class/net`, and `SIOCGIFADDR` ioctl telemetry from `agent@10.0.0.179` with BigInt wire rates (`rxRateBps`/`txRateBps`). Profiled Hailo-8 41 inf/s HTTP bottleneck against 306.7 FPS raw NPU line rate, demonstrating CPU base64 decode and Wi-Fi RTT dominance over 10.63ms silicon execution. |
| 2026-10-09 | ARCH-001 | Refocus: real-hardware testbed and verifier for agent-proposed SDN policy | Active | Measured limits of the Zodiac FX (software lookup, ~58 µs + 4.24 µs per rule; session loss at 1.3 to 2.3x capacity) make autonomy at scale unreachable. Scope reduced to tracks A to D in `docs/ROADMAP.md`; autonomous framing dropped (agents propose, deterministic checks decide, a person approves). Sentinel frozen; old roadmap and design material archived under `docs/archive/`. |
| 2026-10-09 | ARCH-002 | Remove `SymbolicRouteVerifier` and `AdaptiveFlowController`; rename `pushVerifiedRule` to `pushRule` | Active | The route verifier's call sites passed one-hop or fixed hop lists that cannot fail, so nothing was verified; a static flow table has no routing loops to prove. Replaced with `verifyPlanAdmissible` (table budget, hairpin, DROP semantics) and the existing `verifyPort1Isolation`. The adaptive controller was exported but on no data path. |
| 2026-10-09 | ARCH-003 | Remove the dashboard "Live Invariant Verification Playground" | Active | It displayed hardcoded counters under a "LIVE MONITOR" badge and toggled a hardcoded hop list as a "verifier", contradicting Invariant 6. Invariants page now lists the six invariants. |
| 2026-10-09 | ARCH-004 | Reframe review tooling and governance docs; persona attribution removed | Active | AI review prompts, skills, rulebooks and AGENTS.md describe invariants and checklists, not expert personas; reviews are explicitly a second reader. npm script names (`council:review*`, `ccie:review*`) are kept for compatibility. |
| 2026-10-10 | NET-016 | Userspace Open vSwitch Reference Switch (`br-sim`), Table Bounds & Control Plane Hardening | Active | Installed Open vSwitch 2.17.12 in userspace `netdev` mode on Jetson Orin Nano (modprobe bypass via `/etc/modprobe.d/openvswitch.conf`) to provide a bounded (10,000-rule hard cap, Invariant 5) OpenFlow 1.3 software reference evaluator for Track A policy checks. Hardened `openflow-server.ts` to reject competing connections when a switch session is active (mitigating control plane DoS), and assigned `br-sim` to dedicated TCP 6634 for complete control plane isolation. |
| 2026-10-12 | NET-017 | Concurrent NETGEAR Switch Access, macOS LaunchAgent Supervisor & Zero Standing Pivot Routes (Invariant 3) | Active | Allocated dedicated local ports (`:8888` for Switch 1 Workload @ `192.168.0.239`, `:8889` for Switch 2 Uplink @ `192.168.0.240`) eliminating port collisions. Implemented persistent operator access via macOS user LaunchAgent (`com.zodiac.netgear-tunnels`, multiplexed SSH supervisor with auto-reconnect). Strictly upheld Invariant 3 (fail closed) by rejecting standing systemd services or persistent routes on untrusted pivot node (RPi 5); instead, the supervisor executes trapped SSH sessions (`trap cleanup EXIT INT TERM HUP`) ensuring switch routes exist on the pivot only during an active operator session and are immediately deleted on disconnect. Exposed lifecycle scripts (`npm run switch:service:install`, `uninstall`, `status`, `restart`). |

---

## 2. Active Technical Debt Tracking

*All items must be tracked here until resolved. Pull requests resolving an item must check the box and link the commit.*

- [x] Initial repository scaffolding and clean-room separation from encompass-platform.
- [x] Weekly automated security scanner (`security-scan.yml`) & Dependabot configuration.
- [x] Neon PostgreSQL Prisma schema for telemetry, DNS query logs, and SDN flow rules.
- [x] Prometheus `/metrics` exposition formatter for BigInt telemetry.
- [x] Wire-protocol RFC 1035 UDP DNS socket server with fail-closed resolution.
- [x] SDN Flow Table with CIDR matching and default-drop enforcement.
- [x] Zodiac FX Physical Hardware Interface & OpenFlow 1.3 Controller Daemon.
- [ ] Connect live Neon PostgreSQL connection string and run initial migration.
- [ ] Independent network-engineer review of the isolation policy and the verifier property list (roadmap, before publishing results).
- [ ] Test the suspected ARP spoofing surface across P1 to P2 (roadmap C1); resolve the A4 (quarantine precedence) versus A9 (forwarding-first layout) tension.

---

## 3. Pre-Push Gate Execution Log

*The pre-push hook at `.agents/hooks/pre-push` appends execution records below.*

| Timestamp (UTC) | Branch | Commit | Status | Summary |
| ----------------- | -------- | -------- | -------- | --------- |
| 2026-09-12T18:30:00Z | main | 14f08fc | PASSED | Initial clean-room bootstrap and baseline invariant verification. |
| 2026-09-12T19:47:18Z | main | 468d373 | PASSED | Added vercel.json and public interactive console (18 tests passed). |
| 2026-09-12T19:55:45Z | main | 9013f67 | PASSED | Pinned Node engine to 22.x (18 tests passed). |
| 2026-09-12T19:59:24Z | main | 079ad1f | PASSED | Adopted .nvmrc as single source of truth (18 tests passed). |
| 2026-09-12T20:26:42Z | main | pending | PASSED | Added Security Scanner, Prisma Neon DB, Prometheus, DNS UDP Server, SDN Flow Table (25 tests passed). |

## 4. Pushes that bypassed the AI review gate (cleanup owed)

Each `git push --no-verify` is listed here with who approved it. **Cleanup owed:** for every row, re-run `npm run review` on the range, then fix the warnings or record why each is not a defect, and confirm CI is green. Remove the row once done.

| Date | Branch | Range pushed | Approved by | Gates 1 to 5 | What the review blocked on | Cleanup |
| ---- | ------ | ------------ | ----------- | ------------ | -------------------------- | ------- |
| 2026-10-18 | fix/only-requires-ids (PR #69) | f772fee..55e6267 | owner, one-time | passed locally (tsc, tests, banned patterns, provenance) | restated, already-disclosed caveats (forgeable ARP source, one flood rate, unknown switch-hang cause) | open |
| 2026-10-19 | feat/eval-baselines-intents | 289032f..HEAD | owner, "bypass as long as we set a reminder to clean it up" (12-hour window) | passed | fresh nit-level warnings on each attempt after the real ones were fixed (identity comparison in `scoreMutants`, fallback category, no CI regeneration check): the last two were addressed, the gate kept finding new ones | open |
