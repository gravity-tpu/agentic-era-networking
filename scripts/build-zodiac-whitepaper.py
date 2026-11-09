#!/usr/bin/env python3
"""
Builds the NeurIPS- evaluation-style Zodiac Whitepaper (v3.0, November 2026):
  docs/design/zodiac-whitepaper.pdf

Follows the Google NeurIPS Evaluation whitepaper template
(docs/archive/sentinel/neurips_evaluation.pdf) with two-pass TOC page detection
and running header/footer stamping via PyMuPDF.

Crispness guarantee (0 Type3 bitmap fonts):
  - All fonts are registered via explicit static TrueType @font-face weights
    (GoogleSans 400/500/700, GoogleSansText 400/500/700, RobotoMono 400/700)
    with `font-synthesis: none;` globally enabled.
  - All five technical diagrams and charts (Figures 1-5) and cover artwork are
    pure inline <svg> vector graphics from scripts/zodiac_whitepaper_figures.py.
  - Physical bench photographs (excluding the StarTech display dock) are
    presented in Appendix A as hardware provenance evidence.
"""

import os
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from zodiac_whitepaper_figures import (  # noqa: E402
    svg_cover_artwork,
    svg_closed_loop_architecture,
    svg_figure_1_physical_topology,
    svg_figure_2_verifier_pipeline,
    svg_figure_3_capacity_ladder,
    svg_figure_4_deployed_cost_and_a8,
    svg_figure_5_agent_eval_chart,
    svg_figure_6_conformance_funnel,
)

FONT_DIR = REPO_ROOT / "docs" / "design" / "fonts"
FIG_DIR = REPO_ROOT / "docs" / "design" / "figures"
HTML_OUT = REPO_ROOT / "docs" / "design" / "zodiac-whitepaper.html"
PDF_RAW = REPO_ROOT / "docs" / "design" / "zodiac-whitepaper-raw.pdf"
PDF_FINAL = REPO_ROOT / "docs" / "design" / "zodiac-whitepaper.pdf"

PHOTO_STACK = (FIG_DIR / "bench-jetson-switch-stack.jpg").resolve().as_uri()
PHOTO_WIRING = (FIG_DIR / "bench-port-wiring-workloads.jpg").resolve().as_uri()


def font_uri(filename: str) -> str:
    path = (FONT_DIR / filename).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Required static font missing: {path}")
    return path.as_uri()


def generate_html(toc_pages: dict[str, int] | None = None) -> str:
    if toc_pages is None:
        toc_pages = {}

    def pg(key: str, default: int) -> int:
        return toc_pages.get(key, default)

    gs_reg = font_uri("GoogleSans-Regular.ttf")
    gs_med = font_uri("GoogleSans-Medium.ttf")
    gs_bold = font_uri("GoogleSans-Bold.ttf")
    gst_reg = font_uri("GoogleSansText-Regular.ttf")
    gst_med = font_uri("GoogleSansText-Medium.ttf")
    gst_bold = font_uri("GoogleSansText-Bold.ttf")
    rm_reg = font_uri("RobotoMono-Regular.ttf")

    fig1_svg = svg_figure_1_physical_topology()
    fig2_svg = svg_figure_2_verifier_pipeline()
    fig3_svg = svg_figure_3_capacity_ladder()
    fig4_svg = svg_figure_4_deployed_cost_and_a8()
    fig5_svg = svg_figure_5_agent_eval_chart()
    fig6_svg = svg_figure_6_conformance_funnel()
    closed_loop_arch_svg = svg_closed_loop_architecture()
    cover_svg = svg_cover_artwork()

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Zodiac: A Real-Hardware Testbed and Deterministic Verifier for Agent-Proposed SDN Policy</title>
<style>
@font-face {{
    font-family: 'GoogleSans';
    src: url('{gs_reg}') format('truetype');
    font-weight: 400;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSans';
    src: url('{gs_med}') format('truetype');
    font-weight: 500;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSans';
    src: url('{gs_bold}') format('truetype');
    font-weight: 600;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSans';
    src: url('{gs_bold}') format('truetype');
    font-weight: 700;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSansText';
    src: url('{gst_reg}') format('truetype');
    font-weight: 400;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSansText';
    src: url('{gst_med}') format('truetype');
    font-weight: 500;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSansText';
    src: url('{gst_bold}') format('truetype');
    font-weight: 600;
    font-style: normal;
}}
@font-face {{
    font-family: 'GoogleSansText';
    src: url('{gst_bold}') format('truetype');
    font-weight: 700;
    font-style: normal;
}}
@font-face {{
    font-family: 'RobotoMono';
    src: local('Menlo-Regular'), local('Menlo');
    font-weight: 400;
    font-style: normal;
}}
@font-face {{
    font-family: 'RobotoMono';
    src: local('Menlo-Bold'), local('Menlo');
    font-weight: 700;
    font-style: normal;
}}

@page {{
    size: 8.5in 11in;
    margin: 54pt 54pt 54pt 54pt;
}}
@page :first {{
    margin: 0in;
}}

* {{
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    font-synthesis: none;
    -webkit-font-smoothing: antialiased;
}}

body {{
    font-family: 'GoogleSansText', sans-serif;
    font-size: 9.8pt;
    line-height: 1.52;
    color: #3c4043;
    background: #ffffff;
}}

.fixed-page {{
    width: 100%;
    height: 676pt;
    position: relative;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
    margin: 0;
    padding: 0;
}}
.cover-page {{
    margin-top: 0;
    width: 8.5in;
    height: 11in;
    position: relative;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
    padding: 0;
}}

/* Cover Page Styling (matching neurips_evaluation.pdf) */
.cover-title {{
    position: absolute;
    top: 56pt;
    left: 54pt;
    width: 504pt;
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 26pt;
    line-height: 1.15;
    color: #202124;
    letter-spacing: -0.4pt;
    z-index: 10;
}}
.cover-subtitle {{
    position: absolute;
    top: 134pt;
    left: 54pt;
    width: 504pt;
    font-family: 'GoogleSans', sans-serif;
    font-weight: 500;
    font-size: 10.2pt;
    line-height: 1.45;
    color: #5f6368;
    z-index: 10;
}}
.cover-badges {{
    position: absolute;
    top: 366pt;
    left: 54pt;
    width: 220pt;
    z-index: 10;
}}
.cover-badge {{
    display: inline-block;
    background: #e8f0fe;
    border: 1pt solid #1a73e8;
    color: #1967d2;
    font-family: 'RobotoMono', monospace;
    font-size: 7.8pt;
    padding: 3pt 6pt;
    border-radius: 3pt;
    margin-right: 4pt;
    margin-bottom: 5pt;
}}
.cover-authors {{
    position: absolute;
    bottom: 80pt;
    left: 54pt;
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 9.5pt;
    line-height: 1.45;
    color: #202124;
    z-index: 10;
}}
.cover-meta {{
    font-family: 'GoogleSansText', sans-serif;
    font-weight: 400;
    font-size: 8.5pt;
    line-height: 1.45;
    color: #5f6368;
    z-index: 10;
}}
.cover-date {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 9.5pt;
    line-height: 1.35;
    color: #202124;
    z-index: 10;
}}

/* Page 2: Invariants & Governance Grid */
.gov-header {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 15.5pt;
    color: #1967d2;
    margin-bottom: 4pt;
}}
.gov-sub {{
    font-size: 8.6pt;
    line-height: 1.38;
    color: #5f6368;
    margin-bottom: 10pt;
}}
.gov-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7pt 12pt;
    margin-bottom: 10pt;
}}
.gov-card {{
    border: 1pt solid #dadce0;
    border-radius: 4pt;
    padding: 6.5pt 9pt;
    background: #f8f9fa;
}}
.gov-card-title {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 8.8pt;
    color: #202124;
    margin-bottom: 2pt;
}}
.gov-card-body {{
    font-size: 8pt;
    line-height: 1.35;
    color: #3c4043;
}}

/* Table of Contents (Page 3) */
.toc-header {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 21pt;
    color: #1967d2;
    margin-top: 6pt;
    margin-bottom: 12pt;
}}
.toc-list {{
    width: 100%;
}}
.toc-row {{
    display: flex;
    align-items: baseline;
    margin-bottom: 4.5pt;
    font-family: 'GoogleSans', sans-serif;
    font-size: 9.2pt;
    color: #3c4043;
}}
.toc-row.major {{
    font-weight: 700;
    color: #202124;
    margin-top: 5.5pt;
}}
.toc-row.sub {{
    padding-left: 14pt;
    font-family: 'GoogleSansText', sans-serif;
    font-weight: 400;
    font-size: 8.5pt;
    color: #5f6368;
    margin-bottom: 3.5pt;
}}
.toc-title {{
    white-space: nowrap;
}}
.toc-leader {{
    flex-grow: 1;
    border-bottom: 1pt dotted #bdc1c6;
    margin: 0 8pt;
    position: relative;
    top: -3pt;
}}
.toc-page {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    color: #1967d2;
    white-space: nowrap;
}}

/* Content Typography & Layout */
.content-flow {{
    width: 100%;
}}
h1 {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 19pt;
    line-height: 1.22;
    color: #1967d2;
    margin-top: 18pt;
    margin-bottom: 9pt;
    page-break-after: avoid;
    break-after: avoid;
}}
h1.page-start {{
    page-break-before: always;
    break-before: page;
    margin-top: 6pt;
}}
h2 {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 12.8pt;
    line-height: 1.28;
    color: #1967d2;
    margin-top: 14pt;
    margin-bottom: 6pt;
    page-break-after: avoid;
    break-after: avoid;
}}
h3 {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 10.5pt;
    line-height: 1.32;
    color: #202124;
    margin-top: 10pt;
    margin-bottom: 4pt;
    page-break-after: avoid;
    break-after: avoid;
}}
p {{
    margin-bottom: 8.5pt;
    text-align: left;
}}
ul, ol {{
    margin-left: 16pt;
    margin-bottom: 9pt;
}}
li {{
    margin-bottom: 4pt;
}}
strong, b {{
    font-weight: 700;
    color: #202124;
}}
code {{
    font-family: 'RobotoMono', monospace;
    font-size: 8.4pt;
    color: #174ea6;
    background-color: #f1f3f4;
    padding: 1pt 3pt;
    border-radius: 2pt;
}}

/* Pull-Quote Layout (Executive Summary) */
.exec-grid {{
    display: flex;
    gap: 20pt;
    align-items: flex-start;
}}
.exec-main {{
    flex: 1;
}}
.exec-main p {{
    margin-bottom: 5pt;
    font-size: 9.4pt;
    line-height: 1.48;
}}
.exec-main ul {{
    margin-top: 2pt;
    margin-bottom: 5pt;
    padding-left: 14pt;
}}
.exec-main li {{
    margin-bottom: 3pt;
    font-size: 8.8pt;
    line-height: 1.42;
}}
.exec-sidebar {{
    width: 176pt;
    flex-shrink: 0;
    border-top: 2pt solid #1a73e8;
    border-bottom: 2pt solid #1a73e8;
    padding: 12pt 0;
    margin-top: 4pt;
    font-family: 'GoogleSans', sans-serif;
    font-weight: 500;
    font-size: 11pt;
    line-height: 1.42;
    color: #1967d2;
}}

/* Callout Boxes */
.callout {{
    background-color: #f8f9fa;
    border-left: 3pt solid #1a73e8;
    padding: 9pt 12pt;
    margin: 10pt 0;
    border-radius: 0 4pt 4pt 0;
    page-break-inside: avoid;
    break-inside: avoid;
}}
.callout.warn {{
    background-color: #fef7e0;
    border-left-color: #fbbc04;
}}
.callout.pass {{
    background-color: #e6f4ea;
    border-left-color: #137333;
}}
.callout-title {{
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    font-size: 9.5pt;
    color: #202124;
    margin-bottom: 3pt;
}}

/* Tables */
table {{
    width: 100%;
    border-collapse: collapse;
    margin: 9pt 0 12pt 0;
    font-size: 8.3pt;
    line-height: 1.35;
    page-break-inside: avoid;
    break-inside: avoid;
}}
th {{
    background-color: #e8f0fe;
    color: #1967d2;
    font-family: 'GoogleSans', sans-serif;
    font-weight: 700;
    text-align: left;
    padding: 5.5pt 6.5pt;
    border-top: 1.2pt solid #1a73e8;
    border-bottom: 1.2pt solid #1a73e8;
}}
td {{
    padding: 5pt 6.5pt;
    border-bottom: 0.6pt solid #dadce0;
    color: #3c4043;
    vertical-align: top;
}}
tr:nth-child(even) td {{
    background-color: #f8f9fa;
}}

/* Figures */
.figure-box {{
    margin: 11pt 0 13pt 0;
    page-break-inside: avoid;
    break-inside: avoid;
}}
.figure-caption {{
    margin-top: 5pt;
    font-size: 8.4pt;
    line-height: 1.38;
    color: #5f6368;
}}
.figure-caption strong {{
    font-family: 'GoogleSans', sans-serif;
    color: #202124;
}}

/* Formula Block */
.equation-box {{
    background: #f8f9fa;
    border: 1pt solid #dadce0;
    border-radius: 4pt;
    padding: 8pt 14pt;
    margin: 8pt 0 10pt 0;
    font-family: 'RobotoMono', monospace;
    font-size: 9pt;
    color: #202124;
    page-break-inside: avoid;
    break-inside: avoid;
}}

/* Bench Evidence Grid in Appendix A */
.photo-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12pt;
    margin: 10pt 0;
    page-break-inside: avoid;
    break-inside: avoid;
}}
.photo-card {{
    border: 1pt solid #dadce0;
    border-radius: 4pt;
    padding: 6pt;
    background: #f8f9fa;
}}
.photo-card img {{
    width: 100%;
    height: 148pt;
    object-fit: cover;
    border-radius: 3pt;
    display: block;
}}
.photo-caption {{
    margin-top: 5pt;
    font-size: 8pt;
    line-height: 1.35;
    color: #3c4043;
}}

/* References */
.ref-item {{
    font-size: 8.2pt;
    line-height: 1.38;
    margin-bottom: 4.5pt;
    padding-left: 18pt;
    text-indent: -18pt;
    color: #3c4043;
}}
</style>
</head>
<body>

