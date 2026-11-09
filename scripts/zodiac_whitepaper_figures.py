#!/usr/bin/env python3
"""
Pure-vector inline SVG figure generators for the Zodiac v3.0 Whitepaper.
Every diagram and chart is emitted as an inline <svg> element using embedded
GoogleSans / GoogleSansText / RobotoMono vector fonts — zero PNG rasterization,
ensuring infinite-zoom crispness in Chromium's PDF output.
"""
import math


def svg_figure_1_physical_topology() -> str:
    """
    Figure 1: Physical Rack, Switch Stack, VLAN Boundaries & Port-by-Port Wiring Breakdown.
    Extracted directly from .agents/network-context.md and physical bench verification.
    """
    return """
<svg viewBox="0 0 880 560" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <!-- Header Banner -->
  <rect x="0" y="0" width="880" height="34" fill="#f8f9fa" />
  <line x1="0" y1="34" x2="880" y2="34" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="22" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11.5" fill="#202124">ZODIAC PHYSICAL TESTBED TOPOLOGY — PORT-LEVEL WIRING, VLAN ISOLATION &amp; OBSERVATION VANTAGE POINTS</text>
  <text x="864" y="22" text-anchor="end" font-family="RobotoMono, monospace" font-size="9.5" fill="#5f6368">FW 0.86 · 3-Switch Stack</text>

  <!-- TOP TIER: Uplink Switch #2 (NETGEAR GS105Ev2, 192.168.0.240) -->
  <rect x="24" y="48" width="510" height="122" rx="5" fill="#f8f9fa" stroke="#1a73e8" stroke-width="1.5" />
  <rect x="24" y="48" width="510" height="24" rx="5" fill="#e8f0fe" />
  <text x="36" y="64" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#1967d2">TIER 3 (TOP OF STACK): NETGEAR GS105Ev2 #2 — Uplink &amp; O3 Mirror Switch (192.168.0.240)</text>

  <!-- VLAN boxes inside Switch #2 -->
  <rect x="36" y="80" width="172" height="78" rx="3" fill="#ffffff" stroke="#bdc1c6" stroke-width="1" />
  <text x="44" y="95" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#202124">802.1Q VLAN 1 (Lab LAN)</text>
  <text x="44" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#3c4043">P1: node-01 eth1 (10.0.0.56)</text>
  <text x="44" y="123" font-family="RobotoMono, monospace" font-size="8.5" fill="#3c4043">P2: node-02 eth1 (10.0.0.57)</text>
  <text x="44" y="136" font-family="RobotoMono, monospace" font-size="8.5" fill="#3c4043">P5: ISP Extender (10.0.0.1)</text>
  <text x="44" y="149" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Out-of-band management</text>

  <rect x="218" y="80" width="146" height="78" rx="3" fill="#ffffff" stroke="#1a73e8" stroke-width="1.2" />
  <text x="226" y="95" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#1967d2">802.1Q VLAN 2 (Uplink)</text>
  <text x="226" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">P4: Zodiac FX Port 2</text>
  <text x="226" y="124" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Hardware mirror source</text>
  <text x="226" y="137" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">(P4 Rx+Tx copied to P3)</text>
  <text x="226" y="150" font-family="RobotoMono, monospace" font-size="8" fill="#137333">802.3x Flow Ctrl: ON</text>

  <rect x="374" y="80" width="148" height="78" rx="3" fill="#fef7e0" stroke="#fbbc04" stroke-width="1.2" />
  <text x="382" y="95" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#b06000">802.1Q VLAN 3 (O3 Tap)</text>
  <text x="382" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">P3: Mirror Dest [O3]</text>
  <text x="382" y="124" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Isolated 1-port VLAN</text>
  <text x="382" y="137" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Blocks capture-NIC</text>
  <text x="382" y="150" font-family="GoogleSansText, sans-serif" font-size="8" fill="#b06000">frame injection (NET-006)</text>

  <!-- MIDDLE TIER (BOTTOM OF PHYSICAL SWITCH STACK): Zodiac FX DUT -->
  <rect x="24" y="206" width="510" height="136" rx="5" fill="#ffffff" stroke="#202124" stroke-width="2" />
  <rect x="24" y="206" width="510" height="26" rx="3" fill="#202124" />
  <text x="36" y="223" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#ffffff">DEVICE UNDER TEST (BOTTOM OF STACK): Northbound Networks Zodiac FX (FW 0.86)</text>
  <text x="36" y="246" font-family="GoogleSansText, sans-serif" font-size="9" fill="#3c4043">Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU · Micrel KSZ8795CLX 4×100BASE-TX · 128-Rule Software Flow Table · OpenFlow 1.3</text>

  <!-- 4 Ports of Zodiac FX -->
  <rect x="36" y="256" width="114" height="74" rx="3" fill="#fce8e6" stroke="#c5221f" stroke-width="1.2" />
  <text x="44" y="271" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#c5221f">Port 1 (Workload)</text>
  <text x="44" y="284" font-family="RobotoMono, monospace" font-size="8" fill="#202124">OpenFlow VLAN 100</text>
  <text x="44" y="297" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Untrusted ingress</text>
  <text x="44" y="310" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">from Switch #1 P5</text>
  <text x="44" y="322" font-family="RobotoMono, monospace" font-size="8" fill="#c5221f">6-Rule Policy (A1-A11)</text>

  <rect x="159" y="256" width="114" height="74" rx="3" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.2" />
  <text x="167" y="271" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#1967d2">Port 2 (Uplink)</text>
  <text x="167" y="284" font-family="RobotoMono, monospace" font-size="8" fill="#202124">OpenFlow VLAN 100</text>
  <text x="167" y="297" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Confinement boundary</text>
  <text x="167" y="310" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">to Switch #2 P4</text>
  <text x="167" y="322" font-family="RobotoMono, monospace" font-size="8" fill="#1967d2">ARP Peers: none (A10)</text>

  <rect x="282" y="256" width="114" height="74" rx="3" fill="#e6f4ea" stroke="#137333" stroke-width="1.2" />
  <text x="290" y="271" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#137333">Port 3 (Tap [O2])</text>
  <text x="290" y="284" font-family="RobotoMono, monospace" font-size="8" fill="#202124">OpenFlow VLAN 100</text>
  <text x="290" y="297" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Policy-derived copy</text>
  <text x="290" y="310" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">to Jetson USB NIC #1</text>
  <text x="290" y="322" font-family="RobotoMono, monospace" font-size="8" fill="#137333">p3-tap-return -&gt; P1</text>

  <rect x="405" y="256" width="117" height="74" rx="3" fill="#f1f3f4" stroke="#5f6368" stroke-width="1.2" />
  <text x="413" y="271" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#202124">Port 4 (Control)</text>
  <text x="413" y="284" font-family="RobotoMono, monospace" font-size="8" fill="#202124">Native VLAN 200</text>
  <text x="413" y="297" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">IP: 10.0.1.99/24</text>
  <text x="413" y="310" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">TCP :6633 OpenFlow</text>
  <text x="413" y="322" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">+ USB CDC Serial</text>

  <!-- BOTTOM TIER (MIDDLE OF PHYSICAL SWITCH STACK): Workload Switch #1 (NETGEAR GS105Ev2, 192.168.0.239) -->
  <rect x="24" y="378" width="510" height="162" rx="5" fill="#f8f9fa" stroke="#137333" stroke-width="1.5" />
  <rect x="24" y="378" width="510" height="24" rx="5" fill="#e6f4ea" />
  <text x="36" y="394" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#137333">TIER 2 (MIDDLE OF STACK): NETGEAR GS105Ev2 #1 — Workload &amp; O1 Mirror Switch (192.168.0.239)</text>

  <rect x="36" y="410" width="328" height="118" rx="3" fill="#ffffff" stroke="#bdc1c6" stroke-width="1" />
  <text x="44" y="425" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#202124">802.1Q VLAN 1 — Untrusted Workload Segment (10.0.2.0/24)</text>
  <text x="44" y="441" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">P5 (100M): Uplink to Zodiac FX Port 1 (Mirrored Rx+Tx to P2)</text>
  <text x="44" y="456" font-family="RobotoMono, monospace" font-size="8.5" fill="#3c4043">P1 (1G):   agentic-node-02 (RPi 3B+, 10.0.2.52) — Legitimate Workload</text>
  <text x="44" y="471" font-family="RobotoMono, monospace" font-size="8.5" fill="#c5221f">P3 (1G):   agentic-node-01 (RPi 3B+, 10.0.2.50) — Hardware Adversary</text>
  <text x="44" y="486" font-family="RobotoMono, monospace" font-size="8.5" fill="#3c4043">P4 (1G):   rpi-hailo eth0  (RPi 5 + Hailo-8 26T, 10.0.2.51)</text>
  <text x="44" y="502" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Host hygiene: wlan0 DOWN during runs; arp_filter=1 persisted on both RPi 3B+ nodes</text>
  <text x="44" y="516" font-family="RobotoMono, monospace" font-size="8" fill="#137333">802.3x Flow Control + 95 Mbit/s fq pacing prevent 1G-&gt;100M buffer drops</text>

  <rect x="374" y="410" width="148" height="118" rx="3" fill="#fef7e0" stroke="#fbbc04" stroke-width="1.2" />
  <text x="382" y="425" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#b06000">802.1Q VLAN 2 (O1 Tap)</text>
  <text x="382" y="441" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">P2: Mirror Dest [O1]</text>
  <text x="382" y="456" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Pre-DUT ground truth:</text>
  <text x="382" y="469" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">captures every frame</text>
  <text x="382" y="482" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">entering/leaving P5</text>
  <text x="382" y="497" font-family="RobotoMono, monospace" font-size="8" fill="#b06000">-&gt; rpi-hailo USB-GbE</text>
  <text x="382" y="511" font-family="RobotoMono, monospace" font-size="8" fill="#b06000">(eth1, clsact drop)</text>

  <!-- RIGHT COLUMN: Jetson Orin Nano Super (Controller & Observer) + Workload/Sensor Nodes -->
  <rect x="564" y="48" width="292" height="294" rx="5" fill="#f8f9fa" stroke="#202124" stroke-width="1.8" />
  <rect x="564" y="48" width="292" height="26" rx="4" fill="#1a73e8" />
  <text x="576" y="65" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#ffffff">NVIDIA Jetson Orin Nano Super (ROBOCO)</text>
  <text x="576" y="87" font-family="GoogleSansText, sans-serif" font-size="9" fill="#3c4043">SDN Controller, Verifier, Approval Gate &amp; Wire Observer</text>
  <text x="576" y="100" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">6-Core Arm Cortex-A78AE · 1024-Core Ampere GPU · 8GB</text>

  <!-- 3 Wired NICs on Jetson -->
  <rect x="576" y="110" width="268" height="52" rx="3" fill="#fef7e0" stroke="#fbbc04" stroke-width="1.2" />
  <text x="584" y="125" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#b06000">1. USB 3.0 GbE NIC #3 (enx9c69d39ddcc0) — [O3]</text>
  <text x="584" y="138" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Independent Egress Ground Truth (from Switch #2 P3)</text>
  <text x="584" y="151" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">promisc, -gro/-lro/-tso, root blackhole qdisc (no TX)</text>

  <rect x="576" y="170" width="268" height="52" rx="3" fill="#e6f4ea" stroke="#137333" stroke-width="1.2" />
  <text x="584" y="185" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#137333">2. USB 3.0 GbE NIC #1 (enx9c69d39dd0a6) — [O2]</text>
  <text x="584" y="198" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Policy-Derived Mirror Tap (from Zodiac FX Port 3)</text>
  <text x="584" y="211" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">Feeds GPU Anomaly Sentinel (scripts/gpu-sdn-anomaly-sentinel.py)</text>

  <rect x="576" y="230" width="268" height="52" rx="3" fill="#ffffff" stroke="#5f6368" stroke-width="1.2" />
  <text x="584" y="245" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#202124">3. Onboard GbE NIC (enP8p1s0, 10.0.1.8/24)</text>
  <text x="584" y="258" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Dedicated OpenFlow 1.3 Control Channel (:6633)</text>
  <text x="584" y="271" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">+ USB CDC ACM (/dev/ttyACM0) hardware register stream</text>

  <rect x="576" y="290" width="268" height="42" rx="3" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1" />
  <text x="584" y="305" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#1967d2">zodiac-bridge.service (:3003) &amp; br-sim (:6634)</text>
  <text x="584" y="319" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">Install Gate (A1-A11) · A8=6000 pps · A3 Auto-Repair=ON</text>

  <!-- RIGHT BOTTOM: Workload & Sensor Nodes Box -->
  <rect x="564" y="378" width="292" height="162" rx="5" fill="#f8f9fa" stroke="#3c4043" stroke-width="1.5" />
  <rect x="564" y="378" width="292" height="24" rx="4" fill="#3c4043" />
  <text x="576" y="394" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#ffffff">Raspberry Pi Workload &amp; Sensor Nodes</text>

  <text x="576" y="418" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#b06000">• rpi-hailo (RPi 5 8GB + Hailo-8 26 TOPS NPU)</text>
  <text x="586" y="431" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">eth0: 10.0.2.51 (Switch #1 P4) · PCIe Gen3 HailoRT 4.20</text>
  <text x="586" y="443" font-family="RobotoMono, monospace" font-size="8" fill="#b06000">eth1: RTL8153 USB-GbE on Switch #1 P2 -&gt; [O1] Pre-DUT</text>

  <text x="576" y="465" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#c5221f">• agentic-node-01 (RPi 3B+ — Red-Team Adversary)</text>
  <text x="586" y="478" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">eth0: 10.0.2.50 (Switch #1 P3) · Spoof/Scan/Flood/Evade</text>

  <text x="576" y="500" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#137333">• agentic-node-02 (RPi 3B+ — Legitimate Client)</text>
  <text x="586" y="513" font-family="RobotoMono, monospace" font-size="8" fill="#3c4043">eth0: 10.0.2.52 (Switch #1 P1) · Conformance Sender</text>
  <text x="586" y="527" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">LLM Proposers (Qwen3.8 27B, Gemma 4 26B) run off-path on Mac</text>

  <!-- Vertical & Horizontal Inter-Tier Cable Links -->
  <!-- Switch #2 P4 <-> Zodiac P2 -->
  <line x1="250" y1="158" x2="250" y2="206" stroke="#1a73e8" stroke-width="2.2" />
  <line x1="250" y1="232" x2="250" y2="256" stroke="#1a73e8" stroke-width="2.2" />
  <rect x="202" y="177" width="96" height="16" rx="2" fill="#e8f0fe" stroke="#1a73e8" stroke-width="0.8" />
  <text x="250" y="188" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#1967d2">P4 &lt;--&gt; P2 (100M)</text>

  <!-- Zodiac P1 <-> Switch #1 P5 -->
  <line x1="93" y1="330" x2="93" y2="378" stroke="#c5221f" stroke-width="2.2" />
  <line x1="93" y1="402" x2="93" y2="410" stroke="#c5221f" stroke-width="2.2" />
  <rect x="45" y="350" width="96" height="16" rx="2" fill="#fce8e6" stroke="#c5221f" stroke-width="0.8" />
  <text x="93" y="361" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#c5221f">P1 &lt;--&gt; P5 (100M)</text>

  <!-- Switch #2 P3 -> Jetson O3 -->
  <line x1="522" y1="136" x2="576" y2="136" stroke="#fbbc04" stroke-width="2" stroke-dasharray="4 2" />
  <polygon points="576,136 569,132 569,140" fill="#b06000" />

  <!-- Zodiac P3 -> Jetson O2 -->
  <line x1="396" y1="292" x2="550" y2="292" stroke="#137333" stroke-width="1.8" stroke-dasharray="4 2" />
  <line x1="550" y1="292" x2="550" y2="196" stroke="#137333" stroke-width="1.8" stroke-dasharray="4 2" />
  <line x1="550" y1="196" x2="576" y2="196" stroke="#137333" stroke-width="1.8" stroke-dasharray="4 2" />
  <polygon points="576,196 569,192 569,200" fill="#137333" />

  <!-- Zodiac P4 <-> Jetson enP8p1s0 -->
  <line x1="522" y1="256" x2="576" y2="256" stroke="#5f6368" stroke-width="2" />

  <!-- Switch #1 P2 -> rpi-hailo O1 -->
  <line x1="522" y1="440" x2="564" y2="440" stroke="#fbbc04" stroke-width="2" stroke-dasharray="4 2" />
  <polygon points="564,440 557,436 557,444" fill="#b06000" />
</svg>
"""


