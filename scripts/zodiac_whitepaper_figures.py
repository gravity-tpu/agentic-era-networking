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


def fmt(val: float) -> str:
    return f"{val:.2f}"


class IsoProjector:
    """
    Projects 3D coordinates (x, y, z) in mm to 2D SVG coordinates (px, py),
    and computes SVG affine transform matrices for planar text/vector groups.
    """
    def __init__(self, ox: float, oy: float, ux: tuple[float, float], uy: tuple[float, float], uz: tuple[float, float]):
        self.ox = ox
        self.oy = oy
        self.ux = ux
        self.uy = uy
        self.uz = uz

    def pt(self, x: float, y: float, z: float = 0.0) -> tuple[float, float]:
        px = self.ox + x * self.ux[0] + y * self.uy[0] + z * self.uz[0]
        py = self.oy + x * self.ux[1] + y * self.uy[1] + z * self.uz[1]
        return (px, py)

    def pts(self, coords: list[tuple[float, float, float]]) -> str:
        return " ".join(f"{fmt(p[0])},{fmt(p[1])}" for p in (self.pt(x, y, z) for x, y, z in coords))

    def plane_matrix(self, x: float, y: float, z: float = 0.0) -> str:
        """
        Returns an SVG transform="matrix(a, b, c, d, e, f)" that maps local 2D (dx, dy)
        in mm directly onto the 3D XY plane at height z, originating at (x, y, z).
        """
        e, f = self.pt(x, y, z)
        a, b = self.ux[0], self.ux[1]
        c, d = self.uy[0], self.uy[1]
        return f"matrix({fmt(a)},{fmt(b)},{fmt(c)},{fmt(d)},{fmt(e)},{fmt(f)})"

    def shadow_box(self, x0: float, y0: float, z0: float, w: float, d: float, dx: float = -1.5, dy: float = 2.5, layers: int = 4) -> str:
        """
        Pure-vector multi-layered soft shadow on plane z0.
        """
        out = []
        for i in range(layers, 0, -1):
            pad = i * 0.85
            alpha = 0.055 * (layers - i + 1)
            p = self.pts([
                (x0 + dx - pad, y0 + dy - pad, z0),
                (x0 + w + dx + pad, y0 + dy - pad, z0),
                (x0 + w + dx + pad, y0 + d + dy + pad, z0),
                (x0 + dx - pad, y0 + d + dy + pad, z0),
            ])
            out.append(f'<polygon points="{p}" fill="#000000" fill-opacity="{alpha:.2f}"/>')
        return "\n".join(out)

    def box(
        self,
        x0: float, y0: float, z0: float,
        w: float, d: float, h: float,
        fill_top: str,
        fill_front_y: str,
        fill_side_x: str,
        stroke: str = "none",
        stroke_w: float = 0.4,
        faces: tuple[str, ...] = ("ymin", "ymax", "xmin", "xmax", "top"),
    ) -> str:
        """
        Renders a 3D rectangular prism from (x0, y0, z0) with size (w, d, h).
        """
        x1, y1, z1 = x0 + w, y0 + d, z0 + h
        out = []
        s_attr = f' stroke="{stroke}" stroke-width="{stroke_w}" stroke-linejoin="round"' if stroke != "none" else ""

        if "ymin" in faces:
            p = self.pts([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)])
            out.append(f'<polygon points="{p}" fill="{fill_front_y}"{s_attr}/>')
        if "xmin" in faces:
            p = self.pts([(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)])
            out.append(f'<polygon points="{p}" fill="{fill_side_x}"{s_attr}/>')
        if "ymax" in faces:
            p = self.pts([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)])
            out.append(f'<polygon points="{p}" fill="{fill_front_y}"{s_attr}/>')
        if "xmax" in faces:
            p = self.pts([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)])
            out.append(f'<polygon points="{p}" fill="{fill_side_x}"{s_attr}/>')
        if "top" in faces:
            p = self.pts([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])
            out.append(f'<polygon points="{p}" fill="{fill_top}"{s_attr}/>')
        return "\n".join(out)


