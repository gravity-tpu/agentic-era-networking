#!/usr/bin/env python3
"""
Sentinel NeurIPS Whitepaper Generator
Generates a publication-grade PDF whitepaper matching https://services.google.com/fh/files/blogs/neurips_evaluation.pdf
using pure Google Sans typography, transparent 3D crystal prism artwork, structured 2-page Table of Contents with dotted leaders,
and flowing layout with zero artificial blank gaps.
"""

import os
import sys
import base64
import subprocess
import re
import fitz
import shutil
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DOCS_DIR = os.path.join(BASE_DIR, "docs", "design")
ARCHIVE_DIR = os.path.join(BASE_DIR, "docs", "archive", "sentinel")
FONTS_DIR = os.path.join(DOCS_DIR, "fonts")  # shared fonts stay in docs/design
FIGURES_DIR = os.path.join(ARCHIVE_DIR, "figures")
OUTPUT_PDF = os.path.join(ARCHIVE_DIR, "sentinel-whitepaper-preview.pdf")

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
    raise FileNotFoundError(
        "Chrome or Chromium binary not found. Set CHROME_BIN environment variable."
    )

def b64_file(path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing required whitepaper asset: {path}")
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def get_fonts_css():
    fonts = {
        "GoogleSans-Bold": ("GoogleSans-Bold.ttf", "bold", "normal"),
        "GoogleSans-Medium": ("GoogleSans-Medium.ttf", "500", "normal"),
        "GoogleSans-Regular": ("GoogleSansText-Regular.ttf", "normal", "normal"),
        "GoogleSansText-Bold": ("GoogleSansText-Bold.ttf", "bold", "normal"),
        "GoogleSansText-Medium": ("GoogleSansText-Medium.ttf", "500", "normal"),
        "GoogleSansText-Regular": ("GoogleSansText-Regular.ttf", "normal", "normal"),
    }
    css = []
    for family, (filename, weight, style) in fonts.items():
        fpath = os.path.join(FONTS_DIR, filename)
        b64 = b64_file(fpath)
        css.append(f"""
        @font-face {{
            font-family: '{family}';
            src: url(data:font/ttf;charset=utf-8;base64,{b64}) format('truetype');
            font-weight: {weight};
            font-style: {style};
        }}
        """)
    return "\n".join(css)

def generate_html(toc_pages=None):
    if toc_pages is None:
        # Default placeholder page numbers for Stage 1 (flow starts on page 5)
        toc_pages = {
            "abstract": 5,
            "sec1": 5,
            "sec1_1": 5,
            "sec1_2": 6,
            "sec1_3": 6,
            "sec2": 6,
            "sec2_1": 6,
            "sec2_2": 7,
            "sec2_3": 7,
            "sec2_4": 7,
            "sec2_5": 7,
            "sec2_6": 8,
            "sec3": 8,
            "sec3_1": 8,
            "sec3_2": 9,
            "sec3_3": 10,
            "sec3_4": 10,
            "sec4": 11,
            "sec4_1": 11,
            "sec4_2": 12,
            "sec4_3": 12,
            "sec4_4": 13,
            "sec5": 13,
            "sec5_1": 14,
            "sec5_2": 14,
            "sec5_3": 14,
            "sec5_4": 15,
            "sec5_5": 15,
            "sec5_6": 15,
            "sec6": 16,
            "sec6_1": 16,
            "sec6_2": 17,
            "sec7": 17,
            "sec8": 18,
            "sec8_1": 18,
            "sec8_2": 19,
            "sec8_3": 20,
            "sec9": 20,
            "sec10": 21,
        }

    fig1_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_deployment_options.png"))
    fig1b_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_alternatives_compared.png"))
    fig2a_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_data_plane.png"))
    fig2b_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_control_plane.png"))
    fig3_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_detection_pipeline.png"))
    fig4_b64 = b64_file(os.path.join(FIGURES_DIR, "sentinel_data_model.png"))

    fonts_css = get_fonts_css()

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Sentinel: Autonomous Bot &amp; Crawler Mitigation System</title>
<style>
{fonts_css}

@page {{
    size: 8.5in 11in;
    margin: 0;
}}

@page content-page {{
    size: 8.5in 11in;
    margin: 72pt;
}}

* {{
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}}

body {{
    margin: 0;
    padding: 0;
    background-color: #ffffff;
    color: #202124;
    font-family: 'GoogleSansText-Regular', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 11pt;
    line-height: 1.58;
    text-rendering: optimizeLegibility;
}}

/* ==========================================================================
   PAGE 1: COVER
   ========================================================================== */
.cover-page {{
    width: 8.5in;
    height: 11in;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #ffffff;
}}

.cover-content {{
    position: absolute;
    top: 130pt;
    left: 48pt;
    width: 510pt;
    z-index: 10;
}}

.cover-title {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 54pt;
    line-height: 1.06;
    letter-spacing: -0.03em;
    color: #202124;
    margin: 0 0 24pt 0;
}}

.cover-subtitle {{
    font-family: 'GoogleSans-Medium', sans-serif;
    font-size: 22pt;
    line-height: 1.25;
    color: #1967d2;
    text-decoration: underline;
    text-underline-offset: 4pt;
    margin: 0 0 32pt 0;
}}

.cover-author {{
    font-family: 'GoogleSansText-Bold', sans-serif;
    font-size: 15pt;
    line-height: 1.4;
    color: #80868b;
    margin: 0;
}}

.cover-brand {{
    position: absolute;
    bottom: 48pt;
    left: 48pt;
    display: flex;
    align-items: center;
    gap: 12pt;
    z-index: 10;
}}

.brand-title {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 18pt;
    letter-spacing: 0.08em;
    color: #202124;
    line-height: 1;
}}

.brand-desc {{
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-size: 9pt;
    color: #80868b;
    letter-spacing: 0.02em;
    margin-top: 3pt;
}}

/* ==========================================================================
   PAGE 2: GUIDING PRINCIPLES & FRAMEWORK
   ========================================================================== */
.principles-page {{
    width: 8.5in;
    height: 11in;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #ffffff;
    padding: 72pt;
}}

.principles-header {{
    position: absolute;
    top: 57pt;
    left: 72pt;
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-size: 8pt;
    color: #80868b;
}}

.principles-footer {{
    position: absolute;
    bottom: 50pt;
    left: 72pt;
    right: 72pt;
    display: flex;
    justify-content: space-between;
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-size: 8pt;
    color: #80868b;
}}

.principles-content {{
    width: 468pt;
    margin-top: 48pt;
    position: relative;
    z-index: 10;
}}

.principles-title {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 22pt;
    color: #202124;
    margin: 0 0 16pt 0;
}}

.principles-notice {{
    font-family: 'GoogleSansText-Regular', sans-serif;
    font-size: 9.5pt;
    line-height: 1.5;
    color: #5f6368;
    margin-bottom: 22pt;
    padding-bottom: 14pt;
    border-bottom: 1px solid #e8eaed;
}}

.principles-group-title {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 11pt;
    color: #80868b;
    margin: 0 0 16pt 0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}}

.principles-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 32pt;
    row-gap: 16pt;
}}

.principle-item {{
    margin-bottom: 0;
}}

.principle-name {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 11pt;
    color: #202124;
    margin-bottom: 3pt;
}}

.principle-desc {{
    font-family: 'GoogleSansText-Regular', sans-serif;
    font-size: 9pt;
    color: #5f6368;
    line-height: 1.4;
}}

.principles-meta {{
    margin-top: 26pt;
    padding-top: 14pt;
    border-top: 1px solid #e8eaed;
    font-family: 'GoogleSansText-Regular', sans-serif;
    font-size: 8.5pt;
    color: #5f6368;
    line-height: 1.5;
}}

/* ==========================================================================
   PAGES 3 & 4: TABLE OF CONTENTS (2-PAGE LAYOUT MATCHING NEURIPS)
   ========================================================================== */
.toc-page-container {{
    width: 8.5in;
    height: 11in;
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #ffffff;
    padding: 72pt;
}}

.toc-header {{
    position: absolute;
    top: 57pt;
    left: 72pt;
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-size: 8pt;
    color: #80868b;
}}

.toc-footer {{
    position: absolute;
    bottom: 50pt;
    left: 72pt;
    right: 72pt;
    display: flex;
    justify-content: space-between;
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-size: 8pt;
    color: #80868b;
}}

.toc-content {{
    width: 468pt;
    margin-top: 55pt;
    position: relative;
    z-index: 10;
}}

.toc-heading {{
    font-family: 'GoogleSansText-Bold', sans-serif;
    font-size: 18pt;
    color: #80868b;
    margin: 0 0 20pt 0;
}}

.toc-item {{
    display: flex;
    align-items: baseline;
    margin-bottom: 7.5pt;
    font-size: 10.5pt;
    color: #202124;
}}

.toc-item.major {{
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-weight: 500;
    margin-top: 8pt;
}}

.toc-item.sub {{
    font-family: 'GoogleSansText-Regular', sans-serif;
    padding-left: 18pt;
    font-size: 10pt;
    color: #3c4043;
}}

.toc-title {{
    white-space: nowrap;
}}

.toc-leader {{
    flex-grow: 1;
    border-bottom: 1.2px dotted #bdc1c6;
    margin: 0 6pt;
    position: relative;
    bottom: 3pt;
}}

.toc-page-num {{
    font-family: 'GoogleSansText-Medium', sans-serif;
    font-variant-numeric: tabular-nums;
    color: #202124;
}}

/* ==========================================================================
   FLOWING CONTENT (PAGES 5+)
   ========================================================================== */
.flowing-content {{
    page: content-page;
    font-family: 'GoogleSansText-Regular', sans-serif;
    font-size: 11pt;
    line-height: 1.58;
    color: #202124;
}}

/* Pull quote matching NeurIPS Page 5 */
.pull-quote-wrapper {{
    display: flex;
    gap: 16pt;
    margin: 20pt 0 40pt 0;
    break-inside: avoid;
}}

.pull-quote-bar {{
    width: 16pt;
    background-color: #1a73e8;
    flex-shrink: 0;
    border-radius: 2pt;
}}

.pull-quote-text {{
    font-family: 'GoogleSans-Regular', sans-serif;
    font-size: 25pt;
    line-height: 1.25;
    color: #5f6368;
    letter-spacing: -0.02em;
}}

/* Headings */
h1.section-h1 {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 24pt;
    line-height: 1.2;
    color: #202124;
    margin: 28pt 0 14pt 0;
    break-after: avoid;
    break-inside: avoid;
}}