def svg_figure_2_verifier_pipeline() -> str:
    """
    Figure 2: End-to-End Verifier-in-the-Loop & On-Wire Conformance Pipeline.
    """
    return """
<svg viewBox="0 0 880 244" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">VERIFIER-IN-THE-LOOP POLICY SYNTHESIS, HUMAN APPROVAL GATE &amp; THREE-VANTAGE-POINT WIRE CONFORMANCE</text>

  <!-- Stage 1: Proposer -->
  <rect x="18" y="46" width="124" height="120" rx="4" fill="#f8f9fa" stroke="#5f6368" stroke-width="1.4" />
  <text x="80" y="66" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10.5" fill="#202124">1. Proposer</text>
  <text x="80" y="82" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Human or LLM Agent</text>
  <text x="80" y="96" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-weight="700" font-size="8" fill="#1967d2">Local / A100 / Cloud API</text>
  <text x="80" y="111" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Synthesizes JSON</text>
  <text x="80" y="123" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">flow rules for</text>
  <text x="80" y="136" text-anchor="middle" font-family="RobotoMono, monospace" font-size="7.8" fill="#3c4043">INTENT-1..8</text>
  <text x="80" y="152" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="7.5" fill="#5f6368">(Off-path from switch)</text>

  <!-- Arrow 1 -> 2 -->
  <line x1="142" y1="106" x2="164" y2="106" stroke="#1a73e8" stroke-width="2" />
  <polygon points="164,106 157,102 157,110" fill="#1a73e8" />

  <!-- Stage 2: Deterministic Verifier -->
  <rect x="164" y="46" width="166" height="120" rx="4" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.8" />
  <text x="247" y="66" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10.5" fill="#1967d2">2. Deterministic Verifier</text>
  <text x="247" y="81" text-anchor="middle" font-family="RobotoMono, monospace" font-size="7.8" fill="#202124">admitInstall() · &lt; 5 ms</text>
  <text x="247" y="95" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A1 Isolation &amp; A2 No Hairpin</text>
  <text x="247" y="107" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A3 Prio-0 Guard · A4 Precedence</text>
  <text x="247" y="119" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A5/A6 Hygiene · A7 128-Rule Cap</text>
  <text x="247" y="131" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A8 Hardware Cost (6,000 pps)</text>
  <text x="247" y="143" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A10 ARP SPA · A11 Exact Intent</text>
  <text x="247" y="157" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-weight="700" font-size="7.8" fill="#137333">196/196 mutants caught</text>

  <!-- Feedback Loop (Protocol B) from Stage 2 bottom-right back to Stage 1 bottom-left -->
  <path d="M 292 166 L 292 210 L 54 210 L 54 166" fill="none" stroke="#c5221f" stroke-width="1.6" stroke-dasharray="4 2" />
  <polygon points="54,166 50,173 58,173" fill="#c5221f" />
  <rect x="70" y="198" width="206" height="22" rx="3" fill="#fce8e6" stroke="#c5221f" stroke-width="1" />
  <text x="173" y="212" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.2" fill="#c5221f">Protocol B (&lt;= 5 turns): Reject Property + Rule IDs</text>

  <!-- Arrow 2 -> 3 -->
  <line x1="330" y1="106" x2="352" y2="106" stroke="#137333" stroke-width="2" />
  <polygon points="352,106 345,102 345,110" fill="#137333" />

  <!-- Stage 3: Human Gate / Envelope -->
  <rect x="352" y="46" width="122" height="120" rx="4" fill="#ffffff" stroke="#137333" stroke-width="1.5" />
  <text x="413" y="66" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10.5" fill="#137333">3. Approval Gate</text>
  <text x="413" y="82" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Explicit Human Sign-Off</text>
  <text x="413" y="96" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Policy never self-installs.</text>
  <text x="413" y="112" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Containment bounded</text>
  <text x="413" y="124" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">by pre-approved</text>
  <text x="413" y="137" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8" fill="#137333">Quarantine Envelope</text>
  <text x="413" y="152" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="7.5" fill="#5f6368">(k &lt;= 8, TTL &lt;= 300s)</text>

  <!-- Arrow 3 -> 4 -->
  <line x1="474" y1="106" x2="496" y2="106" stroke="#202124" stroke-width="2" />
  <polygon points="496,106 489,102 489,110" fill="#202124" />

  <!-- Stage 4: OpenFlow Actuation & Action Readback -->
  <rect x="496" y="46" width="166" height="120" rx="4" fill="#f8f9fa" stroke="#202124" stroke-width="1.6" />
  <text x="579" y="66" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10.5" fill="#202124">4. Actuate &amp; Readback</text>
  <text x="579" y="81" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-weight="700" font-size="8" fill="#1967d2">Zodiac FX (OpenFlow 1.3)</text>
  <text x="579" y="96" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• Installs rules + Prio-0 DROP</text>
  <text x="579" y="109" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• Parses OFPIT_APPLY_ACTIONS</text>
  <text x="579" y="122" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• 60s damped re-check loop</text>
  <text x="579" y="135" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• A3 Auto-Repair (3 bad → resend)</text>
  <text x="579" y="152" text-anchor="middle" font-family="RobotoMono, monospace" font-size="7.5" fill="#137333">provenForwarding: true</text>

  <!-- Arrow 4 -> 5 -->
  <line x1="662" y1="106" x2="684" y2="106" stroke="#b06000" stroke-width="2" />
  <polygon points="684,106 677,102 677,110" fill="#b06000" />

  <!-- Stage 5: Wire Conformance & Red Team -->
  <rect x="684" y="46" width="178" height="120" rx="4" fill="#fef7e0" stroke="#fbbc04" stroke-width="1.6" />
  <text x="773" y="66" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10.5" fill="#b06000">5. Wire Ground Truth</text>
  <text x="773" y="81" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-weight="700" font-size="8" fill="#202124">Mirrors O1, O2 &amp; O3</text>
  <text x="773" y="96" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• 128 rule sets, 611 flow checks</text>
  <text x="773" y="109" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• 100% agreement (Finding F1)</text>
  <text x="773" y="122" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• Track C Red Team (Scenarios 1–7)</text>
  <text x="773" y="135" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">• SHA-256 provenance sidecars</text>
  <text x="773" y="152" text-anchor="middle" font-family="RobotoMono, monospace" font-size="7.5" fill="#b06000">origin: physical_capture</text>
</svg>
"""


