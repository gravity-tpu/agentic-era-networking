#!/usr/bin/env python3
"""
Pure-vector inline SVG figure generators for the Zodiac v3.0 Whitepaper.
Every diagram and chart is emitted as an inline <svg> element using embedded
GoogleSans / GoogleSansText / RobotoMono vector fonts — zero PNG rasterization,
ensuring infinite-zoom crispness in Chromium's PDF output.
"""


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
    Cover Artwork: Replaces abstract prism with a crisp, self-explanatory
    Zodiac Closed-Loop Verification & Hardware Conformance Architecture Card.
    Fits neatly on the right half of the cover page without overlapping footer or titles.
    """
    return """
<svg viewBox="0 0 380 435" width="280pt" height="320pt" xmlns="http://www.w3.org/2000/svg" style="position:absolute;right:48pt;top:222pt;z-index:5;">
  <!-- Card Background -->
  <rect x="0" y="0" width="380" height="435" rx="8" fill="#f8f9fa" stroke="#dadce0" stroke-width="1.5" />
  
  <!-- Header Bar -->
  <rect x="0" y="0" width="380" height="38" rx="8" fill="#1a73e8" />
  <rect x="0" y="30" width="380" height="8" fill="#1a73e8" />
  <text x="16" y="24" font-family="GoogleSans, sans-serif" font-weight="700" font-size="11.5" fill="#ffffff">ZODIAC CLOSED-LOOP ARCHITECTURE</text>
  <text x="364" y="24" text-anchor="end" font-family="RobotoMono, monospace" font-size="8.5" fill="#d2e3fc">v3.0 VERIFIED</text>

  <!-- Step 1: LLM Policy Proposers -->
  <g transform="translate(16, 50)">
    <rect x="0" y="0" width="348" height="66" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="6" height="66" rx="3" fill="#1a73e8" />
    <text x="14" y="18" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#202124">1. LLM Policy Proposers (Local · Rented A100 · Cloud API)</text>
    <text x="14" y="34" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#5f6368">Natural language operator intent &rarr; OpenFlow 1.3 JSON flow table.</text>
    <text x="14" y="52" font-family="RobotoMono, monospace" font-weight="700" font-size="8" fill="#d93025">Zero-Shot (Protocol A): 35%–57% Local, 96.0% Haiku (2,303/2,400)</text>
  </g>

  <!-- Connecting Arrow 1 -> 2 -->
  <line x1="190" y1="116" x2="190" y2="134" stroke="#1a73e8" stroke-width="2" />
  <polygon points="190,137 186,130 194,130" fill="#1a73e8" />

  <!-- Step 2: Deterministic Verifier -->
  <g transform="translate(16, 138)">
    <rect x="0" y="0" width="348" height="76" rx="5" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.4" />
    <text x="14" y="18" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#1967d2">2. Deterministic Verifier (Properties A1–A11 &amp; Cost Model)</text>
    <text x="14" y="34" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Precedence conflicts (A4), shadowing (A9), ARP confinement (A10),</text>
    <text x="14" y="47" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">table budget k&le;8, and traversal cost: t_pkt = 80.0&micro;s + 5.42&micro;s &middot; k (A8).</text>
    <text x="14" y="65" font-family="RobotoMono, monospace" font-weight="700" font-size="8.2" fill="#137333">Protocol B Feedback (&le;5 turns): 94%–100% Admissible (400/400 Haiku)</text>
  </g>

  <!-- Connecting Arrow 2 -> 3 -->
  <line x1="190" y1="214" x2="190" y2="232" stroke="#1a73e8" stroke-width="2" />
  <polygon points="190,235 186,228 194,228" fill="#1a73e8" />

  <!-- Step 3: Governance & Quarantine Envelope -->
  <g transform="translate(16, 236)">
    <rect x="0" y="0" width="348" height="66" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="6" height="66" rx="3" fill="#fbbc04" />
    <text x="14" y="18" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#202124">3. Governance: Human Approval Gate &amp; Containment Envelope</text>
    <text x="14" y="34" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#5f6368">Agent policies NEVER self-install; human sign-off required.</text>
    <text x="14" y="52" font-family="RobotoMono, monospace" font-size="8" fill="#b06000">Quarantine Envelope: k&le;8 DROPs, TTL&le;300s, protected hosts immune</text>
  </g>

  <!-- Connecting Arrow 3 -> 4 -->
  <line x1="190" y1="302" x2="190" y2="320" stroke="#1a73e8" stroke-width="2" />
  <polygon points="190,323 186,316 194,316" fill="#1a73e8" />

  <!-- Step 4: Physical Silicon & Conformance -->
  <g transform="translate(16, 324)">
    <rect x="0" y="0" width="348" height="98" rx="5" fill="#ffffff" stroke="#dadce0" stroke-width="1.2" />
    <rect x="0" y="0" width="6" height="98" rx="3" fill="#137333" />
    <text x="14" y="18" font-family="GoogleSans, sans-serif" font-weight="700" font-size="10" fill="#202124">4. Physical Silicon (Zodiac FX 120 MHz) &amp; Wire Taps (O1, O2, O3)</text>
    <text x="14" y="34" font-family="GoogleSansText, sans-serif" font-size="8.5" fill="#3c4043">Execution on Atmel SAM4E8E (FW 0.86) + dual GS105Ev2 mirror taps.</text>
    <text x="14" y="52" font-family="RobotoMono, monospace" font-weight="700" font-size="8" fill="#137333">&bull; Track B: 611/611 wire flow checks conform (128 rule sets, F1)</text>
    <text x="14" y="68" font-family="RobotoMono, monospace" font-weight="700" font-size="8" fill="#137333">&bull; Track C: 7/7 live adversary scenarios contained (0 leaked frames)</text>
    <text x="14" y="84" font-family="GoogleSansText, sans-serif" font-size="8" fill="#5f6368">Fate-sharing: switch wipes table on controller loss; recovers in 4–6 s.</text>
  </g>
</svg>
"""