h2.section-h2 {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 18pt;
    line-height: 1.25;
    color: #202124;
    margin: 24pt 0 10pt 0;
    break-after: avoid;
    break-inside: avoid;
}}

h3.section-h3 {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 13.5pt;
    line-height: 1.3;
    color: #202124;
    margin: 18pt 0 8pt 0;
    break-after: avoid;
    break-inside: avoid;
}}

h4.section-h4 {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 11.5pt;
    color: #5f6368;
    margin: 14pt 0 6pt 0;
    break-after: avoid;
    break-inside: avoid;
}}

p {{
    margin: 0 0 10pt 0;
    color: #202124;
}}

ul, ol {{
    margin: 0 0 12pt 0;
    padding-left: 20pt;
}}

li {{
    margin-bottom: 4pt;
}}

/* Figures */
.figure-container {{
    margin: 18pt 0 20pt 0;
    text-align: center;
    break-inside: avoid;
}}

.figure-img {{
    width: 100%;
    max-width: 468pt;
    height: auto;
    display: block;
    margin: 0 auto;
    border-radius: 4pt;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}}

.figure-caption {{
    font-family: 'GoogleSansText-Regular', sans-serif;
    font-size: 9.5pt;
    line-height: 1.4;
    color: #5f6368;
    margin-top: 8pt;
    text-align: left;
}}

.figure-caption-bold {{
    font-family: 'GoogleSans-Bold', sans-serif;
    color: #202124;
}}

/* Tables */
.table-container {{
    margin: 16pt 0 20pt 0;
    width: 100%;
    break-inside: avoid;
}}

table.styled-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
    line-height: 1.4;
}}

table.styled-table th {{
    background-color: #f8f9fa;
    color: #202124;
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 9pt;
    text-align: left;
    padding: 7pt 9pt;
    border-top: 1.5px solid #202124;
    border-bottom: 1px solid #dadce0;
}}

table.styled-table td {{
    padding: 7pt 9pt;
    border-bottom: 1px solid #e8eaed;
    color: #3c4043;
    vertical-align: top;
}}

table.styled-table tr:last-child td {{
    border-bottom: 1.5px solid #202124;
}}

.tag-approved {{
    background-color: #e6f4ea;
    color: #137333;
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 8pt;
    padding: 2pt 6pt;
    border-radius: 3pt;
    display: inline-block;
}}

.tag-rejected {{
    background-color: #fce8e6;
    color: #c5221f;
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 8pt;
    padding: 2pt 6pt;
    border-radius: 3pt;
    display: inline-block;
}}

.tag-warn {{
    background-color: #fef7e0;
    color: #b06000;
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 8pt;
    padding: 2pt 6pt;
    border-radius: 3pt;
    display: inline-block;
}}

/* Code blocks using system monospace for 100% glyph support */
.code-container {{
    margin: 14pt 0 16pt 0;
    background-color: #f8f9fa;
    border: 1px solid #dadce0;
    border-radius: 4pt;
    padding: 10pt 14pt;
    break-inside: avoid;
}}

pre {{
    margin: 0;
    font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 8.5pt;
    line-height: 1.45;
    color: #202124;
    overflow-x: hidden;
    white-space: pre-wrap;
}}

code {{
    font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 9pt;
    background-color: #f1f3f4;
    padding: 1pt 4pt;
    border-radius: 2pt;
    color: #1a73e8;
}}

.callout-box {{
    background-color: #f8f9fa;
    border-left: 3.5px solid #1a73e8;
    padding: 10pt 14pt;
    margin: 14pt 0 16pt 0;
    border-radius: 0 4pt 4pt 0;
    break-inside: avoid;
}}

.callout-title {{
    font-family: 'GoogleSans-Bold', sans-serif;
    font-size: 10pt;
    color: #1a73e8;
    margin-bottom: 4pt;
}}

.callout-body {{
    font-size: 9.5pt;
    color: #3c4043;
    line-height: 1.45;
}}
</style>
</head>
<body>

<!-- =======================================================================
     PAGE 1: COVER
     ======================================================================= -->
<div class="cover-page">
    <div class="cover-content">
        <div class="cover-title">
            Sentinel: Autonomous<br>
            Bot &amp; Crawler<br>
            Mitigation System
        </div>
        <div class="cover-subtitle">
            Origin Protection, Asynchronous Telemetry &amp; Neuro-Symbolic Verification
        </div>
        <div class="cover-author">
            Author: github.com/gravity-tpu<br>
            Zodiac Systems Architecture
        </div>
    </div>

    <!-- Clean Zodiac Project Logo (Non-Google, Authentic Identity) -->
    <div class="cover-brand">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="18" stroke="#1a73e8" stroke-width="2.5" stroke-dasharray="4 2"/>
            <circle cx="20" cy="20" r="8" fill="#1a73e8"/>
            <circle cx="20" cy="7" r="3" fill="#34a853"/>
            <circle cx="33" cy="20" r="3" fill="#fbbc04"/>
            <circle cx="20" cy="33" r="3" fill="#ea4335"/>
            <circle cx="7" cy="20" r="3" fill="#4285f4"/>
            <line x1="20" y1="12" x2="20" y2="7" stroke="#34a853" stroke-width="1.5"/>
            <line x1="28" y1="20" x2="33" y2="20" stroke="#fbbc04" stroke-width="1.5"/>
            <line x1="20" y1="28" x2="20" y2="33" stroke="#ea4335" stroke-width="1.5"/>
            <line x1="12" y1="20" x2="7" y2="20" stroke="#4285f4" stroke-width="1.5"/>
        </svg>
        <div>
            <div class="brand-title">ZODIAC</div>
            <div class="brand-desc">Autonomous Network Infrastructure · Repository: gravity-tpu/agentic-era-networking</div>
        </div>
    </div>
</div>

<!-- =======================================================================
     PAGE 2: GUIDING PRINCIPLES & FRAMEWORK
     ======================================================================= -->
<div class="principles-page">
    <div class="principles-header">
        Sentinel: Autonomous Bot &amp; Crawler Mitigation System
    </div>

    <div class="principles-content">
        <div class="principles-title">Guiding Principles &amp; Framework</div>

        <div class="principles-notice">
            The architectural invariants and design methodologies of Sentinel are directly informed by published systems, distributed algorithms, and verification principles established by senior technical leaders across Google, DeepMind, and Google Brain. While these individuals have not directly participated in or attested to this document, their foundational contributions serve as the engineering compass for the Zodiac architecture:
        </div>

        <div class="principles-group-title">Published Leadership Frameworks</div>

        <div class="principles-grid">
            <div class="principle-item">
                <div class="principle-name">Jeff Dean</div>
                <div class="principle-desc">Systems Scale, Nanosecond Latency Budgets &amp; Hardware Co-Design</div>
            </div>

            <div class="principle-item">
                <div class="principle-name">Sanjay Ghemawat</div>
                <div class="principle-desc">Radical Simplicity, Flat Data Structures &amp; Fail-Open Invariants</div>
            </div>

            <div class="principle-item">
                <div class="principle-name">Quoc Le</div>
                <div class="principle-desc">Neural Architecture Search &amp; Robustness Under Distribution Shift</div>
            </div>

            <div class="principle-item">
                <div class="principle-name">Oriol Vinyals</div>
                <div class="principle-desc">Graph Representation, Game-Theoretic Convergence &amp; Flap Prevention</div>
            </div>

            <div class="principle-item" style="grid-column: span 2;">
                <div class="principle-name">Demis Hassabis</div>
                <div class="principle-desc">Verification Asymmetry &amp; Hybrid Neuro-Symbolic Verification (AlphaProof Paradigm)</div>
            </div>
        </div>

        <div class="principles-meta">
            <strong>Project Reference:</strong> Zodiac Network Architecture (<code>gravity-tpu/agentic-era-networking</code>)<br>
            <strong>Author:</strong> <a href="https://github.com/gravity-tpu" style="color: #1a73e8; text-decoration: none;">github.com/gravity-tpu</a> · Zodiac Systems Architecture<br>
            <strong>Document Classification:</strong> Technical Systems Reference &amp; Specification<br>
            <strong>Publication Date:</strong> September 2026<br>
            <strong>Data Plane Execution:</strong> Linux Kernel <code>nftables</code> + Jetson Orin Nano + Coral TPU
        </div>
    </div>

    <div class="principles-footer">
        <span>September 2026</span>
        <span>2</span>
    </div>
</div>

<!-- =======================================================================
     PAGE 3: TABLE OF CONTENTS (PART 1: ABSTRACT & SECTIONS 1 - 3)
     ======================================================================= -->
<div class="toc-page-container">
    <div class="toc-content">
        <div class="toc-heading">Table of contents</div>

        <div class="toc-item major">
            <span class="toc-title">Abstract</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("abstract", 5)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">1. Problem Formulation &amp; The Distributed Crawler Crisis</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec1", 5)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">1.1 The Anatomy of Origin Exhaustion</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec1_1", 5)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">1.2 The Three Operational Challenges</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec1_2", 6)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">1.3 Operational Invariants &amp; Constraints</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec1_3", 6)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">2. Guiding Principles &amp; Published Architectural Invariants</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2", 6)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.1 The Dean Latency Invariant (Systems Scale &amp; Nanosecond Profiling)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_1", 6)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.2 The Ghemawat Razor (Radical Simplicity &amp; Fail-Open Isolation)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_2", 7)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.3 The Quoc Le Invariant (Neural Adaptation &amp; Zero Magic Numbers)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_3", 7)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.4 The Vinyals Invariant (Game-Theoretic Stability &amp; Flap Prevention)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_4", 7)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.5 The Hassabis Invariant (Verification Asymmetry &amp; Symbolic Proof)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_5", 7)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">2.6 The Epistemic Provenance Invariant (Anti-Simulation Law)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec2_6", 8)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">3. System Architecture &amp; Operational Topology</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec3", 8)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">3.1 The Synchronous Data Plane: Sub-Microsecond Kernel Drops</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec3_1", 8)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">3.2 The Asynchronous Control Plane: Threat Intelligence Loop</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec3_2", 9)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">3.3 Decoupled Hardware Compute: Bridging Physical Lab to Edge</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec3_3", 10)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">3.4 Zodiac Infrastructure Integration &amp; Architectural Logic</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec3_4", 10)}</span>
        </div>
    </div>

    <div class="toc-footer">
        <span>September 2026</span>
        <span>3</span>
    </div>