def svg_figure_3_capacity_ladder() -> str:
    """
    Figure 3: Pure-vector SVG bar chart of 600-byte UDP capacity vs. rule depth
    (Base layout 4.24 us/rule vs. Forwarding-First layout 1.30 us/rule).
    Values from docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md.
    """
    rules = [0, 16, 32, 64, 126]
    base_vals = [(17800, True), (8055, False), (5272, False), (3091, False), (1711, False)]
    fwd_vals = [(17241, True), (12693, False), (10000, False), (7078, False), (4497, False)]

    # Chart area: x=78..840, y=54..254 (height=200 for 0..20000 pps -> 0.01 px/pps)
    x0, y0, w, h = 78, 254, 762, 200
    max_y = 20000

    def y_px(val: int) -> float:
        return y0 - (val / max_y) * h

    bars_svg = []
    # Grid lines
    for tick in [0, 5000, 10000, 15000, 20000]:
        yy = y_px(tick)
        bars_svg.append(f'<line x1="{x0}" y1="{yy:.1f}" x2="{x0+w}" y2="{yy:.1f}" stroke="#e8eaed" stroke-width="1" />')
        bars_svg.append(
            f'<text x="{x0-8}" y="{yy+3.5:.1f}" text-anchor="end" font-family="RobotoMono, monospace" font-size="8.5" fill="#5f6368">{tick:,}</text>'
        )

    group_step = w / len(rules)
    bar_w = 42

    for i, r in enumerate(rules):
        cx = x0 + (i + 0.5) * group_step
        # Base bar
        b_val, b_mod = base_vals[i]
        by = y_px(b_val)
        bh = y0 - by
        bx = cx - bar_w - 3
        if b_mod:
            bars_svg.append(
                f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w}" height="{bh:.1f}" fill="url(#hatchBlue)" stroke="#1a73e8" stroke-width="1.5" />'
            )
        else:
            bars_svg.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w}" height="{bh:.1f}" fill="#1a73e8" />')
        bars_svg.append(
            f'<text x="{bx + bar_w/2:.1f}" y="{by - 5:.1f}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#1967d2">{b_val:,}{"*" if b_mod else ""}</text>'
        )

        # Fwd-first bar
        f_val, f_mod = fwd_vals[i]
        fy = y_px(f_val)
        fh = y0 - fy
        fx = cx + 3
        if f_mod:
            bars_svg.append(
                f'<rect x="{fx:.1f}" y="{fy:.1f}" width="{bar_w}" height="{fh:.1f}" fill="url(#hatchOrange)" stroke="#e66100" stroke-width="1.5" />'
            )
        else:
            bars_svg.append(f'<rect x="{fx:.1f}" y="{fy:.1f}" width="{bar_w}" height="{fh:.1f}" fill="#e66100" />')
        bars_svg.append(
            f'<text x="{fx + bar_w/2:.1f}" y="{fy - 5:.1f}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#b06000">{f_val:,}{"*" if f_mod else ""}</text>'
        )

        # X label
        bars_svg.append(
            f'<text x="{cx:.1f}" y="{y0 + 16}" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#202124">N = {r} rules</text>'
        )
        if i > 0:
            ratio_str = f"{f_val / b_val:.2f}x"
            bars_svg.append(
                f'<text x="{cx:.1f}" y="{y0 + 28}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#137333">({ratio_str} capacity)</text>'
            )
        else:
            bars_svg.append(
                f'<text x="{cx:.1f}" y="{y0 + 28}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#5f6368">(empty table*)</text>'
            )

    return f"""
<svg viewBox="0 0 880 302" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <defs>
    <pattern id="hatchBlue" width="6" height="6" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#e8f0fe" />
      <line x1="0" y1="0" x2="0" y2="6" stroke="#1a73e8" stroke-width="2" />
    </pattern>
    <pattern id="hatchOrange" width="6" height="6" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#fef7e0" />
      <line x1="0" y1="0" x2="0" y2="6" stroke="#e66100" stroke-width="2" />
    </pattern>
  </defs>
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">600-BYTE UDP CAPACITY VS. RULE DEPTH — BASE LAYOUT (4.24 µs/rule) VS. FORWARDING-FIRST (1.30 µs/rule)</text>

  <!-- Legend -->
  <rect x="440" y="37" width="11" height="11" fill="#1a73e8" />
  <text x="456" y="46" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Quarantine-First Base Layout (4.24 µs/rule)</text>
  <rect x="652" y="37" width="11" height="11" fill="#e66100" />
  <text x="668" y="46" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#202124">Forwarding-First Layout (1.30 µs/rule; * = modelled)</text>

  {''.join(bars_svg)}

  <!-- Axes -->
  <line x1="{x0}" y1="54" x2="{x0}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <line x1="{x0}" y1="{y0}" x2="{x0+w}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <text x="20" y="154" transform="rotate(-90 20 154)" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#3c4043">Forwarded Throughput (packets / sec)</text>
</svg>
"""