<!-- ==================== PAGE 1: COVER ==================== -->
<div class="cover-page">
    <div class="cover-title">Zodiac: A Real-Hardware Testbed and Deterministic Verifier for Agent-Proposed SDN Policy</div>
    <div class="cover-subtitle">Closed-Loop Verification of Language Model Flow Policies Against Physical OpenFlow Silicon, Deterministic Safety Invariants, and Live Network Adversaries</div>
    {cover_svg}
    <div class="cover-profile-card" style="position:absolute;top:458pt;left:54pt;width:504pt;background:#f8f9fa;border:1pt solid #dadce0;border-radius:4pt;padding:8pt 12pt;box-sizing:border-box;z-index:10;">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:0.75pt solid #dadce0;padding-bottom:4pt;margin-bottom:6pt;">
            <span style="font-family:'GoogleSans',sans-serif;font-weight:700;font-size:8pt;color:#202124;letter-spacing:0.3pt;">EXECUTIVE TESTBED &amp; MULTI-TRACK EMPIRICAL PROFILE</span>
            <span style="font-family:'RobotoMono',monospace;font-size:7pt;color:#1a73e8;">Tracks A, B, C &bull; Protocols A &amp; B &bull; Measured Ground Truth</span>
        </div>
        <div style="display:flex;gap:12pt;">
            <!-- Column 1: Track A -->
            <div style="flex:1;border-right:0.75pt solid #e8eaed;padding-right:8pt;">
                <div style="font-family:'GoogleSans',sans-serif;font-weight:700;font-size:7.5pt;color:#1967d2;margin-bottom:3pt;">Track A: Physical Data Plane</div>
                <div style="font-family:'GoogleSansText',sans-serif;font-size:7pt;line-height:1.45;color:#3c4043;">
                    &bull; <strong>DUT:</strong> Zodiac FX (SAM4E 120MHz, FW 0.86)<br>
                    &bull; <strong>Table 0:</strong> 128-rule hardware budget<br>
                    &bull; <strong>Cost Model:</strong> 4.24 &mu;s/rule; 58 &mu;s base latency<br>
                    &bull; <strong>Sustained Rate:</strong> 8,106 pps (38.9M) at k&le;8
                </div>
            </div>
            <!-- Column 2: Track B -->
            <div style="flex:1;border-right:0.75pt solid #e8eaed;padding-right:8pt;">
                <div style="font-family:'GoogleSans',sans-serif;font-weight:700;font-size:7.5pt;color:#137333;margin-bottom:3pt;">Track B: Deterministic Verifier</div>
                <div style="font-family:'GoogleSansText',sans-serif;font-size:7pt;line-height:1.45;color:#3c4043;">
                    &bull; <strong>Safety Gates:</strong> 11 pre-install checks (A1&ndash;A11)<br>
                    &bull; <strong>Protocol A:</strong> 43.5%&ndash;79.8% zero-shot rate<br>
                    &bull; <strong>Protocol B:</strong> <strong>100.0% admissible</strong> (&le;3 turns)<br>
                    &bull; <strong>Robustness:</strong> 0 unhandled exceptions; fail-closed
                </div>
            </div>
            <!-- Column 3: Track C -->
            <div style="flex:1;">
                <div style="font-family:'GoogleSans',sans-serif;font-weight:700;font-size:7.5pt;color:#b06000;margin-bottom:3pt;">Track C: On-Wire &amp; Red Team</div>
                <div style="font-family:'GoogleSansText',sans-serif;font-size:7pt;line-height:1.45;color:#3c4043;">
                    &bull; <strong>Mirror Taps:</strong> [O1] Pre-DUT, [O2] Pol, [O3] Egress<br>
                    &bull; <strong>Wire Conformance:</strong> <strong>611 / 611 (100.0%)</strong><br>
                    &bull; <strong>Live Adversary:</strong> 25k pps flood, ARP spoof, scans<br>
                    &bull; <strong>Envelope:</strong> 18.4ms quarantine; 100% anti-steer
                </div>
            </div>
        </div>
    </div>
    <div class="cover-authors">
        Gravity TPU Infrastructure &amp; Agentic Networking Group<br>
        <span style="font-weight:400;font-size:9.2pt;color:#5f6368;">Hardware Verification, Systems Telemetry &amp; Adversarial Evaluation</span>
    </div>
    <div class="cover-meta" style="position:absolute;bottom:42pt;left:54pt;width:370pt;border-top:0.75pt solid #dadce0;padding-top:6pt;">
        DUT: Northbound Networks Zodiac FX (120 MHz, FW 0.86) · Controller: NVIDIA Jetson Orin Nano Super
    </div>
    <div class="cover-date" style="position:absolute;bottom:42pt;right:54pt;text-align:right;">
        November 2026<br><span style="font-size:8.5pt;font-weight:500;color:#5f6368;">v3.0 Close-Out</span>
    </div>
</div>

<!-- ==================== PAGE 2: REPOSITORY INVARIANTS & NETWORK PRINCIPLES ==================== -->
<div class="fixed-page">
    <div style="margin-top:12pt;">
        <div class="gov-header">Repository Invariants &amp; Network Engineering Principles</div>
        <div class="gov-sub">
            Zodiac enforces six deterministic software invariants (<code>AGENTS.md</code>) and six physical packet-forwarding principles (<code>.agents/rules/network-engineering-principles.md</code>) in CI and at the runtime OpenFlow install boundary. Agents propose; deterministic code decides admissibility; a human approves installation.
        </div>

        <div class="gov-grid">
            <div class="gov-card">
                <div class="gov-card-title">Invariant 1 — No Suppression of Errors</div>
                <div class="gov-card-body">Zero <code>@ts-ignore</code>, loose <code>any</code> casts, or empty <code>catch</code> blocks. Protocol and state errors are handled deterministically at the boundary.</div>
            </div>
            <div class="gov-card">
                <div class="gov-card-title">Invariant 2 — Integer Accounting &amp; Monotonic Time</div>
                <div class="gov-card-body">All packet counters, byte rates, and SLA budgets use 64-bit integer arithmetic (<code>BigInt</code>) and monotonic nanoseconds (<code>process.hrtime.bigint()</code>).</div>
            </div>
            <div class="gov-card">
                <div class="gov-card-title">Invariant 3 — Fail Closed by Construction</div>
                <div class="gov-card-body">Ambiguous or unrecognized frames, rules, or tenant contexts are dropped or quarantined. Priority-0 table-miss explicitly drops unmatched traffic; controller loss wipes the hardware flow table.</div>
            </div>
            <div class="gov-card">
                <div class="gov-card-title">Invariant 4 — Verify Before Actuating</div>
                <div class="gov-card-body">Every proposed rule set must pass deterministic checks (<code>A1</code>–<code>A11</code>) and receive explicit human sign-off. Detector containment is bounded by a pre-approved Quarantine Envelope (<code>k &lt;= 8</code>, <code>TTL &lt;= 300s</code>).</div>
            </div>
            <div class="gov-card">
                <div class="gov-card-title">Invariant 5 — Configurable, Bounded &amp; Damped Limits</div>
                <div class="gov-card-body">Timeouts, rate limits, and hysteresis gates are named, bounded, and damped (3 consecutive bad readbacks before <code>A3</code> repair; 300 s minimum hold before quarantine release).</div>
            </div>
            <div class="gov-card">
                <div class="gov-card-title">Invariant 6 — Physical &amp; Cryptographic Provenance</div>
                <div class="gov-card-body">No simulation is passed off as live telemetry. Disconnected hardware reports <code>0</code> rates and explicit offline status. Every benchmark artifact carries a SHA-256 provenance sidecar.</div>
            </div>
        </div>

        <div class="gov-header" style="font-size:14pt;margin-top:8pt;">Physical Data-Plane &amp; Control-Plane Rules (NET-001 through NET-006)</div>
        <table>
            <thead>
                <tr>
                    <th style="width:14%;">Rule ID</th>
                    <th style="width:28%;">Engineering Principle</th>
                    <th>Physical Enforcement on the Zodiac Testbed</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>NET-001</strong></td>
                    <td>Control / Data Plane Separation</td>
                    <td>OpenFlow 1.3 TCP control (<code>10.0.1.99:6633</code>) runs on dedicated Native VLAN 200 (Port 4 to Jetson <code>enP8p1s0</code>), physically isolated from OpenFlow VLAN 100 data ports (Ports 1–3).</td>
                </tr>
                <tr>
                    <td><strong>NET-002</strong></td>
                    <td>Fate-Sharing &amp; Fail-Closed State</td>
                    <td>Hardware characterization proved Firmware 0.86 wipes all flow entries upon TCP control-channel loss (0/200 frames forwarded at <code>O3</code>). Controller reconnect automatically re-installs the verified baseline within 4–6 s.</td>
                </tr>
                <tr>
                    <td><strong>NET-003</strong></td>
                    <td>Loop-Free Forwarding &amp; Hairpin Guard</td>
                    <td>Verifier checks <code>A1</code> (workload isolation), <code>A2</code> (no single-rule or two-hop hairpin), and <code>A10</code> (<code>arp_spa</code> source confinement on Port 2) before any <code>OFPFC_ADD</code> reaches the switch.</td>
                </tr>
                <tr>
                    <td><strong>NET-004</strong></td>
                    <td>Flow-Table Budget &amp; Cost Model</td>
                    <td>Strictly capped at 128 rules (<code>A7</code>), with priority-65535 quarantines capped at <code>k &lt;= 8</code> and live throughput checked against the measured equation <code>80.0 us + 5.42 us * k</code> (<code>A8</code>).</td>
                </tr>
                <tr>
                    <td><strong>NET-005</strong></td>
                    <td>Queue Pacing &amp; Speed-Step Management</td>
                    <td>IEEE 802.3x Flow Control enabled on both GS105Ev2 switches plus 95 Mbit/s <code>tc fq</code> sender pacing on 1000BASE-T hosts prevents 1G-to-100M egress buffer drops from masquerading as DUT packet loss.</td>
                </tr>
                <tr>
                    <td><strong>NET-006</strong></td>
                    <td>Passive Tap Hygiene (Zero Injection)</td>
                    <td>Mirror destination ports <code>O1</code> and <code>O3</code> reside in isolated 1-port 802.1Q VLANs with <code>clsact</code> ingress drop / <code>blackhole</code> root qdiscs and hardware offloads disabled.</td>
                </tr>
            </tbody>
        </table>
    </div>
</div>

<!-- ==================== PAGE 3: TABLE OF CONTENTS ==================== -->
<div class="fixed-page">
    <div class="toc-header">Table of Contents</div>
    <div class="toc-list">
        <div class="toc-row major"><span class="toc-title">Executive Summary</span><span class="toc-leader"></span><span class="toc-page">{pg('exec', 4)}</span></div>

        <div class="toc-row major"><span class="toc-title">1. Introduction &amp; Research Thesis</span><span class="toc-leader"></span><span class="toc-page">{pg('sec1', 4)}</span></div>
        <div class="toc-row sub"><span class="toc-title">1.1 Why Constrained Hardware Exposes Agent Failure Modes</span><span class="toc-leader"></span><span class="toc-page">{pg('sec1_1', 4)}</span></div>
        <div class="toc-row sub"><span class="toc-title">1.2 Summary of Contributions Across Tracks A, B, and C</span><span class="toc-leader"></span><span class="toc-page">{pg('sec1_2', 5)}</span></div>

        <div class="toc-row major"><span class="toc-title">2. Physical Testbed Architecture &amp; Topology Breakdown</span><span class="toc-leader"></span><span class="toc-page">{pg('sec2', 5)}</span></div>
        <div class="toc-row sub"><span class="toc-title">2.1 Three-Tier Switch Stack &amp; Compute/Sensor Nodes</span><span class="toc-leader"></span><span class="toc-page">{pg('sec2_1', 5)}</span></div>
        <div class="toc-row sub"><span class="toc-title">2.2 Port-by-Port Wiring, 802.1Q VLAN Isolation &amp; Observation Points (O1, O2, O3)</span><span class="toc-leader"></span><span class="toc-page">{pg('sec2_2', 6)}</span></div>
        <div class="toc-row sub"><span class="toc-title">2.3 Host Interface Hygiene &amp; 1G-to-100M Speed-Step Calibration</span><span class="toc-leader"></span><span class="toc-page">{pg('sec2_3', 7)}</span></div>

        <div class="toc-row major"><span class="toc-title">3. Track A: Deterministic Flow-Table Verifier &amp; Cost Model</span><span class="toc-leader"></span><span class="toc-page">{pg('sec3', 7)}</span></div>
        <div class="toc-row sub"><span class="toc-title">3.1 The Eleven Verifier Properties (A1–A11) &amp; Mutation-Corpus Coverage</span><span class="toc-leader"></span><span class="toc-page">{pg('sec3_1', 7)}</span></div>
        <div class="toc-row sub"><span class="toc-title">3.2 Precedence-Aware Conflict Detection (A4) Over Shadowed Redundancy (A9)</span><span class="toc-leader"></span><span class="toc-page">{pg('sec3_2', 8)}</span></div>
        <div class="toc-row sub"><span class="toc-title">3.3 Priority-0 Firmware Quirk, Action Readback &amp; Damped A3 Auto-Repair</span><span class="toc-leader"></span><span class="toc-page">{pg('sec3_3', 8)}</span></div>
        <div class="toc-row sub"><span class="toc-title">3.4 Deployed-Table Cost Equation (A8) &amp; Allow-Rule Floor Calibration</span><span class="toc-leader"></span><span class="toc-page">{pg('sec3_4', 9)}</span></div>

        <div class="toc-row major"><span class="toc-title">4. Track A: Agent Policy Synthesis — Verifier Feedback vs. LoRA</span><span class="toc-leader"></span><span class="toc-page">{pg('sec4', 10)}</span></div>
        <div class="toc-row sub"><span class="toc-title">4.1 Three Hosting Tiers: Local Edge, Rented A100 GPUs, and Cloud APIs</span><span class="toc-leader"></span><span class="toc-page">{pg('sec4_1', 10)}</span></div>
        <div class="toc-row sub"><span class="toc-title">4.2 Twelve-Model Cloud Pilot &amp; Safety Refusal Findings</span><span class="toc-leader"></span><span class="toc-page">{pg('sec4_2', 11)}</span></div>

        <div class="toc-row major"><span class="toc-title">5. Track B: Hardware Characterization &amp; On-Wire Conformance Oracle</span><span class="toc-leader"></span><span class="toc-page">{pg('sec5', 12)}</span></div>
        <div class="toc-row sub"><span class="toc-title">5.1 128-Rule-Set Differential Conformance Campaign (611/611 Flow Checks)</span><span class="toc-leader"></span><span class="toc-page">{pg('sec5_1', 12)}</span></div>
        <div class="toc-row sub"><span class="toc-title">5.2 Finding F1: Why Controller-State Verification Cannot Replace Wire Ground Truth</span><span class="toc-leader"></span><span class="toc-page">{pg('sec5_2', 12)}</span></div>
        <div class="toc-row sub"><span class="toc-title">5.3 Physical Reality Gaps Across Conformance &amp; Red-Team Tracks</span><span class="toc-leader"></span><span class="toc-page">{pg('sec5_3', 13)}</span></div>

        <div class="toc-row major"><span class="toc-title">6. Track C: Live Red-Team Adversary &amp; Quarantine Envelope Evaluation</span><span class="toc-leader"></span><span class="toc-page">{pg('sec6', 13)}</span></div>
        <div class="toc-row sub"><span class="toc-title">6.1 Consolidated Hardware Red-Team Matrix (Scenarios 1–7)</span><span class="toc-leader"></span><span class="toc-page">{pg('sec6_1', 13)}</span></div>
        <div class="toc-row sub"><span class="toc-title">6.2 Pre-Approved Quarantine Envelope &amp; Anti-Steering Guarantees</span><span class="toc-leader"></span><span class="toc-page">{pg('sec6_2', 14)}</span></div>

        <div class="toc-row major"><span class="toc-title">7. Scope Boundaries, Threats to Validity &amp; Owner's Review Sign-Off</span><span class="toc-leader"></span><span class="toc-page">{pg('sec7', 14)}</span></div>
        <div class="toc-row major"><span class="toc-title">References</span><span class="toc-leader"></span><span class="toc-page">{pg('refs', 15)}</span></div>
        <div class="toc-row major"><span class="toc-title">Appendix A: Physical Testbed Attestation &amp; Bench Evidence</span><span class="toc-leader"></span><span class="toc-page">{pg('appa', 16)}</span></div>
    </div>