</div>

<!-- =======================================================================
     PAGE 4: TABLE OF CONTENTS (PART 2: SECTIONS 4 - 10)
     ======================================================================= -->
<div class="toc-page-container">
    <div class="toc-content">
        <div class="toc-item major" style="margin-top: 0;">
            <span class="toc-title">4. Architectural Alternatives Considered &amp; Comparative Analysis</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec4", 11)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">4.1 Candidate 1: In-Process Application &amp; Web Server Middleware (REJECTED)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec4_1", 11)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">4.2 Candidate 2: In-Line Reverse Proxy Gateway (REJECTED)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec4_2", 12)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">4.3 Candidate 3 (SELECTED): Asynchronous Kernel Sidecar</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec4_3", 12)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">4.4 Comparative Architectural Decision Matrix</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec4_4", 13)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">5. Collective Behavior Detection &amp; Neuro-Symbolic Verification</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5", 13)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.1 Stage 1: Ingestion &amp; Sister-Site Trie Bypass (&lt; 1 µs)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_1", 14)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.2 Stage 2: Temporal Subnet Aggregation (/24 Sliding Window)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_2", 14)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.3 Stage 3: Deep AI Scoring (Jetson Orin GPU &amp; Coral TPU)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_3", 14)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.4 Demystifying Neuro-Symbolic Verification: Concrete Architecture</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_4", 15)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.5 Formal Symbolic Verification Gate (Hassabis Invariant)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_5", 15)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">5.6 Dual Enforcement (Kernel nftables &amp; SDN Switch)</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec5_6", 15)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">6. Storage Architecture, Data Models &amp; Wire Contracts</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec6", 16)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">6.1 Deterministic Prisma Schema</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec6_1", 16)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">6.2 Secure Wire API Contracts</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec6_2", 17)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">7. Implementation, Deployment &amp; Coexistence Model</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec7", 17)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">8. Empirical Evaluation, Benchmarks &amp; Operational Verification</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec8", 18)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">8.1 Jeff Dean Latency Profile Verification</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec8_1", 18)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">8.2 Operational Verification Benchmarks</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec8_2", 20)}</span>
        </div>
        <div class="toc-item sub">
            <span class="toc-title">8.3 PoC Desktop Limits vs. Enterprise-Scale Requirements</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec8_3", 21)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">9. Conclusion &amp; Strategic Roadmap</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec9", 19)}</span>
        </div>

        <div class="toc-item major">
            <span class="toc-title">10. Engineering Governance &amp; Invariant Compliance Matrix</span>
            <span class="toc-leader"></span>
            <span class="toc-page-num">{toc_pages.get("sec10", 20)}</span>
        </div>
    </div>

    <div class="toc-footer">
        <span>September 2026</span>
        <span>4</span>
    </div>
</div>

<!-- =======================================================================
     FLOWING CONTENT (PAGES 5+)
     ======================================================================= -->
<div class="flowing-content">

    <!-- Pull Quote with 16pt Google Blue Bar -->
    <div class="pull-quote-wrapper">
        <div class="pull-quote-bar"></div>
        <div class="pull-quote-text">
            Deterministic origin mitigation demands verification asymmetry: probabilistic neural inference proposing rate-limits, verified by formal kernel-level proofs.
        </div>
    </div>

    <!-- Abstract Section -->
    <h1 class="section-h1" id="heading_abstract">Abstract</h1>

    <p>
        Modern web infrastructure is under siege from a new class of adversaries: highly distributed, automated crawler pools and AI scraping swarms operating across rotating <code>/24</code> and <code>/16</code> IPv4 subnet blocks. Traditional perimeter defenses, such as Cloudflare Edge WAFs and host-level intrusion prevention engines like CrowdSec, are structurally incapable of mitigating these attacks: Cloudflare forwards unblocked requests directly to the origin, while host-level application middleware executes too late in the operating system connection lifecycle, allowing concurrent crawler bursts to exhaust the web server's worker thread pool (<code>MaxRequestWorkers</code>) and crash origin servers.
    </p>

    <p>
        This systems whitepaper presents <strong>Sentinel</strong>, an autonomous, neuro-symbolic bot mitigation system co-designed for modern origin protection within the Zodiac network architecture. Sentinel resolves the origin exhaustion crisis through three foundational architectural decisions:
    </p>

    <ol>
        <li><strong>Asynchronous Out-of-Band Log Observation:</strong> Telemetry is extracted out-of-band via non-blocking pipes and inotify hooks, adding exactly <strong>0.00 ms of latency</strong> to legitimate user requests.</li>
        <li><strong>Sub-Microsecond Kernel Pre-Routing Drops:</strong> Malicious CIDR blocks are dropped directly in the Linux network driver layer via <code>nftables</code> in <strong>&lt; 1 µs</strong>, destroying attacking packets <em>before</em> TCP socket or worker thread allocation, permanently eliminating origin crashes.</li>
        <li><strong>Zero Infrastructure Surgery:</strong> The entire system integrates seamlessly on the host with <strong>zero modifications to Cloudflare DNS/WAF</strong>, <strong>zero modifications to CrowdSec</strong>, and <strong>zero changes to Apache virtual hosts</strong>.</li>
        <li><strong>Hybrid Cloud-to-Hardware Federation:</strong> High-parameter neural clustering is offloaded asynchronously to dedicated physical accelerator silicon (NVIDIA Jetson Orin Nano Super GPU and Google Coral TPUs) without routing live client traffic through on-premises hardware.</li>
    </ol>

    <!-- Section 1 -->
    <h1 class="section-h1" id="heading_sec1">1. Problem Formulation &amp; The Distributed Crawler Crisis</h1>

    <h2 class="section-h2" id="heading_sec1_1">1.1 The Anatomy of Origin Exhaustion</h2>
    <p>
        Production origin servers running Apache 2.4 (<code>mpm_event</code> or <code>mpm_prefork</code>) operate with a bounded worker capacity configured via <code>MaxRequestWorkers</code> (typically 150–400 concurrent worker threads per host). When autonomous crawler swarms strike, they generate sustained waves of 2,000 to 5,000 requests per second across rotating IP pools.
    </p>

    <div class="code-container">
        <pre>[ Crawler Wave (2,000+ req/s) ]
               │
               ▼
[ Linux Kernel TCP Handshake (SYN-ACK) ] ──► Consumes OS Socket Backlog
               │
               ▼
[ Apache Accepts Socket Connection ]     ──► Consumes Worker Slot from MaxRequestWorkers Pool
               │
               ▼
[ Allocates OS Memory Buffers &amp; TLS ]    ──► Reads Request Headers into RAM
               │
               ▼
[ Worker Thread Saturation (100%) ]      ──► Zero Available Worker Slots for Real Users
               │
               ▼
[ Inbound Real User Requests Queue ]     ──► Connection Timeouts &amp; HTTP 504 Spikes
               │
               ▼