def svg_figure_4_deployed_cost_and_a8() -> str:
    """
    Figure 4: Deployed 6-Rule Policy Capacity Ladder (k=0..8 quarantine DROPs at prio 65535)
    comparing pre-registered 4.24 us/rule prediction vs. measured 80.0 + 5.42k us slope,
    the 7,765 pps allow-rule floor (1..8 allow rules at k=8), and the 6,000 pps A8 target ceiling.
    """
    # k values: 0, 2, 4, 8
    ks = [0, 2, 4, 8]
    # Measured rounds (2026-10-20 & 2026-10-31):
    # k=0: 12,500 / 12,698 pps (model: 12,500)
    # k=2: 10,950 pps (model: 11,008)
    # k=4: 9,800 pps (model: 9,834)
    # k=8: 8,100 pps (model: 8,106)
    measured = [12599, 10950, 9800, 8100]
    fitted = [12500, 11008, 9834, 8106]

    x0, y0, w, h = 78, 238, 460, 176
    max_y = 15000

    def x_px(k: int) -> float:
        return x0 + (k / 8.0) * (w - 64) + 34

    def y_px(val: int) -> float:
        return y0 - (val / max_y) * h

    els = []
    for tick in [0, 3000, 6000, 9000, 12000, 15000]:
        yy = y_px(tick)
        els.append(f'<line x1="{x0}" y1="{yy:.1f}" x2="{x0+w}" y2="{yy:.1f}" stroke="#e8eaed" stroke-width="1" />')
        els.append(
            f'<text x="{x0-8}" y="{yy+3.5:.1f}" text-anchor="end" font-family="RobotoMono, monospace" font-size="8.5" fill="#5f6368">{tick:,}</text>'
        )

    # 6,000 pps A8 declared ceiling line (label placed cleanly below dashed line)
    y_a8 = y_px(6000)
    els.append(f'<line x1="{x0}" y1="{y_a8:.1f}" x2="{x0+w}" y2="{y_a8:.1f}" stroke="#137333" stroke-width="1.8" stroke-dasharray="5 3" />')
    els.append(
        f'<text x="{x0+12}" y="{y_a8+13:.1f}" font-family="RobotoMono, monospace" font-size="7.8" fill="#137333">A8 Live Target Ceiling = 6,000 pps (74% of k=8 capacity)</text>'
    )

    # 7,765 pps allow-rule floor at k=8 (label placed cleanly above dashed line)
    y_floor = y_px(7765)
    els.append(f'<line x1="{x_px(4):.1f}" y1="{y_floor:.1f}" x2="{x0+w}" y2="{y_floor:.1f}" stroke="#b06000" stroke-width="1.4" stroke-dasharray="3 2" />')
    els.append(
        f'<text x="{x0+w-6}" y="{y_floor-5:.1f}" text-anchor="end" font-family="RobotoMono, monospace" font-size="7.8" fill="#b06000">Allow-Rule Floor (1..8 rules @ k=8) &gt;= 7,765 pps</text>'
    )

    # Fitted line
    pts = " ".join(f"{x_px(k):.1f},{y_px(v):.1f}" for k, v in zip(ks, fitted))
    els.append(f'<polyline points="{pts}" fill="none" stroke="#1a73e8" stroke-width="2.2" />')

    # Measured points
    for k, m_val, f_val in zip(ks, measured, fitted):
        xx = x_px(k)
        yy = y_px(m_val)
        els.append(f'<circle cx="{xx:.1f}" cy="{yy:.1f}" r="4.5" fill="#c5221f" stroke="#ffffff" stroke-width="1.2" />')
        els.append(
            f'<text x="{xx:.1f}" y="{yy-9:.1f}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="8" fill="#202124">{m_val:,} pps</text>'
        )
        els.append(
            f'<text x="{xx:.1f}" y="{y0+16}" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#202124">k = {k}</text>'
        )

    return f"""
<svg viewBox="0 0 880 274" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">DEPLOYED 6-RULE POLICY CAPACITY VS. QUARANTINE DEPTH (k = 0..8) &amp; A8 ADMISSIBILITY BOUNDARIES</text>

  {''.join(els)}

  <!-- Axes -->
  <line x1="{x0}" y1="54" x2="{x0}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <line x1="{x0}" y1="{y0}" x2="{x0+w}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <text x="20" y="146" transform="rotate(-90 20 146)" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#3c4043">Capacity at 572 B Payload (pps)</text>
  <text x="{x0 + w/2:.1f}" y="266" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#3c4043">Active Priority-65535 Quarantine DROP Rules (k)</text>

  <!-- Right-side Explanatory Summary Panel -->
  <rect x="558" y="48" width="302" height="206" rx="4" fill="#f8f9fa" stroke="#dadce0" stroke-width="1.2" />
  <text x="570" y="68" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#202124">Deployed-Table Cost Model (src/sdn/deployed-cost-model.ts)</text>
  <text x="570" y="86" font-family="RobotoMono, monospace" font-size="9" fill="#1967d2">t_pkt = 80.0 us + 5.42 us * k   (k = 0..8, 572 B)</text>
  <text x="570" y="104" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">• Pre-registered prediction (4.24 µs/rule) was falsified:</text>
  <text x="578" y="117" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">the 6-rule policy adds +28% per-quarantine overhead.</text>
  <text x="570" y="133" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">• At k=8 quarantines, capacity is 8,106 pps (36% below</text>
  <text x="578" y="146" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">k=0); at k=32 it would drop to ~3,940 pps (hence k≤8).</text>
  <text x="570" y="162" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">• Allow-rule floor (2026-11-01, 4 hardware runs): adding</text>
  <text x="578" y="175" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">1..8 prio-120 P3→P1 allow rules at k=8 held ≥ 7,765 pps.</text>
  <text x="570" y="191" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#c5221f">• Overload cliff (Scenario 4): 25,000 pps (2x capacity)</text>
  <text x="578" y="204" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#c5221f">drops OpenFlow TCP &amp; wipes table; recovers in ≤ 4–6 s.</text>
  <circle cx="576" cy="224" r="4" fill="#c5221f" />
  <text x="586" y="227" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Measured Saturation</text>
  <line x1="680" y1="224" x2="704" y2="224" stroke="#1a73e8" stroke-width="2.2" />
  <text x="710" y="227" font-family="GoogleSansText, sans-serif" font-size="8" fill="#3c4043">Fitted Model (±1.3%)</text>
</svg>
"""


def svg_figure_5_agent_eval_chart() -> str:
    """
    Figure 5: Pure-vector SVG chart comparing zero-shot (Protocol A) vs. verifier feedback (Protocol B),
    and LoRA adaptation across models and intents from docs/research/models.md (commit 1e12cee).
    """
    groups = [
        (
            "Local & Cloud Zero-Shot (Protocol A)",
            [
                ("Gemma4 26B", 70, 200, "#80868b"),
                ("Qwen3.8 v2", 86, 200, "#5f6368"),
                ("Qwen3.8 v1", 113, 200, "#4285f4"),
                ("Haiku 5.5", 2303, 2400, "#1a73e8"),
            ],
        ),
        (
            "Verifier Feedback (Protocol B, <=5t)",
            [
                ("Gemma4 26B", 75, 80, "#137333"),
                ("Qwen3.8 v2", 79, 80, "#137333"),
                ("Qwen3.8 v1", 80, 80, "#137333"),
                ("Haiku 5.5", 400, 400, "#137333"),
            ],
        ),
        (
            "Rented A100 LoRA Adapters (0-Shot)",
            [
                ("C3 Ctrl (I1-4)", 174, 200, "#4285f4"),
                ("L3 15s (I1-4)", 176, 200, "#fbbc04"),
                ("L3 15s (I5-8)", 141, 200, "#ea8600"),
                ("L4 90s (6-Int)", 145, 300, "#c5221f"),
            ],
        ),
    ]

    x0, y0, w, h = 64, 232, 792, 168
    els = []
    for pct in [0, 25, 50, 75, 100]:
        yy = y0 - (pct / 100.0) * h
        els.append(f'<line x1="{x0}" y1="{yy:.1f}" x2="{x0+w}" y2="{yy:.1f}" stroke="#e8eaed" stroke-width="1" />')
        els.append(
            f'<text x="{x0-8}" y="{yy+3.5:.1f}" text-anchor="end" font-family="RobotoMono, monospace" font-size="8.5" fill="#5f6368">{pct}%</text>'
        )

    g_step = w / len(groups)
    bar_w = 46
    gap = 10

    for gi, (g_title, items) in enumerate(groups):
        gx_center = x0 + (gi + 0.5) * g_step
        total_bw = len(items) * bar_w + (len(items) - 1) * gap
        start_x = gx_center - total_bw / 2

        for bi, (label, num, den, color) in enumerate(items):
            pct = (num * 100.0) / den
            bx = start_x + bi * (bar_w + gap)
            by = y0 - (pct / 100.0) * h
            bh = y0 - by
            els.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w}" height="{bh:.1f}" rx="2" fill="{color}" />')
            els.append(
                f'<text x="{bx + bar_w/2:.1f}" y="{by - 12:.1f}" text-anchor="middle" font-family="RobotoMono, monospace" font-weight="700" font-size="7.8" fill="#202124">{num}/{den}</text>'
            )
            els.append(
                f'<text x="{bx + bar_w/2:.1f}" y="{by - 3:.1f}" text-anchor="middle" font-family="RobotoMono, monospace" font-size="7.2" fill="#5f6368">({pct:.1f}%)</text>'
            )
            els.append(
                f'<text x="{bx + bar_w/2:.1f}" y="{y0 + 13}" text-anchor="middle" font-family="GoogleSansText, sans-serif" font-size="7.5" fill="#3c4043">{label}</text>'
            )

        els.append(
            f'<text x="{gx_center:.1f}" y="{y0 + 30}" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#202124">{g_title}</text>'
        )

    return f"""
<svg viewBox="0 0 880 274" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">AGENT POLICY SYNTHESIS ADMISSIBILITY — ZERO-SHOT (PROTOCOL A) VS. VERIFIER FEEDBACK (PROTOCOL B) &amp; LoRA</text>

  {''.join(els)}

  <line x1="{x0}" y1="48" x2="{x0}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <line x1="{x0}" y1="{y0}" x2="{x0+w}" y2="{y0}" stroke="#202124" stroke-width="1.2" />
  <text x="18" y="140" transform="rotate(-90 18 140)" text-anchor="middle" font-family="GoogleSans, sans-serif" font-weight="500" font-size="9" fill="#3c4043">Verifier-Admissible Proposals (%)</text>
</svg>
"""