def render_jetson_orin_group(
    ox: float = 268.0,
    oy: float = 64.0,
    scale: float = 1.0,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Returns the <g> element and projector for the NVIDIA Jetson Orin Nano Super Developer Kit.
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(2.42 * scale, 1.72 * scale),
        uy=(-2.82 * scale, 2.12 * scale),
        uz=(0.0, -3.15 * scale),
    )
    parts = ['  <g id="jetson-orin-nano-super">']

    # Soft multi-layer vector ground shadow
    parts.append(iso.shadow_box(-1.5, -1.5, 0.0, 103.0, 83.0, dx=0.5, dy=2.5, layers=4))

    # 1. Base Tray Bottom & Lip
    parts.append(iso.box(
        -1.5, -1.5, 0.0, 103.0, 83.0, 3.2,
        fill_top="#24272c",
        fill_front_y="#141619",
        fill_side_x="#0d0e11",
        stroke="#33373e",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # Main Carrier PCB (Z = 3.2..5.0mm, X = 0..100, Y = 0..80)
    parts.append(iso.box(
        0.0, 0.0, 3.2, 100.0, 80.0, 1.8,
        fill_top="#22252b",
        fill_front_y="#181a1f",
        fill_side_x="#111317",
        stroke="#3c4048",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # 2. Carrier PCB Surface Details
    parts.append(f'  <g transform="{iso.plane_matrix(0, 0, 5.05)}">')
    parts.append('    <rect x="2" y="2" width="96" height="76" rx="1.5" fill="none" stroke="#4b5563" stroke-width="0.25" stroke-dasharray="6,2"/>')

    for sx, sy in [(6, 72), (88, 74), (94, 14), (8, 8)]:
        parts.append(f'    <circle cx="{sx}" cy="{sy}" r="2.8" fill="#181a1f" stroke="#6b7280" stroke-width="0.5"/>')
        parts.append(f'    <circle cx="{sx}" cy="{sy}" r="1.8" fill="#0f1115" stroke="#374151" stroke-width="0.3"/>')
        parts.append(f'    <line x1="{sx-1}" y1="{sy}" x2="{sx+1}" y2="{sy}" stroke="#4b5563" stroke-width="0.35"/>')
        parts.append(f'    <line x1="{sx}" y1="{sy-1}" x2="{sx}" y2="{sy+1}" stroke="#4b5563" stroke-width="0.35"/>')

    smd_clusters = [
        (60, 62, 2.2, 1.4, "#111317"), (63, 62, 1.5, 0.9, "#9ca3af"), (65, 62, 1.5, 0.9, "#b45309"),
        (58, 65, 3.0, 2.5, "#111317"), (62, 66, 1.4, 0.8, "#d97706"), (64, 66, 1.4, 0.8, "#9ca3af"),
        (66, 68, 2.5, 2.0, "#111317"), (70, 67, 1.2, 0.8, "#b45309"), (72, 68, 1.2, 0.8, "#9ca3af"),
        (52, 68, 3.5, 3.5, "#181a1f"), (48, 70, 1.8, 1.0, "#b45309"), (45, 71, 1.8, 1.0, "#9ca3af"),
        (38, 69, 2.4, 1.8, "#111317"), (35, 70, 1.5, 0.9, "#d97706"), (32, 71, 1.5, 0.9, "#9ca3af"),
        (62, 48, 2.0, 1.2, "#b45309"), (65, 48, 2.0, 1.2, "#9ca3af"), (68, 44, 2.8, 2.2, "#111317"),
        (71, 40, 1.6, 1.0, "#d97706"), (73, 36, 2.2, 1.6, "#111317"), (75, 32, 1.5, 0.9, "#9ca3af"),
        (22, 72, 2.0, 1.2, "#b45309"), (25, 72, 1.5, 0.9, "#9ca3af"), (50, 74, 2.2, 1.2, "#d97706"),
        (54, 74, 1.6, 1.0, "#9ca3af"), (57, 73, 2.5, 2.0, "#111317"),
    ]
    for cx, cy, cw, ch, col in smd_clusters:
        parts.append(f'    <rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" fill="{col}" stroke="#4b5563" stroke-width="0.15"/>')

    parts.append('    <text x="28" y="78.5" font-family="RobotoMono, monospace" font-size="2.0" fill="#9ca3af">CAM0</text>')
    parts.append('    <text x="58" y="78.5" font-family="RobotoMono, monospace" font-size="2.0" fill="#9ca3af">CAM1</text>')
    parts.append('    <text x="89" y="10" font-family="RobotoMono, monospace" font-size="1.8" fill="#9ca3af">J12</text>')
    parts.append('  </g>')

    # 3. Two MIPI CSI Camera Ribbon Connectors
    for cam_x in [18.0, 44.0]:
        parts.append(iso.box(
            cam_x, 74.5, 5.0, 18.0, 3.2, 2.4,
            fill_top="#374151",
            fill_front_y="#111827",
            fill_side_x="#1f2937",
            stroke="#4b5563",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(iso.box(
            cam_x + 1.2, 75.0, 7.4, 15.6, 2.0, 0.5,
            fill_top="#9ca3af",
            fill_front_y="#6b7280",
            fill_side_x="#4b5563",
            stroke="none",
            faces=("ymax", "xmax", "top"),
        ))

    # 4. 40-Pin GPIO Header (Back-Right Edge)
    parts.append(iso.box(
        18.0, 1.5, 5.0, 56.0, 5.0, 2.5,
        fill_top="#111317",
        fill_front_y="#090a0d",
        fill_side_x="#181a1f",
        stroke="#272a30",
        stroke_w=0.3 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    for i in range(20):
        px = 19.5 + i * 2.75
        for py in [2.6, 5.0]:
            p_bot = iso.pt(px, py, 7.5)
            p_top = iso.pt(px, py, 13.8)
            parts.append(f'  <line x1="{fmt(p_bot[0])}" y1="{fmt(p_bot[1])}" x2="{fmt(p_top[0])}" y2="{fmt(p_top[1])}" stroke="#cbd5e1" stroke-width="{fmt(1.35*scale)}" stroke-linecap="square"/>')
            parts.append(f'  <line x1="{fmt(p_bot[0])}" y1="{fmt(p_bot[1])}" x2="{fmt(p_top[0])}" y2="{fmt(p_top[1])}" stroke="#94a3b8" stroke-width="{fmt(0.6*scale)}"/>')
            parts.append(f'  <circle cx="{fmt(p_top[0])}" cy="{fmt(p_top[1])}" r="{fmt(0.65*scale)}" fill="#ffffff"/>')

    # 5. 260-Pin SO-DIMM Connector & Jetson Orin Nano SoM Module
    parts.append(iso.box(
        54.5, 11.0, 5.0, 6.5, 55.0, 4.8,
        fill_top="#1e2024",
        fill_front_y="#0d0f12",
        fill_side_x="#15171b",
        stroke="#374151",
        stroke_w=0.4 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    for i in range(42):
        py = 12.5 + i * 1.24
        p1 = iso.pt(55.0, py, 9.8)
        p2 = iso.pt(60.5, py, 9.8)
        p3 = iso.pt(60.5, py, 5.2)
        parts.append(f'  <polyline points="{fmt(p1[0])},{fmt(p1[1])} {fmt(p2[0])},{fmt(p2[1])} {fmt(p3[0])},{fmt(p3[1])}" fill="none" stroke="#cbd5e1" stroke-width="{fmt(0.55*scale)}" opacity="0.85"/>')

    parts.append(iso.box(
        8.0, 12.0, 8.2, 47.5, 54.0, 1.6,
        fill_top="#202329",
        fill_front_y="#141619",
        fill_side_x="#1c1f24",
        stroke="#4b5563",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(f'  <g transform="{iso.plane_matrix(8.0, 12.0, 9.9)}">')
    for sy in range(4, 50, 3):
        parts.append(f'    <rect x="44" y="{sy}" width="2.0" height="1.2" fill="#b45309"/>')
        parts.append(f'    <rect x="41.5" y="{sy+1}" width="1.5" height="0.9" fill="#9ca3af"/>')
    for sx in range(4, 42, 4):
        parts.append(f'    <rect x="{sx}" y="50" width="1.8" height="1.1" fill="#9ca3af"/>')
        parts.append(f'    <rect x="{sx+1.5}" y="48" width="1.4" height="0.9" fill="#d97706"/>')
    parts.append('    <circle cx="4" cy="50" r="2.2" fill="#181a1f" stroke="#9ca3af" stroke-width="0.5"/>')
    parts.append('    <line x1="3" y1="50" x2="5" y2="50" stroke="#9ca3af" stroke-width="0.35"/>')
    parts.append('    <line x1="4" y1="49" x2="4" y2="51" stroke="#9ca3af" stroke-width="0.35"/>')
    parts.append('  </g>')

    # Silver metal SO-DIMM retention clip at front end of SoM
    parts.append(iso.box(
        26.0, 65.5, 6.0, 9.0, 2.2, 4.0,
        fill_top="#e2e8f0",
        fill_front_y="#94a3b8",
        fill_side_x="#64748b",
        stroke="#475569",
        stroke_w=0.35 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # 6. Anodized Aluminum Heatsink & Recessed Axial Fan (Rich gunmetal gray matching Photo 1!)
    hs_x0, hs_y0, hs_z0 = 10.0, 13.0, 9.8
    hs_w, hs_d, hs_h = 42.0, 47.0, 20.5

    parts.append(iso.shadow_box(hs_x0, hs_y0, hs_z0, hs_w, hs_d, dx=1.0, dy=1.5, layers=3))
    parts.append(iso.box(
        hs_x0, hs_y0, hs_z0, hs_w, hs_d, hs_h,
        fill_top="#363940",
        fill_front_y="#272a30",
        fill_side_x="#1d2025",
        stroke="#4b5058",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    num_fins = 8
    slot_w = 3.4
    slot_gap = (hs_w - 5.0) / num_fins
    for i in range(num_fins):
        sx0 = hs_x0 + 2.8 + i * slot_gap
        sx1 = sx0 + slot_w
        sz0 = hs_z0 + 0.5
        sz1 = hs_z0 + hs_h - 4.2
        y_face = hs_y0 + hs_d
        slot_pts = iso.pts([
            (sx0, y_face, sz0),
            (sx1, y_face, sz0),
            (sx1, y_face, sz1),
            (sx0, y_face, sz1),
        ])
        parts.append(f'  <polygon points="{slot_pts}" fill="#08090c" stroke="#1f2328" stroke-width="{fmt(0.35*scale)}"/>')
        in_pts = iso.pts([
            (sx0 + 0.7, y_face, sz0),
            (sx0 + 0.7, y_face, sz1 - 0.5),
        ])
        parts.append(f'  <polyline points="{in_pts}" fill="none" stroke="#383c44" stroke-width="{fmt(0.45*scale)}"/>')

    parts.append(f'  <g transform="{iso.plane_matrix(hs_x0, hs_y0, hs_z0 + hs_h)}">')
    parts.append(f'    <rect x="0.8" y="0.8" width="{hs_w-1.6}" height="{hs_d-1.6}" rx="1.2" fill="none" stroke="#525760" stroke-width="0.3"/>')
    parts.append('    <g transform="translate(23, 6.8) rotate(180)" opacity="0.85">')
    parts.append('      <text x="0" y="1.8" font-family="GoogleSans, sans-serif" font-weight="700" font-size="5.2" letter-spacing="0.4" fill="#7c828d" text-anchor="middle">nVIDIA</text>')
    parts.append('    </g>')

    fcx, fcy, fr = 21.0, 27.5, 16.8
    parts.append(f'    <circle cx="{fcx}" cy="{fcy}" r="{fr+0.7}" fill="#1f2227" stroke="#525760" stroke-width="0.4"/>')
    parts.append(f'    <circle cx="{fcx}" cy="{fcy}" r="{fr}" fill="#0c0e12" stroke="#050608" stroke-width="0.6"/>')
    parts.append(f'    <path d="M {fcx-fr},{fcy} A {fr},{fr} 0 1,1 {fcx+fr},{fcy} A {fr},{fr*0.86} 0 1,0 {fcx-fr},{fcy} Z" fill="#25282e" opacity="0.75"/>')

    num_blades = 9
    for b in range(num_blades):
        angle = b * (360.0 / num_blades)
        parts.append(f'    <g transform="translate({fcx}, {fcy}) rotate({angle:.1f})">')
        parts.append('      <path d="M 5.5,-2.2 C 9.0,-4.5 13.0,-4.0 15.6,-1.2 C 16.0,0.8 15.2,2.8 13.5,3.4 C 10.5,2.0 7.8,1.2 5.2,1.5 Z" fill="#282c33" stroke="#4b5058" stroke-width="0.28"/>')
        parts.append('      <path d="M 6.0,-1.9 C 9.2,-4.0 12.8,-3.6 15.3,-1.0" fill="none" stroke="#646a73" stroke-width="0.35"/>')
        parts.append('    </g>')

    parts.append(f'    <circle cx="{fcx}" cy="{fcy}" r="7.4" fill="#2c3038" stroke="#4b5058" stroke-width="0.4"/>')
    parts.append(f'    <circle cx="{fcx}" cy="{fcy}" r="1.2" fill="#141619" stroke="#525760" stroke-width="0.3"/>')
    parts.append(f'    <circle cx="{fcx}" cy="{fcy}" r="0.35" fill="#6b7280"/>')
    parts.append(f'    <path d="M {fcx+2.8},{fcy-3.8} C {fcx+3.8},{fcy-4.2} {fcx+4.4},{fcy-3.2} {fcx+3.4},{fcy-2.6}" fill="none" stroke="#525760" stroke-width="0.35"/>')
    parts.append('  </g>')

    # 7. Front-Right I/O Port Cluster (Brushed Metallic Silver Shields matching Photo 1!)
    # 7A. USB Type-C Port
    parts.append(iso.box(
        89.0, 5.5, 5.0, 9.5, 8.5, 3.8,
        fill_top="#e2e8f0",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#64748b",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    usbc_cav = iso.pts([(98.5, 7.0, 5.8), (98.5, 12.5, 5.8), (98.5, 12.5, 8.0), (98.5, 7.0, 8.0)])
    parts.append(f'  <polygon points="{usbc_cav}" fill="#0f172a" stroke="#475569" stroke-width="{fmt(0.4*scale)}"/>')
    usbc_tongue = iso.pts([(98.5, 8.0, 6.7), (98.5, 11.5, 6.7), (98.5, 11.5, 7.1), (98.5, 8.0, 7.1)])
    parts.append(f'  <polygon points="{usbc_tongue}" fill="#cbd5e1"/>')

    # 7B. Gigabit Ethernet RJ45 Tower
    parts.append(iso.shadow_box(76.0, 16.0, 5.0, 21.5, 16.0, dx=-1.0, dy=1.5, layers=2))
    parts.append(iso.box(
        76.0, 16.0, 5.0, 21.5, 16.0, 14.5,
        fill_top="#f1f5f9",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#64748b",
        stroke_w=0.55 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    # Specular sheen on top of GbE shield
    parts.append(f'  <g transform="{iso.plane_matrix(76.0, 16.0, 19.55)}">')
    parts.append('    <polygon points="1,1 20.5,1 14,15 1,15" fill="#ffffff" fill-opacity="0.45"/>')
    parts.append('  </g>')
    rj_cav = iso.pts([
        (97.5, 18.2, 6.5),
        (97.5, 29.8, 6.5),
        (97.5, 29.8, 15.8),
        (97.5, 26.8, 15.8),
        (97.5, 26.8, 17.5),
        (97.5, 21.2, 17.5),
        (97.5, 21.2, 15.8),
        (97.5, 18.2, 15.8),
    ])
    parts.append(f'  <polygon points="{rj_cav}" fill="#090d14" stroke="#334155" stroke-width="{fmt(0.45*scale)}"/>')
    rj_inner = iso.pts([
        (97.5, 18.5, 6.7),
        (97.5, 29.5, 6.7),
        (97.5, 29.5, 9.8),
        (97.5, 24.5, 11.2),
        (97.5, 18.5, 8.8),
    ])
    parts.append(f'  <polygon points="{rj_inner}" fill="#1e293b"/>')
    for pin_i in range(6):
        py = 19.8 + pin_i * 1.6
        p_a = iso.pt(97.5, py, 15.4)
        p_b = iso.pt(97.5, py + 0.8, 12.2)
        parts.append(f'  <line x1="{fmt(p_a[0])}" y1="{fmt(p_a[1])}" x2="{fmt(p_b[0])}" y2="{fmt(p_b[1])}" stroke="#eab308" stroke-width="{fmt(0.6*scale)}"/>')

    # 7C. Two Dual-Stacked USB 3.2 Type-A Towers
    for usb_y in [34.5, 49.5]:
        parts.append(iso.shadow_box(79.0, usb_y, 5.0, 18.5, 13.0, dx=-1.0, dy=1.5, layers=2))
        parts.append(iso.box(
            79.0, usb_y, 5.0, 18.5, 13.0, 15.5,
            fill_top="#f1f5f9",
            fill_front_y="#94a3b8",
            fill_side_x="#cbd5e1",
            stroke="#64748b",
            stroke_w=0.55 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(f'  <g transform="{iso.plane_matrix(79.0, usb_y, 20.55)}">')
        parts.append('    <polygon points="0.8,0.8 17.5,0.8 11,12.2 0.8,12.2" fill="#ffffff" fill-opacity="0.42"/>')
        parts.append('    <rect x="3.5" y="2.2" width="4.5" height="2.2" fill="none" stroke="#64748b" stroke-width="0.35"/>')
        parts.append('    <rect x="3.5" y="8.6" width="4.5" height="2.2" fill="none" stroke="#64748b" stroke-width="0.35"/>')
        parts.append('    <line x1="11" y1="1.5" x2="11" y2="11.5" stroke="#94a3b8" stroke-width="0.3"/>')
        parts.append('  </g>')
        for uz in [6.8, 13.5]:
            ucav = iso.pts([
                (97.5, usb_y + 1.6, uz),
                (97.5, usb_y + 11.4, uz),
                (97.5, usb_y + 11.4, uz + 4.8),
                (97.5, usb_y + 1.6, uz + 4.8),
            ])
            parts.append(f'  <polygon points="{ucav}" fill="#090d14" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')
            utongue = iso.pts([
                (97.5, usb_y + 2.2, uz + 2.2),
                (97.5, usb_y + 10.8, uz + 2.2),
                (97.5, usb_y + 10.8, uz + 3.4),
                (97.5, usb_y + 2.2, uz + 3.4),
            ])
            parts.append(f'  <polygon points="{utongue}" fill="#1e293b" stroke="#64748b" stroke-width="{fmt(0.3*scale)}"/>')
            for u_i in range(4):
                upy = usb_y + 3.2 + u_i * 2.1
                pa = iso.pt(97.5, upy, uz + 2.1)
                pb = iso.pt(97.5, upy + 0.5, uz + 1.2)
                parts.append(f'  <line x1="{fmt(pa[0])}" y1="{fmt(pa[1])}" x2="{fmt(pb[0])}" y2="{fmt(pb[1])}" stroke="#eab308" stroke-width="{fmt(0.5*scale)}"/>')

    # 7D. DisplayPort Connector
    parts.append(iso.shadow_box(81.0, 64.5, 5.0, 16.5, 11.0, dx=-1.0, dy=1.2, layers=2))
    parts.append(iso.box(
        81.0, 64.5, 5.0, 16.5, 11.0, 6.2,
        fill_top="#f1f5f9",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#64748b",
        stroke_w=0.5 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(f'  <g transform="{iso.plane_matrix(81.0, 64.5, 11.25)}">')
    parts.append('    <polyline points="5,2.5 11,3.2 11,4.5 5,4.2" fill="none" stroke="#475569" stroke-width="0.45"/>')
    parts.append('    <polyline points="5,6.8 11,7.5 11,8.8 5,8.5" fill="none" stroke="#475569" stroke-width="0.45"/>')
    parts.append('  </g>')
    dp_cav = iso.pts([
        (97.5, 65.8, 5.8),
        (97.5, 74.2, 5.8),
        (97.5, 74.2, 10.2),
        (97.5, 67.2, 10.2),
        (97.5, 65.8, 8.8),
    ])
    parts.append(f'  <polygon points="{dp_cav}" fill="#090d14" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')

    # 7E. Black DC Power Barrel Jack
    parts.append(iso.box(
        68.5, 68.5, 5.0, 9.5, 7.5, 8.2,
        fill_top="#262930",
        fill_front_y="#14161a",
        fill_side_x="#1c1f24",
        stroke="#374151",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(iso.box(
        69.2, 74.5, 5.0, 8.0, 4.8, 7.6,
        fill_top="#2d3139",
        fill_front_y="#111317",
        fill_side_x="#1f232a",
        stroke="#374151",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    dc_center = iso.pt(73.2, 79.3, 8.8)
    parts.append(f'  <ellipse cx="{fmt(dc_center[0])}" cy="{fmt(dc_center[1])}" rx="{fmt(7.5*scale)}" ry="{fmt(9.2*scale)}" transform="rotate(-22 {fmt(dc_center[0])} {fmt(dc_center[1])})" fill="#07080a" stroke="#374151" stroke-width="{fmt(0.7*scale)}"/>')
    parts.append(f'  <ellipse cx="{fmt(dc_center[0]+1.2*scale)}" cy="{fmt(dc_center[1]-0.8*scale)}" rx="{fmt(2.0*scale)}" ry="{fmt(2.6*scale)}" transform="rotate(-22 {fmt(dc_center[0]+1.2*scale)} {fmt(dc_center[1]-0.8*scale)})" fill="#cbd5e1" stroke="#475569" stroke-width="{fmt(0.4*scale)}"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso



def render_rpi5_hailo_group(
    ox: float = 28.0,
    oy: float = 550.0,
    scale: float = 0.62,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Renders the Raspberry Pi 5 + Official AI HAT+ (Hailo-8 26 TOPS M.2 Neural Accelerator)
    matching Reference Photo 2 & 3:
      - The 3 metallic port blocks sit side-by-side along the right edge (x = 74..100, y = 4.5..77.5),
        drawn in strict back-to-front painter's order:
          1. Back (y = 4.5..25.0): Dual USB 2.0 Tower (black tongues)
          2. Middle (y = 29.0..49.5): Dual USB 3.0 Tower (bright blue tongues #0284c7 -> O1 Capture NIC)
          3. Front (y = 53.5..77.5): Shielded Gigabit Ethernet RJ45 Jack (10.0.2.51)
      - The Hailo-8 AI HAT+ covers the left 68% of the board (x = 0..68, y = 0..80) on 4 brass hex
        standoffs, leaving all 3 metallic port towers on the right edge 100% uncovered from above!
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(1.85 * scale, 0.98 * scale),
        uy=(-2.65 * scale, 1.15 * scale),
        uz=(0.0, -1.75 * scale),
    )
    parts = ['  <g id="rpi5-hailo-assembly">']
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 100.0, 80.0, dx=-2.0, dy=3.0, layers=4))

    # 1. Bottom Layer: Raspberry Pi 5 Green PCB Base (100 x 80 x 2.0)
    parts.append(iso.box(
        0.0, 0.0, 0.0, 100.0, 80.0, 2.0,
        fill_top="#15803d",
        fill_front_y="#0f5128",
        fill_side_x="#115e2e",
        stroke="#166534",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # 2. Brass Hex Standoffs Supporting the AI HAT+ (z = 2.0 to z = 19.5 at x = 5.5 and x = 63.5)
    for sx, sy in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(iso.box(
            sx - 1.8, sy - 1.8, 2.0, 3.6, 3.6, 17.5,
            fill_top="#fbbf24",
            fill_front_y="#d97706",
            fill_side_x="#b45309",
            stroke="#78350f",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 3. Front-Left Edge of Pi 5 (along y = 69..80): USB-C Power + Dual Micro-HDMI Ports
    for port_x, port_w in [(12.0, 11.0), (28.0, 9.5), (42.0, 9.5)]:
        parts.append(iso.box(
            port_x, 69.0, 2.0, port_w, 11.0, 4.6,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.4 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 4. Top Deck (z = 19.5..21.3, x = 0..68, y = 0..80): Official Raspberry Pi M.2 / AI HAT+ Dark Matte PCB
    parts.append(iso.box(
        0.0, 0.0, 19.5, 68.0, 80.0, 1.8,
        fill_top="#1e293b",
        fill_front_y="#0f172a",
        fill_side_x="#111827",
        stroke="#475569",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    parts.append(f'  <g transform="{iso.plane_matrix(0, 0, 21.35)}">')
    for mx, my in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="2.8" fill="#cbd5e1" stroke="#64748b" stroke-width="0.35"/>')
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="1.3" fill="#334155"/>')
    parts.append('    <rect x="10.0" y="2.5" width="50.0" height="6.0" rx="0.5" fill="#090d16" stroke="#475569" stroke-width="0.35"/>')
    for p_i in range(20):
        px = 11.5 + p_i * 2.45
        parts.append(f'    <circle cx="{px:.1f}" cy="4.0" r="0.55" fill="#fbbf24"/>')
        parts.append(f'    <circle cx="{px:.1f}" cy="7.0" r="0.55" fill="#fbbf24"/>')
    parts.append('  </g>')

    # Hailo-8 M.2 2280 AI Accelerator Module Seated on the HAT (x = 10..60, y = 16..64, z = 21.3..25.0)
    parts.append(iso.box(
        10.0, 16.0, 21.3, 50.0, 48.0, 1.6,
        fill_top="#0f172a",
        fill_front_y="#020617",
        fill_side_x="#090d16",
        stroke="#38bdf8",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(iso.box(
        18.0, 24.0, 22.9, 34.0, 32.0, 3.1,
        fill_top="#111827",
        fill_front_y="#090d16",
        fill_side_x="#1f2937",
        stroke="#94a3b8",
        stroke_w=0.5 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(f'  <g transform="{iso.plane_matrix(18.0, 24.0, 26.05)}">')
    parts.append('    <rect x="1.5" y="1.5" width="31.0" height="29.0" rx="0.8" fill="none" stroke="#38bdf8" stroke-width="0.35"/>')
    parts.append('    <text x="17.0" y="12.5" font-family="GoogleSans, sans-serif" font-weight="900" font-size="5.2" fill="#f8fafc" letter-spacing="0.4" text-anchor="middle">HAILO-8</text>')
    parts.append('    <text x="17.0" y="18.5" font-family="RobotoMono, monospace" font-weight="700" font-size="3.1" fill="#38bdf8" text-anchor="middle">26 TOPS · PCIe</text>')
    parts.append('    <text x="17.0" y="24.2" font-family="RobotoMono, monospace" font-weight="700" font-size="2.7" fill="#cbd5e1" text-anchor="middle">10.0.2.51</text>')
    parts.append('  </g>')

    # 5. Front-Right Port Edge of Pi 5 (x = 74..100, across y = 4.5..77.5)
    for usb_y, tongue_col in [(4.5, "#334155"), (29.0, "#0284c7")]:
        parts.append(iso.box(
            76.0, usb_y, 2.0, 24.0, 20.5, 16.0,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#cbd5e1",
            stroke="#475569",
            stroke_w=0.55 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(f'  <g transform="{iso.plane_matrix(76.0, usb_y, 18.05)}">')
        parts.append('    <rect x="1.2" y="1.2" width="21.6" height="18.1" fill="none" stroke="#94a3b8" stroke-width="0.25"/>')
        parts.append('    <path d="M 10,4.5 L 18,4.5 M 10,7.5 L 18,7.5 M 10,13.0 L 18,13.0 M 10,16.0 L 18,16.0" stroke="#475569" stroke-width="0.5"/>')
        parts.append('  </g>')
        for slot_z in [4.2, 11.0]:
            ucav = iso.pts([
                (100.0, usb_y + 2.2, slot_z),
                (100.0, usb_y + 18.3, slot_z),
                (100.0, usb_y + 18.3, slot_z + 4.6),
                (100.0, usb_y + 2.2, slot_z + 4.6),
            ])
            parts.append(f'  <polygon points="{ucav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.35*scale)}"/>')
            utongue = iso.pts([
                (100.0, usb_y + 3.0, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 3.8),
                (100.0, usb_y + 3.0, slot_z + 3.8),
            ])
            parts.append(f'  <polygon points="{utongue}" fill="{tongue_col}"/>')

    rj5_y, rj5_d, rj5_h = 53.5, 24.0, 14.0
    parts.append(iso.box(
        74.0, rj5_y, 2.0, 26.0, rj5_d, rj5_h,
        fill_top="#e2e8f0",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#475569",
        stroke_w=0.55 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    rj5_cav = iso.pts([
        (100.0, rj5_y + 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 13.4),
        (100.0, rj5_y + 3.2, 13.4),
    ])
    parts.append(f'  <polygon points="{rj5_cav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')
    led5_g = iso.pt(100.0, rj5_y + rj5_d - 2.8, 4.8)
    led5_a = iso.pt(100.0, rj5_y + 2.8, 4.8)
    parts.append(f'  <circle cx="{fmt(led5_g[0])}" cy="{fmt(led5_g[1])}" r="{fmt(1.3*scale)}" fill="#22c55e"/>')
    parts.append(f'  <circle cx="{fmt(led5_a[0])}" cy="{fmt(led5_a[1])}" r="{fmt(1.3*scale)}" fill="#f59e0b"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso


def render_zodiac_fx_group(
    ox: float = 76.0,
    oy: float = 152.0,
    scale: float = 1.0,
    show_usb_cable: bool = True,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Returns the <g> element and projector for the Northbound Networks Zodiac FX Rev A OpenFlow Switch.
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(3.22 * scale, -0.86 * scale),
        uy=(1.06 * scale, 2.84 * scale),
        uz=(-0.38 * scale, -2.55 * scale),
    )
    parts = ['  <g id="zodiac-fx-board">']

    # Soft multi-layer vector ground shadow
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 100.0, 80.0, dx=-2.5, dy=3.5, layers=4))

    # 1. Plugged-in Black Micro-USB Cable
    if show_usb_cable:
        p_cab_far = iso.pt(-6.0, -52.0, 3.2)
        p_cab_mid = iso.pt(1.0, -26.0, 2.8)
        p_cab_boot = iso.pt(3.8, -10.0, 2.6)
        parts.append(f'  <path d="M {fmt(p_cab_far[0])},{fmt(p_cab_far[1])} Q {fmt(p_cab_mid[0])},{fmt(p_cab_mid[1])} {fmt(p_cab_boot[0])},{fmt(p_cab_boot[1])}" fill="none" stroke="#181b20" stroke-width="{fmt(10.5*scale)}" stroke-linecap="round"/>')
        parts.append(f'  <path d="M {fmt(p_cab_far[0]+1.5*scale)},{fmt(p_cab_far[1])} Q {fmt(p_cab_mid[0]+1.5*scale)},{fmt(p_cab_mid[1])} {fmt(p_cab_boot[0]+1.5*scale)},{fmt(p_cab_boot[1])}" fill="none" stroke="#374151" stroke-width="{fmt(2.2*scale)}" stroke-linecap="round"/>')
        parts.append(iso.box(
            1.2, -13.5, 1.2, 5.4, 6.5, 3.4,
            fill_top="#252930",
            fill_front_y="#16181d",
            fill_side_x="#0f1115",
            stroke="#374151",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmin", "top"),
        ))
        parts.append(iso.box(
            0.0, -7.0, 0.9, 7.8, 11.5, 4.2,
            fill_top="#2c3038",
            fill_front_y="#181b20",
            fill_side_x="#111317",
            stroke="#3f444e",
            stroke_w=0.45 * scale,
            faces=("ymax", "xmin", "top"),
        ))

    # 2. Zodiac FX Deep Cobalt-Blue PCB Substrate (#18325c)
    parts.append(iso.box(
        0.0, 0.0, 0.0, 100.0, 80.0, 1.8,
        fill_top="#18325c",
        fill_front_y="#1c2826",
        fill_side_x="#283530",
        stroke="#2d4a7c",
        stroke_w=0.65 * scale,
        faces=("ymax", "xmin", "top"),
    ))

    # 3. Planar PCB Traces, Silkscreen, Pads, Mounting Holes, SMD Passives
    parts.append(f'  <g transform="{iso.plane_matrix(0, 0, 1.82)}">')
    # Subtle sheen on upper-left PCB
    parts.append('    <polygon points="0,0 75,0 35,80 0,80" fill="#23457a" fill-opacity="0.28"/>')

    parts.append('    <g stroke="#284c85" stroke-width="0.45" fill="none" opacity="0.8">')
    parts.append('      <polyline points="12,15 24,25 32,34"/>')
    parts.append('      <polyline points="14,18 28,28 35,34"/>')
    parts.append('      <polyline points="42,39 52,36 56,33"/>')
    parts.append('      <polyline points="42,42 54,39 56,35"/>')
    parts.append('      <polyline points="42,45 55,42 56,37"/>')
    parts.append('      <polyline points="32,48 24,55"/>')
    parts.append('      <polyline points="36,48 42,55"/>')
    parts.append('      <polyline points="40,48 60,55"/>')
    parts.append('      <polyline points="68,38 80,55"/>')
    parts.append('      <polyline points="64,20 58,10"/>')
    parts.append('      <polyline points="72,22 84,14"/>')
    parts.append('    </g>')

    for mx, my in [(4.8, 5.2), (95.2, 5.2), (4.8, 74.8), (95.2, 74.8)]:
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="3.4" fill="#d49a56" stroke="#f3c68f" stroke-width="0.35"/>')
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="1.9" fill="#18191c"/>')
        for v_ang in range(0, 360, 45):
            rad = math.radians(v_ang)
            vx = mx + 2.65 * math.cos(rad)
            vy = my + 2.65 * math.sin(rad)
            parts.append(f'    <circle cx="{vx:.2f}" cy="{vy:.2f}" r="0.22" fill="#0f2244"/>')

    # Regulatory Markings along Left Edge
    parts.append('    <g fill="#f8fafc" stroke="none" opacity="0.92">')
    parts.append('      <circle cx="6.2" cy="29.0" r="2.6" fill="none" stroke="#f8fafc" stroke-width="0.45"/>')
    parts.append('      <polygon points="4.8,29.8 7.6,29.8 6.2,27.2" fill="none" stroke="#f8fafc" stroke-width="0.4"/>')
    parts.append('      <text x="3.2" y="39.5" font-family="GoogleSans, sans-serif" font-weight="900" font-size="5.6" letter-spacing="-0.4">FC</text>')
    parts.append('      <text x="3.0" y="47.2" font-family="GoogleSans, sans-serif" font-weight="900" font-size="5.6" letter-spacing="0.2">CE</text>')
    parts.append('      <rect x="4.5" y="50.5" width="3.2" height="3.8" fill="none" stroke="#f8fafc" stroke-width="0.38"/>')
    parts.append('      <line x1="3.3" y1="49.8" x2="8.9" y2="55.2" stroke="#f8fafc" stroke-width="0.45"/>')
    parts.append('      <line x1="8.9" y1="49.8" x2="3.3" y2="55.2" stroke="#f8fafc" stroke-width="0.45"/>')
    parts.append('      <text x="8.8" y="56.5" font-family="RobotoMono, monospace" font-weight="700" font-size="1.65" transform="rotate(90 8.8 56.5)">CAN ICES-3 (B)/NMB-3(B)</text>')
    parts.append('    </g>')

    # Center "Northbound NETWORKS" Silkscreen Logo
    parts.append('    <g transform="translate(25.5, 28.0)" fill="#ffffff">')
    parts.append('      <rect x="0.0" y="-1.1" width="0.6" height="1.1" rx="0.2"/>')
    parts.append('      <rect x="1.1" y="-2.0" width="0.6" height="2.0" rx="0.2"/>')
    parts.append('      <rect x="2.2" y="-3.0" width="0.6" height="3.0" rx="0.2"/>')
    parts.append('      <rect x="3.3" y="-4.1" width="0.6" height="4.1" rx="0.2"/>')
    parts.append('      <rect x="4.4" y="-5.3" width="0.6" height="5.3" rx="0.2"/>')
    parts.append('      <text x="6.0" y="-1.3" font-family="GoogleSans, sans-serif" font-weight="800" font-size="3.1" letter-spacing="0.08">Northbound</text>')
    parts.append('      <text x="14.2" y="0.5" font-family="GoogleSans, sans-serif" font-weight="700" font-size="1.45" letter-spacing="0.4" fill="#cbd5e1">NETWORKS</text>')
    parts.append('    </g>')

    parts.append('    <text x="55.5" y="13.8" font-family="RobotoMono, monospace" font-weight="700" font-size="1.6" fill="#ffffff">MASTER</text>')
    parts.append('    <text x="67.0" y="4.2" font-family="GoogleSans, sans-serif" font-weight="700" font-size="1.55" fill="#ffffff" transform="rotate(180 67.0 4.2)">MADE IN AUSTRALIA</text>')
    parts.append('    <polygon points="71.5,13.5 79.5,13.5 75.5,6.8" fill="#ffffff"/>')
    parts.append('    <polygon points="73.2,12.8 77.8,12.8 75.5,8.8" fill="#18325c"/>')
    parts.append('    <line x1="72.5" y1="10.2" x2="78.5" y2="12.2" stroke="#ffffff" stroke-width="0.6"/>')

    parts.append('    <text x="89.5" y="18.2" font-family="RobotoMono, monospace" font-weight="700" font-size="1.6" fill="#ffffff">JTAG</text>')
    parts.append('    <text x="80.5" y="38.2" font-family="RobotoMono, monospace" font-weight="700" font-size="1.6" fill="#ffffff">ERASE</text>')

    parts.append('    <text x="92.8" y="44.0" font-family="GoogleSans, sans-serif" font-weight="800" font-size="2.1" fill="#ffffff" transform="rotate(-90 92.8 44.0)">ZODIAC FX - Rev A</text>')
    parts.append('    <text x="95.2" y="44.0" font-family="GoogleSans, sans-serif" font-weight="700" font-size="1.85" fill="#cbd5e1" transform="rotate(-90 95.2 44.0)">Northbound Networks 2016</text>')

    # SMD Passive Components
    parts.append('    <rect x="18.0" y="33.0" width="3.4" height="2.4" rx="0.3" fill="#eab308" stroke="#ca8a04" stroke-width="0.2"/>')
    parts.append('    <rect x="20.6" y="33.0" width="0.7" height="2.4" fill="#a16207"/>')
    parts.append('    <rect x="21.0" y="45.8" width="4.2" height="2.8" rx="0.4" fill="#cbd5e1" stroke="#64748b" stroke-width="0.25"/>')
    parts.append('    <rect x="21.6" y="46.2" width="3.0" height="2.0" rx="0.2" fill="#94a3b8"/>')
    parts.append('    <rect x="51.5" y="16.0" width="3.6" height="2.4" rx="0.4" fill="#cbd5e1" stroke="#64748b" stroke-width="0.25"/>')
    parts.append('    <rect x="54.0" y="41.5" width="3.2" height="4.2" fill="#e2e8f0" stroke="#475569" stroke-width="0.25"/>')
    parts.append('    <rect x="54.8" y="42.5" width="1.6" height="2.2" rx="0.4" fill="#b45309"/>')

    smds = [
        (14, 29), (14, 31), (17, 22), (24, 21), (26, 21), (32, 19), (34, 19),
        (22, 41), (22, 43), (25, 43), (45, 32), (47, 32), (45, 34), (48, 36),
        (50, 38), (51, 40), (51, 43), (51, 45), (48, 22), (50, 22), (56, 17),
        (60, 17), (68, 16), (70, 16), (76, 23), (78, 23), (74, 34), (74, 36),
    ]
    for sx, sy in smds:
        parts.append(f'    <rect x="{sx}" y="{sy}" width="1.8" height="0.95" fill="#cbd5e1"/>')
        parts.append(f'    <rect x="{sx+0.4}" y="{sy+0.1}" width="1.0" height="0.75" fill="#92400e"/>')

    # 4. Integrated Circuits
    for soic_x, soic_y in [(17.5, 13.5), (26.5, 13.5), (76.0, 15.5)]:
        for p_i in range(4):
            px = soic_x + 0.8 + p_i * 1.25
            parts.append(f'    <rect x="{px:.2f}" y="{soic_y-1.1:.2f}" width="0.55" height="1.2" fill="#e2e8f0"/>')
            parts.append(f'    <rect x="{px:.2f}" y="{soic_y+4.4:.2f}" width="0.55" height="1.2" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{soic_x}" y="{soic_y}" width="5.8" height="4.5" rx="0.3" fill="#20242c" stroke="#475569" stroke-width="0.22"/>')
        parts.append(f'    <circle cx="{soic_x+0.9}" cy="{soic_y+3.6}" r="0.35" fill="#94a3b8"/>')

    # Micrel KSZ8795CLXCC 80-Pin LQFP Switch IC
    mx0, my0, mw = 28.5, 33.5, 13.0
    parts.append(f'    <rect x="{mx0-1.4}" y="{my0-1.4}" width="{mw+2.8}" height="{mw+2.8}" fill="none" stroke="#cbd5e1" stroke-width="0.22"/>')
    for p_i in range(18):
        ofs = 0.8 + p_i * ((mw - 1.6) / 17.0)
        parts.append(f'    <rect x="{mx0+ofs-0.18:.2f}" y="{my0-1.2:.2f}" width="0.36" height="1.3" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{mx0+ofs-0.18:.2f}" y="{my0+mw-0.1:.2f}" width="0.36" height="1.3" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{mx0-1.2:.2f}" y="{my0+ofs-0.18:.2f}" width="1.3" height="0.36" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{mx0+mw-0.1:.2f}" y="{my0+ofs-0.18:.2f}" width="1.3" height="0.36" fill="#e2e8f0"/>')
    parts.append(f'    <rect x="{mx0}" y="{my0}" width="{mw}" height="{mw}" rx="0.5" fill="#20242c" stroke="#475569" stroke-width="0.3"/>')
    parts.append(f'    <rect x="{mx0+0.6}" y="{my0+0.6}" width="{mw-1.2}" height="{mw-1.2}" fill="none" stroke="#334155" stroke-width="0.2"/>')
    parts.append(f'    <circle cx="{mx0+1.8}" cy="{my0+mw-1.8}" r="0.55" fill="#94a3b8"/>')
    parts.append(f'    <text x="{mx0+6.5}" y="{my0+4.5}" font-family="GoogleSans, sans-serif" font-weight="800" font-size="1.95" fill="#e2e8f0" text-anchor="middle">MICREL</text>')
    parts.append(f'    <text x="{mx0+6.5}" y="{my0+6.6}" font-family="RobotoMono, monospace" font-weight="700" font-size="1.45" fill="#cbd5e1" text-anchor="middle">KSZ8795CLXCC</text>')
    parts.append(f'    <text x="{mx0+6.5}" y="{my0+8.3}" font-family="RobotoMono, monospace" font-size="1.2" fill="#94a3b8" text-anchor="middle">1529A2T</text>')
    parts.append(f'    <text x="{mx0+6.5}" y="{my0+9.8}" font-family="RobotoMono, monospace" font-size="1.1" fill="#94a3b8" text-anchor="middle">1529054.1H</text>')

    # Atmel ATSAM4E8C 100-Pin LQFP Microcontroller
    ax0, ay0, aw = 55.5, 21.5, 17.0
    parts.append(f'    <rect x="{ax0-1.6}" y="{ay0-1.6}" width="{aw+3.2}" height="{aw+3.2}" fill="none" stroke="#cbd5e1" stroke-width="0.25"/>')
    for p_i in range(22):
        ofs = 0.9 + p_i * ((aw - 1.8) / 21.0)
        parts.append(f'    <rect x="{ax0+ofs-0.18:.2f}" y="{ay0-1.35:.2f}" width="0.36" height="1.45" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{ax0+ofs-0.18:.2f}" y="{ay0+aw-0.1:.2f}" width="0.36" height="1.45" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{ax0-1.35:.2f}" y="{ay0+ofs-0.18:.2f}" width="1.45" height="0.36" fill="#e2e8f0"/>')
        parts.append(f'    <rect x="{ax0+aw-0.1:.2f}" y="{ay0+ofs-0.18:.2f}" width="1.45" height="0.36" fill="#e2e8f0"/>')
    parts.append(f'    <rect x="{ax0}" y="{ay0}" width="{aw}" height="{aw}" rx="0.6" fill="#20242c" stroke="#475569" stroke-width="0.35"/>')
    parts.append(f'    <rect x="{ax0+0.8}" y="{ay0+0.8}" width="{aw-1.6}" height="{aw-1.6}" fill="none" stroke="#334155" stroke-width="0.22"/>')
    parts.append(f'    <circle cx="{ax0+2.2}" cy="{ay0+2.2}" r="0.65" fill="#94a3b8"/>')
    parts.append(f'    <g transform="translate({ax0+8.5}, {ay0+8.5}) rotate(90)">')
    parts.append('      <text x="0" y="-2.2" font-family="GoogleSans, sans-serif" font-weight="800" font-size="3.1" fill="#cbd5e1" text-anchor="middle">Atmel</text>')
    parts.append('      <text x="-1.5" y="0.5" font-family="RobotoMono, monospace" font-weight="700" font-size="1.45" fill="#94a3b8" text-anchor="middle">ATSAM4E8C</text>')
    parts.append('      <text x="-2.2" y="2.2" font-family="RobotoMono, monospace" font-size="1.25" fill="#94a3b8" text-anchor="middle">AU</text>')
    parts.append('      <text x="2.8" y="2.8" font-family="GoogleSans, sans-serif" font-weight="900" font-size="1.6" fill="#cbd5e1" text-anchor="middle">ARM</text>')
    parts.append('    </g>')
    parts.append('  </g>')

    # 5. 3D Silver Micro-USB Receptacle + Bright Green LED Glow
    parts.append(iso.box(
        0.2, 4.5, 1.8, 7.6, 8.5, 3.2,
        fill_top="#e2e8f0",
        fill_front_y="#cbd5e1",
        fill_side_x="#94a3b8",
        stroke="#64748b",
        stroke_w=0.4 * scale,
        faces=("ymax", "xmin", "top"),
    ))
    usb_refl = iso.pts([(0.2, 13.0, 1.8), (7.8, 13.0, 1.8), (7.8, 13.0, 5.0), (0.2, 13.0, 5.0)])
    parts.append(f'  <polygon points="{usb_refl}" fill="#00e676" fill-opacity="0.58"/>')

    led_pt = iso.pt(5.8, 19.2, 2.0)
    for r_mult, op in [(22, 0.14), (15, 0.25), (9, 0.55), (5.5, 0.85)]:
        parts.append(f'  <circle cx="{fmt(led_pt[0])}" cy="{fmt(led_pt[1])}" r="{fmt(r_mult*scale)}" fill="#00e676" fill-opacity="{op}"/>')
    parts.append(f'  <circle cx="{fmt(led_pt[0])}" cy="{fmt(led_pt[1])}" r="{fmt(3.2*scale)}" fill="#ffffff" stroke="#69f0ae" stroke-width="{fmt(1.0*scale)}"/>')

    # 6. 3D Pin Headers & Black Jumper Shunts
    parts.append(iso.box(
        38.0, 2.5, 1.8, 12.5, 5.5, 2.4,
        fill_top="#1f242d",
        fill_front_y="#111318",
        fill_side_x="#0b0d10",
        stroke="#374151",
        stroke_w=0.35 * scale,
        faces=("ymax", "xmin", "top"),
    ))
    for h_i in range(5):
        hx = 39.4 + h_i * 2.4
        for hy in [3.8, 6.6]:
            pb = iso.pt(hx, hy, 4.2)
            pt = iso.pt(hx, hy, 11.5)
            parts.append(f'  <line x1="{fmt(pb[0])}" y1="{fmt(pb[1])}" x2="{fmt(pt[0])}" y2="{fmt(pt[1])}" stroke="#cbd5e1" stroke-width="{fmt(1.35*scale)}" stroke-linecap="square"/>')
            parts.append(f'  <circle cx="{fmt(pt[0])}" cy="{fmt(pt[1])}" r="{fmt(0.6*scale)}" fill="#ffffff"/>')

    parts.append(iso.box(
        56.0, 3.5, 1.8, 3.6, 5.8, 10.5,
        fill_top="#2d323b",
        fill_front_y="#16191e",
        fill_side_x="#0e1014",
        stroke="#475569",
        stroke_w=0.4 * scale,
        faces=("ymax", "xmin", "top"),
    ))

    parts.append(iso.box(
        85.0, 4.0, 1.8, 5.2, 11.0, 2.2,
        fill_top="#1f242d",
        fill_front_y="#111318",
        fill_side_x="#0b0d10",
        stroke="#374151",
        stroke_w=0.35 * scale,
        faces=("ymax", "xmin", "top"),
    ))
    for j_i in range(5):
        jy = 5.2 + j_i * 2.1
        for jx in [86.3, 88.8]:
            pb = iso.pt(jx, jy, 4.0)
            pt = iso.pt(jx, jy, 10.8)
            parts.append(f'  <line x1="{fmt(pb[0])}" y1="{fmt(pb[1])}" x2="{fmt(pt[0])}" y2="{fmt(pt[1])}" stroke="#cbd5e1" stroke-width="{fmt(1.15*scale)}" stroke-linecap="square"/>')
            parts.append(f'  <circle cx="{fmt(pt[0])}" cy="{fmt(pt[1])}" r="{fmt(0.5*scale)}" fill="#ffffff"/>')

    parts.append(iso.box(
        81.0, 27.0, 1.8, 3.6, 5.8, 10.2,
        fill_top="#2d323b",
        fill_front_y="#16191e",
        fill_side_x="#0e1014",
        stroke="#475569",
        stroke_w=0.4 * scale,
        faces=("ymax", "xmin", "top"),
    ))

    # 7. Four Sharevve Shielded Chrome RJ45 Jacks (Brushed Nickel/Silver matching Photo 2!)
    jack_w = 16.2
    jack_d = 26.5
    jack_h = 14.2
    y_jack0 = 54.2

    for idx in reversed(range(4)):
        jx0 = 14.5 + idx * 19.6
        parts.append(f'  <g transform="{iso.plane_matrix(jx0 - 1.2, y_jack0 + 6.0, 1.85)}">')
        parts.append('    <ellipse cx="0.6" cy="2.0" rx="1.2" ry="2.2" fill="#cbd5e1" stroke="#64748b" stroke-width="0.25"/>')
        parts.append('    <ellipse cx="0.6" cy="14.0" rx="1.2" ry="2.2" fill="#cbd5e1" stroke="#64748b" stroke-width="0.25"/>')
        parts.append('  </g>')

        parts.append(iso.shadow_box(jx0, y_jack0, 1.8, jack_w, jack_d, dx=-1.5, dy=1.5, layers=2))
        parts.append(iso.box(
            jx0, y_jack0, 1.8, jack_w, jack_d, jack_h,
            fill_top="#e2e8f0",
            fill_front_y="#cbd5e1",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.55 * scale,
            faces=("xmin", "ymax", "top"),
        ))

        parts.append(f'  <g transform="{iso.plane_matrix(jx0, y_jack0, 1.8 + jack_h + 0.05)}">')
        # Metallic diagonal specular sheen across top of chrome RJ45 housing
        parts.append(f'    <polygon points="0.6,0.6 {jack_w-0.6},0.6 {jack_w*0.65:.1f},{jack_d-0.6} 0.6,{jack_d-0.6}" fill="#f8fafc" fill-opacity="0.55"/>')
        parts.append(f'    <rect x="0.8" y="0.8" width="{jack_w-1.6}" height="{jack_d-1.6}" fill="none" stroke="#94a3b8" stroke-width="0.25"/>')
        parts.append(f'    <text x="{jack_w/2:.1f}" y="6.2" font-family="GoogleSans, sans-serif" font-weight="700" font-size="2.3" fill="#475569" opacity="0.82" text-anchor="middle">Sharevve</text>')
        parts.append(f'    <text x="{jack_w/2:.1f}" y="9.0" font-family="RobotoMono, monospace" font-weight="600" font-size="1.8" fill="#475569" opacity="0.78" text-anchor="middle">SRJ2118A31</text>')
        parts.append(f'    <text x="{jack_w/2:.1f}" y="11.4" font-family="RobotoMono, monospace" font-weight="600" font-size="1.75" fill="#475569" opacity="0.75" text-anchor="middle">1612</text>')

        for tab_x in [3.4, 9.8]:
            parts.append(f'    <path d="M {tab_x},16.5 L {tab_x},25.5 L {tab_x+3.0},25.5 L {tab_x+3.0},16.5" fill="none" stroke="#1e293b" stroke-width="0.65"/>')
            parts.append(f'    <rect x="{tab_x+0.35}" y="16.5" width="2.3" height="8.6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="0.2"/>')
        parts.append('  </g>')

        yf = y_jack0 + jack_d
        cav_pts = iso.pts([
            (jx0 + 2.0, yf, 4.2),
            (jx0 + 5.2, yf, 4.2),
            (jx0 + 5.2, yf, 2.6),
            (jx0 + jack_w - 5.2, yf, 2.6),
            (jx0 + jack_w - 5.2, yf, 4.2),
            (jx0 + jack_w - 2.0, yf, 4.2),
            (jx0 + jack_w - 2.0, yf, 13.8),
            (jx0 + 2.0, yf, 13.8),
        ])
        parts.append(f'  <polygon points="{cav_pts}" fill="#080c14" stroke="#1e293b" stroke-width="{fmt(0.5*scale)}"/>')

        floor_pts = iso.pts([
            (jx0 + 2.3, yf, 4.3),
            (jx0 + jack_w - 2.3, yf, 4.3),
            (jx0 + jack_w - 3.0, yf - 6.5, 5.5),
            (jx0 + 3.0, yf - 6.5, 5.5),
        ])
        parts.append(f'  <polygon points="{floor_pts}" fill="#1e293b"/>')

        lwall_pts = iso.pts([
            (jx0 + 2.1, yf, 4.3),
            (jx0 + 2.1, yf, 13.6),
            (jx0 + 3.0, yf - 6.5, 12.8),
            (jx0 + 3.0, yf - 6.5, 5.5),
        ])
        parts.append(f'  <polygon points="{lwall_pts}" fill="#111827"/>')

        for ftab_x in [jx0 + 3.4, jx0 + 9.8]:
            ftab_pts = iso.pts([
                (ftab_x, yf, 14.0),
                (ftab_x + 2.8, yf, 14.0),
                (ftab_x + 2.6, yf - 1.2, 11.8),
                (ftab_x + 0.2, yf - 1.2, 11.8),
            ])
            parts.append(f'  <polygon points="{ftab_pts}" fill="#e2e8f0" stroke="#475569" stroke-width="{fmt(0.3*scale)}"/>')

        for pin_k in range(6):
            px = jx0 + 4.2 + pin_k * 1.55
            p1 = iso.pt(px, yf - 1.5, 12.2)
            p2 = iso.pt(px, yf - 5.5, 9.5)
            parts.append(f'  <line x1="{fmt(p1[0])}" y1="{fmt(p1[1])}" x2="{fmt(p2[0])}" y2="{fmt(p2[1])}" stroke="#eab308" stroke-width="{fmt(0.45*scale)}" opacity="0.85"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso



def render_rpi5_hailo_group(
    ox: float = 28.0,
    oy: float = 550.0,
    scale: float = 0.62,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Renders the Raspberry Pi 5 + Official AI HAT+ (Hailo-8 26 TOPS M.2 Neural Accelerator)
    matching Reference Photo 2 & 3:
      - The 3 metallic port blocks sit side-by-side along the right edge (x = 74..100, y = 4.5..77.5),
        drawn in strict back-to-front painter's order:
          1. Back (y = 4.5..25.0): Dual USB 2.0 Tower (black tongues)
          2. Middle (y = 29.0..49.5): Dual USB 3.0 Tower (bright blue tongues #0284c7 -> O1 Capture NIC)
          3. Front (y = 53.5..77.5): Shielded Gigabit Ethernet RJ45 Jack (10.0.2.51)
      - The Hailo-8 AI HAT+ covers the left 68% of the board (x = 0..68, y = 0..80) on 4 brass hex
        standoffs, leaving all 3 metallic port towers on the right edge 100% uncovered from above!
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(1.85 * scale, 0.98 * scale),
        uy=(-2.65 * scale, 1.15 * scale),
        uz=(0.0, -1.75 * scale),
    )
    parts = ['  <g id="rpi5-hailo-assembly">']
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 100.0, 80.0, dx=-2.0, dy=3.0, layers=4))

    # 1. Bottom Layer: Raspberry Pi 5 Green PCB Base (100 x 80 x 2.0)
    parts.append(iso.box(
        0.0, 0.0, 0.0, 100.0, 80.0, 2.0,
        fill_top="#15803d",
        fill_front_y="#0f5128",
        fill_side_x="#115e2e",
        stroke="#166534",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # 2. Brass Hex Standoffs Supporting the AI HAT+ (z = 2.0 to z = 19.5 at x = 5.5 and x = 63.5)
    for sx, sy in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(iso.box(
            sx - 1.8, sy - 1.8, 2.0, 3.6, 3.6, 17.5,
            fill_top="#fbbf24",
            fill_front_y="#d97706",
            fill_side_x="#b45309",
            stroke="#78350f",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 3. Front-Left Edge of Pi 5 (along y = 69..80): USB-C Power + Dual Micro-HDMI Ports
    for port_x, port_w in [(12.0, 11.0), (28.0, 9.5), (42.0, 9.5)]:
        parts.append(iso.box(
            port_x, 69.0, 2.0, port_w, 11.0, 4.6,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.4 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 4. Top Deck (z = 19.5..21.3, x = 0..68, y = 0..80): Official Raspberry Pi M.2 / AI HAT+ Dark Matte PCB
    parts.append(iso.box(
        0.0, 0.0, 19.5, 68.0, 80.0, 1.8,
        fill_top="#1e293b",
        fill_front_y="#0f172a",
        fill_side_x="#111827",
        stroke="#475569",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    parts.append(f'  <g transform="{iso.plane_matrix(0, 0, 21.35)}">')
    for mx, my in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="2.8" fill="#cbd5e1" stroke="#64748b" stroke-width="0.35"/>')
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="1.3" fill="#334155"/>')
    parts.append('    <rect x="10.0" y="2.5" width="50.0" height="6.0" rx="0.5" fill="#090d16" stroke="#475569" stroke-width="0.35"/>')
    for p_i in range(20):
        px = 11.5 + p_i * 2.45
        parts.append(f'    <circle cx="{px:.1f}" cy="4.0" r="0.55" fill="#fbbf24"/>')
        parts.append(f'    <circle cx="{px:.1f}" cy="7.0" r="0.55" fill="#fbbf24"/>')
    parts.append('  </g>')

    # Hailo-8 M.2 2280 AI Accelerator Module Seated on the HAT (x = 10..60, y = 16..64, z = 21.3..25.0)
    parts.append(iso.box(
        10.0, 16.0, 21.3, 50.0, 48.0, 1.6,
        fill_top="#0f172a",
        fill_front_y="#020617",
        fill_side_x="#090d16",
        stroke="#38bdf8",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(iso.box(
        18.0, 24.0, 22.9, 34.0, 32.0, 3.1,
        fill_top="#111827",
        fill_front_y="#090d16",
        fill_side_x="#1f2937",
        stroke="#94a3b8",
        stroke_w=0.5 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(f'  <g transform="{iso.plane_matrix(18.0, 24.0, 26.05)}">')
    parts.append('    <rect x="1.5" y="1.5" width="31.0" height="29.0" rx="0.8" fill="none" stroke="#38bdf8" stroke-width="0.35"/>')
    parts.append('    <text x="17.0" y="12.5" font-family="GoogleSans, sans-serif" font-weight="900" font-size="5.2" fill="#f8fafc" letter-spacing="0.4" text-anchor="middle">HAILO-8</text>')
    parts.append('    <text x="17.0" y="18.5" font-family="RobotoMono, monospace" font-weight="700" font-size="3.1" fill="#38bdf8" text-anchor="middle">26 TOPS · PCIe</text>')
    parts.append('    <text x="17.0" y="24.2" font-family="RobotoMono, monospace" font-weight="700" font-size="2.7" fill="#cbd5e1" text-anchor="middle">10.0.2.51</text>')
    parts.append('  </g>')

    # 5. Front-Right Port Edge of Pi 5 (x = 74..100, across y = 4.5..77.5)
    for usb_y, tongue_col in [(4.5, "#334155"), (29.0, "#0284c7")]:
        parts.append(iso.box(
            76.0, usb_y, 2.0, 24.0, 20.5, 16.0,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#cbd5e1",
            stroke="#475569",
            stroke_w=0.55 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(f'  <g transform="{iso.plane_matrix(76.0, usb_y, 18.05)}">')
        parts.append('    <rect x="1.2" y="1.2" width="21.6" height="18.1" fill="none" stroke="#94a3b8" stroke-width="0.25"/>')
        parts.append('    <path d="M 10,4.5 L 18,4.5 M 10,7.5 L 18,7.5 M 10,13.0 L 18,13.0 M 10,16.0 L 18,16.0" stroke="#475569" stroke-width="0.5"/>')
        parts.append('  </g>')
        for slot_z in [4.2, 11.0]:
            ucav = iso.pts([
                (100.0, usb_y + 2.2, slot_z),
                (100.0, usb_y + 18.3, slot_z),
                (100.0, usb_y + 18.3, slot_z + 4.6),
                (100.0, usb_y + 2.2, slot_z + 4.6),
            ])
            parts.append(f'  <polygon points="{ucav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.35*scale)}"/>')
            utongue = iso.pts([
                (100.0, usb_y + 3.0, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 3.8),
                (100.0, usb_y + 3.0, slot_z + 3.8),
            ])
            parts.append(f'  <polygon points="{utongue}" fill="{tongue_col}"/>')

    rj5_y, rj5_d, rj5_h = 53.5, 24.0, 14.0
    parts.append(iso.box(
        74.0, rj5_y, 2.0, 26.0, rj5_d, rj5_h,
        fill_top="#e2e8f0",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#475569",
        stroke_w=0.55 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    rj5_cav = iso.pts([
        (100.0, rj5_y + 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 13.4),
        (100.0, rj5_y + 3.2, 13.4),
    ])
    parts.append(f'  <polygon points="{rj5_cav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')
    led5_g = iso.pt(100.0, rj5_y + rj5_d - 2.8, 4.8)
    led5_a = iso.pt(100.0, rj5_y + 2.8, 4.8)
    parts.append(f'  <circle cx="{fmt(led5_g[0])}" cy="{fmt(led5_g[1])}" r="{fmt(1.3*scale)}" fill="#22c55e"/>')
    parts.append(f'  <circle cx="{fmt(led5_a[0])}" cy="{fmt(led5_a[1])}" r="{fmt(1.3*scale)}" fill="#f59e0b"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso


def generate_jetson_orin_svg(width: int = 560, height: int = 440, bg_color: str | None = "#ffffff") -> str:
    grp, _ = render_jetson_orin_group(ox=268.0, oy=64.0, scale=1.0)
    bg = f'  <rect width="{width}" height="{height}" fill="{bg_color}"/>\n' if bg_color else ""
    return f'<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">\n{bg}{grp}\n</svg>'


def generate_zodiac_fx_svg(width: int = 560, height: int = 440, bg_color: str | None = "#f4f1ea") -> str:
    grp, _ = render_zodiac_fx_group(ox=76.0, oy=152.0, scale=1.0, show_usb_cable=True)
    bg = f'  <rect width="{width}" height="{height}" fill="{bg_color}"/>\n' if bg_color else ""
    return f'<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">\n{bg}{grp}\n</svg>'


def render_netgear_stack_group(
    ox: float = 28.0,
    oy: float = 195.0,
    scale: float = 0.84,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(2.15 * scale, -0.72 * scale),
        uy=(0.95 * scale, 1.55 * scale),
        uz=(0.0, -1.65 * scale),
    )
    ux_deg = math.degrees(math.atan2(iso.ux[1], iso.ux[0]))
    uy_deg = math.degrees(math.atan2(iso.uy[1], iso.uy[0]))
    parts = ['  <g id="netgear-switch-stack">']
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 96.0, 62.0, dx=-2.0, dy=3.0, layers=4))

    for tier_idx, (z0, label_tag, role_tag, role_col) in enumerate([
        (0.0, "GS105Ev2 #1", "TIER 2 · WORKLOAD", "#60a5fa"),
        (30.0, "GS105Ev2 #2", "TIER 3 · UPLINK", "#34d399"),
    ]):
        parts.append(iso.box(
            0.0, 0.0, z0, 96.0, 62.0, 23.0,
            fill_top="#263349",
            fill_front_y="#162032",
            fill_side_x="#111927",
            stroke="#475569",
            stroke_w=0.65 * scale,
            faces=("xmin", "ymax", "top"),
        ))
        # Role label on the visible front-left side face (xmin face) of each switch
        p_side = iso.pt(0.0, 31.0, z0 + 9.5)
        parts.append(f'  <text x="{fmt(p_side[0])}" y="{fmt(p_side[1])}" font-family="GoogleSans, sans-serif" font-weight="800" font-size="{fmt(5.8*scale)}" fill="{role_col}" text-anchor="middle" transform="rotate({fmt(uy_deg)} {fmt(p_side[0])} {fmt(p_side[1])})">{role_tag}</text>')

        bezel = iso.pts([
            (3.0, 62.0, z0 + 2.2),
            (93.0, 62.0, z0 + 2.2),
            (93.0, 62.0, z0 + 20.8),
            (3.0, 62.0, z0 + 20.8),
        ])
        parts.append(f'  <polygon points="{bezel}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.45*scale)}"/>')

        p_brand = iso.pt(6.5, 62.0, z0 + 13.8)
        parts.append(f'  <text x="{fmt(p_brand[0])}" y="{fmt(p_brand[1])}" font-family="GoogleSans, sans-serif" font-weight="800" font-size="{fmt(7.2*scale)}" fill="#cbd5e1" transform="rotate({fmt(ux_deg)} {fmt(p_brand[0])} {fmt(p_brand[1])})">NETGEAR</text>')
        p_sub = iso.pt(6.5, 62.0, z0 + 7.5)
        parts.append(f'  <text x="{fmt(p_sub[0])}" y="{fmt(p_sub[1])}" font-family="RobotoMono, monospace" font-weight="600" font-size="{fmt(5.0*scale)}" fill="#64748b" transform="rotate({fmt(ux_deg)} {fmt(p_sub[0])} {fmt(p_sub[1])})">{label_tag}</text>')

        p_pwr = iso.pt(28.0, 62.0, z0 + 14.2)
        parts.append(f'  <circle cx="{fmt(p_pwr[0])}" cy="{fmt(p_pwr[1])}" r="{fmt(1.6*scale)}" fill="#22c55e"/>')

        for p_i in range(5):
            px0 = 33.5 + p_i * 11.4
            pcav = iso.pts([
                (px0, 62.0, z0 + 5.2),
                (px0 + 8.8, 62.0, z0 + 5.2),
                (px0 + 8.8, 62.0, z0 + 15.5),
                (px0, 62.0, z0 + 15.5),
            ])
            parts.append(f'  <polygon points="{pcav}" fill="#020617" stroke="#475569" stroke-width="{fmt(0.45*scale)}"/>')
            pled = iso.pt(px0 + 2.2, 62.0, z0 + 18.0)
            led_col = "#22c55e"
            parts.append(f'  <circle cx="{fmt(pled[0])}" cy="{fmt(pled[1])}" r="{fmt(1.3*scale)}" fill="{led_col}"/>')
            plbl = iso.pt(px0 + 4.4, 62.0, z0 + 2.5)
            parts.append(f'  <text x="{fmt(plbl[0])}" y="{fmt(plbl[1])}" font-family="RobotoMono, monospace" font-weight="700" font-size="{fmt(4.6*scale)}" fill="#94a3b8" text-anchor="middle" transform="rotate({fmt(ux_deg)} {fmt(plbl[0])} {fmt(plbl[1])})">P{p_i+1}</text>')

    parts.append('  </g>')
    return "\n".join(parts), iso


def render_rpi3b_stack_group(
    ox: float = 28.0,
    oy: float = 128.0,
    scale: float = 0.62,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Renders a 2-tier stack of Raspberry Pi 3 Model B+ boards (Red Team / Untrusted Workload
    nodes: agentic-node-01 10.0.2.50 and agentic-node-02 10.0.2.52) matching the exact
    board geometry of Reference Photo 1 & 3:
      - Local x (0..100) runs along D_vec (down-right): carries Micro-USB, HDMI, CSI, 3.5mm Audio along y=80,
        and the 40-pin GPIO header along y=0.
      - Local y (80..0) runs along W_vec (up-right): carries the 3 side-by-side metallic port housings
        along x=100: [Ethernet RJ45 (y=54..78)] [Dual USB #1 (y=29..50)] [Dual USB #2 (y=4.5..25.5)],
        drawn in strict back-to-front painter's order (y=4.5 first, y=29.0 second, y=54.0 last)
        so they sit cleanly side-by-side with zero overlap.
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(1.85 * scale, 0.98 * scale),
        uy=(-2.65 * scale, 1.15 * scale),
        uz=(0.0, -1.75 * scale),
    )
    parts = ['  <g id="rpi3b-redteam-stack">']
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 100.0, 80.0, dx=-2.0, dy=3.0, layers=4))

    for tier_idx, (z0, node_tag, ip_tag) in enumerate([
        (0.0, "RPi 3B+ #2", "10.0.2.52"),
        (32.0, "RPi 3B+ #1", "10.0.2.50"),
    ]):
        # 1. Classic Raspberry Pi Emerald Green PCB Substrate (100 x 80 x 2.0)
        parts.append(iso.box(
            0.0, 0.0, z0, 100.0, 80.0, 2.0,
            fill_top="#15803d",
            fill_front_y="#0f5128",
            fill_side_x="#115e2e",
            stroke="#166534",
            stroke_w=0.6 * scale,
            faces=("ymax", "xmax", "top"),
        ))

        # 2. Planar PCB Details (Mounting Holes, Traces, BCM2837B0 Silver SoC, Wi-Fi Shield, Silkscreen)
        parts.append(f'  <g transform="{iso.plane_matrix(0, 0, z0 + 2.02)}">')
        parts.append('    <polygon points="0,0 72,0 32,80 0,80" fill="#22c55e" fill-opacity="0.14"/>')
        parts.append('    <g stroke="#16a34a" stroke-width="0.45" fill="none" opacity="0.85">')
        parts.append('      <polyline points="18,22 30,32 36,36"/>')
        parts.append('      <polyline points="48,38 58,34 74,20"/>')
        parts.append('      <polyline points="48,42 58,40 74,40"/>')
        parts.append('      <polyline points="48,46 62,54 74,64"/>')
        parts.append('    </g>')
        # 4 Gold-Plated Mounting Holes (at x=5.5 and x=68.0, right behind the USB/RJ45 towers)
        for mx, my in [(5.5, 5.5), (68.0, 5.5), (5.5, 74.5), (68.0, 74.5)]:
            parts.append(f'    <circle cx="{mx}" cy="{my}" r="3.2" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.35"/>')
            parts.append(f'    <circle cx="{mx}" cy="{my}" r="1.6" fill="#1e293b"/>')

        # Cypress Dual-Band Wi-Fi / BT Metallic RF Shield Can (top-left of Pi 3B+, x=10..23, y=12..26)
        parts.append('    <rect x="10.0" y="12.0" width="13.0" height="14.0" rx="0.8" fill="#cbd5e1" stroke="#64748b" stroke-width="0.35"/>')
        parts.append('    <rect x="10.8" y="12.8" width="11.4" height="12.4" fill="none" stroke="#94a3b8" stroke-width="0.2"/>')
        parts.append('    <circle cx="16.5" cy="19.0" r="2.6" fill="none" stroke="#64748b" stroke-width="0.35"/>')

        # Broadcom BCM2837B0 SoC with Signature Silver Metal Heat-Spreader Cap (x=28..47, y=30..49)
        parts.append('    <rect x="28.0" y="30.0" width="19.0" height="19.0" rx="1.0" fill="#e2e8f0" stroke="#475569" stroke-width="0.4"/>')
        parts.append('    <rect x="29.4" y="31.4" width="16.2" height="16.2" rx="0.5" fill="#cbd5e1" stroke="#94a3b8" stroke-width="0.25"/>')
        parts.append('    <text x="37.5" y="38.8" font-family="GoogleSans, sans-serif" font-weight="800" font-size="2.3" fill="#334155" text-anchor="middle">BROADCOM</text>')
        parts.append('    <text x="37.5" y="42.2" font-family="RobotoMono, monospace" font-weight="700" font-size="1.8" fill="#475569" text-anchor="middle">BCM2837B0</text>')

        # SMSC/Microchip LAN7515 Ethernet + USB Controller IC (Black QFP at x=54..66, y=28..40)
        parts.append('    <rect x="54.0" y="28.0" width="12.0" height="12.0" rx="0.6" fill="#1e293b" stroke="#475569" stroke-width="0.3"/>')
        parts.append('    <text x="60.0" y="35.0" font-family="RobotoMono, monospace" font-weight="700" font-size="1.6" fill="#cbd5e1" text-anchor="middle">LAN7515</text>')

        # Silkscreen Label near GPIO / center-right
        parts.append(f'    <text x="41.0" y="18.0" font-family="GoogleSans, sans-serif" font-weight="800" font-size="3.2" fill="#f8fafc" text-anchor="middle">{node_tag}</text>')
        parts.append(f'    <text x="41.0" y="22.5" font-family="RobotoMono, monospace" font-weight="700" font-size="2.6" fill="#bbf7d0" text-anchor="middle">{ip_tag}</text>')
        parts.append('    <text x="33.0" y="61.5" font-family="GoogleSans, sans-serif" font-weight="800" font-size="2.4" fill="#f8fafc" text-anchor="middle">HDMI</text>')
        parts.append('  </g>')

        # Back-side brass standoffs drawn before the lower board's tall USB towers so USB towers naturally occlude (68.0, 5.5)
        if tier_idx == 0:
            for sx, sy in [(5.5, 5.5), (68.0, 5.5)]:
                parts.append(iso.box(
                    sx - 1.8, sy - 1.8, 2.0, 3.6, 3.6, 30.0,
                    fill_top="#fbbf24",
                    fill_front_y="#d97706",
                    fill_side_x="#b45309",
                    stroke="#78350f",
                    stroke_w=0.35 * scale,
                    faces=("ymax", "xmax", "top"),
                ))

        # 3. 40-Pin (2x20) GPIO Header along the Back-Right Edge (y = 2.0..8.0, x = 10..64)
        parts.append(iso.box(
            10.0, 2.0, z0 + 2.0, 54.0, 6.0, 2.8,
            fill_top="#1f2937",
            fill_front_y="#111827",
            fill_side_x="#0f172a",
            stroke="#374151",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        for p_i in range(20):
            px = 11.6 + p_i * 2.65
            for py in [3.4, 6.4]:
                pb = iso.pt(px, py, z0 + 4.8)
                pt = iso.pt(px, py, z0 + 9.4)
                parts.append(f'  <line x1="{fmt(pb[0])}" y1="{fmt(pb[1])}" x2="{fmt(pt[0])}" y2="{fmt(pt[1])}" stroke="#fbbf24" stroke-width="{fmt(0.85*scale)}" stroke-linecap="square"/>')

        # 4. DSI Display Ribbon Connector along Back-Left Edge (x = 2.5..6.2, y = 28..58)
        parts.append(iso.box(
            2.5, 28.0, z0 + 2.0, 3.8, 30.0, 4.5,
            fill_top="#f8fafc",
            fill_front_y="#cbd5e1",
            fill_side_x="#94a3b8",
            stroke="#475569",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(iso.box(
            2.2, 27.5, z0 + 5.5, 4.4, 31.0, 1.2,
            fill_top="#1e293b",
            fill_front_y="#0f172a",
            fill_side_x="#111827",
            stroke="#334155",
            stroke_w=0.3 * scale,
            faces=("ymax", "xmax", "top"),
        ))

        # 5. Front-Left Edge Components (along y = 64..80, drawn back-to-front in x: Micro-USB -> HDMI -> CSI -> Audio)
        parts.append(iso.box(
            9.0, 71.0, z0 + 2.0, 8.5, 9.0, 3.6,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(iso.box(
            23.0, 64.0, z0 + 2.0, 18.0, 16.0, 6.8,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.45 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        hdmi_cav = iso.pts([
            (25.2, 80.0, z0 + 3.2),
            (38.8, 80.0, z0 + 3.2),
            (38.8, 80.0, z0 + 7.4),
            (25.2, 80.0, z0 + 7.4),
        ])
        parts.append(f'  <polygon points="{hdmi_cav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.35*scale)}"/>')
        parts.append(iso.box(
            45.0, 50.0, z0 + 2.0, 3.8, 28.0, 4.5,
            fill_top="#f8fafc",
            fill_front_y="#cbd5e1",
            fill_side_x="#94a3b8",
            stroke="#475569",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(iso.box(
            44.7, 49.5, z0 + 5.5, 4.4, 29.0, 1.2,
            fill_top="#1e293b",
            fill_front_y="#0f172a",
            fill_side_x="#111827",
            stroke="#334155",
            stroke_w=0.3 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(iso.box(
            53.0, 64.0, z0 + 2.0, 11.0, 16.0, 6.2,
            fill_top="#334155",
            fill_front_y="#0f172a",
            fill_side_x="#1e293b",
            stroke="#475569",
            stroke_w=0.4 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        aud_pt = iso.pt(58.5, 80.2, z0 + 5.0)
        parts.append(f'  <circle cx="{fmt(aud_pt[0])}" cy="{fmt(aud_pt[1])}" r="{fmt(2.4*scale)}" fill="#020617" stroke="#475569" stroke-width="{fmt(0.45*scale)}"/>')

        if tier_idx == 0:
            for sx, sy in [(5.5, 74.5), (68.0, 74.5)]:
                parts.append(iso.box(
                    sx - 1.8, sy - 1.8, 2.0, 3.6, 3.6, 30.0,
                    fill_top="#fbbf24",
                    fill_front_y="#d97706",
                    fill_side_x="#b45309",
                    stroke="#78350f",
                    stroke_w=0.35 * scale,
                    faces=("ymax", "xmax", "top"),
                ))

        # 6. Front-Right Port Edge (x = 75..100, across y = 4..78) in strict back-to-front painter's order
        for usb_y in [4.5, 29.0]:
            parts.append(iso.box(
                76.0, usb_y, z0 + 2.0, 24.0, 20.5, 16.0,
                fill_top="#e2e8f0",
                fill_front_y="#94a3b8",
                fill_side_x="#cbd5e1",
                stroke="#475569",
                stroke_w=0.55 * scale,
                faces=("ymax", "xmax", "top"),
            ))
            parts.append(f'  <g transform="{iso.plane_matrix(76.0, usb_y, z0 + 18.05)}">')
            parts.append('    <rect x="1.2" y="1.2" width="21.6" height="18.1" fill="none" stroke="#94a3b8" stroke-width="0.25"/>')
            parts.append('    <path d="M 10,4.5 L 18,4.5 M 10,7.5 L 18,7.5 M 10,13.0 L 18,13.0 M 10,16.0 L 18,16.0" stroke="#475569" stroke-width="0.5"/>')
            parts.append('  </g>')
            for slot_z in [z0 + 4.2, z0 + 11.0]:
                ucav = iso.pts([
                    (100.0, usb_y + 2.2, slot_z),
                    (100.0, usb_y + 18.3, slot_z),
                    (100.0, usb_y + 18.3, slot_z + 4.6),
                    (100.0, usb_y + 2.2, slot_z + 4.6),
                ])
                parts.append(f'  <polygon points="{ucav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.35*scale)}"/>')
                utongue = iso.pts([
                    (100.0, usb_y + 3.0, slot_z + 2.4),
                    (100.0, usb_y + 17.5, slot_z + 2.4),
                    (100.0, usb_y + 17.5, slot_z + 3.8),
                    (100.0, usb_y + 3.0, slot_z + 3.8),
                ])
                parts.append(f'  <polygon points="{utongue}" fill="#f8fafc"/>')

        rj_y, rj_d, rj_h = 53.5, 24.0, 14.0
        parts.append(iso.box(
            74.0, rj_y, z0 + 2.0, 26.0, rj_d, rj_h,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#cbd5e1",
            stroke="#475569",
            stroke_w=0.55 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        rjcav = iso.pts([
            (100.0, rj_y + 3.2, z0 + 4.0),
            (100.0, rj_y + rj_d - 3.2, z0 + 4.0),
            (100.0, rj_y + rj_d - 3.2, z0 + 13.4),
            (100.0, rj_y + 3.2, z0 + 13.4),
        ])
        parts.append(f'  <polygon points="{rjcav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')
        led_g = iso.pt(100.0, rj_y + rj_d - 2.8, z0 + 4.8)
        led_a = iso.pt(100.0, rj_y + 2.8, z0 + 4.8)
        parts.append(f'  <circle cx="{fmt(led_g[0])}" cy="{fmt(led_g[1])}" r="{fmt(1.3*scale)}" fill="#22c55e"/>')
        parts.append(f'  <circle cx="{fmt(led_a[0])}" cy="{fmt(led_a[1])}" r="{fmt(1.3*scale)}" fill="#f59e0b"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso


def render_rpi5_hailo_group(
    ox: float = 28.0,
    oy: float = 550.0,
    scale: float = 0.62,
    custom_iso: IsoProjector | None = None,
) -> tuple[str, IsoProjector]:
    """
    Renders the Raspberry Pi 5 + Official AI HAT+ (Hailo-8 26 TOPS M.2 Neural Accelerator)
    matching Reference Photo 2 & 3:
      - The 3 metallic port blocks sit side-by-side along the right edge (x = 74..100, y = 4.5..77.5),
        drawn in strict back-to-front painter's order:
          1. Back (y = 4.5..25.0): Dual USB 2.0 Tower (black tongues)
          2. Middle (y = 29.0..49.5): Dual USB 3.0 Tower (bright blue tongues #0284c7 -> O1 Capture NIC)
          3. Front (y = 53.5..77.5): Shielded Gigabit Ethernet RJ45 Jack (10.0.2.51)
      - The Hailo-8 AI HAT+ covers the left 68% of the board (x = 0..68, y = 0..80) on 4 brass hex
        standoffs, leaving all 3 metallic port towers on the right edge 100% uncovered from above!
    """
    iso = custom_iso if custom_iso is not None else IsoProjector(
        ox=ox,
        oy=oy,
        ux=(1.85 * scale, 0.98 * scale),
        uy=(-2.65 * scale, 1.15 * scale),
        uz=(0.0, -1.75 * scale),
    )
    parts = ['  <g id="rpi5-hailo-assembly">']
    parts.append(iso.shadow_box(0.0, 0.0, 0.0, 100.0, 80.0, dx=-2.0, dy=3.0, layers=4))

    # 1. Bottom Layer: Raspberry Pi 5 Green PCB Base (100 x 80 x 2.0)
    parts.append(iso.box(
        0.0, 0.0, 0.0, 100.0, 80.0, 2.0,
        fill_top="#15803d",
        fill_front_y="#0f5128",
        fill_side_x="#115e2e",
        stroke="#166534",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    # 2. Brass Hex Standoffs Supporting the AI HAT+ (z = 2.0 to z = 19.5 at x = 5.5 and x = 63.5)
    for sx, sy in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(iso.box(
            sx - 1.8, sy - 1.8, 2.0, 3.6, 3.6, 17.5,
            fill_top="#fbbf24",
            fill_front_y="#d97706",
            fill_side_x="#b45309",
            stroke="#78350f",
            stroke_w=0.35 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 3. Front-Left Edge of Pi 5 (along y = 69..80): USB-C Power + Dual Micro-HDMI Ports
    for port_x, port_w in [(12.0, 11.0), (28.0, 9.5), (42.0, 9.5)]:
        parts.append(iso.box(
            port_x, 69.0, 2.0, port_w, 11.0, 4.6,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#64748b",
            stroke="#475569",
            stroke_w=0.4 * scale,
            faces=("ymax", "xmax", "top"),
        ))

    # 4. Top Deck (z = 19.5..21.3, x = 0..68, y = 0..80): Official Raspberry Pi M.2 / AI HAT+ Dark Matte PCB
    parts.append(iso.box(
        0.0, 0.0, 19.5, 68.0, 80.0, 1.8,
        fill_top="#1e293b",
        fill_front_y="#0f172a",
        fill_side_x="#111827",
        stroke="#475569",
        stroke_w=0.6 * scale,
        faces=("ymax", "xmax", "top"),
    ))

    parts.append(f'  <g transform="{iso.plane_matrix(0, 0, 21.35)}">')
    for mx, my in [(5.5, 5.5), (63.5, 5.5), (5.5, 74.5), (63.5, 74.5)]:
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="2.8" fill="#cbd5e1" stroke="#64748b" stroke-width="0.35"/>')
        parts.append(f'    <circle cx="{mx}" cy="{my}" r="1.3" fill="#334155"/>')
    parts.append('    <rect x="10.0" y="2.5" width="50.0" height="6.0" rx="0.5" fill="#090d16" stroke="#475569" stroke-width="0.35"/>')
    for p_i in range(20):
        px = 11.5 + p_i * 2.45
        parts.append(f'    <circle cx="{px:.1f}" cy="4.0" r="0.55" fill="#fbbf24"/>')
        parts.append(f'    <circle cx="{px:.1f}" cy="7.0" r="0.55" fill="#fbbf24"/>')
    parts.append('  </g>')

    # Hailo-8 M.2 2280 AI Accelerator Module Seated on the HAT (x = 10..60, y = 16..64, z = 21.3..25.0)
    parts.append(iso.box(
        10.0, 16.0, 21.3, 50.0, 48.0, 1.6,
        fill_top="#0f172a",
        fill_front_y="#020617",
        fill_side_x="#090d16",
        stroke="#38bdf8",
        stroke_w=0.45 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(iso.box(
        18.0, 24.0, 22.9, 34.0, 32.0, 3.1,
        fill_top="#111827",
        fill_front_y="#090d16",
        fill_side_x="#1f2937",
        stroke="#94a3b8",
        stroke_w=0.5 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    parts.append(f'  <g transform="{iso.plane_matrix(18.0, 24.0, 26.05)}">')
    parts.append('    <rect x="1.5" y="1.5" width="31.0" height="29.0" rx="0.8" fill="none" stroke="#38bdf8" stroke-width="0.35"/>')
    parts.append('    <text x="17.0" y="12.5" font-family="GoogleSans, sans-serif" font-weight="900" font-size="5.2" fill="#f8fafc" letter-spacing="0.4" text-anchor="middle">HAILO-8</text>')
    parts.append('    <text x="17.0" y="18.5" font-family="RobotoMono, monospace" font-weight="700" font-size="3.1" fill="#38bdf8" text-anchor="middle">26 TOPS · PCIe</text>')
    parts.append('    <text x="17.0" y="24.2" font-family="RobotoMono, monospace" font-weight="700" font-size="2.7" fill="#cbd5e1" text-anchor="middle">10.0.2.51</text>')
    parts.append('  </g>')

    # 5. Front-Right Port Edge of Pi 5 (x = 74..100, across y = 4.5..77.5)
    for usb_y, tongue_col in [(4.5, "#334155"), (29.0, "#0284c7")]:
        parts.append(iso.box(
            76.0, usb_y, 2.0, 24.0, 20.5, 16.0,
            fill_top="#e2e8f0",
            fill_front_y="#94a3b8",
            fill_side_x="#cbd5e1",
            stroke="#475569",
            stroke_w=0.55 * scale,
            faces=("ymax", "xmax", "top"),
        ))
        parts.append(f'  <g transform="{iso.plane_matrix(76.0, usb_y, 18.05)}">')
        parts.append('    <rect x="1.2" y="1.2" width="21.6" height="18.1" fill="none" stroke="#94a3b8" stroke-width="0.25"/>')
        parts.append('    <path d="M 10,4.5 L 18,4.5 M 10,7.5 L 18,7.5 M 10,13.0 L 18,13.0 M 10,16.0 L 18,16.0" stroke="#475569" stroke-width="0.5"/>')
        parts.append('  </g>')
        for slot_z in [4.2, 11.0]:
            ucav = iso.pts([
                (100.0, usb_y + 2.2, slot_z),
                (100.0, usb_y + 18.3, slot_z),
                (100.0, usb_y + 18.3, slot_z + 4.6),
                (100.0, usb_y + 2.2, slot_z + 4.6),
            ])
            parts.append(f'  <polygon points="{ucav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.35*scale)}"/>')
            utongue = iso.pts([
                (100.0, usb_y + 3.0, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 2.4),
                (100.0, usb_y + 17.5, slot_z + 3.8),
                (100.0, usb_y + 3.0, slot_z + 3.8),
            ])
            parts.append(f'  <polygon points="{utongue}" fill="{tongue_col}"/>')

    rj5_y, rj5_d, rj5_h = 53.5, 24.0, 14.0
    parts.append(iso.box(
        74.0, rj5_y, 2.0, 26.0, rj5_d, rj5_h,
        fill_top="#e2e8f0",
        fill_front_y="#94a3b8",
        fill_side_x="#cbd5e1",
        stroke="#475569",
        stroke_w=0.55 * scale,
        faces=("ymax", "xmax", "top"),
    ))
    rj5_cav = iso.pts([
        (100.0, rj5_y + 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 4.0),
        (100.0, rj5_y + rj5_d - 3.2, 13.4),
        (100.0, rj5_y + 3.2, 13.4),
    ])
    parts.append(f'  <polygon points="{rj5_cav}" fill="#090d16" stroke="#334155" stroke-width="{fmt(0.4*scale)}"/>')
    led5_g = iso.pt(100.0, rj5_y + rj5_d - 2.8, 4.8)
    led5_a = iso.pt(100.0, rj5_y + 2.8, 4.8)
    parts.append(f'  <circle cx="{fmt(led5_g[0])}" cy="{fmt(led5_g[1])}" r="{fmt(1.3*scale)}" fill="#22c55e"/>')
    parts.append(f'  <circle cx="{fmt(led5_a[0])}" cy="{fmt(led5_a[1])}" r="{fmt(1.3*scale)}" fill="#f59e0b"/>')

    parts.append('  </g>')
    return "\n".join(parts), iso


def _arrow_head_polygon(tip: tuple[float, float], prev: tuple[float, float], size: float = 7.5, wing: float = 4.2, color: str = "#38bdf8") -> str:
    """
    Returns a crisp SVG <polygon> arrowhead at `tip` pointing along `prev -> tip`.
    """
    dx = tip[0] - prev[0]
    dy = tip[1] - prev[1]
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return ""
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    bx = tip[0] - ux * size
    by = tip[1] - uy * size
    p1 = (bx + nx * wing, by + ny * wing)
    p2 = (bx - nx * wing, by - ny * wing)
    return f'<polygon points="{fmt(tip[0])},{fmt(tip[1])} {fmt(p1[0])},{fmt(p1[1])} {fmt(p2[0])},{fmt(p2[1])}" fill="{color}"/>'


def _draw_orthogonal_arrow(
    pts: list[tuple[float, float]],
    color: str,
    width: float = 2.6,
    dashed: bool = False,
    start_arrow: bool = False,
    end_arrow: bool = True,
    corner_r: float = 6.0,
) -> str:
    """
    Draws a clean orthogonal/stepped line with rounded 90-degree corners, port anchor dots,
    and sharp vector arrowheads (100% pure geometry, no <marker> dependencies).
    """
    if len(pts) < 2:
        return ""

    # Shorten start/end segments slightly so the line stops inside the arrowhead base
    work_pts = [list(p) for p in pts]
    trim = 5.5
    if start_arrow:
        dx = work_pts[1][0] - work_pts[0][0]
        dy = work_pts[1][1] - work_pts[0][1]
        L = math.hypot(dx, dy)
        if L > trim * 2:
            work_pts[0][0] += (dx / L) * trim
            work_pts[0][1] += (dy / L) * trim
    if end_arrow:
        dx = work_pts[-2][0] - work_pts[-1][0]
        dy = work_pts[-2][1] - work_pts[-1][1]
        L = math.hypot(dx, dy)
        if L > trim * 2:
            work_pts[-1][0] += (dx / L) * trim
            work_pts[-1][1] += (dy / L) * trim

    # Build path with subtle quadratic bezier bends at interior vertices
    d_cmds = [f"M {fmt(work_pts[0][0])},{fmt(work_pts[0][1])}"]
    for i in range(1, len(work_pts) - 1):
        p_prev = work_pts[i - 1]
        p_curr = work_pts[i]
        p_next = work_pts[i + 1]
        v1x, v1y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        v2x, v2y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        L1 = math.hypot(v1x, v1y)
        L2 = math.hypot(v2x, v2y)
        r = min(corner_r, L1 * 0.4, L2 * 0.4)
        if r > 0.5:
            in_x = p_curr[0] - (v1x / L1) * r
            in_y = p_curr[1] - (v1y / L1) * r
            out_x = p_curr[0] + (v2x / L2) * r
            out_y = p_curr[1] + (v2y / L2) * r
            d_cmds.append(f"L {fmt(in_x)},{fmt(in_y)} Q {fmt(p_curr[0])},{fmt(p_curr[1])} {fmt(out_x)},{fmt(out_y)}")
        else:
            d_cmds.append(f"L {fmt(p_curr[0])},{fmt(p_curr[1])}")
    d_cmds.append(f"L {fmt(work_pts[-1][0])},{fmt(work_pts[-1][1])}")
    path_d = " ".join(d_cmds)

    out = [
        # White backing halo for crisp contrast
        f'  <path d="{path_d}" fill="none" stroke="#ffffff" stroke-width="{fmt(width + 3.2)}" stroke-linecap="round" stroke-linejoin="round"/>',
    ]
    if dashed:
        # Emit explicit vector dash segments along each straight run so both PyMuPDF and Chrome render identical dashes
        dash_len, gap_len = 7.0, 5.0
        for i in range(len(work_pts) - 1):
            x0, y0 = work_pts[i]
            x1, y1 = work_pts[i + 1]
            seg_len = math.hypot(x1 - x0, y1 - y0)
            if seg_len < 1e-3:
                continue
            ux, uy = (x1 - x0) / seg_len, (y1 - y0) / seg_len
            pos = 0.0
            while pos < seg_len:
                end_pos = min(pos + dash_len, seg_len)
                sx, sy = x0 + ux * pos, y0 + uy * pos
                ex, ey = x0 + ux * end_pos, y0 + uy * end_pos
                out.append(f'  <line x1="{fmt(sx)}" y1="{fmt(sy)}" x2="{fmt(ex)}" y2="{fmt(ey)}" stroke="{color}" stroke-width="{fmt(width)}" stroke-linecap="round"/>')
                pos += dash_len + gap_len
    else:
        out.append(f'  <path d="{path_d}" fill="none" stroke="{color}" stroke-width="{fmt(width)}" stroke-linecap="round" stroke-linejoin="round"/>')
    if not start_arrow:
        out.append(f'  <circle cx="{fmt(pts[0][0])}" cy="{fmt(pts[0][1])}" r="3.2" fill="{color}" stroke="#ffffff" stroke-width="1.2"/>')
    else:
        out.append("  " + _arrow_head_polygon(pts[0], pts[1], size=8.2, wing=4.6, color=color))

    if end_arrow:
        out.append("  " + _arrow_head_polygon(pts[-1], pts[-2], size=8.2, wing=4.6, color=color))
    else:
        out.append(f'  <circle cx="{fmt(pts[-1][0])}" cy="{fmt(pts[-1][1])}" r="3.2" fill="{color}" stroke="#ffffff" stroke-width="1.2"/>')

    return "\n".join(out)


def generate_composed_testbed_svg(width: int = 900, height: int = 470) -> str:
    """
    Symmetrical 3-column hardware layout on a clean white background where all three devices
    share the EXACT SAME isometric footprint and projection angles (`W_vec`, `D_vec`, `uz`),
    connected by clean, defined orthogonal arrow lines along parallel horizontal routing tracks.
    """
    parts = [f'''<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
  <!-- Clean White Paper Background -->
  <rect width="{width}" height="{height}" fill="#ffffff"/>''']

    # Shared isometric footprint basis vectors for all three devices:
    # W_vec: Front-right port edge vector (152 px right, 66 px up -> -23.5 deg)
    # D_vec: Front-left depth edge vector (102 px right, 54 px down -> +27.9 deg)
    W_vec = (152.0, -66.0)
    D_vec = (102.0, 54.0)

    # Shared vertical baseline for the left-most corner of all three devices
    Y_base = 224.0
    # Horizontally symmetrical X positions for the 3 footprints (each 254 px wide: 152 + 102 = 254)
    # Left margin = 28, Gap = 41 -> X1 = 28..282, X2 = 323..577 (center 450), X3 = 618..872, Right margin = 28
    X1_left = 28.0
    X2_left = 323.0
    X3_left = 618.0

    # 1. Left Column: 2-Tier Netgear Switch Stack (96 x 62 mm mapped onto W_vec x D_vec)
    ng_custom_iso = IsoProjector(
        ox=X1_left,
        oy=Y_base,
        ux=(W_vec[0] / 96.0, W_vec[1] / 96.0),
        uy=(D_vec[0] / 62.0, D_vec[1] / 62.0),
        uz=(0.0, -1.55),
    )
    ng_grp, ng_iso = render_netgear_stack_group(scale=0.62, custom_iso=ng_custom_iso)
    parts.append(ng_grp)

    # 2. Center Column: Zodiac FX OpenFlow 1.3 Switch (100 x 80 mm mapped onto W_vec x D_vec)
    zfx_custom_iso = IsoProjector(
        ox=X2_left,
        oy=Y_base,
        ux=(W_vec[0] / 100.0, W_vec[1] / 100.0),
        uy=(D_vec[0] / 80.0, D_vec[1] / 80.0),
        uz=(0.0, -1.65),
    )
    zfx_grp, zfx_iso = render_zodiac_fx_group(scale=0.60, show_usb_cable=False, custom_iso=zfx_custom_iso)
    parts.append(zfx_grp)

    # 3. Right Column: NVIDIA Jetson Orin Nano Super (100 x 80 mm mapped onto D_vec x (-W_vec)
    #    so its left corner (x=0, y=80) is at (X3_left, Y_base) and its port edge (x=100, y=80..0)
    #    has the exact same W_vec angle and position as the Switch Stack and Zodiac FX!)
    orin_custom_iso = IsoProjector(
        ox=X3_left + W_vec[0],
        oy=Y_base + W_vec[1],
        ux=(D_vec[0] / 100.0, D_vec[1] / 100.0),
        uy=(-W_vec[0] / 80.0, -W_vec[1] / 80.0),
        uz=(0.0, -1.85),
    )
    orin_grp, orin_iso = render_jetson_orin_group(scale=0.60, custom_iso=orin_custom_iso)
    parts.append(orin_grp)

    # 4. Compute exact screen coordinates of hardware ports along the aligned front-right edges
    # Left Switch Stack ports:
    # - Tier 3 Uplink Switch (top, z0=30): P4 at x = 33.5 + 3*11.4 + 4.4 = 72.1
    # - Tier 2 Workload Switch (bottom, z0=0): P5 at x = 33.5 + 4*11.4 + 4.4 = 83.5
    p_up_p4 = ng_iso.pt(72.1, 62.0, 36.0)
    p_wl_p5 = ng_iso.pt(83.5, 62.0, 6.0)

    # Center Zodiac FX ports P1..P4 (front bottom of RJ45 opening at y=80.7, z=4.5)
    p_zfx_p1 = zfx_iso.pt(14.5 + 0 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p2 = zfx_iso.pt(14.5 + 1 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p3 = zfx_iso.pt(14.5 + 2 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p4 = zfx_iso.pt(14.5 + 3 * 19.6 + 8.1, 80.7, 4.5)

    # Port P1..P4 badges positioned on the upper-front lip of each RJ45 housing (z=16.5) so the dark cavity & pins remain 100% visible
    for p_idx in range(4):
        p_lbl = zfx_iso.pt(14.5 + p_idx * 19.6 + 8.1, 76.0, 16.5)
        parts.append(f'''
  <rect x="{fmt(p_lbl[0]-9)}" y="{fmt(p_lbl[1]-6)}" width="18" height="11.5" rx="2.5" fill="#0f172a" stroke="#64748b" stroke-width="0.8"/>
  <text x="{fmt(p_lbl[0])}" y="{fmt(p_lbl[1]+2.2)}" font-family="RobotoMono, monospace" font-weight="700" font-size="7.8" fill="#f8fafc" text-anchor="middle">P{p_idx+1}</text>''')

    # Right Jetson Orin ports (along x=97.5 face):
    # - USB 3.2 capture interface at y=48.0, z=8.0
    # - GbE RJ45 control interface at y=24.0, z=8.0
    p_orin_usb = orin_iso.pt(97.5, 48.0, 8.0)
    p_orin_gbe = orin_iso.pt(97.5, 24.0, 8.0)

    # 5. Symmetrical Orthogonal Arrow Connections along Two Parallel Tracks (Y_upper = 328, Y_lower = 374)
    # Notice:
    # Left Data Plane:
    #   - Inner pair (Workload Switch P5 -> Zodiac FX P1): uses Upper Track (Y = 328) -> 0 crossings!
    #   - Outer pair (Zodiac FX P2 -> Uplink Switch P4): uses Lower Track (Y = 374) -> 0 crossings!
    # Right Control & Telemetry Plane:
    #   - Inner pair (Zodiac FX P3 -> Jetson Orin USB 3.2): uses Upper Track (Y = 328) -> 0 crossings!
    #   - Outer pair (Zodiac FX P4 <-> Jetson Orin GbE): uses Lower Track (Y = 374) -> 0 crossings!
    Y_track_top = 328.0
    Y_track_bot = 374.0

    # 5A. Untrusted Ingress (VLAN 1): Workload Switch P5 -> Zodiac FX P1 (Blue directional arrow)
    parts.append(_draw_orthogonal_arrow(
        [p_wl_p5, (p_wl_p5[0], Y_track_top), (p_zfx_p1[0], Y_track_top), p_zfx_p1],
        color="#2563eb",
        width=2.6,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5B. Filtered Egress: Zodiac FX P2 -> Uplink Switch P4 (Emerald green directional arrow)
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p2, (p_zfx_p2[0], Y_track_bot), (p_up_p4[0], Y_track_bot), p_up_p4],
        color="#059669",
        width=2.6,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5C. Mirror Taps [O1, O2, O3]: Zodiac FX P3 -> Jetson Orin USB 3.2 (Dashed cyan directional arrow)
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p3, (p_zfx_p3[0], Y_track_top), (p_orin_usb[0], Y_track_top), p_orin_usb],
        color="#0284c7",
        width=2.2,
        dashed=True,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5D. OpenFlow 1.3 Control (:6633): Zodiac FX P4 <-> Jetson Orin GbE (Bidirectional amber arrow)
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p4, (p_zfx_p4[0], Y_track_bot), (p_orin_gbe[0], Y_track_bot), p_orin_gbe],
        color="#d97706",
        width=2.6,
        dashed=False,
        start_arrow=True,
        end_arrow=True,
    ))

    # 6. Inline Pill Labels Centered on the 4 Symmetric Horizontal Arrow Tracks (Crisp Light Paper Palette)
    x_mid_left_top = 0.5 * (p_wl_p5[0] + p_zfx_p1[0])
    x_mid_left_bot = 0.5 * (p_up_p4[0] + p_zfx_p2[0])
    x_mid_right_top = 0.5 * (p_zfx_p3[0] + p_orin_usb[0])
    x_mid_right_bot = 0.5 * (p_zfx_p4[0] + p_orin_gbe[0])

    parts.append(f'''
  <!-- Left Track Pill 1: Untrusted Ingress -->
  <g transform="translate({fmt(x_mid_left_top - 72)}, {fmt(Y_track_top - 11)})">
    <rect x="0" y="0" width="144" height="22" rx="4" fill="#eff6ff" stroke="#2563eb" stroke-width="1.3"/>
    <text x="72" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#1d4ed8" text-anchor="middle">Untrusted Ingress →</text>
  </g>

  <!-- Left Track Pill 2: Filtered Egress -->
  <g transform="translate({fmt(x_mid_left_bot - 68)}, {fmt(Y_track_bot - 11)})">
    <rect x="0" y="0" width="136" height="22" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="1.3"/>
    <text x="68" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#047857" text-anchor="middle">← Filtered Egress</text>
  </g>

  <!-- Right Track Pill 1: Mirror Taps -->
  <g transform="translate({fmt(x_mid_right_top - 78)}, {fmt(Y_track_top - 11)})">
    <rect x="0" y="0" width="156" height="22" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.3"/>
    <text x="78" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#0369a1" text-anchor="middle">Mirror Taps [O1..O3] →</text>
  </g>

  <!-- Right Track Pill 2: OF 1.3 Control -->
  <g transform="translate({fmt(x_mid_right_bot - 82)}, {fmt(Y_track_bot - 11)})">
    <rect x="0" y="0" width="164" height="22" rx="4" fill="#fffbeb" stroke="#d97706" stroke-width="1.3"/>
    <text x="82" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#b45309" text-anchor="middle">↔ OF 1.3 Control (:6633)</text>
  </g>''')

    # 7. Three Symmetrical Top Header Callout Cards (Y = 22, Width = 254 matching each column's footprint!)
    parts.append('''
  <!-- Column 1 Header Card: 2-Tier Switch Stack (X = 28..282) -->
  <g transform="translate(28, 22)">
    <line x1="127" y1="48" x2="127" y2="78" stroke="#059669" stroke-width="1.5"/>
    <circle cx="127" cy="78" r="2.8" fill="#059669"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#059669" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#047857" text-anchor="middle">TIER 2 &amp; 3 · WORKLOAD / UPLINK STACK</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">2× Netgear GS105Ev2 · Mirror [O1, O3]</text>
  </g>

  <!-- Column 2 Header Card: Zodiac FX OpenFlow DUT (X = 323..577) -->
  <g transform="translate(323, 22)">
    <line x1="127" y1="48" x2="127" y2="128" stroke="#d97706" stroke-width="1.5"/>
    <circle cx="127" cy="128" r="2.8" fill="#d97706"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#d97706" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#b45309" text-anchor="middle">TIER 1 · ZODIAC FX (OPENFLOW 1.3 DUT)</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">Atmel SAM4E + KSZ8795 · 128-Rule Budget</text>
  </g>

  <!-- Column 3 Header Card: SDN Controller & Verifier (X = 618..872) -->
  <g transform="translate(618, 22)">
    <line x1="127" y1="48" x2="127" y2="95" stroke="#0284c7" stroke-width="1.5"/>
    <circle cx="127" cy="95" r="2.8" fill="#0284c7"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#0284c7" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#0369a1" text-anchor="middle">SDN CONTROLLER &amp; VERIFIER</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">NVIDIA Jetson Orin Nano Super</text>
  </g>

  <!-- Bottom Legend Banner (Centered at X = 450) -->
  <g transform="translate(225, 420)">
    <rect x="0" y="0" width="450" height="32" rx="16" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
    <text x="225" y="20" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11.5" letter-spacing="0.6" fill="#0f172a" text-anchor="middle">PHYSICAL 3-TIER SDN TESTBED &amp; DETERMINISTIC VERIFIER LOOP</text>
  </g>
</svg>''')
    return "\n".join(parts)


def generate_composed_testbed_with_pis_svg(width: int = 900, height: int = 748) -> str:
    """
    Extended symmetrical hardware layout preserving the exact 3-column core
    ([Netgear Switch Stack] <-> [Zodiac FX] <-> [Jetson Orin Nano Super]) in the middle row,
    while stacking the 2x Raspberry Pi 3B+ (Red Team) directly ABOVE the Netgear stack in
    Column 1 and the Raspberry Pi 5 + Hailo-8 (26 TOPS) directly BELOW the Netgear stack in
    Column 1, all sharing the exact same isometric projection vectors (`W_vec`, `D_vec`, `uz`)
    and with arrows plugging directly into the actual Ethernet and USB port cavities.
    """
    parts = [f'''<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
  <!-- Clean White Paper Background -->
  <rect width="{width}" height="{height}" fill="#ffffff"/>''']

    # Shared isometric footprint basis vectors for every device in the diagram:
    W_vec = (152.0, -66.0)
    D_vec = (102.0, 54.0)

    # Horizontally symmetrical X positions for the 3 columns (each 254 px wide: 152 + 102 = 254)
    X1_left = 28.0
    X2_left = 323.0
    X3_left = 618.0

    # Vertical baselines:
    # - Top-Left (Column 1): 2x Raspberry Pi 3B+ Red Team Stack at Y_rpi3 = 176.0
    # - Middle Row (Columns 1, 2, 3): Netgear Stack, Zodiac FX, Jetson Orin at Y_base = 382.0
    # - Bottom-Left (Column 1): Raspberry Pi 5 + Hailo-8 at Y_rpi5 = 596.0
    Y_rpi3 = 176.0
    Y_base = 382.0
    Y_rpi5 = 596.0

    # 1A. Top-Left (Column 1): 2-Tier Raspberry Pi 3B+ Red Team Stack (100 x 80 mapped onto D_vec x (-W_vec))
    rpi3_custom_iso = IsoProjector(
        ox=X1_left + W_vec[0],
        oy=Y_rpi3 + W_vec[1],
        ux=(D_vec[0] / 100.0, D_vec[1] / 100.0),
        uy=(-W_vec[0] / 80.0, -W_vec[1] / 80.0),
        uz=(0.0, -1.45),
    )
    rpi3_grp, rpi3_iso = render_rpi3b_stack_group(scale=0.60, custom_iso=rpi3_custom_iso)
    parts.append(rpi3_grp)

    # 1B. Middle-Left (Column 1): 2-Tier Netgear Switch Stack (96 x 62 mapped onto W_vec x D_vec)
    ng_custom_iso = IsoProjector(
        ox=X1_left,
        oy=Y_base,
        ux=(W_vec[0] / 96.0, W_vec[1] / 96.0),
        uy=(D_vec[0] / 62.0, D_vec[1] / 62.0),
        uz=(0.0, -1.55),
    )
    ng_grp, ng_iso = render_netgear_stack_group(scale=0.62, custom_iso=ng_custom_iso)
    parts.append(ng_grp)

    # 1C. Bottom-Left (Column 1): Raspberry Pi 5 + Hailo-8 (100 x 80 mapped onto D_vec x (-W_vec))
    rpi5_custom_iso = IsoProjector(
        ox=X1_left + W_vec[0],
        oy=Y_rpi5 + W_vec[1],
        ux=(D_vec[0] / 100.0, D_vec[1] / 100.0),
        uy=(-W_vec[0] / 80.0, -W_vec[1] / 80.0),
        uz=(0.0, -1.45),
    )
    rpi5_grp, rpi5_iso = render_rpi5_hailo_group(scale=0.60, custom_iso=rpi5_custom_iso)
    parts.append(rpi5_grp)

    # 2. Middle-Center (Column 2): Zodiac FX OpenFlow 1.3 Switch (100 x 80 mapped onto W_vec x D_vec)
    zfx_custom_iso = IsoProjector(
        ox=X2_left,
        oy=Y_base,
        ux=(W_vec[0] / 100.0, W_vec[1] / 100.0),
        uy=(D_vec[0] / 80.0, D_vec[1] / 80.0),
        uz=(0.0, -1.65),
    )
    zfx_grp, zfx_iso = render_zodiac_fx_group(scale=0.60, show_usb_cable=False, custom_iso=zfx_custom_iso)
    parts.append(zfx_grp)

    # 3. Middle-Right (Column 3): NVIDIA Jetson Orin Nano Super (100 x 80 mapped onto D_vec x (-W_vec))
    orin_custom_iso = IsoProjector(
        ox=X3_left + W_vec[0],
        oy=Y_base + W_vec[1],
        ux=(D_vec[0] / 100.0, D_vec[1] / 100.0),
        uy=(-W_vec[0] / 80.0, -W_vec[1] / 80.0),
        uz=(0.0, -1.85),
    )
    orin_grp, orin_iso = render_jetson_orin_group(scale=0.60, custom_iso=orin_custom_iso)
    parts.append(orin_grp)

    # 4. Port Coordinates for Core Horizontal Connections
    p_up_p4 = ng_iso.pt(72.1, 62.0, 36.0)
    p_wl_p5 = ng_iso.pt(83.5, 62.0, 6.0)

    p_zfx_p1 = zfx_iso.pt(14.5 + 0 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p2 = zfx_iso.pt(14.5 + 1 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p3 = zfx_iso.pt(14.5 + 2 * 19.6 + 8.1, 80.7, 4.5)
    p_zfx_p4 = zfx_iso.pt(14.5 + 3 * 19.6 + 8.1, 80.7, 4.5)

    for p_idx in range(4):
        p_lbl = zfx_iso.pt(14.5 + p_idx * 19.6 + 8.1, 76.0, 16.5)
        parts.append(f'''
  <rect x="{fmt(p_lbl[0]-9)}" y="{fmt(p_lbl[1]-6)}" width="18" height="11.5" rx="2.5" fill="#0f172a" stroke="#64748b" stroke-width="0.8"/>
  <text x="{fmt(p_lbl[0])}" y="{fmt(p_lbl[1]+2.2)}" font-family="RobotoMono, monospace" font-weight="700" font-size="7.8" fill="#f8fafc" text-anchor="middle">P{p_idx+1}</text>''')

    p_orin_usb = orin_iso.pt(97.5, 48.0, 8.0)
    p_orin_gbe = orin_iso.pt(97.5, 24.0, 8.0)

    # 5. Core Horizontal Tracks (Y_track_top = 486, Y_track_bot = 530)
    Y_track_top = Y_base + 104.0
    Y_track_bot = Y_base + 148.0

    # 5A. Untrusted Ingress: Workload Switch P5 -> Zodiac FX P1
    parts.append(_draw_orthogonal_arrow(
        [p_wl_p5, (p_wl_p5[0], Y_track_top), (p_zfx_p1[0], Y_track_top), p_zfx_p1],
        color="#2563eb",
        width=2.6,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5B. Filtered Egress: Zodiac FX P2 -> Uplink Switch P4
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p2, (p_zfx_p2[0], Y_track_bot), (p_up_p4[0], Y_track_bot), p_up_p4],
        color="#059669",
        width=2.6,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5C. Mirror Taps [O1, O2, O3]: Zodiac FX P3 -> Jetson Orin USB 3.2
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p3, (p_zfx_p3[0], Y_track_top), (p_orin_usb[0], Y_track_top), p_orin_usb],
        color="#0284c7",
        width=2.2,
        dashed=True,
        start_arrow=False,
        end_arrow=True,
    ))

    # 5D. OpenFlow 1.3 Control (:6633): Zodiac FX P4 <-> Jetson Orin GbE
    parts.append(_draw_orthogonal_arrow(
        [p_zfx_p4, (p_zfx_p4[0], Y_track_bot), (p_orin_gbe[0], Y_track_bot), p_orin_gbe],
        color="#d97706",
        width=2.6,
        dashed=False,
        start_arrow=True,
        end_arrow=True,
    ))

    # 6. Direct Port-to-Port Orthogonal Arrows for Column 1 (RPi 3B+ RJ45 -> Netgear RJ45 <- RPi 5 RJ45 & USB 3.0)
    p_rpi3_top_rj = rpi3_iso.pt(100.0, 62.0, 40.5)
    p_rpi3_bot_rj = rpi3_iso.pt(100.0, 68.0, 8.5)
    p_ng_top_p1 = ng_iso.pt(37.9, 62.0, 40.0)
    p_ng_top_p3 = ng_iso.pt(60.7, 62.0, 40.0)
    y_rpi3_mid = 238.0
    x_rpi3_top_escape = 186.0

    parts.append(_draw_orthogonal_arrow(
        [p_rpi3_bot_rj, (p_rpi3_bot_rj[0], y_rpi3_mid), (p_ng_top_p1[0], y_rpi3_mid), p_ng_top_p1],
        color="#dc2626",
        width=2.4,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))
    parts.append(_draw_orthogonal_arrow(
        [p_rpi3_top_rj, (x_rpi3_top_escape, p_rpi3_top_rj[1]), (x_rpi3_top_escape, y_rpi3_mid - 14.0), (p_ng_top_p3[0], y_rpi3_mid - 14.0), p_ng_top_p3],
        color="#dc2626",
        width=2.4,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    parts.append(f'''
  <g transform="translate(115, {fmt(y_rpi3_mid - 11)})">
    <rect x="0" y="0" width="154" height="22" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.3"/>
    <text x="77" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#b91c1c" text-anchor="middle">Red Team GbE [P1, P3] ↓</text>
  </g>''')

    p_rpi5_rj = rpi5_iso.pt(100.0, 65.5, 8.5)
    p_rpi5_usb = rpi5_iso.pt(100.0, 39.2, 8.5)
    p_ng_wl_p1 = ng_iso.pt(37.9, 62.0, 10.0)
    p_ng_wl_p2 = ng_iso.pt(49.3, 62.0, 10.0)
    y_rpi5_top_step = 442.0
    y_rpi5_bot_step = 482.0

    parts.append(_draw_orthogonal_arrow(
        [p_rpi5_rj, (p_ng_wl_p1[0], p_rpi5_rj[1]), p_ng_wl_p1],
        color="#2563eb",
        width=2.4,
        dashed=False,
        start_arrow=False,
        end_arrow=True,
    ))

    parts.append(_draw_orthogonal_arrow(
        [p_ng_wl_p2, (p_ng_wl_p2[0], p_rpi5_usb[1])],
        color="#0284c7",
        width=2.2,
        dashed=True,
        start_arrow=False,
        end_arrow=True,
    ))

    parts.append(f'''
  <g transform="translate(88, {fmt(y_rpi5_top_step - 11)})">
    <rect x="0" y="0" width="146" height="22" rx="4" fill="#eff6ff" stroke="#2563eb" stroke-width="1.3"/>
    <text x="73" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="8.8" fill="#1d4ed8" text-anchor="middle">↑ GbE Workload [P4]</text>
  </g>
  <g transform="translate(88, {fmt(y_rpi5_bot_step - 11)})">
    <rect x="0" y="0" width="146" height="22" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.3"/>
    <text x="73" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="8.8" fill="#0369a1" text-anchor="middle">↓ O1 Mirror Tap [P2]</text>
  </g>''')

    # 7. Inline Pill Labels Centered on the 4 Symmetric Horizontal Arrow Tracks
    x_mid_left_top = 0.5 * (p_wl_p5[0] + p_zfx_p1[0])
    x_mid_left_bot = 0.5 * (p_up_p4[0] + p_zfx_p2[0])
    x_mid_right_top = 0.5 * (p_zfx_p3[0] + p_orin_usb[0])
    x_mid_right_bot = 0.5 * (p_zfx_p4[0] + p_orin_gbe[0])

    parts.append(f'''
  <!-- Left Track Pill 1: Untrusted Ingress -->
  <g transform="translate({fmt(x_mid_left_top - 68)}, {fmt(Y_track_top - 11)})">
    <rect x="0" y="0" width="136" height="22" rx="4" fill="#eff6ff" stroke="#2563eb" stroke-width="1.3"/>
    <text x="68" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#1d4ed8" text-anchor="middle">Untrusted Ingress →</text>
  </g>

  <!-- Left Track Pill 2: Filtered Egress -->
  <g transform="translate({fmt(x_mid_left_bot - 66)}, {fmt(Y_track_bot - 11)})">
    <rect x="0" y="0" width="132" height="22" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="1.3"/>
    <text x="66" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#047857" text-anchor="middle">← Filtered Egress</text>
  </g>

  <!-- Right Track Pill 1: Mirror Taps -->
  <g transform="translate({fmt(x_mid_right_top - 78)}, {fmt(Y_track_top - 11)})">
    <rect x="0" y="0" width="156" height="22" rx="4" fill="#f0f9ff" stroke="#0284c7" stroke-width="1.3"/>
    <text x="78" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#0369a1" text-anchor="middle">Mirror Taps [O1..O3] →</text>
  </g>

  <!-- Right Track Pill 2: OF 1.3 Control -->
  <g transform="translate({fmt(x_mid_right_bot - 82)}, {fmt(Y_track_bot - 11)})">
    <rect x="0" y="0" width="164" height="22" rx="4" fill="#fffbeb" stroke="#d97706" stroke-width="1.3"/>
    <text x="82" y="14.5" font-family="RobotoMono, monospace" font-weight="700" font-size="9" fill="#b45309" text-anchor="middle">↔ OF 1.3 Control (:6633)</text>
  </g>''')

    # 8. Symmetrical Callout Cards for Every Hardware Node
    parts.append('''
  <!-- Column 1 Top Header Card: 2x Raspberry Pi 3B+ Red Team (X = 28..282, Y = 16) -->
  <g transform="translate(28, 16)">
    <line x1="127" y1="48" x2="127" y2="68" stroke="#dc2626" stroke-width="1.5"/>
    <circle cx="127" cy="68" r="2.8" fill="#dc2626"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#dc2626" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#b91c1c" text-anchor="middle">RED TEAM · UNTRUSTED WORKLOADS</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">2× Raspberry Pi 3B+ (10.0.2.50, .52)</text>
  </g>

  <!-- Column 1 Bottom Card: Raspberry Pi 5 + Hailo-8 (X = 28..282, Y = 680) -->
  <g transform="translate(28, 680)">
    <line x1="127" y1="0" x2="127" y2="-24" stroke="#2563eb" stroke-width="1.5"/>
    <circle cx="127" cy="-24" r="2.8" fill="#2563eb"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#2563eb" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#1d4ed8" text-anchor="middle">ADVERSARIAL WORKLOAD &amp; O1 CAPTURE</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">RPi 5 + Hailo-8 (26 TOPS) · 10.0.2.51</text>
  </g>

  <!-- Column 2 Header Card: Zodiac FX OpenFlow DUT (X = 323..577, Y = 180) -->
  <g transform="translate(323, 180)">
    <line x1="127" y1="48" x2="127" y2="128" stroke="#d97706" stroke-width="1.5"/>
    <circle cx="127" cy="128" r="2.8" fill="#d97706"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#d97706" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#b45309" text-anchor="middle">TIER 1 · ZODIAC FX (OPENFLOW 1.3 DUT)</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">Atmel SAM4E + KSZ8795 · 128-Rule Budget</text>
  </g>

  <!-- Column 3 Header Card: SDN Controller & Verifier (X = 618..872, Y = 180) -->
  <g transform="translate(618, 180)">
    <line x1="127" y1="48" x2="127" y2="95" stroke="#0284c7" stroke-width="1.5"/>
    <circle cx="127" cy="95" r="2.8" fill="#0284c7"/>
    <rect x="0" y="0" width="254" height="48" rx="6" fill="#f8fafc" stroke="#0284c7" stroke-width="1.5"/>
    <text x="127" y="19" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11" fill="#0369a1" text-anchor="middle">SDN CONTROLLER &amp; VERIFIER</text>
    <text x="127" y="36" font-family="RobotoMono, monospace" font-weight="600" font-size="9" fill="#334155" text-anchor="middle">NVIDIA Jetson Orin Nano Super</text>
  </g>

  <!-- Bottom Legend Banner (Aligned across Columns 2 & 3 at X = 323..872, Y = 688) -->
  <g transform="translate(323, 688)">
    <rect x="0" y="0" width="549" height="32" rx="16" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
    <text x="274.5" y="20" font-family="GoogleSans, sans-serif" font-weight="800" font-size="11.5" letter-spacing="0.6" fill="#0f172a" text-anchor="middle">COMPLETE PHYSICAL SDN TESTBED &amp; DETERMINISTIC VERIFIER LOOP</text>
  </g>
</svg>''')
    return "\n".join(parts)


def svg_cover_artwork() -> str:
    """
    Cover Artwork: Symmetrical 3D isometric CAD representation of the Zodiac physical testbed:
      - Left Column:
        * Top: 2x Raspberry Pi 3 Model B+ (Red Team / Untrusted Workloads: 10.0.2.50, 10.0.2.52)
        * Middle: 2-tier Netgear GS105Ev2 switch stack (Tier 3 Uplink #2 on top, Tier 2 Workload #1 on bottom)
        * Bottom: Raspberry Pi 5 + Official AI HAT+ (Hailo-8 26 TOPS, 10.0.2.51 & O1 Mirror Capture)
      - Center Column: Northbound Networks Zodiac FX Rev A bare-board OpenFlow 1.3 switch
      - Right Column: NVIDIA Jetson Orin Nano Super SDN Controller & Verifier
    All devices share the exact same isometric basis vectors and footprint geometry,
    connected by direct port-to-port orthogonal arrow lines.
    Centered on Page 1 with balanced white space above and below.
    """
    raw_svg = generate_composed_testbed_with_pis_svg(width=900, height=748)
    return raw_svg.replace(
        "<svg viewBox=\"0 0 900 748\" width=\"900\" height=\"748\" xmlns=\"http://www.w3.org/2000/svg\">",
        "<svg viewBox=\"0 0 900 748\" width=\"486pt\" height=\"404pt\" xmlns=\"http://www.w3.org/2000/svg\" style=\"position:absolute;left:63pt;top:234pt;z-index:5;display:block;\">",
        1,
    )


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