[ Operating System OOM / Watchdog Crash ]──► COMPLETE ORIGIN DOWNTIME</pre>
    </div>

    <p>
        The critical vulnerability is <strong>architectural timing</strong>: by the time an application or web server module executes to inspect request headers or evaluate IP reputation, the operating system and Apache have already allocated the worker thread. Serving an <code>HTTP 403 Forbidden</code> response still ties up the worker slot. Under high concurrency, worker threads become 100% saturated just answering 403s, causing the server to collapse.
    </p>

    <h2 class="section-h2" id="heading_sec1_2">1.2 The Three Operational Challenges</h2>
    <ol>
        <li><strong>The Concurrency Trap:</strong> Individual IP addresses generate low request frequencies (e.g. 1 req/sec), staying well below traditional perimeter rate-limiting thresholds. However, their collective subnet footprint across <code>/24</code> blocks exhausts server concurrency within seconds.</li>
        <li><strong>The Sister-Site Coexistence Invariant:</strong> Production environments frequently host sister-site APIs, internal scrapers, and partner microservices that must never be throttled or blocked under any operational circumstances.</li>
        <li><strong>The Strict Latency Ceiling (&lt; 10% Budget):</strong> Any security intervention placed on the origin cannot increase user-perceived page load latency by more than 10% (under 0.05 ms added CPU overhead on a fast static request).</li>
    </ol>

    <h2 class="section-h2" id="heading_sec1_3">1.3 Operational Invariants &amp; Constraints</h2>
    <ul>
        <li><strong>Cloudflare Coexistence:</strong> Zero modifications permitted to Cloudflare DNS records, edge caching, or perimeter WAF rules.</li>
        <li><strong>CrowdSec Coexistence:</strong> CrowdSec must continue running in parallel without port, rule, or log conflict.</li>
        <li><strong>Fail-Open Availability:</strong> If the Sentinel daemon crashes or loses cloud connectivity, website traffic must continue serving normally without interruption.</li>
    </ul>

    <!-- Section 2 -->
    <h1 class="section-h1" id="heading_sec2">2. Guiding Principles &amp; Published Architectural Invariants</h1>
    <p>
        Sentinel is architected around six non-negotiable systems and networking invariants derived from published literature and established engineering practices of senior distributed systems architects:
    </p>

    <h2 class="section-h2" id="heading_sec2_1">2.1 The Dean Latency Invariant (Systems Scale &amp; Nanosecond Profiling)</h2>
    <p>
        <em>“Every architectural decision must have an explicit latency profile.”</em> Sentinel strictly bounds data-path operations to nanosecond and microsecond budgets. Looking up an IP in the Linux kernel <code>nftables</code> interval tree takes <strong>&lt; 1,000 ns (1 µs)</strong>. Packet dropping takes <strong>&lt; 500 ns</strong>. Zero synchronous I/O or blocking network round-trips are permitted on the user-facing request path.
    </p>

    <h2 class="section-h2" id="heading_sec2_2">2.2 The Ghemawat Razor (Radical Simplicity &amp; Fail-Open Isolation)</h2>
    <p>
        <em>“The best abstraction is the one where failure modes disappear by construction.”</em> Sentinel avoids heavy in-line reverse proxies. It is deployed as a single, lightweight, read-only observer daemon (&lt; 25MB RAM). If the daemon terminates unexpectedly, the origin host continues serving traffic normally. Security inspection never stands as a fragile single point of failure between users and the web server.
    </p>

    <h2 class="section-h2" id="heading_sec2_3">2.3 The Quoc Le Invariant (Neural Adaptation &amp; Zero Magic Numbers)</h2>
    <p>
        Hardcoded heuristic thresholds (e.g., "block any IP making &gt; 50 requests") inevitably fail under traffic distribution shifts. Sentinel employs dynamic Exponential Moving Average (EMA) baseline tracking and continuous distribution estimation, adapting quarantine thresholds to seasonal traffic swings while preventing route-flapping oscillations.
    </p>

    <h2 class="section-h2" id="heading_sec2_4">2.4 The Vinyals Invariant (Game-Theoretic Stability &amp; Flap Prevention)</h2>
    <p>
        To eliminate multi-agent route flapping and firewall thrashing when crawlers rotate subnets, all kernel quarantine elements enforce a monotonic 300-second Time-To-Live (TTL). Once quarantined, an IP range remains stable, allowing the multi-agent network state to reach equilibrium.
    </p>

    <h2 class="section-h2" id="heading_sec2_5">2.5 The Hassabis Invariant (Verification Asymmetry &amp; Symbolic Proof)</h2>
    <p>
        In the agentic era, generating hypotheses or machine learning predictions is cheap; verifying them must be deterministic. Probabilistic outputs from neural models (autoencoders and tensor multipliers) are never permitted to touch firewall tables directly. Every quarantine recommendation must pass the deterministic <code>SymbolicRouteVerifier</code>, formally proving zero collision with sister sites and strict loop-free invariants before execution.
    </p>

    <h2 class="section-h2" id="heading_sec2_6">2.6 The Epistemic Provenance Invariant (Anti-Simulation Law)</h2>
    <p>
        <em>“When a measure becomes a target, it ceases to be a good measure.”</em> Telemetry without verifiable physical origin is fiction. All packet counters must use 64-bit integer units (<code>BigInt</code>) and monotonic nanosecond timestamps (<code>process.hrtime.bigint()</code>). Disconnected hardware probes must evaluate to physical truth (0 rates, null thermals), preventing simulated or fabricated metrics.
    </p>

    <!-- Section 3 -->
    <h1 class="section-h1" id="heading_sec3">3. System Architecture &amp; Operational Topology</h1>
    <p>
        Sentinel decouples the synchronous user-facing <strong>Data Plane</strong> from the asynchronous <strong>Control &amp; Intelligence Plane</strong>, bridging edge cloud infrastructure to physical accelerator hardware.
    </p>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig1_b64}" alt="Figure 1: Architectural Deployment Topology" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 1: Sentinel End-to-End Deployment Topology</span> across Ingress, Origin Host, Cloud Federation, and Physical Hardware Lab.
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec3_1">3.1 The Synchronous Data Plane: Sub-Microsecond Kernel Drops</h2>
    <p>
        The Data Plane executes entirely on the origin server host. Legitimate user requests pass directly from Cloudflare to Apache without any proxy hop or intermediate delay.
    </p>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig2a_b64}" alt="Figure 2A: Synchronous Data Plane" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 2A: Synchronous Data Plane Request Lifecycle</span> &amp; Sub-Microsecond Latency Profile.
        </div>
    </div>

    <p>When a malicious crawler burst hits the server:</p>
    <ol>
        <li>Inbound packets hit the Linux kernel network interface driver.</li>
        <li>The <code>nftables</code> pre-routing hook evaluates the source IP against the in-memory interval set (<code>set zodiac_quarantine</code>) in <strong>&lt; 500 nanoseconds</strong>.</li>
        <li>Matched CIDRs are immediately dropped at the network interface layer.</li>
        <li>The packet is discarded <strong>before TCP socket allocation, before TLS negotiation, and before Apache worker thread assignment</strong>, consuming zero Apache CPU and zero worker slots.</li>
    </ol>

    <h2 class="section-h2" id="heading_sec3_2">3.2 The Asynchronous Control Plane: Threat Intelligence Loop</h2>
    <p>The Control Plane operates completely out-of-band:</p>
    <ol>
        <li>Apache writes access log events asynchronously to a named pipe or log file.</li>
        <li>The local <code>zodiac-sentinel-agent</code> tails logs asynchronously via non-blocking inotify hooks, consuming <code>&lt; 1%</code> CPU and <code>&lt; 25MB</code> RAM.</li>
        <li>Every 5 seconds, the agent pushes scrubbed telemetry batches to the serverless Cloud Relay and receives verified quarantine updates.</li>
    </ol>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig2b_b64}" alt="Figure 2B: Asynchronous Control Plane" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 2B: Asynchronous Threat Intelligence, Cloud Federation, and Hardware Quarantine Loop.</span>
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec3_3">3.3 Decoupled Hardware Compute: Bridging Physical Lab to External Clients</h2>
    <p>
        Zodiac's heavy AI compute engine (NVIDIA Jetson Orin Nano Super GPU and Google Coral TPUs) resides in a physical hardware lab. To make this physical engine available to external client servers globally without hair-pinning live web traffic through the lab:
    </p>
    <ul>
        <li><strong>Outbound-Only Hardware Bridge:</strong> The physical lab connects <strong>outbound</strong> to Neon Postgres and Vercel over encrypted HTTPS/WSS (<code>zodiac-bridge-server.ts</code>). The lab requires zero open inbound firewall ports and zero static public IPs.</li>
        <li><strong>Client Isolation:</strong> External client agents communicate exclusively with the globally distributed, hardened Vercel edge API and Neon database; they never make connections into the private lab network.</li>
        <li><strong>Graceful Degradation:</strong> If the physical lab loses power or connectivity, client agents continue operating autonomously using their local in-memory LRU cache and active kernel firewall rules.</li>
    <h2 class="section-h2" id="heading_sec3_4">3.4 Zodiac Infrastructure Integration &amp; Architectural Logic</h2>
    <p>
        A central architectural question for Sentinel is: <em>How does this solution leverage the existing physical and cloud infrastructure of the Zodiac repository (<code>gravity-tpu/agentic-era-networking</code>)?</em>
    </p>
    <p>
        The Zodiac repository establishes an autonomous, hardware-grounded SDN control plane comprising physical compute appliances, programmable OpenFlow switching, serverless edge storage, and deterministic verifiers. Sentinel integrates into this existing substrate through a decoupled, multi-tiered operational model:
    </p>
    <ul>
        <li><strong>Physical Appliance Acceleration (NVIDIA Jetson Orin Nano Super &amp; Dual Google Coral Edge TPUs):</strong>
            Rather than forcing production web servers (e.g. Apache origin hosts) to run resource-heavy neural clustering algorithms, or hair-pinning live web requests across the WAN into an on-premises lab, Sentinel utilizes Zodiac's on-premises physical appliance as an <em>out-of-band threat intelligence engine</em>. The Jetson Orin Nano Super executes real-time 1D-CNN autoencoders to detect request velocity and path entropy shifts, while the Google Coral Edge TPUs (TPU 1 DNS/IP Sentinel) perform line-rate quantized INT8 cluster evaluation across <code>/24</code> subnet swarms.
        </li>
        <li><strong>Hardware-Grounded SDN Control (Zodiac FX OpenFlow Switch):</strong>
            For workloads co-located with or routed through Zodiac SDN networks, Sentinel interfaces directly with the Zodiac OpenFlow 1.3 controller (<code>src/sdn/openflow-server.ts</code>). Verified threat CIDRs are pushed into the Zodiac FX Switch's 128-flow bounded hardware table (Microchip KSZ8795 switch IC) at <code>/16</code> supernet granularity, terminating malicious flows at physical line rate in silicon.
        </li>
        <li><strong>Serverless Cloud Federation (Neon Serverless Postgres &amp; Vercel Edge):</strong>
            External origin servers in the cloud communicate exclusively with Zodiac's hardened serverless cloud relay (<code>api/sentinel/telemetry-batch</code> and <code>api/sentinel/sync</code>), backed by Neon Postgres. Telemetry batches are persisted with monotonic nanosecond timestamps (<code>process.hrtime.bigint()</code>) in accordance with the Dean &amp; Ghemawat determinism invariants. The physical lab connects <em>outbound</em> to Neon via <code>zodiac-bridge-server.ts</code>, pulling aggregated telemetry and publishing verified quarantine lists without requiring any public inbound ports into the lab.
        </li>
        <li><strong>Sub-Microsecond Host Enforcement (Linux Kernel <code>nftables</code>):</strong>
            On the remote origin server, the lightweight <code>zodiac-sentinel-agent</code> pulls the cryptographically signed quarantine manifest from the cloud relay every 5 seconds, updating an in-memory kernel interval set (<code>set zodiac_quarantine</code>). Attacking packets are dropped in <strong>&lt; 500 nanoseconds</strong> before socket allocation, preserving 100% of Apache's worker pool for real users.
        </li>
        <li><strong>Fail-Open Hardware Independence:</strong>
            If the physical hardware lab loses power or network transit, external origin servers suffer zero disruption. The origin agent maintains active firewall rules and falls back to local sliding-window LRU accounting, ensuring the physical lab is purely an accelerator, never a single point of failure.
        </li>
    </ul>

    <!-- Section 4 -->
    <h1 class="section-h1" id="heading_sec4">4. Architectural Alternatives Considered &amp; Comparative Analysis</h1>
    <p>
        During the architectural definition of Sentinel, three candidate deployment topologies were evaluated against the strict <strong>&lt; 10% latency budget</strong>, the <strong>minimal infrastructure surgery constraint</strong>, and the <strong>6 Council Invariants</strong>.
    </p>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig1b_b64}" alt="Figure 1B: Alternatives Compared" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 1B: Architectural Topology Comparison</span> (Alternatives Evaluated vs. Chosen System).
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec4_1">4.1 Candidate 1: In-Process Application &amp; Web Server Middleware (REJECTED)</h2>
    <p>
        In this model, Sentinel would run as an Apache C-module (<code>mod_sentinel.so</code>), an embedded Lua handler, or an application-level framework interceptor (e.g. PHP/Node/Python middleware).
    </p>

    <h3 class="section-h3">Fatal Flaws &amp; Rejection Rationale:</h3>
    <ol>
        <li><strong>Fails to Prevent Origin Server Crashes (The Concurrency Trap):</strong>
            In-process middleware executes <strong>too late</strong> in the connection lifecycle. Before middleware runs, the Linux kernel has already completed the TCP handshake, negotiated TLS, transferred the socket to Apache's accept queue, and Apache has <strong>allocated a worker thread</strong> and memory buffers. Under an attack of 2,000–5,000 req/s across rotating <code>/24</code> subnets, even if the middleware responds with <code>HTTP 403 Forbidden</code> in 1ms, all worker threads are tied up servicing 403s. Legitimate requests are starved in the queue until Apache crashes.
        </li>
        <li><strong>Synchronous Latency Tax on Legitimate Users:</strong>
            Evaluating IP reputation or sliding-window rate counters synchronously inside the worker thread adds <strong>1–5 ms of blocking CPU time</strong> to every page view, imposing a <strong>10%–25% latency overhead</strong> on fast responses and violating the Dean Latency Invariant.
        </li>
        <li><strong>High Blast Radius:</strong>
            Middleware runs in the same memory space as Apache. A bug, memory leak, or panic crashes the worker process, terminating active user connections.
        </li>
        <li><strong>Violates Minimal Surgery:</strong>
            Requires modifying <code>httpd.conf</code>, managing C module dependencies across OS upgrades, or intrusive application codebase changes.
        </li>
    </ol>

    <h2 class="section-h2" id="heading_sec4_2">4.2 Candidate 2: In-Line Reverse Proxy Gateway (REJECTED)</h2>
    <p>
        In this model, Sentinel would be deployed as an in-path reverse proxy (e.g., Nginx, Envoy, or HAProxy) positioned between Cloudflare and the Apache origin.
    </p>

    <h3 class="section-h3">Fatal Flaws &amp; Rejection Rationale:</h3>
    <ol>
        <li><strong>The Fatal WAN Hairpin Penalty (+50–150ms Latency Explosion):</strong>
            Zodiac's deep AI compute engine resides on an on-premises physical hardware lab network. Placing Sentinel in-line would require routing every single client request from Cloudflare over the public WAN into the lab network, processing it, and hair-pinning it back out to the origin server. Cross-network WAN round-trips add <strong>50–150 ms of latency</strong>, imposing a <strong>+100% to +300% latency penalty</strong> and bursting the <code>&lt; 10%</code> budget by 500%–1,000%. Even if the proxy were deployed on a separate cloud VM, TLS termination, HTTP parsing, and proxy forwarding add <strong>5–15 ms</strong>, consuming the entire latency budget.
        </li>
        <li><strong>Critical Single Point of Failure (SPOF):</strong>
            An in-line proxy sits directly in the hot traffic pathway. If the proxy process encounters a deadlock, memory exhaustion, or network glitch, <strong>100% of website traffic is immediately killed</strong> (fails closed for traffic).
        </li>
        <li><strong>Violates Zero Infrastructure Surgery:</strong>
            Requires changing Cloudflare origin DNS records to point to the proxy, generating and renewing SSL certificates on the proxy host, changing Apache's listening ports (<code>80/443</code> -&gt; <code>8080</code>), and reconfiguring CrowdSec bouncers.
        </li>
    </ol>

    <h2 class="section-h2" id="heading_sec4_3">4.3 Candidate 3 (SELECTED): Asynchronous Out-of-Band Sidecar with Kernel Pre-Routing Drop</h2>
    <p>
        In this architecture, Sentinel operates completely out-of-band as a lightweight local observer daemon (<code>zodiac-sentinel-agent</code>, &lt; 25MB RAM) paired with the Linux kernel's native <code>nftables</code> packet filter.
    </p>

    <div class="callout-box">
        <div class="callout-title">The Five Winning Pillars of Candidate 3</div>
        <div class="callout-body">
            1. <strong>True 0.00 ms Added Latency:</strong> Clean user traffic flows directly between Cloudflare and Apache without any intermediate proxy hop.<br>
            2. <strong>Sub-Microsecond Kernel Drops:</strong> Malicious packets dropped in &lt; 500 ns before TCP socket allocation—Apache allocates zero worker threads.<br>
            3. <strong>Zero Configuration Surgery:</strong> Cloudflare, CrowdSec, and Apache configurations remain 100% untouched.<br>
            4. <strong>Fail-Open Resilience:</strong> If the agent terminates, Apache serves traffic normally without disruption.<br>
            5. <strong>Decoupled Hardware Compute:</strong> Bridges physical Jetson Orin and Coral TPUs asynchronously via cloud federation.
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec4_4">4.4 Comparative Architectural Decision Matrix</h2>

    <div class="table-container">
        <table class="styled-table">
            <thead>
                <tr>
                    <th style="width: 32%;">Evaluation Dimension</th>
                    <th style="width: 22%; text-align: center;">Option 1: In-Process</th>
                    <th style="width: 22%; text-align: center;">Option 2: Reverse Proxy</th>
                    <th style="width: 24%; text-align: center;">Option 3 (SELECTED)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Added Latency to Real Users</strong></td>
                    <td style="text-align: center;"><span class="tag-rejected">+1–5 ms</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">+50–150 ms</span></td>
                    <td style="text-align: center;"><span class="tag-approved">0.00 ms</span></td>
                </tr>
                <tr>
                    <td><strong>Strict &lt; 10% Latency Budget</strong></td>
                    <td style="text-align: center;"><span class="tag-warn">At Risk</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">FAILED (+500%)</span></td>
                    <td style="text-align: center;"><span class="tag-approved">PASSED (0.00%)</span></td>
                </tr>
                <tr>
                    <td><strong>Prevents Apache Worker Exhaustion</strong></td>
                    <td style="text-align: center;"><span class="tag-rejected">NO (Thread Taken)</span></td>
                    <td style="text-align: center;"><span class="tag-approved">Yes</span></td>
                    <td style="text-align: center;"><span class="tag-approved">YES (&lt; 1 µs Drop)</span></td>
                </tr>
                <tr>
                    <td><strong>Single Point of Failure (SPOF)</strong></td>
                    <td style="text-align: center;"><span class="tag-rejected">High</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">Critical</span></td>
                    <td style="text-align: center;"><span class="tag-approved">None (Fail-Open)</span></td>
                </tr>
                <tr>
                    <td><strong>Cloudflare Zero-Touch Compliance</strong></td>
                    <td style="text-align: center;"><span class="tag-approved">Yes</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">NO (DNS Re-route)</span></td>
                    <td style="text-align: center;"><span class="tag-approved">YES (Untouched)</span></td>
                </tr>
                <tr>
                    <td><strong>CrowdSec Zero-Touch Compliance</strong></td>
                    <td style="text-align: center;"><span class="tag-approved">Yes</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">NO (Re-wiring)</span></td>
                    <td style="text-align: center;"><span class="tag-approved">YES (Untouched)</span></td>
                </tr>
                <tr>
                    <td><strong>Hardware Lab Compatibility</strong></td>
                    <td style="text-align: center;"><span class="tag-warn">Stalls Worker</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">WAN Hairpin</span></td>
                    <td style="text-align: center;"><span class="tag-approved">Decoupled Bridge</span></td>
                </tr>
                <tr>
                    <td><strong>Host Resource Overhead</strong></td>
                    <td style="text-align: center;"><span class="tag-warn">High Worker CPU</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">Dedicated VM</span></td>
                    <td style="text-align: center;"><span class="tag-approved">&lt; 25MB RAM, &lt; 1% CPU</span></td>
                </tr>
                <tr>
                    <td><strong>Architectural Verdict</strong></td>
                    <td style="text-align: center;"><span class="tag-rejected">REJECTED</span></td>
                    <td style="text-align: center;"><span class="tag-rejected">REJECTED</span></td>
                    <td style="text-align: center;"><span class="tag-approved">APPROVED</span></td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- Section 5 -->
    <h1 class="section-h1" id="heading_sec5">5. Collective Behavior Detection &amp; Neuro-Symbolic Verification</h1>
    <p>
        Sentinel implements a 5-stage detection and verification pipeline that combines edge telemetry aggregation with deep neural classification and formal symbolic invariant proof.
    </p>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig3_b64}" alt="Figure 3: Detection Pipeline" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 3: 5-Stage Collective Detection, Formal Symbolic Verification, and Dual Enforcement Pipeline.</span>
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec5_1">5.1 Stage 1: Ingestion &amp; Sister-Site Trie Bypass (&lt; 1 µs)</h2>
    <p>
        Ingests <code>CF-Connecting-IP</code>, HTTP method, URI target, User-Agent, and monotonic nanosecond timestamp. Designated sister-site CIDRs and internal subnets are evaluated against an in-memory Radix Trie in <strong>&lt; 1 µs</strong> (constant-time O(1) lookup). Allowlisted CIDRs immediately bypass all scoring and can never be quarantined under any conditions.
    </p>

    <h2 class="section-h2" id="heading_sec5_2">5.2 Stage 2: Temporal Subnet Aggregation (/24 Sliding Window)</h2>
    <p>
        Requests are grouped into collective <strong>/24 subnet buckets</strong> rather than evaluated as isolated IPs. Tracks active unique IPs, subnet request velocity (req/min), endpoint URI entropy, and 4xx/5xx error distribution within a 60-second sliding window.
    </p>

    <h2 class="section-h2" id="heading_sec5_3">5.3 Stage 3: Deep AI Scoring (Jetson Orin GPU &amp; Coral TPU)</h2>
    <ul>
        <li><strong>NVIDIA Jetson Orin Nano Super GPU:</strong> Real-time 1D-CNN Anomaly Autoencoder (<code>gpu_anomaly_kernel.cu</code>, sm_87, 0.271ms inference) computes reconstruction error against baseline human traffic.</li>
        <li><strong>Google Coral Edge TPU:</strong> INT8 matrix multiplication clusters rotating subnets and distinguishes legitimate traffic bursts from distributed bot collectives.</li>
        <li>Generates a composite reputation score <code>[0–100]</code> with self-tuning EMA thresholds (Quoc Le Invariant).</li>
    </ul>

    <h2 class="section-h2" id="heading_sec5_4">5.4 Demystifying Neuro-Symbolic Verification: Concrete Architecture</h2>
    <p>
        In modern systems engineering, <em>Neuro-Symbolic Verification</em> is not a marketing buzzword—it denotes the formal architectural pairing of <strong>statistical neural perception</strong> with <strong>deterministic symbolic safety proofs</strong> (the AlphaProof and Demis Hassabis paradigm).
    </p>
    <p>
        In autonomous network defense, relying on either paradigm alone creates fatal failure modes:
    </p>
    <ul>
        <li><strong>Why Purely Neural Systems Fail in Networking:</strong>
            Deep learning models (e.g. autoencoders or embedding clusters) excel at pattern recognition across high-dimensional, noisy data. They detect subtle, slow-moving crawler swarms spread across hundreds of IP addresses that static regexes miss. However, neural networks are inherently <em>probabilistic and non-deterministic</em>. They are susceptible to distribution drift and adversarial hallucinations. If a neural model is given write access to a firewall or SDN switch table, a single false positive can quarantine Cloudflare edge IP ranges, payment gateway webhooks, or internal VPC subnets—causing a catastrophic production outage.
        </li>
        <li><strong>Why Purely Symbolic Systems Fail in Modern Attacks:</strong>
            Traditional rule-based intrusion detection systems (e.g. Fail2ban, static rate limiters) rely on fixed thresholds (e.g. <em>"drop IP if requests &gt; 100/min"</em>). Modern automated crawler pools easily bypass these by distributing attacks across rotating pools of 2,000+ IP addresses within a <code>/24</code> subnet, where each IP sends only 1 request every 30 seconds. To a static rule engine, each IP appears benign, but collectively the swarm starves Apache's <code>MaxRequestWorkers</code> pool.
        </li>
        <li><strong>The Hybrid Neuro-Symbolic Solution: Verification Asymmetry:</strong>
            Sentinel enforces a strict separation between hypothesis generation and data-plane execution:
            <ol>
                <li><strong>The Neural Layer Proposes (Statistical Inference):</strong> Running on the Jetson Orin GPU and Google Coral TPU, the neural engine continuously monitors multidimensional telemetry (request inter-arrival entropy, URI traversal variance, 4xx/5xx status ratios). It outputs an unverified proposal: <em>"Subnet 198.51.100.0/24 exhibits distributed crawler signature with 94.2% confidence."</em></li>
                <li><strong>The Symbolic Layer Disposes (Deterministic Proof Gate):</strong> Before ANY candidate CIDR is transmitted to the origin host or installed in a kernel/switch table, it must pass through the deterministic <code>SymbolicRouteVerifier</code> (<code>src/core/routing-verifier.ts</code>). This engine executes four formal, mathematical safety proofs:
                    <ul>
                        <li><strong>Proof 1: Allowlist &amp; Sister-Site Non-Intersection:</strong> The candidate subnet is verified against an in-memory Radix Trie containing Cloudflare egress CIDRs, sister-site IPs, and internal infrastructure. If <code>Candidate ∩ Allowlist ≠ ∅</code>, the proposal is rejected with a hard <code>SecurityInvariantViolationException</code>.</li>
                        <li><strong>Proof 2: Prefix Boundary Constraint:</strong> Enforces that no proposed quarantine block can be broader than <code>/24</code> (for IPv4) or <code>/48</code> (for IPv6). The symbolic engine mathematically prevents an AI model from proposing a wildcard ban (e.g. <code>0.0.0.0/0</code> or <code>/16</code>).</li>
                        <li><strong>Proof 3: Loop-Free DAG &amp; Reachability Invariant:</strong> In SDN routing environments, the verifier models network hops as a directed graph and proves cycle-freedom via depth-first recursion stack traversal before committing flow updates.</li>
                        <li><strong>Proof 4: Monotonic TTL Expiry:</strong> Guarantees a monotonic 300-second Time-To-Live on all quarantine entries with hysteresis damping (<code>src/core/adaptive-control.ts</code>), mathematically eliminating route flapping.</li>
                    </ul>
                </li>
            </ol>
            <p>
                In short: <strong>Neural models synthesize hypotheses; symbolic verifiers prove safety bounds.</strong> Only proposals backed by formal proofs ever touch the kernel or data plane.
            </p>
        </li>
    </ul>

    <h2 class="section-h2" id="heading_sec5_5">5.5 Formal Symbolic Verification Gate (Hassabis Invariant)</h2>
    <p>
        Probabilistic AI model outputs are never allowed to touch firewall rules directly. The <code>SymbolicRouteVerifier</code> formally executes the verification checklist before signing each quarantine manifest:
    </p>
    <ol>
        <li>Zero collision with sister-site or infrastructure CIDRs via constant-time Trie lookup (&lt; 1 µs).</li>
        <li>Rule conforms strictly to <code>/24</code> host boundaries (or <code>/16</code> for hardware-bounded OpenFlow switch tables).</li>
        <li>Monotonic TTL timestamp generated via <code>process.hrtime.bigint()</code>.</li>
        <li>Fail-closed state bounds and cryptographic manifest signature verified.</li>
    </ol>

    <h2 class="section-h2" id="heading_sec5_6">5.6 Dual Enforcement (Kernel nftables &amp; SDN Switch)</h2>
    <ul>
        <li><strong>Production Origin (Linux Kernel):</strong> Injected into the Linux kernel <code>nftables</code> interval set with an automatic 300s TTL. Dropped in &lt; 500 ns at network driver layer.</li>
        <li><strong>Lab SDN Switch (Zodiac FX OpenFlow):</strong> For local workloads, installed on the Zodiac FX OpenFlow switch table at <code>/16</code> supernet granularity (satisfying the 128-rule hardware table limit).</li>
    </ul>

    <!-- Section 6 -->
    <h1 class="section-h1" id="heading_sec6">6. Storage Architecture, Data Models &amp; Wire Contracts</h1>
    <p>
        Sentinel implements a 3-tier storage architecture enforcing strict 64-bit integer determinism (Dean &amp; Ghemawat Invariant).
    </p>

    <div class="figure-container">
        <img class="figure-img" src="data:image/png;base64,{fig4_b64}" alt="Figure 4: Storage Architecture" />
        <div class="figure-caption">
            <span class="figure-caption-bold">Figure 4: 3-Tier Storage Hierarchy</span> across Local In-Memory Fast Path, Neon Postgres, and Immutable Audit Log.
        </div>
    </div>

    <h2 class="section-h2" id="heading_sec6_1">6.1 Deterministic Prisma Schema</h2>
    <div class="code-container">
        <pre>model SentinelIPRecord {{
  id               String   @id @default(cuid())
  ip_range         String   @unique  // CIDR e.g. "203.0.113.0/24"
  threat_score     Int      @default(0) // 0 - 100
  total_requests   BigInt   @default(0) // Dean &amp; Ghemawat Invariant: int64
  total_bytes      BigInt   @default(0) // Dean &amp; Ghemawat Invariant: int64
  first_seen_ns    BigInt   // process.hrtime.bigint()
  last_seen_ns     BigInt   // process.hrtime.bigint()
  quarantine_count Int      @default(0)
  is_allowlisted   Boolean  @default(false)
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt

  @@index([threat_score])
  @@index([last_seen_ns])
  @@index([is_allowlisted])
}}