def svg_figure_6_conformance_funnel() -> str:
    """
    Figure 6: On-Wire Conformance Run Breakdown (RQ4) & Pre-Campaign Smoke Gate Validation Funnel.
    Visualizes the 128-rule-set matrix (611/611 flow checks) and the 4-stage smoke gate that caught
    the tcpdump -p non-promiscuous bug and discovered Finding F1 (switch-path drop of self-addressed IPv4 frames).
    """
    return """
<svg viewBox="0 0 880 320" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <!-- Header -->
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">PHYSICAL WIRE CONFORMANCE (RQ4) — 128-RULE-SET EXECUTION MATRIX &amp; SMOKE GATE VALIDATION FUNNEL</text>
  <text x="864" y="20" text-anchor="end" font-family="RobotoMono, monospace" font-size="9" fill="#137333">611 / 611 (100.0%) Agreed</text>

  <!-- LEFT PANEL: 128-Rule-Set Execution Matrix -->
  <g transform="translate(18, 44)">
    <rect x="0" y="0" width="456" height="260" rx="5" fill="#f8f9fa" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="456" height="26" rx="5" fill="#e8f0fe" />
    <text x="14" y="17" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#1967d2">PART A: 128-RULE-SET WIRE CONFORMANCE EXECUTION MATRIX</text>
    <text x="442" y="17" text-anchor="end" font-family="RobotoMono, monospace" font-size="8.5" fill="#137333">143 Set-Runs · 611 Checks</text>

    <!-- Table Header -->
    <rect x="10" y="34" width="436" height="20" fill="#ffffff" stroke="#dadce0" stroke-width="0.8" />
    <text x="16" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Rule-Set Category</text>
    <text x="180" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Sets</text>
    <text x="218" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Runs</text>
    <text x="256" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Flows</text>
    <text x="312" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Model Match (M1)</text>
    <text x="408" y="48" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#3c4043">Intent (M2)</text>

    <!-- Row 1: Model-Admissible -->
    <rect x="10" y="56" width="436" height="32" fill="#ffffff" stroke="#e8eaed" stroke-width="0.8" />
    <text x="16" y="71" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.8" fill="#202124">Model-Admissible</text>
    <text x="16" y="83" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">5 arms across 8 intents</text>
    <text x="180" y="76" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">56</text>
    <text x="218" y="76" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">56</text>
    <text x="256" y="76" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">224</text>
    <text x="312" y="76" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">224 / 224 (100%)</text>
    <text x="408" y="76" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">100.0%</text>

    <!-- Row 2: Surviving Mutants -->
    <rect x="10" y="90" width="436" height="32" fill="#ffffff" stroke="#e8eaed" stroke-width="0.8" />
    <text x="16" y="105" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.8" fill="#202124">Surviving Mutants</text>
    <text x="16" y="117" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">Distinct from reference</text>
    <text x="180" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">36</text>
    <text x="218" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">36</text>
    <text x="256" y="110" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">149</text>
    <text x="312" y="110" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">149 / 149 (100%)</text>
    <text x="408" y="110" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">100.0%</text>

    <!-- Row 3: Reference Baselines -->
    <rect x="10" y="124" width="436" height="32" fill="#ffffff" stroke="#e8eaed" stroke-width="0.8" />
    <text x="16" y="139" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.8" fill="#202124">Reference Baselines</text>
    <text x="16" y="151" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">8 canonical references</text>
    <text x="180" y="144" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">8</text>
    <text x="218" y="144" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">23</text>
    <text x="256" y="144" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">126</text>
    <text x="312" y="144" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">126 / 126 (100%)</text>
    <text x="408" y="144" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">100.0%</text>

    <!-- Row 4: Equivalence Controls -->
    <rect x="10" y="158" width="436" height="32" fill="#ffffff" stroke="#e8eaed" stroke-width="0.8" />
    <text x="16" y="173" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.8" fill="#202124">Equivalence Controls</text>
    <text x="16" y="185" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">Model + Mutant controls</text>
    <text x="180" y="178" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">28</text>
    <text x="218" y="178" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">28</text>
    <text x="256" y="178" font-family="RobotoMono, monospace" font-size="8.5" fill="#202124">112</text>
    <text x="312" y="178" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">112 / 112 (100%)</text>
    <text x="408" y="178" font-family="RobotoMono, monospace" font-weight="700" font-size="8.5" fill="#137333">100.0%</text>

    <!-- Total Row -->
    <rect x="10" y="192" width="436" height="26" fill="#e6f4ea" stroke="#ceead6" stroke-width="1" />
    <text x="16" y="209" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#137333">TOTAL CAMPAIGN</text>
    <text x="180" y="209" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#137333">128</text>
    <text x="218" y="209" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#137333">143</text>
    <text x="256" y="209" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#137333">611</text>
    <text x="312" y="209" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#137333">611 / 611 (99.4%–100%)</text>
    <text x="408" y="209" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#137333">100.0%</text>

    <text x="14" y="235" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">9 wire sessions: coverage-refs, smoke-refs, and 7 intent campaigns (51–120 flows each).</text>
    <text x="14" y="248" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#5f6368">Each set ran via guarded endpoint with isolation policy restored &amp; read back after each.</text>
  </g>

  <!-- RIGHT PANEL: Pre-Campaign Smoke Gate Validation Funnel -->
  <g transform="translate(488, 44)">
    <rect x="0" y="0" width="374" height="260" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="374" height="26" rx="5" fill="#fef7e0" />
    <text x="14" y="17" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#b06000">PART B: SMOKE GATE VALIDATION FUNNEL &amp; DISCOVERIES</text>

    <!-- Stage 1 -->
    <g transform="translate(14, 34)">
      <rect x="0" y="0" width="346" height="44" rx="4" fill="#fce8e6" stroke="#ea4335" stroke-width="1.2" />
      <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#c5221f">1. first-smoke (28 flows) &rarr; 11 / 28 Disagreements</text>
      <text x="10" y="28" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#3c4043">Root Cause 1: tcpdump -p on O2 tap NIC disabled promiscuous mode.</text>
      <text x="10" y="39" font-family="RobotoMono, monospace" font-weight="700" font-size="7.5" fill="#c5221f">Fix: Removed -p flag; verified promiscuous tap capture (-7 errors resolved).</text>
    </g>

    <!-- Arrow 1 -> 2 -->
    <line x1="187" y1="78" x2="187" y2="88" stroke="#5f6368" stroke-width="1.5" />
    <polygon points="187,90 184,84 190,84" fill="#5f6368" />

    <!-- Stage 2 -->
    <g transform="translate(14, 90)">
      <rect x="0" y="0" width="346" height="44" rx="4" fill="#fef7e0" stroke="#fbbc04" stroke-width="1.2" />
      <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#b06000">2. smoke-fixed-capture (28 fl) &rarr; 4 / 28 Disagreements</text>
      <text x="10" y="28" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#3c4043">Root Cause 2: All 4 remaining disagreements were identical flow type:</text>
      <text x="10" y="39" font-family="RobotoMono, monospace" font-weight="700" font-size="7.5" fill="#b06000">IPv4 frame with src === dst (self-addressed / Land attack shape).</text>
    </g>

    <!-- Arrow 2 -> 3 -->
    <line x1="187" y1="134" x2="187" y2="144" stroke="#5f6368" stroke-width="1.5" />
    <polygon points="187,146 184,140 190,140" fill="#5f6368" />

    <!-- Stage 3: Diagnostic -->
    <g transform="translate(14, 146)">
      <rect x="0" y="0" width="346" height="44" rx="4" fill="#f8f9fa" stroke="#1a73e8" stroke-width="1.2" />
      <text x="10" y="15" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9" fill="#1967d2">3. diagnostic-self-addressed &rarr; Finding F1 Discovered</text>
      <text x="10" y="27" font-family="GoogleSansText, sans-serif" font-size="7.8" fill="#3c4043">3 self-addressed frames: dropped by switch path (safe failure mode).</text>
      <text x="10" y="38" font-family="RobotoMono, monospace" font-size="7.5" fill="#1967d2">2 normal frames: forwarded. Excluded degenerate self-addressed flows.</text>
    </g>

    <!-- Arrow 3 -> 4 -->
    <line x1="187" y1="190" x2="187" y2="200" stroke="#5f6368" stroke-width="1.5" />
    <polygon points="187,202 184,196 190,196" fill="#5f6368" />

    <!-- Stage 4: Gate Passed -->
    <g transform="translate(14, 202)">
      <rect x="0" y="0" width="346" height="48" rx="4" fill="#e6f4ea" stroke="#137333" stroke-width="1.4" />
      <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#137333">4. smoke-final (28 flows) &rarr; 0 / 28 Disagreements (PASSED)</text>
      <text x="10" y="30" font-family="GoogleSansText, sans-serif" font-size="8" fill="#202124">Smoke gate fully satisfied; authorized unattended 143-run campaign.</text>
      <text x="10" y="42" font-family="RobotoMono, monospace" font-weight="700" font-size="8" fill="#137333">&rarr; Unlocked 611/611 (100.0%) physical conformance milestone.</text>
    </g>
  </g>
</svg>
"""


