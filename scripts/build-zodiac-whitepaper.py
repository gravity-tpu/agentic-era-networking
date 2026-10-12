#!/usr/bin/env python3
"""
Builds docs/design/zodiac-whitepaper.pdf.

The paper is a position paper with a measured foundation: every number is taken from the
benchmark whitepaper (docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)
and the figures are drawn from those values. Modelled points are drawn hatched and labelled as
modelled (provenance rule: nothing synthetic may look measured). Planned work is labelled as planned.

Requires: Python 3, matplotlib, and Chrome/Chromium (set CHROME_BIN to override discovery).
"""

import base64
import os
import shutil
import subprocess
import tempfile

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.patches as mpatches  # noqa: E402
import matplotlib.ticker as mticker  # noqa: E402

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS_DIR = os.path.join(BASE_DIR, "docs", "design")
FONTS_DIR = os.path.join(DOCS_DIR, "fonts")
OUTPUT_PDF = os.path.join(DOCS_DIR, "zodiac-whitepaper.pdf")

VERSION = "2.0 (draft)"
DATE = "2026-10-09"


def get_chrome_binary():
    env_bin = os.environ.get("CHROME_BIN") or os.environ.get("CHROME_PATH")
    if env_bin and os.path.isfile(env_bin):
        return env_bin
    for candidate in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]:
        resolved = shutil.which(candidate) if not candidate.startswith("/") else (candidate if os.path.isfile(candidate) else None)
        if resolved:
            return resolved
    raise FileNotFoundError("Chrome or Chromium binary not found. Set CHROME_BIN.")


