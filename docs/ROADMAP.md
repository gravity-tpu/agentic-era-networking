# Zodiac — Master Architecture Roadmap

Autonomous, verifiable networking infrastructure — the Zodiac control plane: telemetry/monitoring, DNS resolution, and Software Defined Networking (SDN).

Governed by the **Technical Staff Council Invariants**:
- **Jeff Dean**: Systems scale, nanosecond-to-WAN latency budgets, hardware co-design, and graceful degradation.
- **Sanjay Ghemawat**: Radical simplicity, invariant rigor, cache-friendly flat layouts, and zero-bloat abstractions.
- **Quoc Le**: Neural architecture search, adaptive self-tuning control loops, and robustness under distribution shift.
- **Oriol Vinyals**: Graph representation routing (Pointer Networks), multi-agent game-theoretic convergence, and flap prevention.
- **Demis Hassabis**: Verification asymmetry, hybrid neuro-symbolic verification (AlphaProof paradigm), and formal state bounds.

---

## Physical Hardware Architecture

```
                                            +───────────────────────────────────+
                                            |    Public Internet / Home LAN     |
                                            +-----------------+-----------------+
                                                              │ (Mesh WiFi)
                                                              ▼
                                            +───────────────────────────────────+
                                            |     ISP Gateway / Mesh Node       |
                                            +-----------------+-----------------+
                                                              │ 100BASE-TX Ethernet
                                                              ▼
+─────────────────────────────────────────────────────────────────────────────────────────────────────────+
|                                  Zodiac FX OpenFlow Switch (Data Plane)                                 |
|                                                                                                         |
|   [Port 1]                      [Port 2]                  [Port 3]                    [Port 4]          |
|   Untrusted Agent Workload      Gateway Uplink            Hardware Mirror Tap         OpenFlow 1.3 Ctrl |
|   VLAN 100 (OpenFlow)           VLAN 100 (OpenFlow)       VLAN 100 (OpenFlow)         VLAN 200 (Native) |
|   100BASE-TX                    100BASE-TX                100BASE-TX                  100BASE-TX        |
+───────┬─────────────────────────────▲─────────────────────────┬───────────────────────────▲─────────────+
        │                             │                         │                           │
        │ RJ-45 Patch                 │ RJ-45 Patch             │ RJ-45 Patch               │ RJ-45 Patch
        │                             │                         ▼                           │
        │                             │             +───────────────────────+               │
        │                             │             | ASIX AX88179 USB GbE  |               │
        │                             │             | (enx* Promiscuous)    |               │
        │                             │             +───────────┬───────────+               │
        │                             │                         │ USB 3.0                   │
        │                             │                         ▼                           │
        │                        +----+-----------------------------------------------------+   Micro-USB
        │                        |         NVIDIA Jetson Orin Nano Super Master Appliance   |<──Serial CDC
        │                        |                                                          |   /dev/ttyACM0
        │                        |  * Controller Plane: enP8p1s0 (<ctrl-subnet>) <──────────+───(115200 8N1)
        │                        |  * Mirror Tap Ingress: enx* (Promiscuous)                |
        │                        |  * Management Plane: wlP1p1s0 (<mgmt-subnet>)            |
        │                        |  * OpenFlow 1.3 Controller Plane (:6633)                 |
        │                        |  * RFC 1035 Transparent DNS Resolver (:53)              |
        │                        |  * Local Telemetry Bridge & Web UI (:3003)               |
        │                        |  * I2C SSD1306 0.96" OLED Telemetry (Bus 7, 0x3c)        |
        │                        |  * USB-C Port: L4T Device Mode (192.168.55.1 / CDC-ACM)  |
        │                        |  * Tailscale Mesh: tailscale0 (100.118.64.16/32)         |
        │                        |  * 67 TOPS Ampere GPU (Stage-2 Anomaly Autoencoder)      |
        │                        +──────────────┬───────────────────────────┬───────────────+
        │                                       │                           │
        │                                       │ Dual USB 3.0              │ DIRECT HIGH-SPEED USB-C CABLE
        │                                       │ (Tap DPI & DNS Sentinel)  │ [Link 9: Management Tether]
        │                                       ▼                           │ * CDC-NCM: 192.168.55.1 <-> en8
        │                           +───────────────────────────────────+   │ * CDC-ACM: /dev/cu.usbmodem*
        │                           | Dual Google Coral Edge TPUs       |   │ * 5 Gbps SuperSpeed USB 3.0
        │                           | * TPU 0: Port 3 Mirror Tap DPI    |   │ * Priority: Tier 1 (Metric 50)
        │                           | * TPU 1: RFC 1035 DNS Sentinel    |   │ * Fail-Closed (Zero Route Bleed)
        │                           +───────────────────────────────────+   │
        ▼                                                                   ▼
+───────────────────────────────────+               +───────────────────────────────────────────────────+
| Raspberry Pi 3 Model B+ (Workload)|               | MacBook M5 · Gemma 4 Local Workstation Plane      |
|                                   |               |                                                   |
| * eth0: <workload-subnet> (Static)| (AIR-GAPPED:  | * Direct USB-C Hardware Tether (Link 9):          |
|   Untrusted SDN Agent Data Plane  |  NO CONNECTION|   - CDC-NCM: en8 (169.254.91.144 <-> 192.168.55.1)|
|   (Zodiac Port 1 VLAN 100)        |  BETWEEN RPi  |   - CDC-ACM: /dev/cu.usbmodem17916261208203       |
|                                   |  AND MACBOOK) | * 20-Core Apple Silicon Metal GPU (UMA VRAM)      |
| * wlan0: <mgmt-subnet> (Wi-Fi)    |               | * Local Ollama Engine: gemma4:26b (:11434)        |
|   Out-of-Band Wireless Management |               | * Dual-Stage Council Review Gate                  |
|   (Home WiFi LAN Only)            |               | * Zero-Dependency Plist XML Scanner (IOKit)       |
|                                   |               | * Tailscale Client (100.112.223.16/32)            |
+───────────────────────────────────+               +───────────────────────────────────────────────────+
                                                                |
                                                        Tailscale Mesh Overlay
                                                                |
                                              +─────────────────────────────+
                                              |    agentic-node-01          |
                                              |  (100.79.152.36/32)         |
                                              |  Remote Compute Peer        |
                                              +─────────────────────────────+
```