def svg_cover_artwork() -> str:
    """
    Cover Artwork: 3D isometric representation of the Zodiac physical testbed stack
    (Uplink Switch GS105Ev2 #2, Workload Switch GS105Ev2 #1, Zodiac FX OpenFlow 1.3 DUT)
    and adjacent SDN Controller (NVIDIA Jetson Orin Nano Super).
    Features RJ45 port cutouts, active link LEDs, dedicated OpenFlow 1.3 control cable,
    VLAN 1 ingress, filtered egress, and mirror tap conduits.
    Pure scalable SVG, zero Type 3 bitmap fonts.
    """
    cos30 = math.cos(math.radians(30))  # ~0.8660
    sin30 = math.sin(math.radians(30))  # 0.5

    def pt(cx, cy, x, y, z):
        px = cx + (x - y) * cos30
        py = cy - (x + y) * sin30 - z
        return round(px, 1), round(py, 1)

    def poly_pts(pts):
        return " ".join(f"{p[0]},{p[1]}" for p in pts)

    sw_w = 120  # front face length
    sw_d = 72   # side face depth
    sw_h = 22   # chassis height
    gap = 9     # gap between stacked switches (rubber feet)

    st_cx = 145
    st_cy = 280

    ctrl_cx = 288
    ctrl_cy = 245
    ctrl_w = 68
    ctrl_d = 62
    ctrl_h = 24

    svg = []
    svg.append('<svg viewBox="0 0 380 340" width="280pt" height="250pt" xmlns="http://www.w3.org/2000/svg" style="position:absolute;right:48pt;top:205pt;z-index:5;">')
    
    # Gradients & Filters
    svg.append("""  <defs>
    <!-- Metallic Netgear Slate-Blue Shading -->
    <linearGradient id="ngTop" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b4252" />
      <stop offset="50%" stop-color="#2e3440" />
      <stop offset="100%" stop-color="#252a34" />
    </linearGradient>
    <linearGradient id="ngFront" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1e222a" />
      <stop offset="100%" stop-color="#282c37" />
    </linearGradient>
    <linearGradient id="ngSide" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#16181f" />
      <stop offset="100%" stop-color="#0f1015" />
    </linearGradient>

    <!-- Zodiac FX Matte Charcoal Shading -->
    <linearGradient id="zfxTop" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2d3748" />
      <stop offset="50%" stop-color="#1a202c" />
      <stop offset="100%" stop-color="#171923" />
    </linearGradient>
    <linearGradient id="zfxFront" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#12141a" />
      <stop offset="100%" stop-color="#1a202c" />
    </linearGradient>
    <linearGradient id="zfxSide" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0d0e12" />
      <stop offset="100%" stop-color="#050608" />
    </linearGradient>

    <!-- Jetson Orin Industrial Shading -->
    <linearGradient id="jetTop" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4a5568" />
      <stop offset="100%" stop-color="#2d3748" />
    </linearGradient>
    <linearGradient id="jetFront" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1a202c" />
      <stop offset="100%" stop-color="#2d3748" />
    </linearGradient>
    <linearGradient id="jetSide" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#111318" />
      <stop offset="100%" stop-color="#0a0b0e" />
    </linearGradient>
  </defs>""")

    # Ambient Bench Shadow
    svg.append(f'  <ellipse cx="205" cy="298" rx="160" ry="32" fill="#000000" fill-opacity="0.05" />')
    svg.append(f'  <ellipse cx="145" cy="280" rx="95" ry="22" fill="#000000" fill-opacity="0.08" />')
    svg.append(f'  <ellipse cx="288" cy="245" rx="52" ry="16" fill="#000000" fill-opacity="0.07" />')

    # Bench Isometric Grid Lines
    svg.append('  <!-- Bench Grid -->')
    svg.append('  <g stroke="#dadce0" stroke-width="0.7" stroke-dasharray="2 3" opacity="0.6">')
    for y_off in range(-20, 100, 30):
        p1 = pt(st_cx, st_cy, -40, y_off, 0)
        p2 = pt(st_cx, st_cy, 220, y_off, 0)
        svg.append(f'    <line x1="{p1[0]}" y1="{p1[1]}" x2="{p2[0]}" y2="{p2[1]}" />')
    for x_off in range(-20, 220, 40):
        p1 = pt(st_cx, st_cy, x_off, -20, 0)
        p2 = pt(st_cx, st_cy, x_off, 100, 0)
        svg.append(f'    <line x1="{p1[0]}" y1="{p1[1]}" x2="{p2[0]}" y2="{p2[1]}" />')
    svg.append('  </g>')

    def draw_chassis(cx, cy, w, d, h, z_base, top_grad, front_grad, side_grad, border_col="#4b5563"):
        res = []
        b_c = pt(cx, cy, 0, 0, z_base)
        b_r = pt(cx, cy, w, 0, z_base)
        b_b = pt(cx, cy, w, d, z_base)
        b_l = pt(cx, cy, 0, d, z_base)
        t_c = pt(cx, cy, 0, 0, z_base + h)
        t_r = pt(cx, cy, w, 0, z_base + h)
        t_b = pt(cx, cy, w, d, z_base + h)
        t_l = pt(cx, cy, 0, d, z_base + h)

        side_pts = poly_pts([b_c, b_l, t_l, t_c])
        res.append(f'    <polygon points="{side_pts}" fill="url({side_grad})" stroke="{border_col}" stroke-width="0.6" />')

        front_pts = poly_pts([b_c, b_r, t_r, t_c])
        res.append(f'    <polygon points="{front_pts}" fill="url({front_grad})" stroke="{border_col}" stroke-width="0.6" />')

        top_pts = poly_pts([t_c, t_r, t_b, t_l])
        res.append(f'    <polygon points="{top_pts}" fill="url({top_grad})" stroke="{border_col}" stroke-width="0.8" />')

        return "\n".join(res)

    def draw_feet(cx, cy, w, d, z_base, foot_h):
        res = []
        coords = [(12, 10), (w - 18, 10), (12, d - 15), (w - 18, d - 15)]
        for fx, fy in coords:
            p_top = pt(cx, cy, fx, fy, z_base + foot_h)
            res.append(f'    <rect x="{p_top[0]-3}" y="{p_top[1]}" width="6" height="{foot_h}" rx="1" fill="#111827" />')
        return "\n".join(res)

    # 1. CONTROLLER: Jetson Orin Nano Super
    svg.append('  <!-- ==================== SDN CONTROLLER (JETSON ORIN NANO SUPER) ==================== -->')
    svg.append('  <g id="sdn-controller">')
    svg.append(draw_chassis(ctrl_cx, ctrl_cy, ctrl_w, ctrl_d, ctrl_h, 0, "#jetTop", "#jetFront", "#jetSide", "#374151"))

    for fin_i in range(5):
        fin_y = 10 + fin_i * 10
        p_l = pt(ctrl_cx, ctrl_cy, 8, fin_y, ctrl_h)
        p_r = pt(ctrl_cx, ctrl_cy, ctrl_w - 8, fin_y, ctrl_h)
        p_lt = pt(ctrl_cx, ctrl_cy, 8, fin_y, ctrl_h + 5)
        p_rt = pt(ctrl_cx, ctrl_cy, ctrl_w - 8, fin_y, ctrl_h + 5)
        fin_poly = poly_pts([p_l, p_r, p_rt, p_lt])
        svg.append(f'    <polygon points="{fin_poly}" fill="#1f2937" stroke="#4b5563" stroke-width="0.5" />')

    led_p = pt(ctrl_cx, ctrl_cy, 12, 0, ctrl_h - 6)
    svg.append(f'    <circle cx="{led_p[0]}" cy="{led_p[1]}" r="1.8" fill="#34a853" />')
    svg.append(f'    <circle cx="{led_p[0]}" cy="{led_p[1]}" r="3.6" fill="#34a853" fill-opacity="0.3" />')

    c_top_p = pt(ctrl_cx, ctrl_cy, 25, 30, ctrl_h + 6)
    svg.append(f'    <rect x="{c_top_p[0]-48}" y="{c_top_p[1]-20}" width="96" height="18" rx="3" fill="#ffffff" stroke="#202124" stroke-width="0.8" filter="drop-shadow(0 1px 2px rgba(0,0,0,0.1))" />')
    svg.append(f'    <text x="{c_top_p[0]}" y="{c_top_p[1]-11}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6.8" fill="#1a73e8" text-anchor="middle">SDN CONTROLLER</text>')
    svg.append(f'    <text x="{c_top_p[0]}" y="{c_top_p[1]-3}" font-family="RobotoMono, monospace" font-size="5.4" fill="#5f6368" text-anchor="middle">Jetson Orin Nano · Verifier</text>')

    cp_port = pt(ctrl_cx, ctrl_cy, 22, 0, 6)
    svg.append(f'    <rect x="{cp_port[0]-4}" y="{cp_port[1]-4}" width="8" height="7" rx="1" fill="#111827" stroke="#fbbc04" stroke-width="0.8" />')
    tap2_port = pt(ctrl_cx, ctrl_cy, 38, 0, 6)
    svg.append(f'    <rect x="{tap2_port[0]-3}" y="{tap2_port[1]-4}" width="7" height="6" rx="1" fill="#111827" stroke="#4285f4" stroke-width="0.6" />')
    tap3_port = pt(ctrl_cx, ctrl_cy, 50, 0, 6)
    svg.append(f'    <rect x="{tap3_port[0]-3}" y="{tap3_port[1]-4}" width="7" height="6" rx="1" fill="#111827" stroke="#4285f4" stroke-width="0.6" />')
    svg.append('  </g>')

    # 2. PHYSICAL SWITCH STACK (3 TIERS)
    # TIER 1: Zodiac FX (DUT) at Base (z=0)
    svg.append('  <!-- ==================== TIER 1: ZODIAC FX OPENFLOW 1.3 DUT ==================== -->')
    svg.append('  <g id="switch-zodiac-fx">')
    svg.append(draw_chassis(st_cx, st_cy, sw_w, sw_d, sw_h, 0, "#zfxTop", "#zfxFront", "#zfxSide", "#374151"))

    z_bez = pt(st_cx, st_cy, 6, 0, sw_h - 6)
    svg.append(f'    <text x="{z_bez[0]}" y="{z_bez[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6" fill="#fbbc04">ZODIAC FX</text>')

    z_ports = []
    for i, p_num in enumerate([1, 2, 3, 4]):
        px_pos = 18 + i * 25
        p_pt = pt(st_cx, st_cy, px_pos, 0, 5)
        led_pt = pt(st_cx, st_cy, px_pos, 0, 15)
        z_ports.append(p_pt)
        svg.append(f'    <rect x="{p_pt[0]-4}" y="{p_pt[1]-4}" width="8.5" height="7.5" rx="1" fill="#000000" stroke="#9ca3af" stroke-width="0.7" />')
        led_color = "#34a853" if p_num in [1, 2] else ("#4285f4" if p_num == 3 else "#fbbc04")
        svg.append(f'    <circle cx="{led_pt[0]}" cy="{led_pt[1]}" r="1.3" fill="{led_color}" />')
        p_lbl = pt(st_cx, st_cy, px_pos - 1, 0, 1)
        svg.append(f'    <text x="{p_lbl[0]}" y="{p_lbl[1]+6}" font-family="RobotoMono, monospace" font-size="4.8" fill="#9ca3af" text-anchor="middle">P{p_num}</text>')

    z_tag_p = pt(st_cx, st_cy, -8, 40, 6)
    svg.append(f'    <rect x="{z_tag_p[0]-115}" y="{z_tag_p[1]-9}" width="115" height="18" rx="3" fill="#ffffff" stroke="#fbbc04" stroke-width="0.8" />')
    svg.append(f'    <text x="{z_tag_p[0]-6}" y="{z_tag_p[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6.5" fill="#202124" text-anchor="end">TIER 1: ZODIAC FX DUT</text>')
    svg.append(f'    <text x="{z_tag_p[0]-6}" y="{z_tag_p[1]+7}" font-family="RobotoMono, monospace" font-size="5.2" fill="#b06000" text-anchor="end">OpenFlow 1.3 · 128-rule Table</text>')
    svg.append(f'    <line x1="{z_tag_p[0]}" y1="{z_tag_p[1]}" x2="{z_tag_p[0]+12}" y2="{z_tag_p[1]}" stroke="#fbbc04" stroke-width="0.8" />')
    svg.append('  </g>')

    svg.append(draw_feet(st_cx, st_cy, sw_w, sw_d, sw_h, gap))

    # TIER 2: NETGEAR GS105Ev2 #1 (Workload Switch) - Middle (z=31)
    z2 = sw_h + gap
    svg.append('  <!-- ==================== TIER 2: NETGEAR GS105Ev2 #1 (WORKLOAD) ==================== -->')
    svg.append('  <g id="switch-netgear-workload">')
    svg.append(draw_chassis(st_cx, st_cy, sw_w, sw_d, sw_h, z2, "#ngTop", "#ngFront", "#ngSide", "#4b5563"))

    w_bez = pt(st_cx, st_cy, 6, 0, z2 + sw_h - 6)
    svg.append(f'    <text x="{w_bez[0]}" y="{w_bez[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6" fill="#8ab4f8">NETGEAR</text>')

    w_ports = []
    for i in range(5):
        p_num = i + 1
        px_pos = 14 + i * 21
        p_pt = pt(st_cx, st_cy, px_pos, 0, z2 + 5)
        led_pt = pt(st_cx, st_cy, px_pos, 0, z2 + 15)
        w_ports.append(p_pt)
        svg.append(f'    <rect x="{p_pt[0]-4}" y="{p_pt[1]-4}" width="7.5" height="7" rx="0.8" fill="#0b0f19" stroke="#cbd5e1" stroke-width="0.6" />')
        led_color = "#34a853" if p_num in [1, 3, 4, 5] else "#fbbc04"
        svg.append(f'    <circle cx="{led_pt[0]}" cy="{led_pt[1]}" r="1.3" fill="{led_color}" />')

    w_tag_p = pt(st_cx, st_cy, -8, 40, z2 + 6)
    svg.append(f'    <rect x="{w_tag_p[0]-115}" y="{w_tag_p[1]-9}" width="115" height="18" rx="3" fill="#ffffff" stroke="#1a73e8" stroke-width="0.8" />')
    svg.append(f'    <text x="{w_tag_p[0]-6}" y="{w_tag_p[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6.5" fill="#202124" text-anchor="end">TIER 2: WORKLOAD SWITCH</text>')
    svg.append(f'    <text x="{w_tag_p[0]-6}" y="{w_tag_p[1]+7}" font-family="RobotoMono, monospace" font-size="5.2" fill="#1967d2" text-anchor="end">GS105Ev2 #1 · Untrusted VLAN 1</text>')
    svg.append(f'    <line x1="{w_tag_p[0]}" y1="{w_tag_p[1]}" x2="{w_tag_p[0]+12}" y2="{w_tag_p[1]}" stroke="#1a73e8" stroke-width="0.8" />')
    svg.append('  </g>')

    z3 = z2 + sw_h + gap
    svg.append(draw_feet(st_cx, st_cy, sw_w, sw_d, z2 + sw_h, gap))

    # TIER 3: NETGEAR GS105Ev2 #2 (Uplink Switch) - Top (z=62)
    svg.append('  <!-- ==================== TIER 3: NETGEAR GS105Ev2 #2 (UPLINK) ==================== -->')
    svg.append('  <g id="switch-netgear-uplink">')
    svg.append(draw_chassis(st_cx, st_cy, sw_w, sw_d, sw_h, z3, "#ngTop", "#ngFront", "#ngSide", "#4b5563"))

    u_bez = pt(st_cx, st_cy, 6, 0, z3 + sw_h - 6)
    svg.append(f'    <text x="{u_bez[0]}" y="{u_bez[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6" fill="#81c995">NETGEAR</text>')

    u_ports = []
    for i in range(5):
        p_num = i + 1
        px_pos = 14 + i * 21
        p_pt = pt(st_cx, st_cy, px_pos, 0, z3 + 5)
        led_pt = pt(st_cx, st_cy, px_pos, 0, z3 + 15)
        u_ports.append(p_pt)
        svg.append(f'    <rect x="{p_pt[0]-4}" y="{p_pt[1]-4}" width="7.5" height="7" rx="0.8" fill="#0b0f19" stroke="#cbd5e1" stroke-width="0.6" />')
        led_color = "#34a853" if p_num in [1, 4] else "#fbbc04"
        svg.append(f'    <circle cx="{led_pt[0]}" cy="{led_pt[1]}" r="1.3" fill="{led_color}" />')

    u_tag_p = pt(st_cx, st_cy, -8, 40, z3 + 6)
    svg.append(f'    <rect x="{u_tag_p[0]-115}" y="{u_tag_p[1]-9}" width="115" height="18" rx="3" fill="#ffffff" stroke="#137333" stroke-width="0.8" />')
    svg.append(f'    <text x="{u_tag_p[0]-6}" y="{u_tag_p[1]}" font-family="GoogleSans, sans-serif" font-weight="700" font-size="6.5" fill="#202124" text-anchor="end">TIER 3: UPLINK SWITCH</text>')
    svg.append(f'    <text x="{u_tag_p[0]-6}" y="{u_tag_p[1]+7}" font-family="RobotoMono, monospace" font-size="5.2" fill="#137333" text-anchor="end">GS105Ev2 #2 · Protected Transit</text>')
    svg.append(f'    <line x1="{u_tag_p[0]}" y1="{u_tag_p[1]}" x2="{u_tag_p[0]+12}" y2="{u_tag_p[1]}" stroke="#137333" stroke-width="0.8" />')
    svg.append('  </g>')

    # 3. INTERCONNECTING PATCH CABLES
    svg.append('  <!-- ==================== PHYSICAL PATCH CABLES & SDN FLOWS ==================== -->')
    c1_start = (cp_port[0], cp_port[1])
    c1_end = (z_ports[3][0], z_ports[3][1])
    c1_ctrl1 = (c1_start[0] - 25, c1_start[1] + 26)
    c1_ctrl2 = (c1_end[0] + 30, c1_end[1] + 24)
    svg.append(f'    <path d="M {c1_start[0]} {c1_start[1]+7} C {c1_ctrl1[0]} {c1_ctrl1[1]+7}, {c1_ctrl2[0]} {c1_ctrl2[1]+7}, {c1_end[0]} {c1_end[1]+7}" fill="none" stroke="#000000" stroke-width="3" stroke-opacity="0.10" />')
    svg.append(f'    <path d="M {c1_start[0]} {c1_start[1]} C {c1_ctrl1[0]} {c1_ctrl1[1]}, {c1_ctrl2[0]} {c1_ctrl2[1]}, {c1_end[0]} {c1_end[1]}" fill="none" stroke="#f9ab00" stroke-width="2.6" stroke-linecap="round" />')
    svg.append(f'    <path d="M {c1_start[0]} {c1_start[1]} C {c1_ctrl1[0]} {c1_ctrl1[1]}, {c1_ctrl2[0]} {c1_ctrl2[1]}, {c1_end[0]} {c1_end[1]}" fill="none" stroke="#ffffff" stroke-width="0.8" stroke-dasharray="3 5" opacity="0.8" />')

    c2_start = (w_ports[4][0], w_ports[4][1])
    c2_end = (z_ports[0][0], z_ports[0][1])
    c2_ctrl1 = (c2_start[0] + 20, c2_start[1] + 14)
    c2_ctrl2 = (c2_end[0] - 18, c2_end[1] - 8)
    svg.append(f'    <path d="M {c2_start[0]} {c2_start[1]} C {c2_ctrl1[0]} {c2_ctrl1[1]}, {c2_ctrl2[0]} {c2_ctrl2[1]}, {c2_end[0]} {c2_end[1]}" fill="none" stroke="#1a73e8" stroke-width="2.4" stroke-linecap="round" />')

    c3_start = (z_ports[1][0], z_ports[1][1])
    c3_end = (u_ports[3][0], u_ports[3][1])
    c3_ctrl1 = (c3_start[0] + 16, c3_start[1] - 14)
    c3_ctrl2 = (c3_end[0] + 22, c3_end[1] + 16)
    svg.append(f'    <path d="M {c3_start[0]} {c3_start[1]} C {c3_ctrl1[0]} {c3_ctrl1[1]}, {c3_ctrl2[0]} {c3_ctrl2[1]}, {c3_end[0]} {c3_end[1]}" fill="none" stroke="#137333" stroke-width="2.4" stroke-linecap="round" />')

    c4_start = (z_ports[2][0], z_ports[2][1])
    c4_end = (tap2_port[0], tap2_port[1])
    c4_ctrl1 = (c4_start[0] + 18, c4_start[1] + 15)
    c4_ctrl2 = (c4_end[0] - 14, c4_end[1] + 16)
    svg.append(f'    <path d="M {c4_start[0]} {c4_start[1]} C {c4_ctrl1[0]} {c4_ctrl1[1]}, {c4_ctrl2[0]} {c4_ctrl2[1]}, {c4_end[0]} {c4_end[1]}" fill="none" stroke="#4285f4" stroke-width="1.5" stroke-dasharray="2 2" stroke-linecap="round" />')

    mid_c1 = (c1_start[0] - 38, c1_start[1] + 30)
    svg.append(f'    <rect x="{mid_c1[0]-46}" y="{mid_c1[1]-8}" width="92" height="15" rx="3" fill="#ffffff" stroke="#fbbc04" stroke-width="0.8" />')
    svg.append(f'    <text x="{mid_c1[0]}" y="{mid_c1[1]+3}" font-family="RobotoMono, monospace" font-size="6.2" font-weight="700" fill="#b06000" text-anchor="middle">OF 1.3 Control (:6633)</text>')

    svg.append(f'    <rect x="{c2_start[0]+12}" y="{c2_start[1]+2}" width="78" height="13" rx="2" fill="#ffffff" stroke="#1a73e8" stroke-width="0.8" />')
    svg.append(f'    <text x="{c2_start[0]+51}" y="{c2_start[1]+11}" font-family="RobotoMono, monospace" font-size="5.8" fill="#1967d2" text-anchor="middle">Data Ingress (VLAN 1)</text>')

    svg.append(f'    <rect x="{c3_end[0]+12}" y="{c3_end[1]+2}" width="72" height="13" rx="2" fill="#ffffff" stroke="#137333" stroke-width="0.8" />')
    svg.append(f'    <text x="{c3_end[0]+48}" y="{c3_end[1]+11}" font-family="RobotoMono, monospace" font-size="5.8" fill="#137333" text-anchor="middle">Filtered Egress</text>')

    svg.append('    <rect x="70" y="318" width="240" height="18" rx="9" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />')
    svg.append('    <text x="190" y="330" font-family="GoogleSans, sans-serif" font-weight="600" font-size="7.5" fill="#3c4043" text-anchor="middle">PHYSICAL 3-TIER TESTBED STACK &amp; SDN CONTROL PLANE</text>')

    svg.append('</svg>')
    return "\n".join(svg)