def b64_file(path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing required asset: {path}")
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


# ---------------------------------------------------------------------------
# Figure: capacity versus rule count (values from whitepaper section 5.1, 600-byte packets)
# ---------------------------------------------------------------------------

RULES = [0, 16, 32, 64, 126]
# (value in pps, is_modelled)
BASE = [(17800, True), (8055, False), (5272, False), (3091, False), (1711, False)]
FWD_FIRST = [(17241, True), (12693, False), (10000, False), (7078, False), (4497, False)]


def draw_capacity_figure(path):
    c_base, c_fwd = "#1a5fb4", "#e66100"
    fig, ax = plt.subplots(figsize=(7.2, 3.6), dpi=200)
    width = 0.38
    xs = range(len(RULES))
    for series, offset, color, label in ((BASE, -width / 2, c_base, "Quarantine rules first (base)"),
                                         (FWD_FIRST, width / 2, c_fwd, "Forwarding rules first, highest priority")):
        for i, (val, modelled) in enumerate(series):
            ax.bar(i + offset, val, width, color=color if not modelled else "white", edgecolor=color,
                   hatch="////" if modelled else None, linewidth=1.2,
                   label=label if i == 0 else None)
            ax.text(i + offset, val + 250, f"{val:,}", ha="center", va="bottom", fontsize=6.5, color="#222")
    ax.set_xticks(list(xs))
    ax.set_xticklabels([str(r) for r in RULES])
    ax.set_xlabel("Quarantine rules in the flow table")
    ax.set_ylabel("Forwarded packets per second")
    ax.set_ylim(0, 20500)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{int(v):,}"))
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", alpha=0.25)
    handles, labels = ax.get_legend_handles_labels()
    modelled_patch = mpatches.Patch(facecolor="white", edgecolor="#555", hatch="////", label="Hatched: modelled, not measured")
    ax.legend(handles + [modelled_patch], labels + [modelled_patch.get_label()], fontsize=7, frameon=False, loc="upper right")
    ax.set_title("600-byte UDP capacity, Zodiac FX firmware 0.86", fontsize=9, loc="left")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


CSS = """
@page { size: A4; margin: 22mm 20mm 22mm 20mm; @bottom-center { content: counter(page); font-size: 9pt; color: #666; } }
* { box-sizing: border-box; }
body { font-family: 'Jakarta', sans-serif; font-size: 10.2pt; line-height: 1.5; color: #1f1f1f; }
h1 { font-size: 24pt; line-height: 1.15; margin: 0 0 6pt 0; }
h2 { font-size: 15pt; margin: 22pt 0 6pt 0; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14pt 0 4pt 0; break-after: avoid; }
p { margin: 0 0 7pt 0; }
.subtitle { font-size: 12.5pt; color: #444; margin-bottom: 14pt; }
.meta { font-size: 9pt; color: #555; border-top: 1px solid #ccc; border-bottom: 1px solid #ccc; padding: 6pt 0; margin-bottom: 14pt; }
.meta div { margin: 1pt 0; }
.abstract { background: #f4f6f8; border-left: 3px solid #1a5fb4; padding: 9pt 12pt; margin: 10pt 0 6pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 10pt 0; font-size: 9pt; break-inside: avoid; }
th, td { border: 1px solid #c8ccd0; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eef1f4; }
code, pre { font-family: 'Mono', monospace; font-size: 8.4pt; }
pre { background: #f6f7f8; border: 1px solid #dde0e3; padding: 7pt 9pt; white-space: pre-wrap; break-inside: avoid; }
figure { margin: 10pt 0; break-inside: avoid; }
figure img { width: 100%; }
figcaption { font-size: 8.8pt; color: #444; margin-top: 3pt; }
ul, ol { margin: 0 0 7pt 0; padding-left: 18pt; }
li { margin: 2pt 0; }
.loop { display: flex; align-items: stretch; gap: 0; margin: 8pt 0 4pt 0; break-inside: avoid; }
.stage { flex: 1; border: 1.5px solid #1a5fb4; border-radius: 6px; padding: 6pt 6pt; font-size: 8.4pt; background: #f3f7fc; }
.stage b { display: block; font-size: 9pt; margin-bottom: 2pt; }
.arrow { align-self: center; padding: 0 3pt; color: #1a5fb4; font-weight: bold; }
.planned { border-style: dashed; background: #fafafa; }
.tag { font-size: 7.6pt; text-transform: uppercase; letter-spacing: .04em; color: #555; }
.refs li { font-size: 9pt; }
"""

BODY = """
<h1>Zodiac</h1>
<div class="subtitle">A real-hardware testbed and verifier for agent-proposed SDN policy</div>
<div class="meta">
  <div><b>Document:</b> Position paper with a measured foundation</div>
  <div><b>Version:</b> __VERSION__ &nbsp; <b>Date:</b> __DATE__</div>
  <div><b>Status:</b> Measurements final (2026-10-04). Verifier partly implemented. First manual conformance run reported (E1; ICMP and ARP only, small sample); adversarial and agent-proposal evaluations planned, no results.</div>
  <div><b>Repository:</b> github.com/gravity-tpu/agentic-era-networking</div>
</div>

<div class="abstract">
<p><b>Abstract.</b> Agents can generate network policy faster than people can review it, so the scarce resource is verification. We describe Zodiac, a testbed for studying that problem on physical hardware: an OpenFlow 1.3 switch with a 128-rule table, a mirror tap, an instrumented controller, and a hostile workload node. We report the measured hardware model. Forwarding cost is <code>38.5 µs + 34.8 ns per payload byte above 64 + 4.24 µs per rule</code>, set by the switch's microcontroller and not its 100 Mbit/s ports; rule layout changes capacity by up to 2.6x; and offered load of 1.3 to 2.3 times capacity makes the switch drop its control session and its flow table. We argue that the right verifier for this system checks properties of the rule set, including capacity, against that measured model, and closes the loop by testing model against wire. The verifier is partly built; the evaluation, including how often LLM-proposed rule sets are unsafe, is specified here and not yet run. The first manual conformance run (E1) is reported in section 5.</p>
</div>

<h2>1. Problem</h2>
<p>An agent asked to "let the workload reach DNS but nothing else" can produce a plausible flow-rule set in seconds. Whether it is safe is a different question, and the cost asymmetry between producing and checking policy grows as generation gets cheaper. Review by a person does not scale, and review by another model is a second opinion, not a proof.</p>
<p>Most work on checking network policy runs on configuration snapshots or in emulation. Those settings omit what a deployment actually fails on: a small switch whose CPU is the bottleneck, firmware that supports a subset of the match fields, and control sessions that collapse under load. Zodiac's contribution is to ground the question in a real device whose limits are measured, so a policy can fail the verifier for a hardware reason (too many rules, wrong layout, too much load) as well as a logical one (isolation leak).</p>
<p>The question we study: <i>can an agent safely propose network policy, and what must "safely" mean on hardware this constrained?</i> We do not claim autonomous operation. Agents propose; deterministic code decides admissibility; a person approves.</p>

<h2>2. Testbed</h2>
<table>
<tr><th>Role</th><th>Device</th></tr>
<tr><td>Device under test</td><td>Northbound Networks Zodiac FX, firmware 0.86: SAM4E8E 120 MHz MCU, KSZ8795 switch IC, 4 x 100BASE-TX, 128-rule flow table, OpenFlow 1.3</td></tr>
<tr><td>Controller, benchmark host, detector</td><td>NVIDIA Jetson Orin Nano Super (the Coral Edge TPUs were removed on 2026-10-11)</td></tr>
<tr><td>Hostile workload, traffic generator</td><td>Raspberry Pi 5 with Hailo-8; Raspberry Pi 3B+ as the client workload</td></tr>
<tr><td>Workload aggregation</td><td>NETGEAR GS105Ev2 (802.1Q, port mirror)</td></tr>
<tr><td>Uplink switch</td><td>Second NETGEAR GS105Ev2 between the ISP mesh and Zodiac Port 2, installed 2026-10-09 after the measurements in section 3. It mirrors the Zodiac P2 link (its P4) to its P3, where the Jetson's third USB NIC captures it as observation point O3, live since 2026-10-12. The NIC is receive-only by two layers, neither a guarantee: egress is dropped by a blackhole qdisc (the Jetson kernel lacks <code>cls_matchall</code>), which does not stop a raw socket that bypasses the qdisc, and the mirror port is isolated in its own VLAN. A test on 2026-10-12 found that the mirror port initially accepted ingress, contradicting the documented behavior; after the VLAN isolation the same test no longer saw the injected frame. The first NETGEAR's mirror port, where the untrusted Pi 5's capture NIC sits, showed the same behavior and was isolated the same way; both re-tests, with untagged, single-tagged and double-tagged frames, were negative.</td></tr>
</table>
<p>Port 1 carries the untrusted workload segment, Port 2 the uplink to the lab LAN and Internet, Port 3 a mirror tap read by the Jetson, and Port 4 the OpenFlow control channel. The policy under test isolates the workload: only IPv4 whose source and destination are both inside the workload subnet, plus ARP, may cross Port 1 to Port 2; everything else from Port 1 is mirrored to the tap only; the table-miss entry drops.</p>
<p><b>Provenance.</b> Every measurement artifact is stamped as a physical run, uses 64-bit integer counters and monotonic nanosecond clocks, and binds the switch identity and firmware version. Telemetry from disconnected hardware reports zero and offline, never a plausible value. Modelled values in this paper are marked as modelled.</p>

<h2>3. The measured hardware model</h2>
<p>Traffic from the Pi to a receiver on the uplink was offered at fixed rates in 45 s steps per rule depth, and forwarded rate was read from the switch's own port counters. Full method, data and limitations are in the benchmark whitepaper [1].</p>
<pre>t_packet = 38.5 µs + 0.0348 µs x (B - 64) + 4.24 µs x N      (base layout; B = UDP payload bytes, N = rules)
capacity = 1,000,000 / t_packet  packets per second</pre>
<p>The equation was fitted on the 64-byte and 572-byte ladders and predicted the independent 1470-byte ladder within about 1% at three rule depths. The switch evaluates its table in software, so a packet is limited by the MCU and the number of rules scanned before its match, not by the 100 Mbit/s port. Port speed only binds for large packets with almost no rules.</p>

<figure>
<img src="data:image/png;base64,__CAPACITY_FIG__" alt="Capacity versus rule count for two layouts">
<figcaption><b>Figure 1.</b> Forwarded packets per second for 600-byte UDP at each quarantine rule depth, for two table layouts. Solid bars are measured; hatched bars are modelled from the fitted equation (empty table: the base run did not saturate, at least 14,807 pps measured, and the forwarding-first run lost its session). Values from [1], section 5.1. Single rounds for most layouts.</figcaption>
</figure>

<h3>Findings that constrain any verifier</h3>
<ul>
<li><b>Layout is a first-order effect.</b> Installing forwarding rules first and at the highest priority cuts the per-rule cost from 4.24 µs to 1.3 µs, which gives 1.6x to 2.6x more capacity at 16 to 126 rules. Either change alone did not help.</li>
<li><b>The control plane is the fragile part.</b> At 1.3 to 2.3 times capacity the switch closes its OpenFlow session and clears its table; recovery takes about 2 to 3 s, and under sustained overload the table could not be restored. Spontaneous session losses also occurred below capacity (8 in three working-window hours).</li>
<li><b>Availability under a realistic working pattern</b> (rules accumulating over five minutes, then flush) was 99.83% to 99.95% over three one-hour runs.</li>
<li><b>The original 20,800 pps plan is unreachable.</b> At 600 bytes the empty-table ceiling is about 17,800 pps.</li>
</ul>
<p>Consequence: a policy that is logically correct can still make the switch unusable. Capacity and layout therefore belong in the set of properties a verifier checks.</p>

<h2>4. Approach: verify the rule set against the model</h2>
<p>A static flow table has no routing loops to find, so a loop-freedom check on hop lists proves little here. (An earlier version of this project used one and called it a symbolic verifier; its call sites passed one-hop lists that cannot fail. We treat it as superseded.) The useful questions are properties of the rule set and its interaction with the hardware.</p>

<div class="loop">
  <div class="stage"><b>Propose</b>human or LLM rule set</div><div class="arrow">&rarr;</div>
  <div class="stage"><b>Verify</b>property checks and cost model; reject on any violation</div><div class="arrow">&rarr;</div>
  <div class="stage"><b>Approve</b>explicit human gate</div><div class="arrow">&rarr;</div>
  <div class="stage"><b>Install</b>OpenFlow 1.3 flow-mods</div><div class="arrow">&rarr;</div>
  <div class="stage"><b>Read back</b>table compared with intent</div><div class="arrow">&rarr;</div>
  <div class="stage planned"><b>Probe</b>model vs wire via mirror tap (planned)</div>
</div>

<table>
<tr><th>Id</th><th>Property</th><th>State</th></tr>
<tr><td>A1</td><td>Isolation: nothing from the workload port reaches the uplink except explicitly allowed traffic</td><td>Implemented</td></tr>
<tr><td>A2</td><td>No hairpin: no rule outputs to its own ingress port</td><td>Implemented</td></tr>
<tr><td>A3</td><td>Default drop: a lowest-priority table-miss DROP exists</td><td>Readback only</td></tr>
<tr><td>A4</td><td>Quarantine precedence over every allow rule</td><td>By constant; check planned; conflicts with A9</td></tr>
<tr><td>A5, A6</td><td>No shadowed rules; no conflicting overlaps at equal priority</td><td>Planned</td></tr>
<tr><td>A7</td><td>Rule budget within the 128-rule table, with runtime headroom</td><td>Planned</td></tr>
<tr><td>A8</td><td>Modelled capacity at this rule count and layout meets a declared target rate</td><td>Planned (uses the model in section 3)</td></tr>
<tr><td>A9</td><td>Layout: forwarding rules ordered per the measured cheap layout</td><td>Planned; conflicts with A4</td></tr>
<tr><td>A10</td><td>ARP confinement across the isolation boundary</td><td>Blocked: firmware 0.86 ARP field matching unverified</td></tr>
</table>
<p>Today the implementation checks A1 and A2 statically (<code>verifyPort1Isolation</code>) and compares the switch's flow-stats readback with intent on match fields (<code>verifyIsolationReadback</code>). Readback does not yet parse output actions, so it proves what the switch matches, not where it forwards. Closing that gap, and the planned checks, are the near-term work.</p>

<h3>A tension between cost and containment</h3>
<p>The cheapest measured layout (forwarding rules first, at the highest priority) puts forwarding rules above quarantine rules. A quarantined source that also matches a forwarding rule would still be forwarded, so properties A4 and A9 cannot both hold as written. The benchmark is unaffected because its quarantine rules match addresses that never appear on the wire. Resolving this, by excluding quarantined sources from forwarding rules, splitting quarantine rules across priorities, or accepting the quarantine-first cost, is the first design question for the verifier, and the capacity cost of each option should be measured.</p>

<h3>A known weakness in the current policy</h3>
<p>The isolation policy forwards ARP between the workload and the lab LAN, because firmware 0.86 support for ARP source and target fields is unverified. The code documents this as address disclosure only. We suspect it is also a spoofing surface: a workload can send ARP claiming a lab-LAN address. This is a hypothesis; testing it is the first adversarial scenario below, and a confirmed result becomes a verifier property.</p>

<h2>5. Evaluation plan</h2>
<p>Only E1 has had a first manual run (below); E2 and E3 have not been run. The evaluations are specified so the results are interpretable, and so a negative result is reportable.</p>

<h3>E1. Model versus wire (conformance)</h3>
<p>For a stated set of generated packets, compute the model's verdict, send the packets from the workload node, and observe what leaves each port through the mirror tap. Metric: agreement rate, with each disagreement classified as a model error, a firmware behavior, or a harness artifact. Falsifier: systematic disagreement on forwarding or drop decisions means the static checks cannot be trusted for this firmware.</p>
<p><b>First manual run (2026-10-12).</b> With observation point O3 live (the uplink switch mirroring the Zodiac P2 link to a receive-only capture NIC on the Jetson) and the Zodiac P3 tap as O2, five checks were made by hand: allowed traffic appeared at O3 (10 of 10 expected ICMP packets, 5 requests plus 5 replies); blocked traffic did not (0 ICMP toward the gateway, with a control capture showing the capture was live); traffic between two workload nodes never reached the Zodiac (0, with a positive control in the same window); ARP from a workload node crossed to the uplink as documented (6 requests at both O2 and O3, repeated with provenance sidecars on both captures); and the tap saw only P1-ingress copies (5 replies, 0 requests, also repeated with sidecars). All five matched the model, and none disagreed. The sample is small (ICMP and ARP, five pings per run, one switch, firmware 0.86), and this is not yet an automated probe over a stated packet set, so it does not establish agreement rate.</p>

<h3>E2. Adversarial scenarios from the Pi 5</h3>
<ol>
<li>ARP spoofing across the isolation boundary.</li>
<li>MAC and IP spoofing within the workload segment.</li>
<li>Port scan and low-rate scan.</li>
<li>Flood to session loss (what an attacker can do to the control plane).</li>
<li>Evasion: traffic crafted to fit allowed rules, fragmentation, rule-table exhaustion.</li>
</ol>
<p>Metrics per scenario: contained or not, time to detect, time to quarantine, false positives, and whether the verifier or the detector would have prevented it. The existing anomaly detector (Coral TPU and Jetson GPU) is the detector under test; its precision and recall are unmeasured today.</p>

<h3>E3. Agent-proposal evaluation</h3>
<p>For a fixed set of natural-language intents, have one or more LLMs propose rule sets. Metrics: fraction rejected by the verifier and by which property; fraction accepted that misbehave on hardware (false accepts, the dangerous case); fraction rejected that were in fact safe (false rejects). Baselines: unverified install, and the same intents written by a person. This is the project's central empirical question and depends on E1 and a sufficiently rich property set.</p>

<h2>6. Related work</h2>
<p>Static data-plane verification is established. Header Space Analysis [3] and VeriFlow [4] check reachability and loop properties over forwarding state in software, and Batfish [5] analyzes network configurations. Zodiac does not claim a new verification algorithm. It differs by (i) pairing the verifier with a measured model of one commodity device, so capacity and layout are checked properties; (ii) comparing the model against traffic on the wire; and (iii) evaluating agent-generated policy specifically. We have not surveyed the literature exhaustively or compared against these tools.</p>

<h2>7. Limitations and threats to validity</h2>
<ul>
<li><b>One switch, one firmware, one workload node.</b> The cost model is fitted to a single Zodiac FX on firmware 0.86 and must not be assumed to hold elsewhere. Several layout ladders are single rounds.</li>
<li><b>Open measurements:</b> drop-path capacity (the drop-rule hit counter stayed at zero while traffic was dropped), direct observation of switch CPU load, and unexplained spontaneous session losses.</li>
<li><b>The verifier encodes the authors' reading of L2 and flow-table semantics.</b> It has had no independent network-engineer review; that is planned before results are published.</li>
<li><b>The anomaly detector's accuracy is unmeasured.</b> Claims about detection are deferred to E2.</li>
<li><b>LLM nondeterminism</b> affects E3; it requires repeated runs and reporting variance.</li>
<li><b>Scale.</b> This is a lab on a 100 Mbit/s MCU switch. It makes no availability or production-readiness claim, and results do not extrapolate to ASIC switches.</li>
</ul>

<h2>8. Status</h2>
<table>
<tr><th>Item</th><th>State</th></tr>
<tr><td>Hardware model and benchmark harness</td><td>Measured, documented [1]</td></tr>
<tr><td>Isolation policy and static checks A1, A2; readback on match fields</td><td>Implemented and unit-tested</td></tr>
<tr><td>Checks A3 to A10; action-level readback; cost-model input to the verifier</td><td>Planned</td></tr>
<tr><td>E1 conformance</td><td>First manual run done: five checks, all matched (section 5); automated probe planned</td></tr>
<tr><td>E2 adversarial suite, E3 agent evaluation</td><td>Planned; no results</td></tr>
<tr><td>Independent review of policy and property list</td><td>Planned before publication of results</td></tr>
</table>
<p>The roadmap [2] gives sequencing and exit criteria. Deferred or dropped from the earlier plan: the Sentinel bot-mitigation module, DNS reverse proxy, multi-agent routing stability, and the agent intent firewall.</p>

<h2>References</h2>
<ol class="refs">
<li>Zodiac Network Infrastructure benchmark archive, <i>Packet-Rate Limits of an OpenFlow Edge Switch Under Rule-Table Load</i>, v1.1, 2026. <code>docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md</code></li>
<li>Zodiac roadmap. <code>docs/ROADMAP.md</code></li>
<li>P. Kazemian, G. Varghese, N. McKeown, "Header Space Analysis: Static Checking for Networks," NSDI 2012.</li>
<li>A. Khurshid, X. Zou, W. Zhou, M. Caesar, P. B. Godfrey, "VeriFlow: Verifying Network-Wide Invariants in Real Time," NSDI 2013.</li>
<li>A. Fogel et al., "A General Approach to Network Configuration Analysis," NSDI 2015.</li>
<li>Open Networking Foundation, <i>OpenFlow Switch Specification, Version 1.3.5</i>, 2015.</li>
</ol>
"""


def main():
    chrome = get_chrome_binary()
    with tempfile.TemporaryDirectory(prefix="zodiac_whitepaper_") as tmp:
        fig_path = os.path.join(tmp, "capacity.png")
        draw_capacity_figure(fig_path)

        jakarta = b64_file(os.path.join(FONTS_DIR, "PlusJakartaSans.ttf"))
        mono = b64_file(os.path.join(FONTS_DIR, "RobotoMono-Regular.ttf"))
        font_css = (
            "@font-face { font-family: 'Jakarta'; font-weight: 400 800; "
            f"src: url('data:font/ttf;base64,{jakarta}') format('truetype'); }}\n"
            "@font-face { font-family: 'Mono'; font-weight: 400; "
            f"src: url('data:font/ttf;base64,{mono}') format('truetype'); }}\n"
        )
        body = (
            BODY.replace("__CAPACITY_FIG__", b64_file(fig_path))
            .replace("__VERSION__", VERSION)
            .replace("__DATE__", DATE)
        )
        html = (
            "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
            "<title>Zodiac: a real-hardware testbed and verifier for agent-proposed SDN policy</title>"
            f"<style>{font_css}{CSS}</style></head><body>{body}</body></html>"
        )
        html_path = os.path.join(tmp, "zodiac_whitepaper.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)

        cmd = [chrome, "--headless=new", "--disable-gpu", f"--print-to-pdf={OUTPUT_PDF}", "--no-pdf-header-footer", html_path]
        print(f"Compiling {OUTPUT_PDF} via Chrome ({chrome})...")
        subprocess.run(cmd, check=True, timeout=120)
    print(f"Wrote {OUTPUT_PDF} ({os.path.getsize(OUTPUT_PDF)} bytes)")


if __name__ == "__main__":
    main()