### Dedicated Jetson Orin ↔ MacBook M5 Direct USB-C Hardware Interconnect (Link 9)

```
+─────────────────────────────────────────────+                 +─────────────────────────────────────────────+
|    NVIDIA Jetson Orin Nano Super Appliance  |                 |       Apple MacBook M5 Workstation          |
|                                             |                 |                                             |
|  [USB-C Device Mode Controller]             |                 |  [Thunderbolt 4 / USB-C Port]               |
|  * Linux for Tegra (L4T) Gadget Stack       |                 |  * VID: 0x0955 (NVIDIA), PID: 0x7020        |
|  * CDC-NCM Bridge: l4tbr0 (192.168.55.1/24) |================>|  * en8 Point-to-Point IP: 169.254.91.144   |
|  * CDC-ACM Serial Debug TTY (115200 8N1)    |  HIGH-SPEED     |  * Direct TTY: /dev/cu.usbmodem17916261208203|
|  * Fail-Closed: net.ipv4.ip_forward = 0     |  USB-C CABLE    |  * Routing Priority: Tier 1 (Metric 50)     |
|    (Zero Leakage into SDN Tenant Flows)     |  (5 Gbps Link)  |  * Physical IOKit IOUSBHostDevice Verified  |
+─────────────────────────────────────────────+                 +─────────────────────────────────────────────+
```

> [!NOTE]
> Detailed private IP allocations, hardware MAC addresses, and physical port assignments are documented in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)).

**Role separation:**

| Node | Role | Hardware / Logical Plane | Always On? |
|---|---|---|---|
| **Zodiac FX Switch** | Data Plane — hardware OpenFlow 1.3 packet forwarding (KSZ8795 + SAM4E8E) | Ports 1-4 | ✅ Yes |
| **Jetson Orin Nano Super** | Control Plane — OpenFlow controller, DNS, telemetry bridge, 67 TOPS Ampere GPU Stage-2 Anomaly Autoencoder | Tri-IF (`<mgmt-subnet>`, `<ctrl-subnet>`), USB-C Device Mode (`192.168.55.1`), Tailscale (`100.118.64.16`) | ✅ Yes |
| **Dual Coral Edge TPUs** | Inference Accelerators — 8 TOPS INT8 dedicated model parallelism | Dual USB 3.0 (Attached to Jetson) | ✅ Yes |
| **ASIX AX88179 USB GbE** | Dedicated Tap Ingress — zero-overhead packet mirror capture from Port 3 | `enx*` Promiscuous Tap | ✅ Yes |
| **Raspberry Pi 3B+**| Untrusted Client Workload — target for agent SDN enforcement | `eth0` (`<workload-subnet>`), `wlan0` (`<mgmt-subnet>`) | ✅ Yes |
| **MacBook M5 Workstation** | Local AI Workstation & Review Plane — 20-Core Metal GPU, local `gemma4:26b` Council pre-push verification gate, IOKit telemetry, BigInt token ledger, Tailscale client | WiFi 6/6E (`<mgmt-subnet>`), Apple Silicon Metal GPU, Direct USB-C Tether (`en8`), Tailscale (`100.112.223.16`) | ❌ On-Demand / Dev Session |
| **agentic-node-01** | Remote Compute Peer — Tailscale mesh node for distributed workload | Tailscale (`100.79.152.36`) | ❌ External |

### Tailscale Mesh Overlay & Subnet Router Architecture

The Jetson Orin operates as a **Tailscale subnet router and WAN exit node**, enabling zero-configuration remote access to the full SDN stack from anywhere in the world:

- **Advertised Subnets**: `10.0.0.0/24` (Home LAN), `10.0.1.0/24` (Zodiac OpenFlow plane), full WAN exit (`0.0.0.0/0`)
- **Remote Access**: `ssh zodiac@jetson-orin` from any Tailscale client — no VPN, port-forwarding, or static IP required
- **Mesh Peers**: MacBook M5 (`100.112.223.16`) ↔ Jetson (`100.118.64.16`) ↔ agentic-node-01 (`100.79.152.36`)

### Management Plane Routing Hierarchy & Fail-Closed Invariants

To eliminate routing ambiguity, split-brain conditions, and non-deterministic interface flapping between the USB-C hardware tether, Tailscale mesh, and wireless network (Council Invariants 3 & 5), the management plane enforces a strict metric priority and interface isolation:

1. **Deterministic Recovery Hierarchy**:
   - **Tier 1 — Direct Hardware Tether (Highest Priority, Metric 50)**: USB-C CDC-NCM point-to-point network (`en8` <-> `l4tbr0`, invariant subnet `192.168.55.0/24`). Lowest administrative distance for deterministic, ultra-low-latency operator access and telemetry bridging.
   - **Tier 2 — Tailscale Mesh Overlay**: WireGuard-encrypted mesh (`tailscale0`). Globally routable remote access immune to dynamic home ISP IP changes; routes `10.0.0.0/24` and `10.0.1.0/24`.
   - **Tier 3 — Wireless Management Plane (Secondary, Metric 200)**: 802.11ax Wi-Fi (`en0` / `wlP1p1s0`, dynamic `<mgmt-subnet>`). Untethered roaming and cloud telemetry relay to Vercel/Neon.
   - **Tier 4 — Hardware Serial Console (Emergency Out-of-Band)**: USB CDC-ACM direct serial device (`/dev/cu.usbmodem*` @ 115200 8N1). Zero-network kernel debugging and rescue console, operational even under total TCP/IP stack failure.
2. **Subnet Non-Leakage Law (Fail-Closed Isolation)**:
   - The point-to-point subnet `192.168.55.0/24` is strictly bound to `l4tbr0` on the Jetson appliance. Tailscale requires `net.ipv4.ip_forward = 1` globally for WAN exit-node routing; however, SDN plane cross-leakage is prevented by explicitly disabling per-interface forwarding on all non-Tailscale interfaces (`net.ipv4.conf.enP8p1s0.forwarding = 0`, `net.ipv4.conf.l4tbr0.forwarding = 0`) and by nftables forward-chain DROP rules on SDN bridge interfaces. Only `tailscale0` and the WAN exit interface have forwarding enabled. **Boot atomicity**: the nftables ruleset is loaded by `nftables.service` which is ordered `Before=network-pre.target` and `Before=network.target`, ensuring DROP rules are installed before any interface is brought up — eliminating transient forwarding windows at startup.

## Phase Overview