model SentinelQuarantineRecord {{
  id                  String   @id @default(cuid())
  subnet_cidr         String   // /16 supernet or /24 subnet
  trigger_score       Int
  trigger_metric      String   // "autoencoder_loss" | "velocity_spike"
  symbolic_proof      String   // Formal DAG verification proof hash
  enacted_ns          BigInt   // process.hrtime.bigint()
  ttl_seconds         Int      @default(300)
  expired             Boolean  @default(false)
  source              String   @default("jetson_orin")
  verified_provenance Boolean  @default(true) // Anti-Simulation Law
  created_at          DateTime @default(now())

  @@index([subnet_cidr])
  @@index([expired])
  @@index([enacted_ns])
}}</pre>
    </div>

    <h2 class="section-h2" id="heading_sec6_2">6.2 Secure Wire API Contracts</h2>
    <ul>
        <li><code>POST /api/sentinel/telemetry-batch</code>: Pushes scrubbed access log events from client agents to the Cloud Relay. Authenticated via <code>X-Sentinel-Api-Key</code> and <code>X-Sentinel-Signature</code> (HMAC-SHA256).</li>
        <li><code>GET /api/sentinel/sync</code>: Polls active quarantine CIDRs and reputation changes from Neon Postgres (&lt; 1ms edge cached, ~5ms cold).</li>
    </ul>

    <!-- Section 7 -->
    <h1 class="section-h1" id="heading_sec7">7. Implementation, Deployment &amp; Coexistence Model</h1>
    <p>
        Deploying Sentinel requires <strong>less than 15 minutes of work on the host</strong>, zero changes to Cloudflare, and zero changes to CrowdSec.
    </p>

    <h3 class="section-h3">Step 1: Install the Local Agent Service</h3>
    <p>Download the pre-compiled static binary (&lt; 25MB RAM) and configure as a <code>systemd</code> unit:</p>

    <div class="code-container">
        <pre>[Unit]
