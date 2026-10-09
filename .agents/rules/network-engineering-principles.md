# Network Engineering Principles & Protocol Invariants

**Foundational literature and RFCs** (references for the principles below; this document does not claim their authors' endorsement):

- Clark: *The Design Philosophy of the DARPA Internet Protocols* (SIGCOMM 1988). Saltzer, Reed, Clark: *End-to-End Arguments in System Design* (TOCS 1984).
- Jacobson: *Congestion Avoidance and Control* (SIGCOMM 1988). McCanne, Jacobson: *The BSD Packet Filter* (USENIX 1993).
- Perlman: *An Algorithm for Distributed Computation of a Spanning Tree in an Extended LAN* (SIGCOMM 1985); *Interconnections: Bridges, Routers, Switches, and Internetworking Protocols* (Addison-Wesley).
- McKeown et al.: *OpenFlow: Enabling Innovation in Campus Networks* (SIGCOMM CCR 2008). Bosshart et al.: *P4: Programming Protocol-Independent Packet Processors* (SIGCOMM CCR 2014).
- Floyd, Jacobson: *Random Early Detection Gateways for Congestion Avoidance* (IEEE/ACM ToN 1993); RFC 2309; RFC 3168 (ECN).
- Greenberg et al.: *A Clean Slate 4D Approach to Network Control and Management* (SIGCOMM CCR 2005).

**Applicable scope: network architecture, packet processing, OpenFlow, nftables, wire-tapping and forwarding policy.**

Status of these rules: they are review criteria. They are enforced by tests only where noted; the roadmap ([docs/ROADMAP.md](../../docs/ROADMAP.md)) lists which are checked programmatically.

---

## 1. Core philosophy: physical packet truth

Packets are physical energy on copper and glass, bounded by the speed of light, clock frequencies, finite table memory (TCAM/SRAM), memory bandwidth and serialization delay. A request that looks like one HTTP call at L7 is, on the wire:

1. **L1 physical and wire timing**:
   - Preamble (7 bytes) + Start Frame Delimiter (1 byte) + Inter-Frame Gap (12 bytes = 96 bit times).
   - Serialization latency: $t_{\text{serialize}} = \frac{8 \times (\text{payload} + \text{framing})}{\text{line rate}}$.
   - A 1518B Ethernet frame at 100 Mbps takes 121.44 µs + 0.96 µs IFG = 122.4 µs.
2. **L2 framing and switching fabric**:
   - 802.1Q VLAN tags (4 bytes with a 12-bit VID), MAC address tables (CAM), aging timers, broadcast containment.
   - Switch pipelines: ingress parser, CAM/TCAM lookup, queueing, egress deparser; cut-through versus store-and-forward jitter and head-of-line blocking.
3. **L3 forwarding and encapsulation**:
   - Longest-prefix match (trie or TCAM), TTL decrement, checksum recalculation.
   - Encapsulation overhead (WireGuard 60–80 bytes, VXLAN 50, Geneve 64) and path-MTU black holes mitigated by MSS clamping.
4. **L4 transport and congestion**:
   - TCP handshake state, window scaling, ACK clocking, congestion avoidance; AQM with ECN marking versus RED dropping.
5. **Data plane versus control plane**:
   - A hardware or kernel fast path decoupled from the software control daemon (slow path), with Control Plane Policing (CoPP) protecting the switch CPU from punted `OFPT_PACKET_IN` floods.
   - **On this project's switch the "fast path" is not hardware.** The Zodiac FX evaluates its flow table in software on a 120 MHz MCU: about 58 µs per packet plus 4.24 µs per rule (see the [whitepaper](../../docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)). Sub-microsecond figures below apply to kernel and ASIC paths, not to the Zodiac FX.

---

## 2. The 6 Inviolable Network Engineering Invariants

### Invariant NET-1: Strict data plane vs. control plane separation & CoPP

- **The Law**: Never perform deep packet inspection, synchronous RPCs, disk logging, or complex stateful processing on the transit packet forwarding pathway.
- **Data Plane (Fast Path)**: Executes in kernel space (`nftables` pre-routing hooks, XDP/eBPF) or physical switch ASIC hardware (OpenFlow 1.3 `FLOW_MOD` tables). Latency budget: **< 1 µs** for kernel/ASIC paths (the Zodiac FX MCU path is about 58 µs + 4.24 µs per rule).
- **Control Plane (Slow Path)**: Evaluates threat models, updates routing tables, logs telemetry, and synchronizes cloud ledgers out-of-band.
- **Control Plane Policing (CoPP)**: All traffic punted from the data plane to the control plane (e.g. `OFPT_PACKET_IN` events, ICMP unreachables, ARP requests, syslog streams) must be strictly rate-limited using Committed Access Rate (CAR) token-bucket limiters. Punted traffic must never starve the control daemon CPU or induce denial of service.

### Invariant NET-2: TCAM & FIB silicon budgeting & ternary bitmasking

- **The Law**: Ternary Content Addressable Memory (TCAM) and hardware forwarding tables are finite silicon budgets subject to range-expansion explosion.
- **Ternary Mechanics**: TCAM entries match `{0, 1, X}` (wildcard) bits in parallel in a single clock cycle. Non-prefix ranges (e.g. arbitrary TCP port ranges) expand exponentially into multiple TCAM rows.
- **Budget Limits**: On embedded switches (e.g. Zodiac FX with SAM4E8E MCU), the hardware table ceiling is strictly **128 flow entries**. On enterprise switches (Broadcom Tomahawk/Trident), TCAM holds between 10,000 and 1,000,000 rules.
- **Hierarchical Aggregation**: Do not install fine-grained `/32` host quarantine rules in hardware tables when a `/24` or `/16` CIDR supernet block can neutralize the collective threat. (Measured on the Zodiac FX: a `/16` rule costs the same per entry as a `/32`, so aggregation saves table slots, not lookup time.)
- **Fail-Safe Quotas & Compaction**: When hardware tables reach 80% capacity (102 rules on Zodiac FX), the system must trigger coarse supernet aggregation or push excess filtering back to the host kernel (`nftables`), never allow silent rule-drop or switch driver panics.

### Invariant NET-3: End-to-end principle & fate-sharing

- **The Law**: The intermediate network must maintain only soft state. If an external monitoring agent, telemetry ledger, or cloud relay crashes, the underlying packet transport must continue forwarding clean traffic uninterrupted.
- **Fate-Separation**:
  - Web server origin traffic and sister-site communication must not share fate with any sidecar agent (for example the frozen Sentinel module).
  - If the agent crashes or encounters an OOM exception, kernel `nftables` rules persist until their monotonic TTL expires, and new clean traffic flows through unaffected (fail-open for clean traffic).
  - Telemetry ingestion must be strictly asynchronous (`inotify` log observation or port-mirror taps). Never inject in-line blocking HTTP middleware into the origin server's request-response lifecycle.

### Invariant NET-4: Loop-free forwarding & flap damping

- **The Law**: Forwarding updates must not create loops, and dynamic rule insertion must converge without flapping.
- **What "loop-free" means here**: a static flow table has no routing loops to prove; the checkable properties are that no rule outputs to its own ingress port (hairpin), that no flood path re-enters the same L2 domain, and that quarantine and allow rules do not conflict. A cycle check over hand-built hop lists is not evidence of any of these.
- **Verification before install**: the rule set passes the property checks in the roadmap's track A (isolation, hairpin, shadowing, conflicts, table budget) before any `FLOW_MOD` is sent.
- **Hysteresis damping**: dynamic ACL additions use exponential backoff. Rapid oscillation between banning and unbanning an IP/subnet consumes CPU and table write cycles; repeat offenders escalate to higher TTL tiers ($300\text{s} \rightarrow 900\text{s} \rightarrow 3600\text{s}$).

### Invariant NET-5: Silicon buffer dynamics, anti-bufferbloat & AQM

- **The Law**: Drop unwanted packets as early as possible in the protocol stack before allocating kernel memory or socket buffers.
- **Pre-Routing Drop**: Drops must occur in the netfilter `PREROUTING` hook via `nftables` interval sets or in switch hardware via OpenFlow. Dropping packets at L7 (in Apache/Node after TCP handshake and TLS termination) wastes CPU cycles, socket handles, and connection tables.
- **Bufferbloat Prevention**: In traffic-shaping scenarios (e.g. sister-site bursts), use token-bucket rate meters rather than abrupt tail-drop to prevent TCP global synchronization and preserve end-to-end ACK clocking. Mark with ECN before dropping where supported.

### Invariant NET-6: Encapsulation overhead & MTU/MSS integrity

- **The Law**: Maintain strict boundary separation between Layer 2 broadcast domains and Layer 3 routed interfaces; eliminate packet fragmentation black holes.
- **VLAN Isolation**: Untrusted workloads, mirror taps, management interfaces, and OpenFlow control channels must reside on dedicated 802.1Q VLANs or isolated physical interfaces.
- **Byte-Exact MTU/MSS Clamping**: Ensure standard 1500-byte Ethernet MTU is preserved without unhandled fragmentation. When tunneling (VXLAN, Geneve, Tailscale WireGuard), enforce TCP Maximum Segment Size (MSS) clamping to prevent path MTU discovery (PMTUD) black holes:
  - Standard Ethernet MTU: $1500\text{ bytes}$
  - Native TCP MSS: $1500 - 20\text{ (IPv4)} - 20\text{ (TCP)} = 1460\text{ bytes}$
  - WireGuard / Tailscale Overlay MTU: $1420\text{ bytes} \implies \text{TCP MSS Clamped to } 1380\text{ bytes}$
  - VXLAN Overlay MTU: $1450\text{ bytes} \implies \text{TCP MSS Clamped to } 1410\text{ bytes}$

---

## 3. Wire Timing, Framing & Physical Layer Forensics

```text
Ethernet Frame Structure (IEEE 802.3 / RFC 894 with 802.1Q):
┌──────────┬─────┬───────────┬───────────┬─────────┬───────────┬──────────────┬─────────┬─────┐
│ Preamble │ SFD │ Dest MAC  │ Src MAC   │ 802.1Q  │ EtherType │ Payload      │ FCS     │ IFG │
│ 7 Bytes  │ 1 B │ 6 Bytes   │ 6 Bytes   │ 4 Bytes │ 2 Bytes   │ 46–1500 B    │ 4 Bytes │ 12 B│
└──────────┴─────┴───────────┴───────────┴─────────┴───────────┴──────────────┴─────────┴─────┘
◄────────────────────────────── On-Wire Envelope: 84 to 1538 Bytes ───────────────────────────►
```

### Serialization & Wire Latency by Speed Tier

| Frame Type | Total Wire Bytes (incl. Preamble/IFG) | 100 Mbps (Fast Ethernet) | 1 Gbps (Gigabit Ethernet) | 10 Gbps (10GbE) |
| :--- | :--- | :--- | :--- | :--- |
| **Minimum Frame (64B payload/padding)** | **84 bytes** | **6.72 µs** | **0.672 µs** (672 ns) | **0.067 µs** (67.2 ns) |
| **Standard Frame (1500B MTU)** | **1538 bytes** | **123.04 µs** | **12.304 µs** | **1.230 µs** |
| **Inter-Frame Gap (12 bytes)** | **12 bytes** | **0.96 µs** (960 ns) | **0.096 µs** (96 ns) | **0.0096 µs** (9.6 ns) |
| **Max Line-Rate PPS (64B frames)** | — | **148,809 pps** | **1,488,095 pps** | **14,880,952 pps** |

---

## 4. Protocol verification & forensics checklist

Before approving any networking pull request, configuration, or SDN daemon:

- [ ] **L2 Isolation & Storm Control**: Is traffic cleanly segmented by 802.1Q VLANs? Are ARP, broadcast, and unknown unicast floods contained?
- [ ] **Data/Control Plane Separation**: Is the forwarding path completely free of synchronous RPCs, disk writes, or event-loop stalls?
- [ ] **CoPP Enforcement**: Is traffic punted to the control CPU strictly rate-limited via token buckets?
- [ ] **Pre-Routing Placement**: Are dropped packets filtered in `PREROUTING` before socket instantiation?
- [ ] **TCAM Silicon Budget**: Does the rule count fit inside the hardware limit (128 rules on Zodiac FX)? Is prefix aggregation used?
- [ ] **Byte-Exact MSS Clamping**: Does any tunneling/encapsulation clamp TCP MSS to prevent PMTUD black holes?
- [ ] **Loop-Freedom & Convergence**: Does the rule set pass the hairpin and conflict checks? Is hysteresis damping applied to prevent rule flaps?
- [ ] **Break-Glass Purge**: Does the operator have an immediate, sub-second CLI command to purge bad firewall rules without restarting services?
- [ ] **Physical Telemetry Provenance**: Are port counters, drop statistics, and interface error registers verified against physical hardware reality?