```
+---------------------------------------------------------------------------------------------------+
| Phase 0: Physical Hardware Telemetry & Web Dashboard (COMPLETE)                                   |
| - Zodiac FX Switch co-design (Ports 1-4, SAM4E8E MCU, KSZ8795 switch IC)                          |
| - Interactive SVG digital twin, dynamic port matrix, real-time rates, and serial terminal         |
| - Local bridge daemon & cryptographically authenticated cloud relay to Vercel                     |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.5: Enterprise Security & Historical Telemetry Persistence (COMPLETE)                      |
| - Milestone 0.5A: Google SSO Authentication Guard (OAuth 2.0 / OIDC, strict email allowlist)       |
| - Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence Engine (10s batching, downsampling)   |
| - Milestone 0.5C: Content-Addressable Asset Pipeline (SHA-256 immutable edge caching)            |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.6: Zero-Trust Cloud Edge Security & External Attack Shield (IN PROGRESS)                 |
| - Air-Gapped Command Diode (Vercel public layer read-only; zero mutating access to switch plane)  |
| - Edge rate limiting & anti-DDoS shield on all serverless endpoints                               |
| - Monotonic HMAC request signatures & replay protection on cloud-to-hardware telemetry bridge     |
| - Strict CSP, CORS fail-closed lockdown, and external vulnerability quarantine                   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.7: Jetson Orin Headless Control-Plane Deployment (COMPLETE)                               |
| - NVMe SSD boot migration: 500GB SanDisk Optimus @ 1.8 GB/s on native JetPack 6.1 (L4T 36.4.7)    |
| - Cross-platform serial CDC-ACM discovery: /dev/ttyACM0 on Jetson with sysfs VID matching        |
| - systemd zodiac-bridge.service unit: auto-restart, fail-closed, memory-bounded, Notify+Watchdog   |
| - Dedicated `zodiac` service user with CAP_NET_BIND_SERVICE & dialout group (no root runtime)     |
| - Physical Triad operational: Zodiac FX (Ports 2 & 4 UP) + Coral TPU + Jetson 24/7 SDN master      |
| - Active OpenFlow 1.3 control channel (0.7ms echo latency) & Table-Miss packet sampling stream   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.8: Real-Time Wire-Packet Ingestion & Dual Coral TPU Epistemic Provenance (COMPLETE)       |
| - AF_PACKET raw socket ingestion on Port 3 mirror tap (enx*), promiscuous mode                   |
| - Zero-copy packet-to-tensor pipeline: 1 wire frame = 1 physical Coral inference                 |
| - Physical epistemic provenance: 0 pps = 0 inf/s STANDBY (Anti-Simulation Law Invariant 6)       |
| - Burst daemon per-TPU telemetry isolation: async writer thread, per-TPU JSONL files             |
| - hardware-burst-daemon.py: coral_tpu1_inferences counter, DNS Sentinel role separation          |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.9: Local 30-Day Telemetry Persistence & Cloud Relay Resilience (COMPLETE)                 |
| - Three-tier storage: RAM (live, 2.5h) + NVMe JSONL disk (30d, localhost) + Neon (30d, Vercel)   |
| - src/db/local-telemetry-db.ts: append-only per-day JSONL, async parallel reads, 30d pruning    |
| - Query priority on localhost: local NVMe first -> Neon fallback -> in-memory (no internet req.) |
| - Cloud relay exponential backoff: 5s->10s->20s->60s cap on monotonic performance.now() clock   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.10: Local AI Workstation Tier & Deterministic Token Accounting Ledger (COMPLETE)          |
| - Elevated MacBook M5 to 6th active appliance tier (MacBook M5 · Gemma 4 Workstation)             |
| - Direct Apple Silicon IOKit hardware profiling: ioreg -r -c IOAccelerator, zero-dep XML parser   |
| - Deterministic BigInt token accounting ledger: prompt, completion, total tok/s, peak velocity     |
| - Jeff Dean TTFT latency budget tracking: monotonic hrtime nanoseconds, ms/token profiling       |
| - Epistemic concurrency mutex: kernel signal 0 orphaned lock recovery, TOCTOU-free state updates  |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.11: Tailscale Global Mesh Overlay & Remote SDN Operator Access (COMPLETE)                 |
| - Jetson as Tailscale subnet router & WAN exit node (0.0.0.0/0, 10.0.0.0/24, 10.0.1.0/24)        |
| - Mesh peers: Jetson (100.118.64.16), MacBook (100.112.223.16), agentic-node-01 (100.79.152.36)  |
| - Zero-config remote access: ssh zodiac@jetson-orin from any Tailscale peer worldwide             |
| - Management tier upgraded: Tier 1 (USB-C) → Tier 2 (Tailscale) → Tier 3 (Wi-Fi) → Tier 4 (Serial)|
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.12: Jetson Ampere GPU Stage-2 Anomaly Autoencoder & Live Wire Quarantine (COMPLETE)       |
| - gpu-workload-1: GPU Neural Stress & Verification Burst Worker (validated on silicon)            |
| - gpu-workload-2: 1D-CNN Autoencoder on 1024 CUDA Cores (sm_87): 0.271ms avg inference latency   |
| - AdaptiveThresholdController: EMA baseline tracking, flap-storm prevention (Council Invariant 5) |
| - Live wire quarantine: 24 anomalies detected → 24 FLOW_MOD DROP rules installed on Zodiac FX     |
| - GPU utilization from physical sysfs (Anti-Simulation Law, Invariant 6)                          |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 1: Zero-Config DNS Reverse Proxy Engine (NEXT)                                              |
| - RFC 1035 UDP interceptor & dynamic domain mapping (wildcard / exact / catch-all)                |
| - Transparent edge reverse proxy with nanosecond latency profiling                                |
| - OpenFlow 1.3 VIP traffic steering (Port 1 UDP 53 & TCP 80/443 -> Port 4 Host Controller)        |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 2: Real-Time Flow Anomaly Detection — Coral + Jetson Split-Inference & Web Wireshark      |
| - Google Coral Edge TPU (4 TOPS INT8): sub-ms shallow packet classification on Port 3 mirror tap |
| - NVIDIA Jetson TensorRT (67 TOPS Ampere): deep anomaly detection model (<1.0ms inference budget) |
| - In-Browser Wireshark: Real-time packet dissector (L2-L7), interactive hex dump & PCAP export   |
| - Fail-closed line-rate FlowMod quarantine (priority 65535 default drop)                          |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 3: AlphaProof Symbolic Verification & Self-Tuning Control                                   |
| - Hybrid neuro-symbolic verification: probabilistic route synthesis gated by formal DAG proof     |
| - Quoc Le self-tuning control loops: dynamic buffer windows adapting to packet arrival distributions |
| - gpu-workload-3: Contextual Bandit Rate-Meter optimizer on live Zodiac 64-bit hardware counters   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 4: Multi-Agent Routing Stability & Flap Prevention                                          |
| - Pointer Network graph routing representations under multi-tenant agent traffic                 |
| - Hysteresis damping and game-theoretic convergence preventing route flap oscillations            |
| - gpu-workload-4: TCN/LSTM Micro-Burst Forecaster (50–200ms predictive rerouting via GPU)         |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 5: Autonomous Agent Intent Firewall                                                         |
| - Application-layer semantic inspection of autonomous tool-use payloads                           |
| - Cryptographic audit trail of all automated policy modifications                                 |
+---------------------------------------------------------------------------------------------------+
```

---

## Detailed Milestones

### Phase 0: Physical Hardware Telemetry & Web Dashboard
*Status: Complete (Commits `349d5d7`, `5cad520`, `4c9e4de`, `9b54887`)*
- [x] Physical co-design with Northbound Networks Zodiac FX OpenFlow 1.3 Switch.
- [x] Interactive SVG board visualizer with dynamic chip tooltips and port LEDs.
- [x] Live port analytics cards for Ports 1–4 with true box collapse and IP relocation.
- [x] OpenFlow 1.3 control plane daemon (Port 6633) with nanosecond latency tracking.
- [x] In-browser interactive CLI terminal emulator for Zodiac management commands.
- [x] Epistemic Telemetry Provenance: Cryptographic `ZODIAC_BRIDGE_SECRET` authentication.
- [x] Cloud Telemetry Relay to Vercel production with bounded rolling WAN window (HTTP 413 fix).
- [ ] **Wireshark-style Flow Rule Registry inspector**: Web UI detail view over the in-memory `flowRuleRegistry` (`zodiac-bridge-server.ts`) surfacing the full `QuarantineAuditEntry` already captured per quarantine — rule ID, action, priority, source/destination CIDR, source/destination MAC, protocol, install timestamp, and OpenFlow install status — in a sortable/filterable table with per-rule drill-down, beyond the current summary counts.