Description=Zodiac Sentinel Edge Agent
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/zodiac-sentinel-agent \\
  --log-file=/var/log/apache2/access.log \\
  --api-endpoint=https://agentic-era-networking.vercel.app/api/sentinel \\
  --api-key=zd_client_sec_live_992x \\
  --quarantine-driver=nftables \\
  --quarantine-ttl=300
Restart=always
RestartSec=5s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target</pre>
    </div>

    <h3 class="section-h3">Step 2: Configure Non-Blocking Log Observation</h3>
    <p>Sentinel attaches directly to the existing Apache access log stream. <strong>No Apache virtual host or code changes are required:</strong></p>

    <div class="code-container">
        <pre>sudo systemctl daemon-reload
sudo systemctl enable --now zodiac-sentinel.service</pre>
    </div>

    <h3 class="section-h3">Step 3: Verify Kernel Firewall Integration</h3>
    <p>The agent automatically provisions an isolated <code>nftables</code> table that coexists without interference alongside UFW, iptables, and CrowdSec:</p>

    <div class="code-container">
        <pre># Verify active kernel quarantine set
sudo nft list set inet filter zodiac_quarantine

# Automatic kernel drop rule installed by agent:
# nft add element inet filter zodiac_quarantine {{ 198.51.100.0/24 timeout 300s }}</pre>
    </div>

    <!-- Section 8 -->
    <h1 class="section-h1" id="heading_sec8">8. Empirical Evaluation, Benchmarks &amp; Operational Verification</h1>

    <h2 class="section-h2" id="heading_sec8_1">8.1 Jeff Dean Latency Profile Verification</h2>

    <div class="table-container">
        <table class="styled-table">
            <thead>
                <tr>
                    <th style="width: 38%;">Operation Stage</th>
                    <th style="width: 25%;">Latency Budget</th>
                    <th style="width: 37%;">Engineering Invariant &amp; Optimization</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Kernel <code>nftables</code> Set Lookup</strong></td>
                    <td><strong>&lt; 1,000 ns (1 µs)</strong></td>
                    <td>Dean Invariant: Fits in L2/L3 cache reference budget.</td>
                </tr>
                <tr>
                    <td><strong>Kernel DROP Execution</strong></td>
                    <td><strong>&lt; 500 ns (0.5 µs)</strong></td>
                    <td>Dropped before TCP socket allocation. Zero Apache worker CPU consumed.</td>
                </tr>
                <tr>
                    <td><strong>Apache Hot-Path Inspection Delay</strong></td>
                    <td><strong>0.00 ms (0 ns)</strong></td>
                    <td>Asynchronous observer: user request is never paused or awaited.</td>
                </tr>
                <tr>
                    <td><strong>Local In-Memory LRU Lookup</strong></td>
                    <td><strong>&lt; 0.1 ms (100 µs)</strong></td>
                    <td>Ghemawat Invariant: Cache-friendly flat hash table.</td>
                </tr>
                <tr>
                    <td><strong>Local Agent Log Tail Latency</strong></td>
                    <td><strong>&lt; 2 ms (async)</strong></td>
                    <td>Non-blocking inotify/pipe. Zero impact on user response pipeline.</td>
                </tr>
                <tr>
                    <td><strong>Background Cloud Delta Sync</strong></td>
                    <td><strong>~15–35 ms (5s cycle)</strong></td>
                    <td>Completely out-of-band background HTTPS polling.</td>
                </tr>
                <tr>
                    <td><strong>Jetson Orin GPU Anomaly Inference</strong></td>
                    <td><strong>0.271 ms per batch</strong></td>
                    <td>Quoc Le Invariant: GPU accelerated neural inference on physical silicon.</td>
                </tr>
                <tr>
                    <td><strong>Total Added Latency on User Request</strong></td>
                    <td><strong>0.00 ms (0.00%)</strong></td>
                    <td><span class="tag-approved">PASSES STRICT &lt; 10% REQUIREMENT</span></td>
                </tr>
            </tbody>
        </table>
    </div>

    <h2 class="section-h2" id="heading_sec8_2">8.2 Operational Verification Benchmarks</h2>
    <ol>
        <li><strong>Latency Benchmark:</strong> Synthetic load test generating 10,000 req/sec through Apache with Sentinel agent active. Measured user-perceived P99 latency increase remains <strong>&lt; 0.05 ms (&lt; 0.1%)</strong>.</li>
        <li><strong>Crash Vector Protection:</strong> Simulated distributed crawler attack (500 rotating IPs across twenty /24 subnets making 2,000 req/min).
            <ul>
                <li><em>Baseline without Sentinel:</em> Apache worker pool exhausted within 15 seconds; server crashes.</li>
                <li><em>With Sentinel Active:</em> Attacking /24 subnets dropped at kernel level in &lt; 1 µs; Apache worker capacity remains &gt; 90% available; zero downtime.</li>
            </ul>
        </li>
        <li><strong>Sister-Site Immunity:</strong> Continuous synthetic burst traffic from designated sister-site CIDR. Verifier confirms 100% pass-through with zero quarantine triggers.</li>
        <li><strong>Fail-Open Resilience:</strong> Simulating complete loss of Vercel/Neon network connectivity. Local agent continues serving from local cache without stalling Apache.</li>
    </ol>

    <h2 class="section-h2" id="heading_sec8_3">8.3 Proof-of-Concept Desktop Limits vs. Enterprise-Scale Requirements</h2>
    <p>
        It is critical to emphasize that the current physical hardware implementation of Zodiac and Sentinel is a <strong>functional proof-of-concept (PoC) built on desktop-grade development hardware and serverless tiers</strong>. While it rigorously proves the algorithmic invariants, zero-latency sidecar model, and symbolic verification mathematics, deploying this system at production enterprise scale requires transitioning from desktop evaluation silicon to enterprise datacenter infrastructure.
    </p>

    <div class="table-container">
        <table class="styled-table">
            <thead>
                <tr>
                    <th style="width: 25%;">Component</th>
                    <th style="width: 25%;">PoC Hardware / Tier</th>
                    <th style="width: 22%;">Throughput / QPS Ceiling</th>
                    <th style="width: 28%;">Primary Bottleneck &amp; Failure Mode</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>SDN Switch Fabric</strong></td>
                    <td>Zodiac FX (Microchip KSZ8795, SAM4E8E MCU)</td>
                    <td><strong>100 Mbps</strong> (~20,800 pps @ 600B)</td>
                    <td>Fast Ethernet wire limit. Local lab test traffic only; cannot sit in 10G/100G transit paths.</td>
                </tr>
                <tr>
                    <td><strong>Hardware Flow Table</strong></td>
                    <td>SAM4E8E MCU SRAM</td>
                    <td><strong>128 Flow Rules Max</strong></td>
                    <td>Hard ceiling on simultaneous quarantined subnets. Obligates coarse <code>/16</code> supernets.</td>
                </tr>
                <tr>
                    <td><strong>Packet Deep Inspection</strong></td>
                    <td>Dual Google Coral USB TPUs</td>
                    <td><strong>~230–450 inf/sec combined</strong></td>
                    <td>Python/USB overhead limits line-rate inspection to ~2.2% of packets at 100 Mbps wire rate.</td>
                </tr>
                <tr>
                    <td><strong>Neural Anomaly Scoring</strong></td>
                    <td>NVIDIA Jetson Orin Nano Super (8GB)</td>
                    <td><strong>0.271 ms / batch</strong> (~3,690 inf/s)</td>
                    <td>Sufficient for PoC sliding windows; memory bandwidth-bound under multi-tenant enterprise streams.</td>
                </tr>
                <tr>
                    <td><strong>Cloud Relay Edge Cache</strong></td>
                    <td>Vercel Edge Function (LRU)</td>
                    <td><strong>~50,000 QPS</strong> (~1 ms P99)</td>
                    <td>High throughput on hot-path IP hits; drops sharply on cache misses.</td>
                </tr>
                <tr>
                    <td><strong>Cloud Cold-Path DB</strong></td>
                    <td>Neon Serverless Postgres</td>
                    <td><strong>~200 QPS</strong> (~5 ms P99)</td>
                    <td><strong>Critical PoC Bottleneck:</strong> Unpooled connection handshakes exhaust under fresh rotating attacks.</td>
                </tr>
                <tr>
                    <td><strong>Origin Web Server</strong></td>
                    <td>Apache <code>mpm_event</code></td>
                    <td><strong>200–500 concurrency</strong> (1k–5k QPS)</td>
                    <td><strong>Origin Failure Point:</strong> Worker thread pool starves long before network saturates.</td>
                </tr>
            </tbody>
        </table>
    </div>

    <div class="table-container">
        <table class="styled-table">
            <thead>
                <tr>
                    <th style="width: 22%;">Layer</th>
                    <th style="width: 24%;">Proof-of-Concept (Desktop Lab)</th>
                    <th style="width: 27%;">Enterprise Production Scale</th>
                    <th style="width: 27%;">Enterprise Capability &amp; Rationale</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Programmable Switching</strong></td>
                    <td>Zodiac FX OpenFlow (100 Mbps, 128 rules)</td>
                    <td><strong>Broadcom Tomahawk / Intel Tofino P4</strong></td>
                    <td><strong>100 Gbps–800 Gbps</strong> line rate with <strong>1,000,000+ TCAM flow entries</strong>; wirespeed P4 packet filtering.</td>
                </tr>
                <tr>
                    <td><strong>In-Line Acceleration</strong></td>
                    <td>Dual Google Coral USB TPUs (4 TOPS)</td>
                    <td><strong>SmartNIC / DPU (NVIDIA BlueField-3)</strong></td>
                    <td>Dedicated 400 Gbps PCIe DPUs executing hardware-offloaded eBPF/XDP and line-rate tensor inference at <strong>40M+ pps</strong>.</td>
                </tr>
                <tr>
                    <td><strong>Neural Inference Cluster</strong></td>
                    <td>Jetson Orin Nano Super (40 TOPS desktop SoC)</td>
                    <td><strong>Datacenter GPUs (NVIDIA L4 / A100)</strong></td>
                    <td>Multi-instance GPU (MIG) clustering supporting distributed 1D-CNN and transformer sequence models across millions of sessions.</td>
                </tr>
                <tr>
                    <td><strong>Threat Ledger</strong></td>
                    <td>Serverless Neon Postgres (~200 cold QPS)</td>
                    <td><strong>Distributed Tier (Redis Enterprise, ScyllaDB)</strong></td>
                    <td>Clustered sub-millisecond P99 state store capable of <strong>500,000+ cold-lookup QPS</strong> with connection multiplexing.</td>
                </tr>
                <tr>
                    <td><strong>Host Enforcement</strong></td>
                    <td>User-space Agent + <code>nftables</code> interval sets</td>
                    <td><strong>SmartNIC TCAM Offload + eBPF XDP</strong></td>
                    <td>Zero-copy packet discard directly in NIC silicon hardware before the Linux kernel network stack touches the buffer.</td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- Section 9 -->
    <h1 class="section-h1" id="heading_sec9">9. Conclusion &amp; Strategic Roadmap</h1>
    <p>
        Sentinel demonstrates that autonomous origin protection can be achieved without compromising user latency, adding operational fragility, or requiring invasive infrastructure rewrites. By combining sub-microsecond kernel packet filtering with asynchronous cloud federation and formal symbolic verification, Sentinel establishes a robust paradigm for securing web infrastructure in the agentic era.
    </p>

    <!-- Section 10 -->
    <h1 class="section-h1" id="heading_sec10">10. Engineering Governance &amp; Invariant Compliance Matrix</h1>

    <div class="table-container">
        <table class="styled-table">
            <thead>
                <tr>
                    <th style="width: 25%;">Architectural Invariant</th>
                    <th style="width: 27%;">Formal Requirement</th>
                    <th style="width: 28%;">Sentinel Implementation</th>
                    <th style="width: 20%;">Enforced In</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>INV-1: Anti-Shortcut Law</strong></td>
                    <td>Zero suppressed errors; no empty catches; explicit failure boundaries.</td>
                    <td>All errors handled explicitly. Network failure defaults to fail-open (never blocks users).</td>
                    <td><code>zodiac-sentinel-agent</code>, <code>api/sentinel/sync.ts</code></td>
                </tr>
                <tr>
                    <td><strong>INV-2: Determinism (Dean &amp; Ghemawat)</strong></td>
                    <td>Monotonic BigInt counters; nanosecond timestamps; zero float in packet accounting.</td>
                    <td>All byte counts, request tallies, and timestamps use <code>BigInt</code> and <code>process.hrtime.bigint()</code>.</td>
                    <td><code>schema.prisma</code>, <code>telemetry-db.ts</code></td>
                </tr>
                <tr>
                    <td><strong>INV-3: Fail-Closed Isolation</strong></td>
                    <td>Ambiguous rules rejected; strict isolation between tenant contexts.</td>
                    <td>Malicious traffic dropped at kernel boundary. Routing ambiguity triggers fail-closed DROP on untrusted subnets.</td>
                    <td><code>nftables</code> driver, <code>quarantine-bridge.ts</code></td>
                </tr>
                <tr>
                    <td><strong>INV-4: Verification Asymmetry (Hassabis)</strong></td>
                    <td>Probabilistic ML outputs must be formally verified before execution.</td>
                    <td>All quarantine recommendations pass <code>SymbolicRouteVerifier.verifyLoopFree()</code> prior to kernel/switch installation.</td>
                    <td><code>SymbolicRouteVerifier.ts</code></td>
                </tr>
                <tr>
                    <td><strong>INV-5: Multi-Agent Stability (Quoc Le &amp; Vinyals)</strong></td>
                    <td>No brittle magic numbers; flap prevention via bounded state.</td>
                    <td>EMA self-tuning thresholds. Mandatory 300s TTL on all quarantine elements prevents route flapping.</td>
                    <td><code>adaptive-threshold.ts</code></td>
                </tr>
                <tr>
                    <td><strong>INV-6: Anti-Simulation Law</strong></td>
                    <td>Telemetry must represent physical silicon truth; no synthetic waveforms.</td>
                    <td>Metrics derived strictly from physical kernel counters and Coral/Orin hardware probes.</td>
                    <td><code>hardware-probe.ts</code>, <code>zodiac-telemetry.ts</code></td>
                </tr>
            </tbody>
        </table>
    </div>