def svg_closed_loop_architecture() -> str:
    """
    Zodiac Closed-Loop Verification Architecture:
    Horizontal 4-stage pipeline visualizing LLM Policy Synthesis -> Deterministic Verifier
    -> Governance Gate & Envelope -> Physical Silicon & Mirror Taps, with the Protocol B
    multi-turn repair loop clearly highlighted.
    Designed for Section 1.2 (Summary of Contributions across Tracks A, B, and C).
    """
    return """
<svg viewBox="0 0 880 240" width="100%" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #dadce0;border-radius:4pt;display:block;">
  <!-- Header Bar -->
  <rect x="0" y="0" width="880" height="30" fill="#f8f9fa" />
  <line x1="0" y1="30" x2="880" y2="30" stroke="#dadce0" stroke-width="1" />
  <text x="16" y="20" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11" fill="#202124">ZODIAC CLOSED-LOOP TESTBED ARCHITECTURE &amp; MULTI-TRACK VERIFICATION PIPELINE</text>
  <text x="864" y="20" text-anchor="end" font-family="RobotoMono, monospace" font-size="9" fill="#1a73e8">Tracks A, B, C · Protocols A &amp; B</text>

  <!-- Step 1: LLM Policy Proposers -->
  <g transform="translate(16, 44)">
    <rect x="0" y="0" width="194" height="136" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="194" height="24" rx="5" fill="#e8f0fe" />
    <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#1967d2">1. LLM Policy Proposers</text>
    <text x="10" y="38" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#3c4043">Natural language operator intent</text>
    <text x="10" y="50" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#3c4043">&rarr; OpenFlow 1.3 JSON flow table.</text>
    <text x="10" y="68" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">&bull; Local edge: Qwen3.8-27B (vLLM)</text>
    <text x="10" y="80" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">&bull; Rented: NVIDIA A100 SXM4 80G</text>
    <text x="10" y="92" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">&bull; Cloud API: Claude Haiku / Sonnet</text>
    <rect x="8" y="104" width="178" height="24" rx="3" fill="#fce8e6" stroke="#ea4335" stroke-width="0.8" />
    <text x="12" y="120" font-family="RobotoMono, monospace" font-size="7.6" fill="#c5221f">Protocol A (Zero-Shot): 43%–80%</text>
  </g>

  <!-- Arrow 1 -> 2 -->
  <g stroke="#1a73e8" stroke-width="2">
    <line x1="212" y1="112" x2="232" y2="112" />
    <polygon points="236,112 228,107 228,117" fill="#1a73e8" stroke="none" />
  </g>

  <!-- Step 2: Deterministic Verifier -->
  <g transform="translate(238, 44)">
    <rect x="0" y="0" width="206" height="136" rx="5" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.4" />
    <rect x="0" y="0" width="206" height="24" rx="5" fill="#1a73e8" />
    <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#ffffff">2. Deterministic Verifier (Track A)</text>
    <text x="10" y="38" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#202124">Properties A1–A11 (Formal Gates)</text>
    <text x="10" y="52" font-family="RobotoMono, monospace" font-size="7.8" fill="#3c4043">&bull; A4: Precedence &amp; Overlaps</text>
    <text x="10" y="64" font-family="RobotoMono, monospace" font-size="7.8" fill="#3c4043">&bull; A3: Priority-0 Action Drop Guard</text>
    <text x="10" y="76" font-family="RobotoMono, monospace" font-size="7.8" fill="#3c4043">&bull; A8: Traversal Cost (80.0 + 5.42k &mu;s)</text>
    <text x="10" y="88" font-family="RobotoMono, monospace" font-size="7.8" fill="#3c4043">&bull; A10: ARP Peer Confinement</text>
    <rect x="8" y="104" width="190" height="24" rx="3" fill="#e6f4ea" stroke="#137333" stroke-width="0.8" />
    <text x="12" y="120" font-family="RobotoMono, monospace" font-weight="700" font-size="7.8" fill="#137333">Track A: 196/196 Mutants Caught</text>
  </g>

  <!-- Arrow 2 -> 3 -->
  <g stroke="#1a73e8" stroke-width="2">
    <line x1="446" y1="112" x2="466" y2="112" />
    <polygon points="470,112 462,107 462,117" fill="#1a73e8" stroke="none" />
  </g>

  <!-- Step 3: Governance & Quarantine Envelope -->
  <g transform="translate(472, 44)">
    <rect x="0" y="0" width="190" height="136" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="190" height="24" rx="5" fill="#fef7e0" />
    <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#b06000">3. Governance (Track C)</text>
    <text x="10" y="38" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#3c4043">Human Approval Gate:</text>
    <text x="10" y="50" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Agent rules NEVER self-install.</text>
    <text x="10" y="66" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#3c4043">Quarantine Envelope (Detector):</text>
    <text x="10" y="78" font-family="RobotoMono, monospace" font-size="7.6" fill="#b06000">&bull; Table budget: k &le; 8 DROPs</text>
    <text x="10" y="90" font-family="RobotoMono, monospace" font-size="7.6" fill="#b06000">&bull; Bounded TTL: &le; 300 s</text>
    <rect x="8" y="104" width="174" height="24" rx="3" fill="#ffffff" stroke="#fbbc04" stroke-width="0.8" />
    <text x="12" y="120" font-family="RobotoMono, monospace" font-weight="700" font-size="7.6" fill="#b06000">Anti-Steering: Protected Immune</text>
  </g>

  <!-- Arrow 3 -> 4 -->
  <g stroke="#1a73e8" stroke-width="2">
    <line x1="664" y1="112" x2="684" y2="112" />
    <polygon points="688,112 680,107 680,117" fill="#1a73e8" stroke="none" />
  </g>

  <!-- Step 4: Physical Silicon & Conformance -->
  <g transform="translate(690, 44)">
    <rect x="0" y="0" width="174" height="136" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="174" height="24" rx="5" fill="#e6f4ea" />
    <text x="10" y="16" font-family="GoogleSans, sans-serif" font-weight="700" font-size="9.5" fill="#137333">4. Physical Silicon (Track B)</text>
    <text x="10" y="38" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#202124">Zodiac FX 120 MHz (FW 0.86)</text>
    <text x="10" y="50" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Atmel SAM4E8E Cortex-M4</text>
    <text x="10" y="66" font-family="GoogleSansText, sans-serif" font-size="8.2" fill="#202124">Dual Mirror Switches &amp; Taps:</text>
    <text x="10" y="78" font-family="RobotoMono, monospace" font-size="7.6" fill="#137333">&bull; O1 Pre-DUT · O2 · O3 Uplink</text>
    <rect x="8" y="104" width="158" height="24" rx="3" fill="#e6f4ea" stroke="#137333" stroke-width="0.8" />
    <text x="12" y="120" font-family="RobotoMono, monospace" font-weight="700" font-size="7.6" fill="#137333">611/611 Wire Checks Agree</text>
  </g>

  <!-- ==================== PROTOCOL B FEEDBACK LOOP ==================== -->
  <path d="M 341 180 L 341 210 L 113 210 L 113 186" fill="none" stroke="#137333" stroke-width="2" stroke-dasharray="4 3" />
  <polygon points="113,180 109,188 117,188" fill="#137333" />
  <rect x="135" y="198" width="186" height="22" rx="3" fill="#e6f4ea" stroke="#137333" stroke-width="1" />
  <text x="142" y="213" font-family="GoogleSans, sans-serif" font-weight="700" font-size="8.5" fill="#137333">Protocol B Feedback: 98.8%–100% (&le;5 turns)</text>
</svg>
"""