### Phase 0.5: Enterprise Security & Historical Telemetry Persistence
*Status: Complete (Commits `b33eb1f`, `32e102f`, `eb1dc5b`, `935b76e`, `5d1c0ba`, `e80f6d0`, `85857c2`)*
- [x] **Milestone 0.5A: Google SSO Authentication Guard**:
  - OpenID Connect / OAuth 2.0 serverless auth flow (`/api/auth/login`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`).
  - Strict operator allowlist: `sekyereandy@gmail.com`, `natborks@gmail.com` with `ALLOWED_GOOGLE_EMAILS` wildcard and domain support.
  - Fail-Closed isolation: session cookie defaults to `; Secure` flag, constant-time HMAC-SHA256 session token verification.
  - Zero-overhead hoisted environment constants (`IS_VERCEL`, `IS_PRODUCTION`) per Jeff Dean Latency Invariant.
  - Dual authentication boundary: Machine-to-machine hardware relay via `X-Zodiac-Bridge-Secret` + Operator SSO for dashboard operators.
  - Dark-glass Google Sign-In modal gate & Operator profile header in Web UI.
  - Non-revealing error messages (fail-closed, zero operator enumeration).
  - Sanjay Ghemawat Radical Simplicity: Flat `SessionCookieOptions` configuration object.
- [x] **Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence**:
  - Prisma models for `ZodiacTelemetryPoint` and `User` in Neon serverless Postgres (`@prisma/adapter-pg` / `@neondatabase/serverless`).
  - 10-second non-blocking batched persistence engine adhering to Ghemawat backpressure invariant (~259k records/30 days, ~40MB).
  - Bucketed SQL downsampling API (`/api/zodiac?range=1h|6h|24h|7d|30d`) returning bounded (<360) data points.
  - Automated 30-day data retention pruning via daily scheduled cron (`/api/cron/prune-telemetry`).
  - Sub-millisecond monotonic clock calculation preserving microsecond precision (`performance.now() * 1000000`).
  - UI historical time range selector with explicit canvas watermark on database degradation/unreachable state (Anti-Shortcut / Anti-Simulation Law).
  - Multi-tier storage architecture documented in [docs/design/physical-sdn-edge-tpu.md (Section 6)](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md#6-telemetry-ingestion-multi-tier-storage--query-routing-architecture): Local Jetson RAM (<10ms) vs. Cloud Vercel RAM (<20ms) vs. Neon Postgres historical downsampling (<150ms).
- [x] **Milestone 0.5C: Content-Addressable Asset Pipeline & Edge Caching**:
  - Automated content-addressed asset build script (`scripts/build-assets.ts`) generating SHA-256 asset hashes (`zodiac.[hash].css`, `zodiac-app.[hash].js`).
  - Immutable edge cache headers (`Cache-Control: public, max-age=31536000, immutable`) on Vercel and local bridge server.

### Phase 0.6: Zero-Trust Cloud Edge Security & External Attack Shield
*Status: In Progress*
- [x] **Milestone 0.6A: Edge Command Diode (Anti-Pivoting / Zero-Ambient Mutating Access)**:
  - Strict read-only boundary for cloud serverless execution: Vercel edge runtime is mathematically decoupled from the local hardware control plane.
  - Zero arbitrary command injection: Remote commands evaluate strictly against mock sandbox templates with explicit simulation watermarks unless attested with verified local socket provenance.
- [ ] **Milestone 0.6B: Token-Bucket Edge Rate Limiting & Anti-DDoS Shield**:
  - In-memory and distributed edge rate limiters on `/api/*` (e.g., 60 req/min for telemetry reads, 10 req/min for auth callbacks) preventing denial-of-service against Neon DB and edge runtimes.
  - Strict 429 Too Many Requests with deterministic `Retry-After` headers.
- [ ] **Milestone 0.6C: Cryptographic Command Attestation & Replay Protection**:
  - Monotonic nanosecond timestamp + HMAC-SHA256 signature verification on all bridge payloads (`X-Zodiac-Signature`, `X-Timestamp-Ns`) preventing replay attacks.
  - Strict Origin and Host pinning to prevent DNS rebinding or SSRF pivot attacks into private appliance subnets.
- [ ] **Milestone 0.6D: Hardened Content Security Policy & Security Headers**:
  - Strict CSP headers (`default-src 'self'`, `script-src 'self'`, `connect-src 'self' https://accounts.google.com`, `frame-ancestors 'none'`).
  - Strict transport security (`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`).

### Phase 0.7: Jetson Orin Headless Control-Plane Deployment
*Status: Complete*
- [x] **Milestone 0.7A: Cross-Platform Serial CDC-ACM Discovery**:
  - `zodiac-serial.ts` `detectDevice()` now resolves `/dev/ttyACM*` (preferred) or `/dev/ttyUSB*` on Linux/Jetson ARM64, and `/dev/cu.usbmodem*` on macOS. No external serial library dependencies (Ghemawat).
  - Platform-aware fallback: `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem212201` on macOS. Anti-Shortcut: error surfaces clearly rather than silently using wrong path.
- [x] **Milestone 0.7B: systemd Service Unit & Secret Provisioning**:
  - `deploy/jetson/zodiac-bridge.service`: Type=simple, `Restart=on-failure`, `StartLimitBurst=5/60s`, `MemoryMax=256M`, `PrivateTmp=true`, `NoNewPrivileges=true`.
  - `deploy/jetson/zodiac-bridge.env.template`: All runtime secrets documented; Coral TPU stubs pre-wired for Phase 2A.
  - Dedicated `zodiac` service user with `CAP_NET_BIND_SERVICE` only — no root runtime.
- [x] **Milestone 0.7C: Untethered Mac SSH Dev Workflow**:
  - MacBook connects via WiFi/Ethernet to push `git pull && npm run build && systemctl restart zodiac-bridge`.
  - Close-lid / reboot Mac does not interrupt any network services.
  - SSH key-based authentication only; password auth disabled on Jetson.

### Phase 0.8: Real-Time Wire-Packet Ingestion & Epistemic Provenance for Coral Edge TPUs
*Status: Complete*
- [x] **Direct AF_PACKET Raw Socket Ingestion on Mirror Tap (`enx*`)**:
  - Promiscuous mirror tap listener sniffing real physical frames on Zodiac Port 3 / Port 1.
  - Fail-closed fallback to `STANDBY` listener mode if interface or permissions are unavailable.
- [x] **Zero-Copy Packet-to-Tensor Triage Pipeline**:
  - Frame header and payload bytes mapped directly into the model's `uint8` input tensor buffer.
  - Fixed-function INT8 execution on Google Coral silicon: 1 wire packet ingested = 1 physical inference.
- [x] **Physical Epistemic Provenance (Anti-Simulation Law - Invariant 6)**:
  - Eliminated synthetic dummy tensor benchmark loops in monitoring.
  - True zero-traffic baseline: when network traffic is 0 pps, Edge TPU evaluates to 0 inf/s (`STANDBY`).
  - High-traffic burst response: inference rate spikes proportionally up to silicon saturation (~230 inf/s per TPU).
- [x] **Multi-TPU Parallel Telemetry Aggregation**:
  - `hardware-probe.ts` aggregates dual Edge TPUs (primary tap DPI daemon on TPU #1 + burst parallel on TPU #2) into combined throughput (~450 inf/s peak).
  - TOCTOU-free atomic telemetry reporting with 5-second fail-closed staleness guards.

### Phase 0.9: Local 30-Day Telemetry Persistence & Cloud Relay Resilience
*Status: Complete (Commits `a050d4c`, `e716eba`, `9474f48`, `ee41d98`)*
- [x] **Milestone 0.9A: Three-Tier Telemetry Storage Architecture**:
  - Architecture upgraded from two-tier (RAM + Neon) to three-tier: Tier 1 — in-memory ring buffer (live, 2.5 h); Tier 2 — local NVMe JSONL files (30-day, localhost history); Tier 3 — Neon Postgres (30-day, Vercel cloud).
  - Localhost is now fully self-sufficient for 30-day historical queries without internet connectivity or Neon access.
  - Query priority on localhost GET `?range=`: Tier 2 (local disk) → Tier 3 (Neon fallback) → Tier 1 (in-memory 2.5 h fallback).
  - Vercel path unchanged: POST relay → `persistTelemetrySnapshot()` → Neon → GET historical query.
- [x] **Milestone 0.9B: Local JSONL History Engine (`src/db/local-telemetry-db.ts`)**:
  - Append-only JSONL storage with one averaged point per 30-second flush cycle per device type (Zodiac, Jetson, Coral) at `~430 KB/day/device` on `/var/lib/zodiac/history/` (NVMe SSD).
  - All file I/O async (`fs.promises.appendFile`, `fs.promises.readFile`) so SDN OpenFlow event loop is never blocked (Jeff Dean latency invariant).
  - Historical queries fan reads across all relevant day files in parallel via `Promise.all`, then apply the same `downsamplePoints` bucketing used by the Neon path — returning ≤360 output points per range.
  - `pruneLocalHistory()` runs synchronously on bridge startup (before HTTP traffic), deleting files whose UTC date suffix predates the 30-day cutoff.
  - Zero new runtime dependencies: pure `node:fs/promises` and `node:path`.
- [x] **Milestone 0.9C: Burst Daemon Per-TPU Telemetry Isolation**:
  - `hardware-burst-daemon.py` refactored: `coral_total_inferences` (aggregate), `coral_tpu0_inferences` (Tap DPI), `coral_tpu1_inferences` (DNS Sentinel) counters.
  - DNS Sentinel worker now writes to `coral-tpu1-burst-telemetry.json` (independent file, no race condition with other workers).
  - Async writer thread (`_coral_telemetry_writer`) decouples all telemetry file writes from the TPU inference hot loop via a bounded `queue.Queue(maxsize=4)`.
  - Exponential P99 latency fixed: `int(n * 0.99)` → `(n * 99) // 100` (integer-only arithmetic, determinism invariant).
- [x] **Milestone 0.9D: Cloud Relay Exponential Backoff**:
  - `ZodiacBridgeServer.relaySnapshotToCloud()` now gates retries via `isRelayBackoffElapsed()` using a monotonic `performance.now()` clock (immune to NTP clock adjustments).
  - Backoff schedule: `consecutiveRelayFailures` 0 → immediate | 1 → 5 s | 2 → 10 s | 3 → 20 s | 4 → 40 s | ≥5 → 60 s cap.
  - `currentRelayBackoffMs` getter is the single source of truth for the formula (eliminates duplication).
  - Recovery logged with outage failure count; `consecutiveRelayFailures` resets to 0 on `res.ok`.

### Phase 0.10: Local AI Workstation Tier & Deterministic Token Accounting Ledger
*Status: Complete (Commit `e602654`)*
- [x] **Milestone 0.10A: 6th Active Appliance Tier — MacBook M5 & Gemma 4 Engine**:
  - Elevated the local MacBook from a passive dev terminal into a first-class autonomous AI Workstation tier (`MacBook M5 · Gemma 4 Workstation`).
  - Added dedicated navigation tab, breadcrumbs, status badges, and responsive UI views to the operator console.
- [x] **Milestone 0.10B: Physical Apple Silicon IOKit Hardware Profiling**:
  - Direct hardware interrogation via `ioreg -r -c IOAccelerator -d 1 -a` without third-party CLI dependencies.
  - Implemented zero-dependency Property List XML recursive-descent parser (`tokenizeApplePlistXml`, `parseApplePlistXml`) with CDATA, entity decoding, and depth bounds (`MAX_PLIST_DEPTH = 32`).
  - Extracted physical Metal GPU utilization (`Device Utilization %`), allocated VRAM, in-use system memory, CPU load, and core counts.
  - Strictly adhering to Council Invariant 6 (Epistemic Provenance): evaluates to 0 utilization and offline badge when disconnected; zero synthetic waveforms.
- [x] **Milestone 0.10C: Deterministic BigInt Token Accounting Ledger**:
  - Track cumulative prompt tokens, completion tokens, and total token throughput.
  - Native 64-bit `BigInt` arithmetic serialized as decimal strings across JSON wire boundaries to prevent IEEE-754 float precision loss beyond $2^{53}-1$ (Council Invariant 2).
  - High-precision telemetry metrics: Generation Velocity (`tok/s`), Prompt Prefill Velocity (`tok/s`), Peak Velocities, Context Window Saturation %, and Edge vs Cloud Offload Ratio.
- [x] **Milestone 0.10D: Jeff Dean TTFT Latency Budget Tracking**:
  - High-precision nanosecond timing (`process.hrtime.bigint()`) tracking Time-to-First-Token (TTFT) and per-token generation latency (`ms/token`).
  - Evaluated against the Jeff Dean datacenter and LLM latency budget (500 ms – 2,000 ms target for TTFT).
- [x] **Milestone 0.10E: Atomic Concurrency & Epistemic Mutex Lock**:
  - Implemented Promise-chained in-memory mutation queue (`enqueueTelemetryMutation`) with single-flight file lock (`withTelemetryFileLock`).
  - Kernel signal 0 orphaned lock recovery (`process.kill(pid, 0)`) recovering stale locks deterministically without artificial time heuristics.
  - Comprehensive invariant test suite validating 20 concurrent parallel inferences under heavy contention with zero dropped counts.
- [x] **Milestone 0.10F: Dual-Stage Council Verification & Edge Anti-Runaway Controls**:
  - Dual-Stage Verification Gate (Hassabis & Vinyals): Stage 1 local workstation pre-push audit paired with Stage 2 mandatory server-side CI/CD symbolic invariant verifier.
  - Platform-Isolated Telemetry (Ghemawat): `probeWorkstationHardware()` and `queryAppleGpuMetrics()` fail closed immediately on non-Darwin platforms (`os.platform() !== 'darwin'`).
  - Anti-Runaway Offload Controls (Quoc Le): 3-attempt circuit breaker, 10s strict timeout budget (`AbortSignal.timeout(10000)`), and 90% edge compute ratio SLA alert to prevent cloud-loop distribution runaway.


### Phase 0.11: Tailscale Global Mesh Overlay & Remote SDN Operator Access
*Status: Complete*
- [x] **Milestone 0.11A: Jetson as Tailscale Subnet Router & WAN Exit Node**:
  - Jetson advertises `10.0.0.0/24`, `10.0.1.0/24`, and `0.0.0.0/0` (WAN exit) into the Tailscale tailnet.
  - Any Tailscale peer can reach `10.0.1.99` (Zodiac FX switch web UI) and `10.0.0.15` (Jetson bridge) without any port-forwarding or static IP.
  - Filter backend: `iptables-legacy` (coexisting correctly with Docker & Tailscale kernel chains).
  - Config file: `/etc/sysctl.d/99-tailscale.conf` (`net.ipv4.ip_forward = 1`, `net.ipv6.conf.all.forwarding = 1`) — required for Tailscale exit-node routing. SDN interface leakage is blocked per-interface: `net.ipv4.conf.enP8p1s0.forwarding = 0`, `net.ipv4.conf.l4tbr0.forwarding = 0` in `/etc/sysctl.d/99-zodiac-sdn.conf`, plus nftables forward-chain DROP on SDN bridge interfaces.
- [x] **Milestone 0.11B: Tailscale SSH ACL (Hardened Remote Access)**:
  - Strict Tailscale ACL enforces `zodiac` user for all SSH sessions to Jetson (rejects username `andymorven`).
  - Remote command: `ssh zodiac@jetson-orin` — globally routable, WireGuard-encrypted, zero knowledge of home ISP IP required.
- [x] **Milestone 0.11C: 4-Tier Management Hierarchy Formalized**:
  - Tier 1 (USB-C Tether, Metric 50) → Tier 2 (Tailscale WireGuard mesh) → Tier 3 (Wi-Fi, Metric 200) → Tier 4 (Hardware Serial CDC-ACM).
  - Tailscale mesh makes Tier 2 globally routable; eliminates dependency on home DHCP/IP for remote work sessions and CI/CD deployments.
  - Documented in [.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md) with full mesh peer table.

### Phase 0.12: Jetson Ampere GPU — Stage-2 Anomaly Autoencoder & Live Wire Quarantine
*Status: Complete (Tracked via [Jetson Orin GPU Workload Mini-Roadmap](file:///Users/andymorven/git/agentic-era-networking/docs/design/gpu-workload-roadmap.md))*
- [x] **Milestone 0.12A (`gpu-workload-1`): GPU Neural Stress & Verification Burst Worker**:
  - `jetson_gpu_worker` thread in `hardware-burst-daemon.py` driving CUDA matrix operations on 1024 Ampere CUDA cores.
  - GPU load verified via physical sysfs (`/sys/devices/platform/bus@0/17000000.gpu/load`); zero synthetic waveforms (Invariant 6).
  - Validated in live 10-minute multi-accelerator burst with power consumption and thermal tracking.
- [x] **Milestone 0.12B (`gpu-workload-2`): Stage-2 Deep Anomaly Autoencoder & Fail-Closed Quarantine**:
  - Native CUDA kernel `src/gpu/gpu_anomaly_kernel.cu` compiled for `sm_87` (Ampere) — 1D-CNN autoencoder with parallel warp reductions on 1024 CUDA cores.
  - **0.271 ms** average inference latency across 174 live inferences (Dean latency budget: `< 1.0 ms`).
  - `AdaptiveThresholdController`: EMA-based dynamic threshold tracking baseline variance — prevents route flap storms (Invariant 5, Quoc Le).
  - Live wire verification on physical interface `enP8p1s0`: 24 anomalies detected → 24 OpenFlow 1.3 `FLOW_MOD` (Priority 65535, action `DROP`) installed on Zodiac FX hardware via `POST /api/sdn/quarantine`.

### Phase 1: Zero-Config DNS Reverse Proxy Engine
*Status: Planned (Next)*
- [ ] Transparent RFC 1035 UDP DNS interception on Zodiac data ports without client proxy setup.
- [ ] Dynamic domain registry with wildcard and exact match mappings to local upstreams.
- [ ] Node HTTP reverse proxy with stream piping and Dean nanosecond latency headers (`X-Edge-Latency-Ns`).
- [ ] OpenFlow 1.3 steering rules redirecting UDP 53 and TCP 80/443 to the host controller.
- [ ] Formal loop-free verification before flow rule hardware deployment.

### Phase 2: Real-Time Flow Anomaly Detection — Coral + Jetson Split-Inference & Web Wireshark
*Status: Planned*
- [ ] **Milestone 2A: Coral + Jetson Split-Inference Line-Rate Anomaly Detection** *(Tracked via [Jetson Orin GPU Workload Mini-Roadmap](file:///Users/andymorven/git/agentic-era-networking/docs/design/gpu-workload-roadmap.md))*:
  - **Google Coral Edge TPU** (4 TOPS INT8, USB 3.0 attached to Jetson): sub-millisecond shallow packet classification on Port 3 hardware mirror tap stream. Handles high-volume benign/rogue first-pass triage.
  - **NVIDIA Jetson TensorRT** (67 TOPS INT8 Ampere GPU): deep anomaly detection model on packets flagged by Coral, `<1.0ms` inference budget.
  - Division of labor: Coral = sub-100µs shallow classifier, Jetson TensorRT = deep-feature anomaly scorer.
  - Fail-closed line-rate FlowMod quarantine (priority 65535 default drop) on high-confidence rogue agent classification.
- [ ] **Milestone 2B: In-Browser Wireshark Packet Dissector Engine**:
  - Real-time deep packet inspection (DPI) & protocol dissection from Port 3 mirror tap and OpenFlow `PACKET_IN` streams.
  - Multi-layer protocol decoders: Layer 2 (Ethernet, 802.1Q VLAN), Layer 3 (IPv4, IPv6, ARP, ICMP), Layer 4 (TCP, UDP), Layer 7 (DNS, HTTP/1.1, OpenFlow 1.3).
  - Interactive Web UI Packet Inspector: Real-time packet table with colorized protocol streams, expandable protocol tree, and synchronous Hex/ASCII dump inspector.
  - Display filter engine (BPF-like syntax, e.g., `ip.src == 192.0.2.2 && tcp.port == 80`) and one-click `.pcap` / `.pcapng` export.

### Phase 3: AlphaProof Symbolic Verification & Self-Tuning Control
*Status: Planned*
- [ ] Formal symbolic verifier gating probabilistic routing updates.
- [ ] Quoc Le self-tuning control loops adapting to traffic distribution shifts.
- [ ] **`gpu-workload-3`: Contextual Bandit Rate-Meter & Bufferbloat Optimizer** — GPU-accelerated contextual bandit trained on live Zodiac 64-bit hardware counters (`fx_port_counts`, CRC errors, drops, byte deltas). Dynamically configures the Zodiac FX's 8 hardware rate meters and flow table timeouts to eliminate packet drops and queue oscillation under bursty multi-agent workloads.

### Phase 4: Multi-Agent Routing Stability & Flap Prevention
*Status: Planned*
- [ ] Graph sequence representations for topology mapping.
- [ ] Multi-agent coordination with hysteresis damping.
- [ ] **`gpu-workload-4`: TCN/LSTM Micro-Burst & Congestion Forecaster** — Temporal Convolutional Network or LSTM running on the Jetson GPU predicting switch buffer saturation 50–200ms ahead of time, proposing preemptive flow reroutes through `SymbolicRouteVerifier.verifyLoopFree()`.

### Phase 5: Autonomous Agent Intent Firewall
*Status: Planned*
- [ ] Semantic tool-call payload inspection at network boundary.
- [ ] Cryptographic audit trail of all automated policy modifications.