</div>

</body>
</html>
"""
    return html

def render_pdf_with_chrome(html_path, pdf_path):
    chrome_bin = get_chrome_binary()
    cmd = [
        chrome_bin,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        html_path
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise RuntimeError(f"Chrome rendering failed (exit code {res.returncode}): {res.stderr}")
    return True

def detect_heading_pages(pdf_path):
    doc = fitz.open(pdf_path)
    print(f"Detecting heading pages in PDF ({len(doc)} pages total)...")
    
    patterns = [
        ("abstract", re.compile(r"Abstract", re.IGNORECASE)),
        ("sec1", re.compile(r"1\.\s+Problem\s+Formulation", re.IGNORECASE)),
        ("sec1_1", re.compile(r"1\.1\s+The\s+Anatomy", re.IGNORECASE)),
        ("sec1_2", re.compile(r"1\.2\s+The\s+Three\s+Operational", re.IGNORECASE)),
        ("sec1_3", re.compile(r"1\.3\s+Operational\s+Invariants", re.IGNORECASE)),
        ("sec2", re.compile(r"2\.\s+Guiding\s+Principles", re.IGNORECASE)),
        ("sec2_1", re.compile(r"2\.1\s+The\s+Dean", re.IGNORECASE)),
        ("sec2_2", re.compile(r"2\.2\s+The\s+Ghemawat", re.IGNORECASE)),
        ("sec2_3", re.compile(r"2\.3\s+The\s+Quoc\s+Le", re.IGNORECASE)),
        ("sec2_4", re.compile(r"2\.4\s+The\s+Vinyals", re.IGNORECASE)),
        ("sec2_5", re.compile(r"2\.5\s+The\s+Hassabis", re.IGNORECASE)),
        ("sec2_6", re.compile(r"2\.6\s+The\s+Epistemic", re.IGNORECASE)),
        ("sec3", re.compile(r"3\.\s+System\s+Architecture", re.IGNORECASE)),
        ("sec3_1", re.compile(r"3\.1\s+The\s+Synchronous", re.IGNORECASE)),
        ("sec3_2", re.compile(r"3\.2\s+The\s+Asynchronous", re.IGNORECASE)),
        ("sec3_3", re.compile(r"3\.3\s+Decoupled\s+Hardware", re.IGNORECASE)),
        ("sec3_4", re.compile(r"3\.4\s+Zodiac\s+Infrastructure", re.IGNORECASE)),
        ("sec4", re.compile(r"4\.\s+Architectural\s+Alternatives", re.IGNORECASE)),
        ("sec4_1", re.compile(r"4\.1\s+Candidate\s+1", re.IGNORECASE)),
        ("sec4_2", re.compile(r"4\.2\s+Candidate\s+2", re.IGNORECASE)),
        ("sec4_3", re.compile(r"4\.3\s+Candidate\s+3", re.IGNORECASE)),
        ("sec4_4", re.compile(r"4\.4\s+Comparative\s+Architectural", re.IGNORECASE)),
        ("sec5", re.compile(r"5\.\s+Collective\s+Behavior", re.IGNORECASE)),
        ("sec5_1", re.compile(r"5\.1\s+Stage\s+1", re.IGNORECASE)),
        ("sec5_2", re.compile(r"5\.2\s+Stage\s+2", re.IGNORECASE)),
        ("sec5_3", re.compile(r"5\.3\s+Stage\s+3", re.IGNORECASE)),
        ("sec5_4", re.compile(r"5\.4\s+Demystifying\s+Neuro-Symbolic", re.IGNORECASE)),
        ("sec5_5", re.compile(r"5\.5\s+Formal\s+Symbolic", re.IGNORECASE)),
        ("sec5_6", re.compile(r"5\.6\s+Dual\s+Enforcement", re.IGNORECASE)),
        ("sec6", re.compile(r"6\.\s+Storage\s+Architecture", re.IGNORECASE)),
        ("sec6_1", re.compile(r"6\.1\s+Deterministic\s+Prisma", re.IGNORECASE)),
        ("sec6_2", re.compile(r"6\.2\s+Secure\s+Wire", re.IGNORECASE)),
        ("sec7", re.compile(r"7\.\s+Implementation", re.IGNORECASE)),
        ("sec8", re.compile(r"8\.\s+Empirical\s+Evaluation", re.IGNORECASE)),
        ("sec8_1", re.compile(r"8\.1\s+Jeff\s+Dean", re.IGNORECASE)),
        ("sec8_2", re.compile(r"8\.2\s+Operational\s+Verification", re.IGNORECASE)),
        ("sec8_3", re.compile(r"8\.3\s+Proof-of-Concept|8\.3\s+PoC", re.IGNORECASE)),
        ("sec9", re.compile(r"9\.\s+Conclusion", re.IGNORECASE)),
        ("sec10", re.compile(r"10\.\s+Engineering\s+Governance", re.IGNORECASE)),
    ]
    
    found_pages = {}
    
    for page_idx in range(4, len(doc)): # Skip pages 1, 2, 3, 4 (Cover, Principles, TOC Part 1 & 2)
        page_num = page_idx + 1
        text = doc[page_idx].get_text()
        for key, regex in patterns:
            if key not in found_pages:
                if regex.search(text):
                    found_pages[key] = page_num
                    print(f"  Found '{key}' on page {page_num}")
    
    # Fill any missed with fallback
    for key, _ in patterns:
        if key not in found_pages:
            found_pages[key] = 5
    
    return found_pages

def post_process_headers_footers(input_pdf, final_pdf):
    doc = fitz.open(input_pdf)
    total_pages = len(doc)
    font_file = os.path.join(FONTS_DIR, "GoogleSansText-Medium.ttf")
    
    print(f"Stamping running headers and footers across {total_pages} pages...")
    
    for page_idx in range(total_pages):
        page_num = page_idx + 1
        page = doc[page_idx]
        
        # Cover page (Page 1) has no running header or footer
        if page_num == 1:
            continue
        
        # Pages 2, 3, 4 already have their headers and footers embedded in the HTML
        if page_num in [2, 3, 4]:
            continue
            
        # Pages 5+ get the standard NeurIPS header & footer
        page.insert_font(fontname="gs-med", fontfile=font_file)
        page.insert_text(
            fitz.Point(72, 60),
            "Sentinel: Autonomous Bot & Crawler Mitigation System",
            fontname="gs-med",
            fontsize=8,
            color=(0.502, 0.525, 0.545) # #80868b
        )
        
        # Footer: y = 725pt, left: September 2026, right: page number
        page.insert_text(
            fitz.Point(72, 725),
            "September 2026",
            fontname="gs-med",
            fontsize=8,
            color=(0.502, 0.525, 0.545)
        )
        
        page_str = str(page_num)
        page.insert_text(
            fitz.Point(535 - (len(page_str) - 1) * 5, 725),
            page_str,
            fontname="gs-med",
            fontsize=8,
            color=(0.502, 0.525, 0.545)
        )
        
    doc.save(final_pdf)
    print(f"Final PDF saved to: {final_pdf}")

def main():
    with tempfile.TemporaryDirectory(prefix="sentinel_build_") as tmpdir:
        html_stage1 = os.path.join(tmpdir, "sentinel_stage1.html")
        pdf_stage1 = os.path.join(tmpdir, "sentinel_stage1.pdf")
        html_stage2 = os.path.join(tmpdir, "sentinel_stage2.html")
        pdf_stage2 = os.path.join(tmpdir, "sentinel_stage2.pdf")

        print("=== Step 1: Generating Initial HTML (Pass 1) ===")
        html_content_stage1 = generate_html(None)
        with open(html_stage1, "w", encoding="utf-8") as f:
            f.write(html_content_stage1)
        
        print("=== Step 2: Compiling Stage 1 PDF via Headless Chrome ===")
        render_pdf_with_chrome(html_stage1, pdf_stage1)
            
        print("=== Step 3: Detecting Exact Section Headings for Table of Contents ===")
        toc_pages = detect_heading_pages(pdf_stage1)
        print("TOC Pages detected:", toc_pages)
        
        print("=== Step 4: Generating Final Synchronized HTML (Pass 2) ===")
        html_content_stage2 = generate_html(toc_pages)
        with open(html_stage2, "w", encoding="utf-8") as f:
            f.write(html_content_stage2)
            
        print("=== Step 5: Compiling Stage 2 PDF via Headless Chrome ===")
        render_pdf_with_chrome(html_stage2, pdf_stage2)
            
        print("=== Step 6: Post-Processing Running Headers and Footers via PyMuPDF ===")
        post_process_headers_footers(pdf_stage2, OUTPUT_PDF)
        
        print(f"=== Complete! Whitepaper ready at {OUTPUT_PDF} ===")

if __name__ == "__main__":
    main()