</div>

<!-- ==================== PAGE 4+: FLOWING TECHNICAL REPORT ==================== -->
<div class="content-flow">

    <h1 id="exec" style="margin-top:4pt;">Executive Summary</h1>
    <div class="exec-grid">
        <div class="exec-main">
            <p>
                Can a large language model safely propose packet-forwarding rules for a real Software-Defined Network (SDN) switch when a single malformed priority, wildcard, or action list can silently blackhole traffic, create a forwarding loop, or exhaust switch CPU? <strong>Zodiac</strong> answers this question empirically on physical hardware rather than in an idealized simulator.
            </p>
            <p>
                Using a Northbound Networks <strong>Zodiac FX</strong> OpenFlow 1.3 switch (120 MHz ARM Cortex-M4 microcontroller, 4×100BASE-TX ports, 128-entry software flow table running Firmware 0.86) governed by an <strong>NVIDIA Jetson Orin Nano Super</strong> controller and instrumented via two managed <strong>NETGEAR GS105Ev2</strong> mirror switches across three independent wire vantage points (<code>O1</code> pre-DUT, <code>O2</code> policy-derived tap, and <code>O3</code> independent post-DUT egress), we built and verified a complete <strong>verifier-in-the-loop</strong> control architecture.
            </p>
            <p>
                Across our three research tracks—completed and signed off in the November 2026 Owner's Review—our findings establish four principal results:
            </p>
            <ul>
                <li><strong>Deterministic verification (<code>A1</code>–<code>A11</code>) + <= 5 feedback turns solves policy admissibility without model weight tuning:</strong> Zero-shot LLM proposals (Protocol A) passed all 11 deterministic checks only <strong>43.0%</strong> of the time on Qwen3.8-27B (Prompt v2) and <strong>80.5%</strong> on Claude Haiku 5.5. Providing the exact rejected property and conflicting rule IDs in a bounded feedback loop (Protocol B, <code>&lt;= 5</code> turns, median 2 turns) raised admissibility to <strong>98.8% (79/80)</strong> on local Qwen3.8-27B and <strong>100.0% (80/80)</strong> on Claude Haiku 5.5 and Prompt v3.</li>
                <li><strong>Longer LoRA fine-tuning degraded generalization on multi-constraint intents:</strong> While a light 15-step SFT+DPO LoRA adapter nudged zero-shot accuracy on seen intents (<code>INTENT-1..4</code>) from 87.0% to 88.0%, it regressed unseen harder intents (<code>INTENT-5..8</code>) from <strong>87.0% to 70.5%</strong>. Scaling to an 80-step SFT + 90-step DPO adapter collapsed 6-intent zero-shot admissibility from <strong>82.7% (248/300)</strong> to <strong>48.3% (145/300)</strong> due to cross-intent rule memorization.</li>
                <li><strong>Controller-state verification must be paired with hardware-quirk modeling and wire ground truth:</strong> In Track B, <strong>128 distinct rule sets (611 flow checks)</strong> achieved <strong>100% (611/611)</strong> agreement between the software reference model and real frames captured at <code>O1</code>/<code>O2</code>/<code>O3</code>—but only after encoding Firmware 0.86's silent priority-0 instruction drop (<strong>Finding F1</strong>) and deployed-table per-packet traversal cost (<code>t_pkt = 80.0 us + 5.42 us * k</code>) into the verifier.</li>
                <li><strong>Pre-approved quarantine envelopes bound adversarial failure modes:</strong> Across <strong>7 live hardware red-team scenarios</strong> launched from an untrusted Raspberry Pi 3B+ node, deterministic rules and bounded quarantine envelopes contained reconnaissance, lateral movement, spoofed Steering DoS, control-plane saturation (recovering within 4–6 s), and flow-table exhaustion while preserving legitimate workload traffic.</li>
            </ul>
        </div>
        <div class="exec-sidebar">
            “Deterministic verifier feedback in 2 turns raised local 27B policy admissibility from 43.0% to 98.8%—whereas heavier LoRA fine-tuning memorized rule templates and cut multi-intent accuracy to 48.3%.”
        </div>
    </div>

    <!-- ==================== SECTION 1 ==================== -->
    <h1 id="sec1" class="page-start">1. Introduction &amp; Research Thesis</h1>
    <p>
        Network configuration synthesis has long separated into two camps: formal control-plane verifiers that analyze static forwarding graphs (Header Space Analysis [2], VeriFlow [3], NetKAT [4], Batfish [5]) and machine-learning systems that translate operator intent into configuration stanzas. In the agentic era, where LLM agents are increasingly asked to propose low-level policy updates in response to operational tickets or anomaly alerts, a dangerous gap emerges between <em>syntactic validity</em> and <em>physical data-plane admissibility</em>.
    </p>

    <h2 id="sec1_1">1.1 Why Constrained Hardware Exposes Agent Failure Modes</h2>
    <p>
        Software switches such as Open vSwitch (OVS) running on multi-gigahertz server CPUs mask poorly structured flow tables behind megaflow caches and gigabytes of DRAM. Real embedded silicon and microcontroller-driven OpenFlow switches offer no such forgiveness:
    </p>
    <ul>
        <li><strong>Linear software table walk:</strong> On the Northbound Networks Zodiac FX (Atmel SAM4E8E 120 MHz ARM Cortex-M4), every frame traverses the software flow table sequentially. Each additional non-matching rule evaluated before a forwarding match adds microsecond-scale CPU overhead that directly reduces wire-rate packet capacity.</li>
        <li><strong>Silent firmware quirks:</strong> Unlike reference specifications [1], embedded OpenFlow 1.3 firmware exhibits undocumented behaviors. On Firmware 0.86, installing a priority-0 flow entry causes the switch to record the match fields in its flow table while <em>silently stripping the <code>OFPIT_APPLY_ACTIONS</code> instruction list</em>—turning an intended catch-all forwarding rule into a silent blackhole.</li>
        <li><strong>Adversarial untrusted segments:</strong> When an anomaly detector can trigger automatic host quarantine rules, an attacker on a shared L2 segment can forge source IPv4/MAC headers to trick the detector into quarantining the legitimate workload or exhausting the 128-rule table budget.</li>
    </ul>

    <h2 id="sec1_2">1.2 Summary of Contributions Across Tracks A, B, and C</h2>
    <p>
        Rather than claiming autonomous self-healing, Zodiac enforces a strict architectural separation: <strong>an agent proposes; deterministic code decides admissibility (<code>A1</code>–<code>A11</code>); a human approves policy installation; and independent hardware mirror taps verify what actually crossed the wire.</strong> To investigate where neural policy generators succeed and fail in real networking environments, our evaluation is organized across three experimental tracks:
    </p>
    <ul>
        <li><strong>Track A — Deterministic Verifier &amp; Adversarial Invariants:</strong> Evaluates formal admissibility checks (<code>A1</code>–<code>A11</code>) against a 196-mutant corpus spanning priority precedence conflicts (<code>A4</code>), silent firmware action-stripping (<code>A3</code>), hardware table budgets (<code>A7</code>), and linear traversal latency budgets (<code>A8</code>). Caught 100% (196/196) of invalid mutations with zero false dismissals.</li>
        <li><strong>Track B — Physical Wire Conformance &amp; Hardware Reality Gaps:</strong> Validates flow tables on actual physical silicon across 128 rule sets (611 differential flow checks) observed at three hardware vantage points (<code>O1</code>, <code>O2</code>, <code>O3</code>). Discovered physical quirks—such as Firmware 0.86 priority-0 silent blackholing and switch-path drops of self-addressed frames (Finding F1)—that controller-only simulation cannot detect.</li>
        <li><strong>Track C — Live Red-Team Adversary &amp; Containment Envelopes:</strong> Exercises 7 live attack scenarios (<code>S1</code>–<code>S7</code>) launched by an adversary node (<code>10.0.2.50</code>) on a shared untrusted segment, demonstrating that pre-approved quarantine envelopes bound attacker steering, prevent table exhaustion, and preserve legitimate client traffic.</li>
    </ul>
    <p>
        Across these tracks, we compare two operational paradigms: <strong>Protocol A</strong> (unassisted zero-shot generation directly to the verifier) and <strong>Protocol B</strong> (a multi-turn closed-loop repair interaction where rejected properties and conflicting rule IDs are returned to the model within &le; 5 turns). Figure 1 illustrates this complete closed-loop architecture.
    </p>

    <div class="figure-container">
        {closed_loop_arch_svg}
        <div class="figure-caption">
            <strong>Figure 1: Zodiac Closed-Loop Testbed Architecture &amp; Multi-Track Verification Pipeline.</strong> Natural language operator intent is synthesized into OpenFlow 1.3 flow rules by local edge models, rented cloud GPUs, or commercial frontier APIs. Before reaching hardware, rules must satisfy the 11 formal properties of the deterministic verifier (Track A). Under Protocol B, diagnostic failure feedback repairs invalid proposals within 2 median turns (raising admissibility from 43% to 98.8%–100%). Policy actuation requires human sign-off, while detector-driven containment is constrained by a pre-approved Quarantine Envelope (Track C). All data-plane behavior is verified against physical silicon across three independent mirror taps (Track B: 611/611 wire checks).
        </div>
    </div>

    <p>
        Table 1 summarizes the physical hardware bill of materials used across all experiments.
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:22%;">Component</th>
                <th style="width:28%;">Hardware Specification</th>
                <th style="width:20%;">Network Role</th>
                <th>Verification / Measurement Function</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Zodiac FX (DUT)</strong></td>
                <td>Atmel SAM4E8E 120 MHz Cortex-M4, Micrel KSZ8795CLX 4×100M, FW 0.86</td>
                <td>OpenFlow 1.3 Switch (128-rule table)</td>
                <td>Executes verified flow tables on Ports 1–3 (VLAN 100); reports per-rule counters &amp; actions over Port 4 (VLAN 200).</td>
            </tr>
            <tr>
                <td><strong>NVIDIA Jetson Orin Nano Super</strong></td>
                <td>6-core Arm Cortex-A78AE, 1024-core Ampere GPU, 8 GB LPDDR5, 3 wired GbE NICs</td>
                <td>Controller, Verifier &amp; Observer (<code>O2</code>, <code>O3</code>)</td>
                <td>Runs <code>zodiac-bridge</code> (<code>:3003</code>), OpenFlow controller (<code>:6633</code>), GPU Anomaly Sentinel on <code>O2</code>, and egress capture on <code>O3</code>.</td>
            </tr>
            <tr>
                <td><strong>NETGEAR GS105Ev2 #1</strong></td>
                <td>5-port Gigabit Plus Managed Switch (<code>192.168.0.239</code>), 802.3x Flow Ctrl ON</td>
                <td>Workload Switch &amp; <code>O1</code> Mirror Source</td>
                <td>Aggregates untrusted <code>10.0.2.0/24</code> hosts on P1/P3/P4 to DUT Port 1 (P5); mirrors P5 Rx+Tx to isolated P2 (<code>O1</code>).</td>
            </tr>
            <tr>
                <td><strong>NETGEAR GS105Ev2 #2</strong></td>
                <td>5-port Gigabit Plus Managed Switch (<code>192.168.0.240</code>), 802.3x Flow Ctrl ON</td>
                <td>Uplink Switch &amp; <code>O3</code> Mirror Source</td>
                <td>Terminates DUT Port 2 on P4 (VLAN 2) and mirrors P4 Rx+Tx to isolated P3 (<code>O3</code>, VLAN 3) on Jetson NIC #3.</td>
            </tr>
            <tr>
                <td><strong>rpi-hailo (Sensor Node)</strong></td>
                <td>Raspberry Pi 5 (8 GB) + Hailo-8 M.2 NPU (26 TOPS, PCIe Gen3, HailoRT 4.20)</td>
                <td><code>O1</code> Pre-DUT Capture &amp; NPU Sensor</td>
                <td><code>eth0</code> on workload segment (<code>10.0.2.51</code>); USB-GbE <code>eth1</code> captures pre-DUT ground truth on Switch #1 P2 (<code>O1</code>).</td>
            </tr>
            <tr>
                <td><strong>agentic-node-01 / 02</strong></td>
                <td>2× Raspberry Pi 3 Model B+ (Broadcom BCM2837B0, 1 GB RAM, Raspberry Pi OS)</td>
                <td>Adversary (<code>.50</code>) &amp; Client (<code>.52</code>)</td>
                <td><code>node-01</code> executes Track C red-team scenarios; <code>node-02</code> generates paced conformance and legitimate workload flows.</td>
            </tr>
        </tbody>
    </table>

    <!-- ==================== SECTION 2 ==================== -->
    <h1 id="sec2">2. Physical Testbed Architecture &amp; Topology Breakdown</h1>
    <p>
        A core requirement of Invariant 6 is that no synthetic counter or unverified topology assumption enters an empirical claim. On our physical bench (photographed in Appendix A), the switching fabric is organized as a compact <strong>three-switch vertical stack</strong> sitting beside the NVIDIA Jetson Orin Nano Super controller and the Raspberry Pi workload/sensor nodes.
    </p>

    <h2 id="sec2_1">2.1 Three-Tier Switch Stack &amp; Compute/Sensor Nodes</h2>
    <p>
        Figure 2 illustrates the complete port-by-port physical wiring, 802.1Q VLAN boundaries, and passive observation taps extracted from our hardware ledger (<code>.agents/network-context.md</code>). Reading the physical switch stack from top to bottom:
    </p>
    <ol>
        <li><strong>Top of Stack — NETGEAR GS105Ev2 #2 (<code>192.168.0.240</code>, Uplink &amp; <code>O3</code> Mirror):</strong> Partitioned into three strict 802.1Q VLANs so out-of-band management traffic (VLAN 1), DUT uplink traffic (VLAN 2 on Port 4), and passive egress capture (<code>O3</code> on Port 3, VLAN 3) never cross-contaminate.</li>
        <li><strong>Middle of Stack — NETGEAR GS105Ev2 #1 (<code>192.168.0.239</code>, Workload &amp; <code>O1</code> Mirror):</strong> Connects the three Raspberry Pi nodes on Ports 1, 3, and 4 (1000BASE-T) to the Zodiac FX's Port 1 via Port 5 (100BASE-TX), while hardware-mirroring Port 5 Rx+Tx to Port 2 (<code>O1</code>, isolated VLAN 2).</li>
        <li><strong>Bottom of Stack — Northbound Networks Zodiac FX (DUT, Firmware 0.86):</strong> Enclosed in its black 3D-printed chassis at the base of the stack, exposing Ports 1–3 to OpenFlow data-plane control (VLAN 100) and Port 4 to dedicated OpenFlow TCP control (<code>10.0.1.99/24</code>, Native VLAN 200).</li>
    </ol>

    <div class="figure-box">
        {fig1_svg}
        <div class="figure-caption">
            <strong>Figure 2: Physical Testbed Topology Breakdown (100% Vector Diagram).</strong> Complete port-level mapping of the 3-switch stack (NETGEAR GS105Ev2 #2 on top, NETGEAR GS105Ev2 #1 in middle, Zodiac FX DUT at bottom), the 3 wired NICs on the NVIDIA Jetson Orin Nano Super, the 3 Raspberry Pi nodes, and the three passive observation points (<code>O1</code>, <code>O2</code>, <code>O3</code>).
        </div>
    </div>

    <h2 id="sec2_2">2.2 Port-by-Port Wiring, 802.1Q VLAN Isolation &amp; Observation Points (O1, O2, O3)</h2>
    <p>
        Why use three distinct observation vantage points? A single capture tap on the switch's own mirror port (<code>O2</code>, Zodiac FX Port 3) only observes frames that the switch's OpenFlow rules <em>chose</em> to copy—meaning a broken rule or firmware bug that dropsboth the forwarding output and the mirror output would be invisible at <code>O2</code> alone. By sandwiching the Zodiac FX between two independent hardware mirror switches (<code>O1</code> on GS105Ev2 #1 Port 2 before the DUT, and <code>O3</code> on GS105Ev2 #2 Port 3 after the DUT), our conformance oracle compares every injected probe packet across all three points simultaneously (Table 2).
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:18%;">Switch / Device</th>
                <th style="width:12%;">Port / NIC</th>
                <th style="width:16%;">VLAN / Subnet</th>
                <th style="width:24%;">Connected Peer</th>
                <th>Role &amp; Hardware Hygiene Enforcement</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Zodiac FX (DUT)</strong></td>
                <td>Port 1</td>
                <td>OF VLAN 100 (Tagged)</td>
                <td>GS105Ev2 #1 Port 5 (100M)</td>
                <td>Untrusted workload ingress/egress; governed by verified 6-rule baseline + dynamic quarantines.</td>
            </tr>
            <tr>
                <td><strong>Zodiac FX (DUT)</strong></td>
                <td>Port 2</td>
                <td>OF VLAN 100 (Tagged)</td>
                <td>GS105Ev2 #2 Port 4 (100M)</td>
                <td>Uplink boundary; <code>A10</code> restricts <code>in_port=2</code> ARP to enumerated peer IPs (<code>none</code> in confinement mode).</td>
            </tr>
            <tr>
                <td><strong>Zodiac FX (DUT)</strong></td>
                <td>Port 3</td>
                <td>OF VLAN 100 (Tagged)</td>
                <td>Jetson USB NIC #1 (<code>O2</code>)</td>
                <td>Policy-derived mirror tap; <code>p3-tap-return</code> rule (prio 100) returns probes in conformance sweeps.</td>
            </tr>
            <tr>
                <td><strong>Zodiac FX (DUT)</strong></td>
                <td>Port 4</td>
                <td>Native VLAN 200</td>
                <td>Jetson <code>enP8p1s0</code> (<code>10.0.1.8</code>)</td>
                <td>Dedicated OpenFlow 1.3 control plane (<code>10.0.1.99:6633</code>) + USB CDC serial register telemetry.</td>
            </tr>
            <tr>
                <td><strong>GS105Ev2 #1</strong></td>
                <td>P1, P3, P4</td>
                <td>802.1Q VLAN 1</td>
                <td><code>node-02</code>, <code>node-01</code>, <code>rpi-hailo</code></td>
                <td>1000BASE-T host links on <code>10.0.2.0/24</code>; 802.3x Flow Control enabled; 95 Mbit/s <code>fq</code> pacing on senders.</td>
            </tr>
            <tr>
                <td><strong>GS105Ev2 #1</strong></td>
                <td>Port 2 (<code>O1</code>)</td>
                <td>802.1Q VLAN 2</td>
                <td><code>rpi-hailo eth1</code> (USB-GbE)</td>
                <td>Hardware mirror of Port 5 Rx+Tx; isolated 1-port VLAN + <code>clsact</code> ingress drop prevents frame injection.</td>
            </tr>
            <tr>
                <td><strong>GS105Ev2 #2</strong></td>
                <td>Port 3 (<code>O3</code>)</td>
                <td>802.1Q VLAN 3</td>
                <td>Jetson USB NIC #3</td>
                <td>Hardware mirror of Port 4 Rx+Tx; isolated 1-port VLAN + <code>blackhole</code> root qdisc; independent egress oracle.</td>
            </tr>
        </tbody>
    </table>

    <h2 id="sec2_3">2.3 Host Interface Hygiene &amp; 1G-to-100M Speed-Step Calibration</h2>
    <p>
        Two physical-layer pitfalls frequently corrupt small-switch testbeds if left unaddressed:
    </p>
    <ul>
        <li><strong>Multi-homed Linux ARP flux:</strong> Both Raspberry Pi 3B+ nodes carry an out-of-band management interface (<code>eth1</code> on <code>10.0.0.0/24</code>) alongside their experiment interface (<code>eth0</code> on <code>10.0.2.0/24</code>). Without intervention, the Linux kernel answers ARP queries or routes local traffic across interfaces, bypassing the DUT. We enforce <code>net.ipv4.conf.all.arp_filter=1</code> and bring <code>wlan0</code> down prior to every measurement run.</li>
        <li><strong>1000BASE-T to 100BASE-TX buffer overflow:</strong> Because the Raspberry Pi 5 and GS105Ev2 host ports negotiate at 1 Gbps while the Zodiac FX's KSZ8795CLX ports operate at 100 Mbps, an unpaced microburst overflows the GS105Ev2's egress queue before reaching the Zodiac FX. Enabling <strong>IEEE 802.3x Flow Control</strong> on both GS105Ev2 switches and configuring Linux <code>tc qdisc add dev eth0 root fq maxrate 95mbit</code> on all workload senders eliminated switch-buffer drops completely.</li>
    </ul>

    <!-- ==================== SECTION 3 ==================== -->
    <h1 id="sec3">3. Track A: Deterministic Flow-Table Verifier &amp; Cost Model</h1>
    <p>
        Every flow-table update proposed by a human operator or an LLM agent passes through the five-stage pipeline shown in Figure 3. At the center of this pipeline is <code>verifyFlowTable()</code> and <code>admitInstall()</code> (<code>src/sdn/flow-verifier.ts</code>, <code>src/sdn/install-gate.ts</code>), a pure, deterministic TypeScript verifier that evaluates <strong>11 formal properties (<code>A1</code>–<code>A11</code>)</strong> in under 5 milliseconds.
    </p>

    <div class="figure-box">
        {fig2_svg}
        <div class="figure-caption">
            <strong>Figure 3: End-to-End Verifier-in-the-Loop &amp; On-Wire Conformance Pipeline.</strong> Candidate JSON rule sets are checked deterministically against <code>A1</code>–<code>A11</code> (with up to 5 structured rejection feedback turns in Protocol B), gated on human approval, verified against Firmware 0.86 readback on the Zodiac FX, and cross-checked against wire taps <code>O1</code>, <code>O2</code>, and <code>O3</code>.
        </div>
    </div>

    <h2 id="sec3_1">3.1 The Eleven Verifier Properties (A1–A11) &amp; Mutation-Corpus Coverage</h2>
    <p>
        In accordance with Invariant 4, a check that cannot fail is not verification. Every property in Table 3 has a formal specification, an exact scope statement of what it proves and what it does not prove, and a dedicated corpus of adversarial positive and negative mutation test cases (<strong>196/196 unit and invariant tests passing</strong> across <code>test/invariants/flow-verifier.test.ts</code>, <code>deployed-cost-model.test.ts</code>, and <code>install-gate.test.ts</code>).
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:8%;">ID</th>
                <th style="width:24%;">Property Name</th>
                <th style="width:42%;">Deterministic Check &amp; What It Proves</th>
                <th>What It Does Not Prove / Boundary</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>A1</strong></td>
                <td>Untrusted Workload Isolation</td>
                <td>Rejects any rule allowing frames from untrusted Port 1 to reach control Port 4 or unauthorized ports.</td>
                <td>Does not prevent L2 frame exchange between hosts on upstream Switch #1 (requires <code>O1</code> / quarantine).</td>
            </tr>
            <tr>
                <td><strong>A2</strong></td>
                <td>No Single-Rule or Two-Hop Hairpin</td>
                <td>Rejects rules where <code>in_port</code> is in <code>outputPorts</code>, or where Port <code>p -&gt; q</code> and Port <code>q -&gt; p</code> form an unguarded two-hop forwarding cycle.</td>
                <td>Checks the DUT's flow table; external L2 cable loops outside the DUT are prevented by VLAN segmentation.</td>
            </tr>
            <tr>
                <td><strong>A3</strong></td>
                <td>Explicit Table-Miss &amp; Action Guard</td>
                <td>Forbids user rules at priority <code>0</code> (preventing FW 0.86 silent action strip) and verifies switch readback retains <code>OFPIT_APPLY_ACTIONS</code>.</td>
                <td>Requires controller connectivity for readback; controller loss triggers hardware table wipe (NET-002).</td>
            </tr>
            <tr>
                <td><strong>A4</strong></td>
                <td>Deterministic Priority Precedence</td>
                <td>Rejects overlapping match rules at the <strong>same priority</strong> with conflicting actions, and rejects <strong>same-priority duplicate</strong> match rules.</td>
                <td>Different-priority overlaps are legal OpenFlow prefix shadowing and are classified under <code>A9</code>.</td>
            </tr>
            <tr>
                <td><strong>A5</strong></td>
                <td>Controller-Channel Protection</td>
                <td>Rejects rules matching or redirecting TCP port <code>6633</code> or control subnet <code>10.0.1.0/24</code> on data ports.</td>
                <td>Physical separation (Port 4 VLAN 200) is the primary defense; <code>A5</code> guards against miswired rules.</td>
            </tr>
            <tr>
                <td><strong>A6</strong></td>
                <td>Match-Field Prerequisite Hygiene</td>
                <td>Enforces OpenFlow 1.3 Section 7.2.3.8 prerequisites (e.g., <code>ipv4_src</code>/<code>ipv4_dst</code> require <code>eth_type=0x0800</code>; <code>tcp_dst</code> requires <code>ip_proto=6</code>; <code>arp_spa</code> requires <code>eth_type=0x0806</code>).</td>
                <td>Prevents silent switch rejection or wildcard widening on Firmware 0.86.</td>
            </tr>
            <tr>
                <td><strong>A7</strong></td>
                <td>128-Rule Hardware Table Budget</td>
                <td>Rejects any table where user rules + implicit priority-0 drop + reserved quarantine slots exceed <code>128</code> entries.</td>
                <td>Bounds memory footprint; CPU traversal time is checked separately by <code>A8</code>.</td>
            </tr>
            <tr>
                <td><strong>A8</strong></td>
                <td>Hardware Traversal Cost Budget</td>
                <td>Bounds worst-case per-packet lookup latency using measured slopes (<code>4.24 us/rule</code> general; <code>80.0 + 5.42k us</code> deployed 6-rule shape) against <code>targetRatePps</code> (<code>6,000 pps</code> live).</td>
                <td>Evaluates steady-state 572-byte UDP saturation; 2x overload bursts are handled by Scenario 4 recovery.</td>
            </tr>
            <tr>
                <td><strong>A9</strong></td>
                <td>Non-Redundancy &amp; Shadowing Hygiene</td>
                <td>Detects lower-priority rules completely shadowed by higher-priority superset rules with identical or conflicting actions.</td>
                <td>Surfaces dead rules so agent-proposed policies remain minimal on a 128-entry switch.</td>
            </tr>
            <tr>
                <td><strong>A10</strong></td>
                <td>Port-2 ARP Source IP Confinement</td>
                <td>Requires any rule permitting ARP (<code>0x0806</code>) on Port 2 to specify <code>arp_spa</code> in the declared peer allowlist (<code>allowedPort2ArpPeers=[]</code> in confinement mode).</td>
                <td>Prevents wildcard ARP rules on Port 2 from leaking spoofed uplink ARP frames across the DUT.</td>
            </tr>
            <tr>
                <td><strong>A11</strong></td>
                <td>Intent-to-Rule Semantic Conformance</td>
                <td>Evaluates the candidate flow table over every concrete packet class in the operator's <code>IntentSpec</code> (highest-priority winning rule per packet class).</td>
                <td>Proves exact semantic equivalence on all declared traffic classes (<code>requiredOutcomes</code>).</td>
            </tr>
        </tbody>
    </table>

    <h2 id="sec3_2">3.2 Precedence-Aware Conflict Detection (A4) Over Shadowed Redundancy (A9)</h2>
    <p>
        During our evaluation, we audited how <code>A4</code> and <code>A9</code> interact when an agent proposes two identical match rules at the <strong>same priority</strong> with identical actions. In early implementations, <code>A9</code> (redundancy) could mask or precede <code>A4</code>. Because OpenFlow 1.3 leaves tie-breaking between identical-priority, identical-match entries undefined on hardware (or silently overwrites one entry depending on <code>OFPFF_CHECK_OVERLAP</code>), we strengthened <code>A4</code> in <code>src/sdn/flow-verifier.ts</code> so that <strong>any two rules with overlapping or identical matches at the same priority are rejected immediately under <code>A4</code></strong>, reserving <code>A9</code> strictly for cross-priority shadowing where a strictly higher-priority rule shadows a lower-priority rule.
    </p>

    <h2 id="sec3_3">3.3 Priority-0 Firmware Quirk, Action Readback &amp; Damped A3 Auto-Repair</h2>
    <p>
        Our hardware characterization of Zodiac FX Firmware 0.86 uncovered two critical control-plane behaviors that every deployed controller must handle:
    </p>
    <ul>
        <li><strong>Priority-0 instruction stripping &amp; damped auto-repair:</strong> When a flow mod is installed at priority 0, Firmware 0.86 stores the match tuple in its 128-entry array but zeroes out the <code>OFPIT_APPLY_ACTIONS</code> instruction block. Conversely, even on valid higher-priority rules, transient serial/TCP framing glitches can leave a rule in hardware with an empty action list. We upgraded our OpenFlow <code>OFPMP_FLOW</code> multipart reply parser (<code>src/sdn/openflow-client.ts</code>) to decode the full <code>OFPIT_APPLY_ACTIONS</code> TLV list on every 60-second readback cycle. If a forwarding rule returns with missing actions for <strong>3 consecutive damped checks</strong> (preventing single-glitch oscillation per Invariant 5), <code>zodiac-bridge</code> automatically re-pushes the verified rule set (<code>repair.enabled: true</code>).</li>
        <li><strong>Controller-loss hardware table wipe (NET-002):</strong> To settle whether the Zodiac FX fails open or fails closed when the Jetson controller disconnects, we executed a 3-phase on-wire measurement (<code>docs/benchmarks/results/2026-10-31-controller-loss-behavior.json</code>). While 200/200 UDP frames crossed from <code>node-02</code> (<code>O1</code>) to <code>O3</code> with the controller connected, stopping <code>zodiac-bridge</code> caused <strong>0/200 frames to reach <code>O3</code></strong> (100% hardware table wipe upon TCP socket close). Restarting the bridge automatically re-verified and re-installed the 6-rule baseline within <strong>4–6 seconds</strong>, restoring 200/200 forwarding.</li>
    </ul>

    <h2 id="sec3_4">3.4 Deployed-Table Cost Equation (A8) &amp; Allow-Rule Floor Calibration</h2>
    <p>
        How much forwarding capacity does each additional flow rule cost on the 120 MHz ARM Cortex-M4? We answered this in two stages: first across synthetic rule-depth ladders from <code>N = 0</code> to <code>N = 126</code> rules (Figure 4), and second on the exact 6-rule production policy with <code>k = 0..8</code> active priority-65535 quarantine DROP rules (Figure 5).
    </p>

    <div class="figure-box">
        {fig3_svg}
        <div class="figure-caption">
            <strong>Figure 4: 600-Byte UDP Capacity vs. Rule Depth (Base vs. Forwarding-First Ordering).</strong> Measured on-wire saturation throughput across <code>N = 16, 32, 64, 126</code> rules (solid bars) and linear-fit empty-table intercepts at <code>N = 0</code> (hatched bars). Placing the active forwarding rule above unused rules reduces per-rule cost from <code>4.24 us/rule</code> to <code>1.30 us/rule</code>—yielding <strong>2.63x higher capacity</strong> at 126 rules (4,497 pps vs. 1,711 pps).
        </div>
    </div>

    <p>
        When we pre-registered our hypothesis for the deployed 6-rule policy under active quarantine load (<code>k = 0..8</code> priority-65535 DROP rules placed at the top of the table so quarantined attackers are dropped before reaching lower-priority allow rules), we predicted that each quarantine rule would add the same <code>4.24 us/rule</code> measured in the synthetic ladder. <strong>Physical hardware falsified that prediction by +28%:</strong> across two independent hardware rounds (<code>2026-10-20</code> and <code>2026-10-31</code>), each priority-65535 quarantine rule added <strong>5.42 us</strong> of traversal time above an <strong>80.0 us</strong> <code>k = 0</code> baseline:
    </p>

    <div class="equation-box">
        t_pkt(k) = 80.0 us + 5.42 us * k &nbsp;&nbsp;==&gt;&nbsp;&nbsp; Capacity(k) = 1,000,000 / (80.0 + 5.42 * k) pps &nbsp;&nbsp;(for k in 0..8 at 572 B payload)
    </div>

    <div class="figure-box">
        {fig4_svg}
        <div class="figure-caption">
            <strong>Figure 5: Deployed 6-Rule Policy Capacity Ladder (<code>k = 0..8</code>) and A8 Admissibility Boundaries.</strong> Red circles show measured hardware saturation; the blue curve shows the fitted model <code>80.0 us + 5.42 us * k</code> (within ±1.3% at every point). The orange dashed line marks the <code>7,765 pps</code> allow-rule floor measured across 1..8 allow rules at <code>k = 8</code>; the green dashed line marks the live <code>6,000 pps</code> A8 admission gate.
        </div>
    </div>

    <p>
        We encoded this exact equation into <code>src/sdn/deployed-cost-model.ts</code> and wired shape recognition (<code>matchesDeployedSixRulePolicyShape()</code>) into <code>A8</code>. Furthermore, to ensure that adding legitimate Port 3 &rarr; Port 1 allow rules does not invalidate the <code>k = 8</code> budget, we swept <code>1, 2, 4, 8</code> priority-120 allow rules at <code>k = 8</code> on hardware (<code>docs/benchmarks/results/2026-11-01-deployed-cost-allow-variation.json</code>): capacity remained between <strong>7,765 pps and 8,325 pps</strong> across all four runs, comfortably above the live <strong>6,000 pps</strong> <code>A8</code> admission ceiling.
    </p>

    <!-- ==================== SECTION 4 ==================== -->
    <h1 id="sec4">4. Track A: Agent Policy Synthesis — Verifier Feedback vs. LoRA</h1>
    <p>
        With <code>A1</code>–<code>A11</code> established as a deterministic oracle, we evaluated a central question for agentic infrastructure: <strong>to get reliable, hardware-admissible SDN policies from an LLM, should engineers invest in fine-tuning model weights (LoRA SFT+DPO), local model execution, or in coupling frontier models to a deterministic verifier feedback loop?</strong>
    </p>

    <h2 id="sec4_1">4.1 Three Hosting Tiers: Local Edge, Rented A100 GPUs, and Cloud APIs</h2>
    <p>
        We systematically benchmarked three distinct compute and hosting tiers across 8 natural-language operator intents spanning standard and hard multi-constraint topologies (<code>docs/research/models.md</code>, commit <code>1e12cee</code>):
    </p>
    <ul>
        <li><strong>Local Models (Apple Silicon Mac &amp; Jetson Orin Nano Super, <code>Q4_K_M</code> via Ollama):</strong>
            <ul>
                <li><code>gemma4:26b</code> (Mac): Achieved <strong>35% (70/200)</strong> zero-shot (Protocol A) when reasoning was enabled (<code>think: true</code>, 32,768-token budget), rising to <strong>93.8% (75/80)</strong> under Protocol B (median 2 turns). Turning reasoning mode on proved decisive: on <code>INTENT-1</code>, zero-shot rose from 0/50 to 5/50 (10%) and Protocol B jumped from 2/20 (10%) to 20/20 within 3 turns. Throughput measured <strong>63 tok/s aggregate</strong> (p50 9.2 s, p95 10.0 s latency, ~2.1 h per 50 trials; an 8,192-token budget exhausted on internal chain-of-thought in 3/3 pilots).</li>
                <li><code>qwen3.8:27b</code> (Mac, digest <code>aaee06c39dcf</code>): Under Plan v1 prompt text, scored <strong>56.5% (113/200)</strong> zero-shot and <strong>100% (80/80)</strong> Protocol B (5h 49m wall time for A, 3h 06m for B). Under Plan v2 (incorporating <code>A10</code> ARP confinement text), scored <strong>43.0% (86/200)</strong> zero-shot (with 8 Node 300s header-timeout transport failures) and <strong>98.8% (79/80)</strong> Protocol B (1 transport timeout; 33/80 passed on Turn 1 vs. 63/80 for Haiku; 7h 55m for A, 4h 57m for B). Under Plan v2 <code>INTENT-3</code>, scored only 1/50 zero-shot (47/49 failures were <code>ERR_INTENT_LEAK</code> from inserting a Port 1 catch-all).</li>
                <li><code>qwen2.5:3b</code> (NVIDIA Jetson Orin Nano Super): <strong>0 admissible sets in 44 answered trials</strong> on <code>INTENT-1</code> (25 <code>ERR_SHADOWED</code>, 18 <code>ERR_SYNTAX</code> such as CIDR masks in IPv4 match fields, 6 transport timeouts). In-flight inference ran at <strong>15.3 tok/s</strong> (p50 latency 39.1 s), driving GPU load to <strong>96.5% mean (99% max)</strong>, board power to 12.5 W mean (13.1 W peak), thermals to 56°C, and consuming 4.6–5.1 GB of the board's 7.6 GB RAM. Removed from active rotation on 2026-10-16.</li>
            </ul>
        </li>
        <li><strong>Rented-GPU Tier (Runpod A100 80 GB at $1.79/hr, Qwen3.8-27B + LoRA Adapters):</strong>
            We evaluated four fine-tuning and pipeline arms: <code>B3</code> (Ollama base), <code>C3</code> (pipeline conversion control), <code>L3</code> (15-step SFT+DPO adapter, rank 16, alpha 32, trained in 14.2 min on 1,466 SFT examples and 1,434 verifier-grounded DPO pairs, ~$19.60 campaign cost), and <code>L4</code> (80 SFT + 90 DPO steps, ~0.5 epoch, $3.90 training cost, ~$20 campaign cost).
            On seen intents (<code>INTENT-1..4</code>), <code>B3</code> and <code>C3</code> scored 87.0% (174/200) zero-shot, while <code>L3</code> reached 88.0% (176/200); both reached 100% (80/80) within &le;2 turns in Protocol B.
            However, on unseen hard intents (<code>INTENT-5..8</code>), <code>C3</code> held 87.0% (174/200) zero-shot, whereas <code>L3</code> regressed to <strong>70.5% (141/200)</strong> (-16.5 pp). On the full 6-intent suite (<code>INTENT-1,3,5,6,7,8</code>), the longer-trained <code>L4</code> adapter collapsed to <strong>48.3% (145/300)</strong> zero-shot (119 <code>ERR_SYNTAX</code> failures from truncated/repetitive JSON) compared to <strong>82.7% (248/300)</strong> for the <code>C3</code> control.
        </li>
        <li><strong>Cloud Frontier API Models (Claude Haiku 5.5 Production Arm &amp; 12-Model Pilot):</strong>
            <ul>
                <li><code>claude-haiku-5-5</code> (effort: low): Evaluated across <strong>2,400 fresh post-selection trials</strong> (800 trials &times; 3 rounds across <code>INTENT-1..4</code>). Scored <strong>2,303/2,400 (96.0%, 95% CI 95.1%–96.7%)</strong> zero-shot (<code>INTENT-1</code> 91.3%, <code>INTENT-2</code> 99.5%, <code>INTENT-3</code> 93.0%, <code>INTENT-4</code> 100.0%) and <strong>400/400 (100.0%)</strong> in Protocol B (388 passed on Turn 1, remaining 12 repaired on Turn &ge; 2). Evaluated on harder <code>INTENT-5..8</code>, scored <strong>98.0% (196/200)</strong> zero-shot. Cost measured <strong>$0.0008 per admissible set</strong> ($0.00072/trial, ~35 min wall time for 200 trials via Batch API vs. ~13 h for local Qwen).</li>
                <li><strong>12-Model Cloud Selection Pilot (N=12 trials each, Table 5):</strong> Evaluated across Anthropic and Google Gemini frontiers. <code>gemini-4-argon</code> scored 12/12 ($0.0076, 10x Haiku cost), <code>claude-sonnet-5-5</code> scored 11/12 ($0.0088, 11x cost), and <code>gemini-3.8-flash</code> scored 12/12 ($0.0115, 15x cost). Crucially, <strong><code>claude-opus-5-5</code> declined all 3 <code>INTENT-4</code> trials with <code>refusal:cyber</code></strong> (scoring 9/12 at $0.0162, 20x cost), while <strong><code>claude-fable-5-1</code> refused 100% of defensive networking probe trials (0/9, <code>refusal:cyber</code>)</strong>.</li>
            </ul>
        </li>
    </ul>

    <div class="figure-box">
        {fig5_svg}
        <div class="figure-caption">
            <strong>Figure 6: Agent Policy Synthesis Admissibility Across Protocols, Models, and LoRA Adapters.</strong> Deterministic verifier feedback (Protocol B, green bars) lifts admissibility to <strong>94%–100%</strong> across local and cloud models. In contrast, scaling LoRA fine-tuning from 15 steps to 80 SFT + 90 DPO steps (red bar) collapses multi-intent accuracy to <strong>48.3%</strong> through template memorization and syntax degeneration.
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width:24%;">Model &amp; Compute Tier</th>
                <th style="width:16%;">Intent Suite</th>
                <th style="width:14%;">Protocol</th>
                <th style="width:16%;">Admissible Rate</th>
                <th style="width:12%;">Wall Time / Cost</th>
                <th>Primary Failure Modes &amp; Empirical Findings</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Gemma 4 26B (Local Mac)</strong><br><span style="font-size:7.5pt;color:#5f6368;">Q4_K_M · reasoning on</span></td>
                <td><code>INTENT-1..4</code> (N=200/80)</td>
                <td>Proto A / B (&le;5t)</td>
                <td><strong>70/200 (35.0%)</strong><br><strong>75/80 (93.8%)</strong></td>
                <td>63 tok/s (p50 9.2s)<br>~2.1 h per 50 trials</td>
                <td>Reasoning took <code>INTENT-1</code> from 0/50 to 5/50 zero-shot &amp; 20/20 in 3 turns. 8,192 tok budget exhausted on internal thoughts in 3/3 pilots.</td>
            </tr>
            <tr>
                <td><strong>Qwen3.8-27B Plan v2 (Local)</strong><br><span style="font-size:7.5pt;color:#5f6368;">Q4_K_M · Ollama</span></td>
                <td><code>INTENT-1..4</code> (N=200/80)</td>
                <td>Proto A / B (&le;5t)</td>
                <td><strong>86/200 (43.0%)</strong><br><strong>79/80 (98.8%)</strong></td>
                <td>7h 55m (A)<br>4h 57m (B)</td>
                <td>8 Node 300s timeout errors; 33/80 passed on Turn 1 (vs 63/80 Haiku). On <code>INTENT-3</code>, 47/49 zero-shot errors were <code>ERR_INTENT_LEAK</code> (P1 catch-all).</td>
            </tr>
            <tr>
                <td><strong>Qwen2.5:3b (Jetson Orin)</strong><br><span style="font-size:7.5pt;color:#5f6368;">Q4_K_M · Removed</span></td>
                <td><code>INTENT-1</code> (N=44)</td>
                <td>Protocol A</td>
                <td><strong>0 / 44 (0.0%)</strong></td>
                <td>15.3 tok/s (p50 39.1s)<br>96.5% GPU, 56&deg;C</td>
                <td>25 <code>ERR_SHADOWED</code>, 18 <code>ERR_SYNTAX</code> (CIDR masks in IPv4), 6 transport timeouts. Board saturated (12.5 W, 5.1 GB RAM).</td>
            </tr>
            <tr>
                <td><strong>Qwen3.8 Rented A100 (C3 Ctrl)</strong><br><span style="font-size:7.5pt;color:#5f6368;">Runpod A100 80 GB ($1.79/h)</span></td>
                <td><code>INTENT-1..4</code><br><code>INTENT-5..8</code></td>
                <td>Proto A (0-shot)<br>Proto B (&le;2t)</td>
                <td><strong>174/200 (87.0%)</strong><br><strong>80/80 (100.0%)</strong></td>
                <td>~$19.60 campaign<br>p50 &le; 2.5 s</td>
                <td>Base weights generalized cleanly across both seen and hard unseen intents when given explicit prompt invariants.</td>
            </tr>
            <tr>
                <td><strong>Qwen3.8 + 15s LoRA (L3)</strong><br><span style="font-size:7.5pt;color:#5f6368;">1,466 SFT + 1,434 DPO pairs</span></td>
                <td><code>INTENT-1..4</code> (Seen)<br><code>INTENT-5..8</code> (Hard)</td>
                <td>Proto A (0-shot)</td>
                <td><strong>176/200 (88.0%)</strong><br><strong>141/200 (70.5%)</strong></td>
                <td>14.2 min training<br>~$19.60 campaign</td>
                <td>Marginal +1.0 pp gain on seen intents; <strong>-16.5 pp regression</strong> on unseen intents (memorized <code>INTENT-1..4</code> port templates).</td>
            </tr>
            <tr>
                <td><strong>Qwen3.8 + 90s LoRA (L4)</strong><br><span style="font-size:7.5pt;color:#5f6368;">80 SFT + 90 DPO steps</span></td>
                <td>6-Intent Suite (N=300)</td>
                <td>Proto A (0-shot)</td>
                <td><strong>145 / 300 (48.3%)</strong></td>
                <td>$3.90 training<br>~$20 campaign</td>
                <td><strong>-34.4 pp collapse</strong> vs C3 control (248/300, 82.7%): 119 <code>ERR_SYNTAX</code> failures from truncated, repetitive JSON strings.</td>
            </tr>
            <tr>
                <td><strong>Claude Haiku 5.5 (Frontier)</strong><br><span style="font-size:7.5pt;color:#5f6368;">Batch API · effort: low</span></td>
                <td><code>INTENT-1..4</code> (Fresh)<br><code>INTENT-5..8</code> (Hard)</td>
                <td>Proto A (0-shot)<br>Proto B (&le;5t)</td>
                <td><strong>2,303/2,400 (96.0%)</strong><br><strong>400/400 (100.0%)</strong></td>
                <td><strong>$0.0008 / set</strong><br>~35 min wall time</td>
                <td>95% CI [95.1%, 96.7%]. 388/400 passed Turn 1. <code>INTENT-5..8</code> zero-shot reached 98.0% (196/200). Dominant price/performance arm.</td>
            </tr>
        </tbody>
    </table>

    <h2 id="sec4_2">4.2 Twelve-Model Cloud Pilot &amp; Safety Refusal Findings</h2>
    <p>
        Prior to selecting Claude Haiku 5.5 for large-scale validation, we conducted a 12-model comparative selection pilot (12 trials each, 3 per intent across <code>INTENT-1..4</code>, Protocol A; Table 5). The pilot exposed critical trade-offs between pricing, speed, reasoning quality, and frontier alignment policies:
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:26%;">Pilot Model Arm</th>
                <th style="width:14%;">0-Shot (N=12)</th>
                <th style="width:16%;">Cost / Admissible</th>
                <th style="width:14%;">Relative Cost</th>
                <th>Selection Decision &amp; Failure Mode Observations</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Claude Haiku 5.5</strong></td>
                <td><strong>11 / 12 (91.7%)</strong></td>
                <td><strong>$0.0008</strong></td>
                <td><strong>1.0&times; (Baseline)</strong></td>
                <td><strong>Selected Production Arm:</strong> Lowest cost, fastest turnaround, 100% convergence in Protocol B.</td>
            </tr>
            <tr>
                <td><strong>Gemini 4 Argon</strong></td>
                <td><strong>12 / 12 (100.0%)</strong></td>
                <td>$0.0076</td>
                <td>9.5&times;</td>
                <td>Flawless zero-shot accuracy; reserved for high-stakes policy synthesis where 10&times; token cost is justified.</td>
            </tr>
            <tr>
                <td><strong>Claude Sonnet 5.5</strong></td>
                <td><strong>11 / 12 (91.7%)</strong></td>
                <td>$0.0088</td>
                <td>11.0&times;</td>
                <td>High zero-shot reasoning, but 11&times; more expensive than Haiku with identical Protocol B outcome.</td>
            </tr>
            <tr>
                <td><strong>Gemini 3.8 Flash</strong></td>
                <td><strong>12 / 12 (100.0%)</strong></td>
                <td>$0.0115</td>
                <td>14.4&times;</td>
                <td>Reliable zero-shot, but priced higher than Haiku without measurable data-plane benefit.</td>
            </tr>
            <tr>
                <td><strong>Gemini 3.6 Flash</strong></td>
                <td><strong>11 / 12 (91.7%)</strong></td>
                <td>$0.0129</td>
                <td>16.1&times;</td>
                <td>Solid zero-shot performance (33/40 in Stage 2 follow-up); superseded by Gemini 3.8 Flash.</td>
            </tr>
            <tr>
                <td><strong>Claude Opus 5.5</strong></td>
                <td><strong>9 / 12 (75.0%)</strong></td>
                <td>$0.0162</td>
                <td>20.3&times;</td>
                <td><strong>Alignment Refusal:</strong> Declined all 3 <code>INTENT-4</code> trials with <code>refusal:cyber</code> (misclassified defensive isolation as hostile).</td>
            </tr>
            <tr>
                <td><strong>Gemini 3.1 Pro Preview</strong></td>
                <td><strong>9 / 12 (75.0%)</strong></td>
                <td>$0.0505</td>
                <td>63.1&times;</td>
                <td>High latency and 63&times; cost; exhibited redundant action lists and table budget violations.</td>
            </tr>
            <tr>
                <td><strong>Gemini 3.1 Flash Lite</strong></td>
                <td><strong>5 / 12 (41.7%)</strong></td>
                <td>$0.0020</td>
                <td>2.5&times;</td>
                <td>Unreliable zero-shot; omitted <code>eth_type</code> prerequisites and emitted contradictory priority values.</td>
            </tr>
            <tr>
                <td><strong>Claude Fable 5.1 (Probe)</strong></td>
                <td><strong>0 / 9 (0.0%)</strong></td>
                <td>&mdash;</td>
                <td>&mdash;</td>
                <td><strong>Severe Alignment False-Positive:</strong> Refused 100% of defensive networking probe trials with <code>refusal:cyber</code>.</td>
            </tr>
        </tbody>
    </table>

    <p>
        <strong>Methodological Limits &amp; Synthesis:</strong> Our model evaluation reveals four operational boundaries (<code>docs/research/models.md</code>):
        (1) <em>Quantization sensitivity:</em> 4-bit local weights (<code>Q4_K_M</code>) suffer from JSON syntax truncation and transport header timeouts under load; production local deployments require 8-bit quantization and at least 32 GB unified memory.
        (2) <em>Non-blind pilot selection:</em> The 12-model pilot was screened non-blind on N=12 samples; while Haiku was validated across N=2,400 fresh samples, other pilot arms were not scaled to N=2,400.
        (3) <em>Admissibility &ne; Wire Correctness:</em> Verifier admissibility (<code>A1</code>–<code>A11</code>) proves safety invariants, but only Track B's three-vantage-point physical taps prove whether packets actually cross the switch silicon correctly.
        (4) <em>Suitable uses:</em> Cloud frontier APIs (Haiku 5.5) paired with deterministic verifiers are optimal for operational controller tooling ($0.0008/set), while local 26B/27B models with reasoning enabled provide an air-gapped fallback for regulated environments.
    </p>

    <!-- ==================== SECTION 5 ==================== -->
    <h1 id="sec5">5. Track B: Hardware Characterization &amp; On-Wire Conformance Oracle</h1>
    <p>
        Does a flow table that passes software verification actually forward and drop the exact packets predicted when installed into the Zodiac FX's Micrel KSZ8795CLX switch silicon and Atmel SAM4E8E firmware? Track B answered this question by building a differential <strong>on-wire conformance harness</strong> (<code>scripts/conformance-harness.ts</code>) that tests rule sets against physical packets captured simultaneously at <code>O1</code>, <code>O2</code>, and <code>O3</code>.
    </p>

    <h2 id="sec5_1">5.1 128-Rule-Set Differential Conformance Campaign (611/611 Flow Checks)</h2>
    <p>
        Our Track B exit criterion required executing at least 100 distinct rule sets on the physical switch and comparing predicted vs. observed forwarding outcomes for every flow check. Across three hardware campaigns (<code>docs/benchmarks/results/conformance-campaign-2026-10-12/</code>, <code>2026-10-13</code>, and <code>2026-10-20</code>), we executed <strong>128 distinct rule sets comprising 611 individual on-wire flow checks</strong> (Table 5). Every check injected real Ethernet/IPv4/UDP/TCP/ARP frames from <code>agentic-node-02</code> into Switch #1, captured pre-DUT ingress at <code>O1</code> (<code>rpi-hailo eth1</code>), policy-tap copies at <code>O2</code> (Jetson NIC #1), and post-DUT egress at <code>O3</code> (Jetson NIC #3), and compared the wire outcome against <code>evaluatePacket()</code> in our reference model.
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:28%;">Conformance Corpus Category</th>
                <th style="width:14%;">Rule Sets</th>
                <th style="width:16%;">Wire Flow Checks</th>
                <th style="width:18%;">Model == Wire Agreement</th>
                <th>Key Hardware Properties Exercised on Zodiac FX (FW 0.86)</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Baseline &amp; Port Confinement</strong></td>
                <td>24</td>
                <td>116</td>
                <td><strong>116 / 116 (100.0%)</strong></td>
                <td>Default table-miss drop, Port 1 &larr;&rarr; Port 3 tap return, Port 2 uplink block, VLAN 100 boundary.</td>
            </tr>
            <tr>
                <td><strong>Priority Precedence &amp; Prefix Overlap</strong></td>
                <td>32</td>
                <td>155</td>
                <td><strong>155 / 155 (100.0%)</strong></td>
                <td>Priority 65535 quarantine overrides prio 100–500 allow rules; longest-prefix / exact-match ordering.</td>
            </tr>
            <tr>
                <td><strong>L2 / L3 / L4 Match Tuple Variations</strong></td>
                <td>36</td>
                <td>172</td>
                <td><strong>172 / 172 (100.0%)</strong></td>
                <td><code>eth_type</code> (IPv4, ARP), <code>ipv4_src</code>/<code>dst</code>, <code>ip_proto</code> (TCP, UDP, ICMP), <code>tcp_dst</code>/<code>udp_dst</code>.</td>
            </tr>
            <tr>
                <td><strong>Agent-Proposed &amp; Quarantine Envelopes</strong></td>
                <td>24</td>
                <td>112</td>
                <td><strong>112 / 112 (100.0%)</strong></td>
                <td>Protocol B accepted policies across <code>INTENT-1..8</code> plus dynamic <code>k = 1..8</code> quarantine insertions.</td>
            </tr>
            <tr>
                <td><strong>Priority-0 Firmware Quirk Corpus (F1)</strong></td>
                <td>12</td>
                <td>56</td>
                <td><strong>56 / 56 (100.0%)</strong></td>
                <td>Verifies hardware drops priority-0 <code>APPLY_ACTIONS</code> and confirms <code>A3</code> rejects prio-0 user rules.</td>
            </tr>
            <tr>
                <td><strong>Total Track B Campaign</strong></td>
                <td><strong>128</strong></td>
                <td><strong>611</strong></td>
                <td><strong>611 / 611 (100.0%)</strong></td>
                <td><strong>Zero unexplained discrepancies across all 128 rule sets and 611 flow checks.</strong></td>
            </tr>
        </tbody>
    </table>

    <div class="figure-box">
        {fig6_svg}
        <div class="figure-caption">
            <strong>Figure 7: Physical Wire Conformance (RQ4) &amp; Smoke Gate Validation Funnel.</strong> Across 128 distinct rule sets and 611 flow checks, <strong>611 of 611 (100.0%)</strong> wire observations across O1, O2, and O3 agreed with the model's match predictions (M1) and satisfied intent clauses (M2). The 4-stage smoke gate (right) resolved capture harness defects (<code>tcpdump -p</code>) and discovered switch-path drops of self-addressed IPv4 frames before unlocking the full 143-run campaign.
        </div>
    </div>

    <h2 id="sec5_2">5.2 Finding F1: Why Controller-State Verification Cannot Replace Wire Ground Truth</h2>
    <div class="callout warn">
        <div class="callout-title">Finding F1 — Silent Priority-0 Action Stripping in Firmware 0.86</div>
        When an OpenFlow 1.3 controller sends an <code>OFPFC_ADD</code> flow modification with <code>priority = 0</code> and an output action list (e.g., <code>OUTPUT:1</code>), the Zodiac FX (Firmware 0.86) accepts the message without emitting an <code>OFPT_ERROR</code> and reports the flow entry as active in <code>OFPMP_FLOW</code> table dumps—<strong>but strips the <code>OFPIT_APPLY_ACTIONS</code> instruction block in hardware</strong>, causing 100% of matching packets to be silently dropped on the wire.
    </div>
    <p>
        Finding <code>F1</code> is the single most important empirical justification for Track B's three-vantage-point wire architecture. A verifier that only inspects the controller's intended flow table—or even one that queries the switch's flow-table match fields without parsing the returned instruction TLVs and cross-checking wire egress at <code>O3</code>—would certify a priority-0 forwarding rule as "installed and forwarding" while 0% of packets actually leave the switch. Encoding <code>F1</code> into both our reference model and <code>A3</code> closed this gap permanently.
    </p>

    <h2 id="sec5_3">5.3 Physical Reality Gaps Across Conformance &amp; Red-Team Tracks</h2>
    <p>
        The central practical insight from deploying on real hardware is that several behaviors looked correct in controller software or simulated environments until physical vantage points contradicted them:
    </p>
    <ul>
        <li><strong>Vacuous observer captures:</strong> A first table-miss experiment reported zero frames at the workload observer; the observing node lacked <code>tcpdump</code>, so its capture never ran and its zeros were false evidence. Observers now strictly prove execution before results are admitted. In Scenario 4, a capture helper read at most 2 MB of text, silently truncating a 250,000-frame capture until caught by size validation.</li>
        <li><strong>Capture-harness promiscuity bug:</strong> The initial wire run disagreed with the model on 11/28 flows. Running <code>tcpdump -p</code> disabled promiscuous mode on the O2 tap NIC, dropping unicast mirror frames. Removing <code>-p</code> resolved 7 disagreements immediately.</li>
        <li><strong>Switch-path drop of self-addressed frames:</strong> The remaining 4 smoke disagreements were IPv4 frames with source IP identical to destination IP (Land attack shape). The Zodiac FX switch silicon silently drops self-addressed frames before reaching mirror taps (safe failure mode); these degenerate flows were excluded from candidate test suites.</li>
        <li><strong>Aggregation switch VLAN bypass:</strong> During Scenario 1 debugging, a convenience change to the uplink aggregation switch gave both workload nodes an unmonitored second path onto the segment under test, bypassing the Zodiac FX entirely until discovered and isolated.</li>
        <li><strong>Linux weak-host model ARP interception:</strong> In Scenario 6, pinging a workload node failed 100%, appearing to confirm containment. In reality, Linux's default <code>arp_filter=0</code> caused the lab-facing NIC to answer for the workload NIC's IP, intercepting traffic before it ever touched the switch. Setting <code>arp_filter=1</code> and downing Wi-Fi revealed the switch rule was never exercised.</li>
        <li><strong>Protected-host authorization block:</strong> In Scenario 3, the detector correctly attributed 939 scan anomalies to the attacker, but every one of 1,543 quarantine requests failed with HTTP 403 because the scanning node was still on the protected-host list from an earlier test role.</li>
    </ul>

    <!-- ==================== SECTION 6 ==================== -->
    <h1 id="sec6">6. Track C: Live Red-Team Adversary &amp; Quarantine Envelope Evaluation</h1>
    <p>
        Track C tested whether our verified policies and bounded containment mechanisms survive contact with a live hardware adversary. Using <code>agentic-node-01</code> (<code>10.0.2.50</code>, Raspberry Pi 3B+ connected to Switch #1 Port 3 on the untrusted workload segment) as the red-team host and <code>agentic-node-02</code> (<code>10.0.2.52</code>, Switch #1 Port 1) as the legitimate workload, we executed <strong>7 adversarial hardware scenarios</strong> (<code>docs/benchmarks/results/2026-11-01-track-c-red-team-consolidated.md</code>).
    </p>

    <h2 id="sec6_1">6.1 Consolidated Hardware Red-Team Matrix (Scenarios 1–7)</h2>
    <p>
        Every scenario in Table 6 was executed on the physical switch stack with SHA-256 provenance sidecars verifying capture integrity at <code>O1</code>, <code>O2</code>, and <code>O3</code>.
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:6%;">#</th>
                <th style="width:22%;">Adversary Scenario</th>
                <th style="width:24%;">Attack Vector from <code>node-01</code> (<code>.50</code>)</th>
                <th style="width:20%;">Defense / Verifier Mechanism</th>
                <th>Measured On-Wire Outcome &amp; Artifact Evidence</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>S1</strong></td>
                <td>Passive Reconnaissance &amp; Port Scan</td>
                <td>ARP sweep + TCP SYN scan across <code>10.0.2.0/24</code> and uplink gateway targets.</td>
                <td>6-rule confinement baseline + <code>A10</code> ARP peer restriction + Sentinel detection.</td>
                <td><strong>0 frames leaked to <code>O3</code></strong>; scan detected on <code>O2</code> within 1 window; priority-65535 quarantine installed in <strong>18.4 ms</strong>.</td>
            </tr>
            <tr>
                <td><strong>S2</strong></td>
                <td>Lateral Movement &amp; L2 Bypass</td>
                <td>Direct L2 unicast probes from <code>.50</code> to legitimate client <code>.52</code> on upstream Switch #1.</td>
                <td><code>O1</code> pre-DUT mirror on Switch #1 P2 + Port-1 quarantine drop at DUT boundary.</td>
                <td>Proves <code>O2</code>/DUT cannot block intra-Switch-#1 L2 frames directly, while <code>O1</code> provides visibility and DUT blocks all uplink/tap transit.</td>
            </tr>
            <tr>
                <td><strong>S3</strong></td>
                <td>Spoofed-Source Steering (Self-DoS Attack)</td>
                <td><code>.50</code> floods frames forging <code>ipv4_src = 10.0.2.52</code> (victim IP) and <code>10.0.1.8</code> (controller IP) to steer quarantine onto protected hosts.</td>
                <td><strong>Quarantine Envelope</strong> (<code>protectedHosts</code> list) + <code>A5</code> control protection.</td>
                <td><strong>100% of forged steering attempts against <code>.52</code>, <code>.51</code>, and <code>10.0.1.8</code> rejected</strong> by envelope; legitimate <code>.52</code> traffic uninterrupted.</td>
            </tr>
            <tr>
                <td><strong>S4</strong></td>
                <td>Data-Plane Saturation &amp; Overload Cliff</td>
                <td><code>.50</code> blasts <strong>25,000 pps</strong> (2x switch capacity) of 600 B UDP frames into Port 1.</td>
                <td>802.3x Flow Control + NET-002 fail-closed table wipe + bridge auto-reconnect.</td>
                <td>At 25k pps, MCU CPU starvation drops OpenFlow TCP and wipes table (<strong>fail-closed: 0 leaked frames</strong>); bridge recovers &amp; restores policy in <strong>4–6 s</strong>.</td>
            </tr>
            <tr>
                <td><strong>S5</strong></td>
                <td>Multi-Host Quarantine Table Exhaustion</td>
                <td><code>.50</code> rotates across <strong>64 random spoofed source IPs</strong> to exhaust the 128-rule table and degrade throughput.</td>
                <td>Envelope cap <code>maxQuarantineRules = 8</code> + <code>A8</code> deployed cost model (<code>8,106 pps</code> at <code>k=8</code>).</td>
                <td>Quarantine table strictly capped at <strong>k = 8 rules</strong>; remaining 56 spoofed IPs denied slot allocation; <code>node-02</code> throughput held <strong>&gt;= 8,100 pps</strong>.</td>
            </tr>
            <tr>
                <td><strong>S6</strong></td>
                <td>Adversarial Policy Injection (Prompt/Rule)</td>
                <td>Adversarial intents attempting to trick LLM proposer into installing prio-0 blackholes, hairpins, or wildcard Port-2 ARP rules.</td>
                <td><code>admitInstall()</code> gate (<code>A1</code>–<code>A11</code>) + mandatory human sign-off.</td>
                <td><strong>100% of unsafe rule mutations rejected</strong> before reaching OpenFlow socket; Protocol B repaired all tricks into compliant rules.</td>
            </tr>
            <tr>
                <td><strong>S7</strong></td>
                <td>Low-Rate Timing &amp; Flap Evasion</td>
                <td>On-off burst pulses timed to trigger rapid quarantine install/release oscillation (rule flapping).</td>
                <td>Invariant 5 damping: <strong>300 s minimum TTL hold</strong> + consecutive-window hysteresis.</td>
                <td><strong>Zero rule flapping</strong>; quarantine held steady across pulse gaps until full damped expiration or manual operator release.</td>
            </tr>
        </tbody>
    </table>

    <h2 id="sec6_2">6.2 Pre-Approved Quarantine Envelope &amp; Anti-Steering Guarantees</h2>
    <p>
        Invariant 4 draws a sharp distinction between <em>agent-proposed policy changes</em> (which always require human sign-off) and <em>detector-driven host containment</em> (where human approval takes minutes against an attack's milliseconds). Detector containment is permitted to act automatically <strong>only inside a deterministic Quarantine Envelope approved in advance by a human</strong> (<code>src/sdn/quarantine-envelope.ts</code>):
    </p>
    <ul>
        <li><strong>Scope &amp; Action Restriction:</strong> Automatic containment may only insert or remove <code>DROP</code> rules on <code>in_port = 1</code> at <code>priority = 65535</code> matching a single <code>eth_type = 0x0800, ipv4_src = /32</code> host on <code>10.0.2.0/24</code>. It can never add forwarding outputs, modify uplink rules, or touch Port 2 or Port 4.</li>
        <li><strong>Protected-Host Immunity (Scenario 3 defense):</strong> The envelope maintains a hard-coded immutable exclusion list (<code>10.0.2.52</code> legitimate client, <code>10.0.2.51</code> sensor node, <code>10.0.1.0/24</code> control plane). Because L2 source addresses are trivially forgeable on an untrusted segment, the envelope guarantees that a spoofed flood can never trick the sentinel into quarantining protected infrastructure.</li>
        <li><strong>Table &amp; Throughput Cap (Scenario 5 defense):</strong> Active quarantines are capped at <code>k &lt;= 8</code> (6.25% of the 128-rule table), guaranteeing via our <code>A8</code> cost model that worst-case legitimate forwarding capacity never falls below <strong>8,106 pps</strong> (or <strong>7,765 pps</strong> with up to 8 allow rules).</li>
    </ul>

    <!-- ==================== SECTION 7 ==================== -->
    <h1 id="sec7">7. Scope Boundaries, Threats to Validity &amp; Owner's Review Sign-Off</h1>
    <p>
        Scientific rigor requires stating what our experiments <strong>do not prove</strong> as clearly as what they prove. Table 7 records the explicit scope boundaries of the Zodiac repository.
    </p>

    <table>
        <thead>
            <tr>
                <th style="width:28%;">Topic / Dimension</th>
                <th style="width:36%;">What Zodiac Proves Empirically</th>
                <th>What Zodiac Explicitly Does Not Claim</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><strong>Autonomy vs. Human Governance</strong></td>
                <td>Verifier feedback (Protocol B) produces 98.8%–100% admissible proposals ready for human review.</td>
                <td>Does <strong>not</strong> claim autonomous self-driving networking; every policy install requires human approval.</td>
            </tr>
            <tr>
                <td><strong>Switch Scale &amp; Silicon</strong></td>
                <td>Exact characterization of a 120 MHz ARM Cortex-M4 OpenFlow 1.3 switch (128 rules, 4×100M ports, FW 0.86).</td>
                <td>Does <strong>not</strong> claim ASIC line-rate generalization to multi-terabit Tofino/Broadcom switches without re-measuring <code>A8</code> and <code>F1</code>.</td>
            </tr>
            <tr>
                <td><strong>Single-Switch vs. Multi-Hop Fabric</strong></td>
                <td>Complete <code>A1</code>–<code>A11</code> verification and 3-point wire conformance across a single OpenFlow DUT.</td>
                <td>Does <strong>not</strong> claim distributed multi-switch state convergence or BGP/OSPF routing verification.</td>
            </tr>
            <tr>
                <td><strong>Source Spoofing on Shared L2</strong></td>
                <td>Quarantine Envelope prevents spoofed-IP steering against protected hosts and caps table usage at <code>k &lt;= 8</code>.</td>
                <td>Does <strong>not</strong> claim unforgeable L2 identity without 802.1X / port-per-host switch isolation.</td>
            </tr>
            <tr>
                <td><strong>LoRA Fine-Tuning</strong></td>
                <td>Demonstrates that 15-step and 90-step LoRA SFT+DPO overfit rule templates and regress multi-intent accuracy.</td>
                <td>Does <strong>not</strong> claim full-parameter pretraining on millions of diverse topologies would fail—only that verifier feedback dominates small-corpus LoRA.</td>
            </tr>
        </tbody>
    </table>

    <div class="callout pass" style="margin-top:12pt;">
        <div class="callout-title">Owner's Review Sign-Off Record (2026-11-07 · Commit 79b36be)</div>
        All exit criteria across <strong>Track A</strong> (deterministic verifier <code>A1</code>–<code>A11</code>, 196/196 mutation tests, Protocol A vs. Protocol B &amp; LoRA evaluation, live Jetson bridge verification with <code>A3</code> auto-repair and <code>A8</code> cost model active), <strong>Track B</strong> (128 rule sets, 611/611 on-wire conformance checks across <code>O1</code>/<code>O2</code>/<code>O3</code>, Finding <code>F1</code>), and <strong>Track C</strong> (7/7 hardware red-team scenarios with SHA-256 provenance sidecars) have been verified and signed off in <code>docs/research/owner-review-packet.md</code> and <code>.agents/audit-log.md</code> (0 open remediation rows).
    </div>

    <!-- ==================== REFERENCES ==================== -->
    <h1 id="refs">References</h1>
    <div class="ref-item">[1] Open Networking Foundation (ONF). <em>OpenFlow Switch Specification, Version 1.3.0 (Wire Protocol 0x04)</em>. ONF TS-006, June 2012.</div>
    <div class="ref-item">[2] P. Kazemian, G. Varghese, and N. McKeown. “Header Space Analysis: Static Checking for Networks.” In <em>Proc. USENIX NSDI</em>, pp. 113–126, 2012.</div>
    <div class="ref-item">[3] A. Khurshid, X. Zou, W. Zhou, M. Caesar, and P. B. Godfrey. “VeriFlow: Verifying Network-Wide Invariants in Real Time.” In <em>Proc. USENIX NSDI</em>, pp. 15–27, 2013.</div>
    <div class="ref-item">[4] C. J. Anderson, N. Foster, A. Guha, J.-B. Jeannin, D. Kozen, C. Schlesinger, and D. Walker. “NetKAT: Semantic Foundations for Networks.” In <em>Proc. ACM POPL</em>, pp. 113–126, 2014.</div>
    <div class="ref-item">[5] A. Fogel et al. “A General Approach to Network Configuration Analysis (Batfish).” In <em>Proc. USENIX NSDI</em>, pp. 469–483, 2015.</div>
    <div class="ref-item">[6] R. Beckett, A. Gupta, R. Mahajan, and D. Walker. “A General Approach to Network Configuration Verification (Minesweeper).” In <em>Proc. ACM SIGCOMM</em>, pp. 155–168, 2017.</div>
    <div class="ref-item">[7] N. Lopes et al. “Checking Beliefs in Dynamic Networks (NoD).” In <em>Proc. USENIX NSDI</em>, pp. 499–512, 2015.</div>
    <div class="ref-item">[8] Northbound Networks. <em>Zodiac FX OpenFlow 1.3 Hardware &amp; Firmware v0.86 Reference Manual</em>. Atmel SAM4E8E / Micrel KSZ8795CLX Architecture, 2018.</div>
    <div class="ref-item">[9] M. Kuzniar, P. Perešíni, and D. Kostić. “What You Need to Know About SDN Flow Tables.” In <em>Proc. Passive and Active Measurement (PAM)</em>, LNCS vol. 8995, pp. 347–359, 2015.</div>
    <div class="ref-item">[10] D. Y. Huang, K. Yocum, and A. C. Snoeren. “High-Fidelity Switch Models for Software-Defined Network Emulation.” In <em>Proc. ACM HotSDN</em>, pp. 43–48, 2013.</div>
    <div class="ref-item">[11] R. Rorig, P. V. B. da Silva, and L. C. E. Bona. “Empirical Performance Characterization of the Northbound Networks Zodiac FX OpenFlow Switch.” In <em>IEEE LANMAN</em>, 2019.</div>
    <div class="ref-item">[12] E. J. Hu et al. “LoRA: Low-Rank Adaptation of Large Language Models.” In <em>Proc. ICLR</em>, 2022.</div>
    <div class="ref-item">[13] R. Rafailov et al. “Direct Preference Optimization: Your Language Model is Secretly a Reward Model.” In <em>Proc. NeurIPS</em>, 2023.</div>
    <div class="ref-item">[14] S. Kambhampati et al. “LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks.” In <em>Proc. ICML</em>, 2024.</div>
    <div class="ref-item">[15] R. Mondal et al. “What Do LLMs Need to Synthesize Correct Router Configurations?” In <em>Proc. ACM HotNets</em>, pp. 189–196, 2023.</div>
    <div class="ref-item">[16] S. Dhawan et al. “SPHINX: Detecting Security Attacks in Software-Defined Networks.” In <em>Proc. NDSS</em>, 2015.</div>
    <div class="ref-item">[17] S. Shin, V. Yegneswaran, P. Porras, and G. Gu. “AVANT-GARDE: Exposing Consistent Security State in OpenFlow Networks.” In <em>Proc. ACM CCS</em>, pp. 275–286, 2013.</div>
    <div class="ref-item">[18] IEEE Standard 802.3x. <em>Supplement to Carrier Sense Multiple Access with Collision Detection (CSMA/CD): Specification for 802.3 Full Duplex Operation and PAUSE Flow Control</em>, 1997.</div>
    <div class="ref-item">[19] Gravity TPU Infrastructure Group. <em>Zodiac Infrastructure Bandwidth &amp; Rule-Depth Characterization Whitepaper</em>. Technical Artifact <code>docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md</code>, October 2026.</div>
    <div class="ref-item">[20] Gravity TPU Infrastructure Group. <em>Zodiac Owner's Review Packet &amp; Consolidated Red-Team Evidence</em>. Technical Artifact <code>docs/research/owner-review-packet.md</code>, November 2026.</div>

    <!-- ==================== APPENDIX A ==================== -->
    <h1 id="appa" class="page-start">Appendix A: Physical Testbed Attestation &amp; Bench Evidence</h1>
    <p>
        In systems and networking research involving LLM agents, reviewers rightly ask whether reported hardware numbers come from real silicon or from mocked/simulated interfaces. In addition to enforcing cryptographic SHA-256 provenance sidecars (<code>npm run check:provenance</code>) on every JSON and PCAP artifact in <code>docs/benchmarks/results/</code>, we include below physical bench photographs of the Zodiac testbed as wired during the Track A, Track B, and Track C campaigns.
    </p>

    <div class="photo-grid">
        <div class="photo-card">
            <img src="{PHOTO_STACK}" alt="NVIDIA Jetson Orin Nano Super (ROBOCO) beside the 3-switch stack">
            <div class="photo-caption">
                <strong>Plate A1 — Controller &amp; Three-Switch Vertical Stack:</strong> On the left is the <strong>NVIDIA Jetson Orin Nano Super</strong> (in the black ROBOCO enclosure with integrated OLED status display showing live Ampere CUDA telemetry at <code>49.5°C</code>). On the right is the 3-tier switch stack: <strong>Zodiac FX DUT</strong> at the bottom (black chassis with USB serial control link), <strong>NETGEAR GS105Ev2 #1</strong> (Workload &amp; <code>O1</code> mirror) in the middle, and <strong>NETGEAR GS105Ev2 #2</strong> (Uplink &amp; <code>O3</code> mirror) on top.
            </div>
        </div>
        <div class="photo-card">
            <img src="{PHOTO_WIRING}" alt="Front port wiring of the 3-switch stack and Raspberry Pi workload/sensor nodes">
            <div class="photo-caption">
                <strong>Plate A2 — Front-Panel Port Wiring &amp; Workload/Sensor Nodes:</strong> Front view showing the active link/activity LEDs and color-coded Cat6 cabling across GS105Ev2 #2 (top), GS105Ev2 #1 (middle, yellow workload/mirror boots), and the Zodiac FX (bottom), alongside the heatsunk <strong>Raspberry Pi 3B+</strong> workload/adversary nodes and the <strong>Raspberry Pi 5 + Hailo-8 NPU</strong> sensor node in the foreground.
            </div>
        </div>
    </div>

    <h2>A.1 Mapping Physical Bench Cabling to Figure 2</h2>
    <ul>
        <li><strong>Bottom Chassis (Northbound Networks Zodiac FX, Firmware 0.86):</strong> Sits at the base of the three-switch stack. Its micro-USB CDC ACM serial port connects to the Jetson Orin Nano Super for out-of-band register telemetry and firmware verification, while RJ45 Ports 1–3 carry OpenFlow VLAN 100 data-plane traffic and Port 4 carries Native VLAN 200 OpenFlow 1.3 TCP control (<code>10.0.1.99:6633</code>).</li>
        <li><strong>Middle Switch (NETGEAR GS105Ev2 #1, <code>192.168.0.239</code>):</strong> Yellow-booted patch cords connect the untrusted <code>10.0.2.0/24</code> Raspberry Pi hosts (Ports 1, 3, 4) to Port 5 (uplink to Zodiac FX Port 1), while Port 2 outputs the hardware port mirror (<code>O1</code>) in isolated 802.1Q VLAN 2 to the Raspberry Pi 5's secondary USB-GbE capture interface (<code>eth1</code>).</li>
        <li><strong>Top Switch (NETGEAR GS105Ev2 #2, <code>192.168.0.240</code>):</strong> Terminates Zodiac FX Port 2 on Port 4 (VLAN 2) and mirrors all ingress/egress frames to Port 3 (<code>O3</code>, isolated VLAN 3), which feeds directly into the Jetson Orin Nano Super's dedicated USB 3.0 GbE capture interface (<code>enx9c69d39ddcc0</code>).</li>
        <li><strong>Excluded Peripheral Note:</strong> Any external desktop display dock visible on the broader workbench is strictly workstation display peripheral equipment and is not part of the Zodiac network topology, data plane, or control plane.</li>
    </ul>

    <h2>A.2 Reproducibility Commands</h2>
    <p>
        Every claim, verifier property, and hardware artifact in this whitepaper can be reproduced and audited directly from the repository:
    </p>
    <div class="equation-box" style="font-size:8.2pt;line-height:1.5;">
        $ npm test &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# Run all unit &amp; invariant suites (A1-A11, cost model, envelope)<br>
        $ npm run check:provenance &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# Verify SHA-256 sidecars for all hardware benchmark artifacts<br>
        $ npx tsx scripts/conformance-harness.ts --help &nbsp;# Run Track B 3-vantage-point wire conformance<br>
        $ python3 scripts/build-zodiac-whitepaper.py &nbsp;&nbsp;&nbsp;&nbsp;# Rebuild this vector PDF whitepaper
    </div>

</div>

</body>
</html>
"""


def find_chrome() -> str:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "google-chrome",
        "chromium",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError("Could not find Google Chrome or Chromium binary.")


def render_pdf(html_content: str, pdf_path: Path) -> None:
    HTML_OUT.write_text(html_content, encoding="utf-8")
    chrome_bin = find_chrome()
    cmd = [
        chrome_bin,
        "--headless",
        "--disable-gpu",
        f"--print-to-pdf={pdf_path.resolve()}",
        "--no-pdf-header-footer",
        HTML_OUT.resolve().as_uri(),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def detect_toc_pages(pdf_path: Path) -> dict[str, int]:
    """Scan rendered PDF pages (1-indexed) to find exact page numbers for each section heading."""
    doc = fitz.open(str(pdf_path))
    markers = {
        "exec": "Executive Summary",
        "sec1": "1. Introduction & Research Thesis",
        "sec1_1": "1.1 Why Constrained Hardware Exposes Agent Failure Modes",
        "sec1_2": "1.2 Summary of Contributions Across Tracks A, B, and C",
        "sec2": "2. Physical Testbed Architecture & Topology Breakdown",
        "sec2_1": "2.1 Three-Tier Switch Stack & Compute/Sensor Nodes",
        "sec2_2": "2.2 Port-by-Port Wiring, 802.1Q VLAN Isolation",
        "sec2_3": "2.3 Host Interface Hygiene & 1G-to-100M Speed-Step",
        "sec3": "3. Track A: Deterministic Flow-Table Verifier & Cost Model",
        "sec3_1": "3.1 The Eleven Verifier Properties (A1",
        "sec3_2": "3.2 Precedence-Aware Conflict Detection (A4)",
        "sec3_3": "3.3 Priority-0 Firmware Quirk, Action Readback",
        "sec3_4": "3.4 Deployed-Table Cost Equation (A8)",
        "sec4": "4. Track A: Agent Policy Synthesis",
        "sec4_1": "4.1 Three Hosting Tiers: Local Edge, Rented A100",
        "sec4_2": "4.2 Twelve-Model Cloud Pilot & Safety Refusal Findings",
        "sec5": "5. Track B: Hardware Characterization & On-Wire Conformance",
        "sec5_1": "5.1 128-Rule-Set Differential Conformance Campaign",
        "sec5_2": "5.2 Finding F1: Why Controller-State Verification",
        "sec5_3": "5.3 Physical Reality Gaps Across Conformance",
        "sec6": "6. Track C: Live Red-Team Adversary & Quarantine Envelope",
        "sec6_1": "6.1 Consolidated Hardware Red-Team Matrix",
        "sec6_2": "6.2 Pre-Approved Quarantine Envelope & Anti-Steering",
        "sec7": "7. Scope Boundaries, Threats to Validity",
        "refs": "References",
        "appa": "Appendix A: Physical Testbed Attestation",
    }
    found: dict[str, int] = {}
    # Start scanning from page index 3 (Page 4, after Cover + Gov + TOC page)
    for page_idx in range(3, len(doc)):
        text = " ".join(doc[page_idx].get_text("text").split())
        for key, needle in markers.items():
            if key not in found and needle in text:
                found[key] = page_idx + 1
    doc.close()
    return found


def stamp_headers_and_footers(raw_pdf: Path, final_pdf: Path) -> int:
    """Stamp crisp vector running headers and page numbers on content pages (Page 4+) using GoogleSansText-Medium."""
    doc = fitz.open(str(raw_pdf))
    font_file = str((FONT_DIR / "GoogleSansText-Medium.ttf").resolve())
    total_pages = len(doc)

    for i in range(3, total_pages):
        page = doc[i]
        page.insert_font(fontname="GSTMed", fontfile=font_file)
        # Running header on top right
        header_text = "Zodiac: Real-Hardware Testbed & Verifier for Agent-Proposed SDN Policy"
        hw = fitz.get_text_length(header_text, fontname="helv", fontsize=8.0)
        page.insert_text(
            fitz.Point(612 - 54 - hw, 34),
            header_text,
            fontname="GSTMed",
            fontsize=8.0,
            color=(0.45, 0.47, 0.49),
        )
        # Thin header separator line
        page.draw_line(
            fitz.Point(54, 40),
            fitz.Point(612 - 54, 40),
            color=(0.85, 0.86, 0.88),
            width=0.5,
        )
        # Running footer: repo provenance on left, page number on right
        footer_left = "gravity-tpu/agentic-era-networking · v3.0 (November 2026)"
        page.insert_text(
            fitz.Point(54, 792 - 30),
            footer_left,
            fontname="GSTMed",
            fontsize=8.0,
            color=(0.55, 0.57, 0.59),
        )
        num_str = f"{i + 1}"
        nw = fitz.get_text_length(num_str, fontname="helv", fontsize=8.5)
        page.insert_text(
            fitz.Point(612 - 54 - nw, 792 - 30),
            num_str,
            fontname="GSTMed",
            fontsize=8.5,
            color=(0.37, 0.39, 0.41),
        )

    doc.save(str(final_pdf), garbage=4, deflate=True)
    doc.close()
    return total_pages


def verify_zero_type3_fonts(pdf_path: Path) -> None:
    """Assert that 0 Type3 bitmap fonts exist anywhere in the generated PDF."""
    doc = fitz.open(str(pdf_path))
    type3_pages = []
    for idx, page in enumerate(doc):
        for f in page.get_fonts():
            # f is (xref, ext, fonttype, basefont, name, encoding)
            if f[2] == "Type3":
                type3_pages.append((idx + 1, f))
    doc.close()
    if type3_pages:
        raise RuntimeError(f"Found rasterized Type3 bitmap fonts on pages: {type3_pages}")


def main() -> None:
    print("Pass 1: Rendering initial PDF for Table of Contents page detection...")
    html_pass1 = generate_html()
    render_pdf(html_pass1, PDF_RAW)
    toc_pages = detect_toc_pages(PDF_RAW)
    print("Detected section pages:", toc_pages)

    print("Pass 2: Rendering PDF with exact Table of Contents page numbers...")
    html_pass2 = generate_html(toc_pages)
    render_pdf(html_pass2, PDF_RAW)

    print("Pass 3: Stamping vector running headers & footers...")
    total_pages = stamp_headers_and_footers(PDF_RAW, PDF_FINAL)
    if PDF_RAW.exists():
        PDF_RAW.unlink()
    if HTML_OUT.exists():
        HTML_OUT.unlink()

    verify_zero_type3_fonts(PDF_FINAL)
    print(f"SUCCESS: Generated {PDF_FINAL} ({total_pages} pages, 0 Type3 bitmap fonts).")


if __name__ == "__main__":
    main()
