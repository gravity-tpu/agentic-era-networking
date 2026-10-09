#!/usr/bin/env python3
import os
import sys
import base64
import subprocess
import shutil
import tempfile

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

# Load PlusJakartaSans (Google Sans geometric twin) for complete unicode glyph coverage
font_path = "docs/design/fonts/PlusJakartaSans.ttf"
if not os.path.exists(font_path):
    raise FileNotFoundError(f"Missing required whitepaper font: {font_path}")
with open(font_path, "rb") as f:
    pjs_b64 = base64.b64encode(f.read()).decode("ascii")

HTML_FONT_HEAD = f"""
@font-face {{
  font-family: 'Google Sans';
  font-style: normal;
  font-weight: 400 800;
  src: url('data:font/ttf;base64,{pjs_b64}') format('truetype');
}}
@font-face {{
  font-family: 'Google Sans Text';
  font-style: normal;
  font-weight: 400 800;
  src: url('data:font/ttf;base64,{pjs_b64}') format('truetype');
}}
@font-face {{
  font-family: 'Roboto Mono';
  font-style: normal;
  font-weight: 400 700;
  src: local('Courier New'), local('Courier'), monospace;
}}
"""

SVG_FONT_STYLE = f"""
<style>
{HTML_FONT_HEAD}
text {{
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
}}
</style>
<defs>
  <filter id="card-shadow" x="-5%" y="-5%" width="110%" height="115%" filterUnits="userSpaceOnUse">
    <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000000" flood-opacity="0.08" />
  </filter>
  <filter id="node-shadow" x="-5%" y="-5%" width="110%" height="120%" filterUnits="userSpaceOnUse">
    <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.06" />
  </filter>
  <marker id="arrow-gray" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#5f6368" />
  </marker>
  <marker id="arrow-blue" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#1a73e8" />
  </marker>
  <marker id="arrow-green" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#137333" />
  </marker>
  <marker id="arrow-red" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#d93025" />
  </marker>
</defs>
"""

# ==============================================================================
# FIGURE 1: Sentinel Deployment Topology
# ==============================================================================
def generate_figure_1():
    width = 1200
    height = 560
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Architecture:</text>
<text x="200" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">End-to-End Hybrid Cloud &amp; Physical Lab Topology</text>
<text x="50" y="60" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Decoupled out-of-band observer · Sub-microsecond kernel pre-routing drop · Off-path accelerator co-processing</text>

<!-- 4 Vertical Container Columns across Left-to-Right -->

<!-- Column 1: Ingress Edge -->
<g transform="translate(50, 80)" filter="url(#card-shadow)">
  <rect width="240" height="420" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="240" height="36" rx="10" fill="#f8fafd"/>
  <rect y="26" width="240" height="10" fill="#f8fafd"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#1a73e8">1. INGRESS &amp; PERIMETER</text>
  
  <g transform="translate(15, 55)">
    <rect width="210" height="95" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.2"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#174ea6">Cloudflare Edge CDN</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Anycast L3/L4 DDoS shield</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Edge TLS termination</text>
    <text x="16" y="82" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Forwards CF-Connecting-IP</text>
  </g>
  
  <g transform="translate(15, 168)">
    <rect width="210" height="95" rx="8" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Zero Config Editing</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• DNS records untouched</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• WAF rules untouched</text>
    <text x="16" y="82" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Cloudflare caching intact</text>
  </g>
  
  <g transform="translate(15, 280)">
    <rect width="210" height="120" rx="8" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Traffic Classification</text>
    <text x="16" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#137333">✓ Real User Browsers</text>
    <text x="16" y="70" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#1a73e8">✓ Sister-Site APIs (Allowlist)</text>
    <text x="16" y="92" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#d93025">✗ Botnet &amp; Crawler Waves</text>
  </g>
</g>

<!-- Arrow: Ingress -> Host -->
<line x1="290" y1="185" x2="328" y2="185" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)"/>

<!-- Column 2: Origin Host Server -->
<g transform="translate(330, 80)" filter="url(#card-shadow)">
  <rect width="290" height="420" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="290" height="36" rx="10" fill="#e6f4ea"/>
  <rect y="26" width="290" height="10" fill="#e6f4ea"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#137333">2. ORIGIN HOST (MINIMAL FOOTPRINT)</text>
  
  <!-- Kernel Fast Path -->
  <g transform="translate(15, 55)">
    <rect width="260" height="90" rx="8" fill="#ffffff" stroke="#137333" stroke-width="1.5"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#137333">Linux Kernel nftables Hook</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#d93025">• Crawler DROP &lt; 500 ns (pre-socket)</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#137333">• Clean Pass &lt; 50 µs to TCP backlog</text>
    <text x="16" y="82" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">set zodiac_quarantine (300s TTL)</text>
  </g>
  
  <!-- Apache Origin Server -->
  <g transform="translate(15, 155)">
    <rect width="260" height="75" rx="8" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#202124">Apache 2.4 (mpm_event)</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#137333">• 0.00 ms Added Latency</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Zero worker thread exhaustion</text>
  </g>
  
  <!-- Sidecar Agent -->
  <g transform="translate(15, 240)">
    <rect width="260" height="85" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.2"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#174ea6">zodiac-sentinel-agent</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Non-blocking log tail (pipe/inotify)</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Lightweight sidecar: &lt; 25MB RAM</text>
    <text x="16" y="80" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#1a73e8">• Fail-open by construction</text>
  </g>
  
  <g transform="translate(15, 335)">
    <rect width="260" height="65" rx="8" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">CrowdSec Coexistence</text>
    <text x="16" y="42" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Runs untouched in parallel</text>
    <text x="16" y="58" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Zero port or table collision</text>
  </g>
</g>

<!-- Arrow: Host Agent -> Cloud Relay -->
<line x1="620" y1="320" x2="663" y2="320" stroke="#1a73e8" stroke-width="1.5" marker-end="url(#arrow-blue)"/>

<!-- Column 3: Cloud Federation Plane -->
<g transform="translate(665, 80)" filter="url(#card-shadow)">
  <rect width="240" height="420" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="240" height="36" rx="10" fill="#fef7e0"/>
  <rect y="26" width="240" height="10" fill="#fef7e0"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#b06000">3. CLOUD FEDERATION (SAAS)</text>
  
  <g transform="translate(15, 55)">
    <rect width="210" height="100" rx="8" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="28" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#202124">Vercel Serverless Edge</text>
    <text x="16" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Public API Gateway</text>
    <text x="16" y="66" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#1a73e8">/api/sentinel/sync</text>
    <text x="16" y="84" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Edge caching &amp; auth token</text>
  </g>
  
  <g transform="translate(15, 170)">
    <rect width="210" height="110" rx="8" fill="#fef7e0" stroke="#e8710a" stroke-width="1.2"/>
    <text x="16" y="28" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#b06000">Neon Postgres DB</text>
    <text x="16" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• PgBouncer connection pool</text>
    <text x="16" y="66" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• 64-bit BigInt packet counts</text>
    <text x="16" y="84" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Monotonic hrtime stamps</text>
    <text x="16" y="102" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• 30-day global reputation</text>
  </g>
  
  <g transform="translate(15, 295)">
    <rect width="210" height="105" rx="8" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="16" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Network Isolation</text>
    <text x="16" y="46" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• External clients only talk to</text>
    <text x="16" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">  hardened cloud relay.</text>
    <text x="16" y="82" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">• Hardware lab never exposed.</text>
  </g>
</g>

<!-- Arrow: Cloud Federation <-> Hardware Lab -->
<line x1="905" y1="225" x2="943" y2="225" stroke="#1a73e8" stroke-width="1.5" marker-end="url(#arrow-blue)"/>
<text x="924" y="215" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#1a73e8" text-anchor="middle">WSS</text>

<!-- Column 4: Physical Hardware Lab Acceleration -->
<g transform="translate(945, 80)" filter="url(#card-shadow)">
  <rect width="205" height="420" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="205" height="36" rx="10" fill="#f8fafd"/>
  <rect y="26" width="205" height="10" fill="#f8fafd"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#1a73e8">4. HARDWARE LAB</text>
  
  <g transform="translate(15, 55)">
    <rect width="175" height="85" rx="8" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
    <text x="14" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">NVIDIA Jetson Orin</text>
    <text x="14" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#174ea6">GPU Compute Engine:</text>
    <text x="14" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Anomaly Autoencoders</text>
    <text x="14" y="74" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#137333">• 0.271 ms batch inference</text>
  </g>
  
  <g transform="translate(15, 150)">
    <rect width="175" height="85" rx="8" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
    <text x="14" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Google Coral Edge TPU</text>
    <text x="14" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#174ea6">Tensor Co-Processor:</text>
    <text x="14" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• 4 TOPS INT8 matrix engine</text>
    <text x="14" y="74" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Fast /24 CIDR clustering</text>
  </g>
  
  <g transform="translate(15, 245)">
    <rect width="175" height="75" rx="8" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
    <text x="14" y="24" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Zodiac FX Switch</text>
    <text x="14" y="42" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• OpenFlow hardware drop</text>
    <text x="14" y="58" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• /16 supernet lab testbeds</text>
  </g>
  
  <g transform="translate(15, 330)">
    <rect width="175" height="70" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1"/>
    <text x="14" y="24" font-family="'Google Sans', sans-serif" font-size="11" font-weight="700" fill="#174ea6">Outbound Bridge</text>
    <text x="14" y="40" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Zero open inbound ports</text>
    <text x="14" y="56" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Zero lab public IP needed</text>
  </g>
</g>

<!-- Footer Invariant Banner -->
<g transform="translate(50, 515)">
  <rect width="1100" height="32" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />
  <text x="20" y="21" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#202124">Ghemawat Razor &amp; Fail-Open Invariant:</text>
  <text x="280" y="21" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">If cloud or hardware lab disconnects, origin server continues serving users with zero downtime.</text>
</g>

</svg>"""
    return svg

# ==============================================================================
# FIGURE 1B: Architectural Topology Comparison (Alternatives Evaluated vs Chosen)
# ==============================================================================
def generate_figure_1b():
    width = 1240
    height = 550
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Alternatives Evaluated:</text>
<text x="300" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">In-Line Proxy vs Hardware Appliance vs Sentinel</text>
<text x="50" y="60" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Council evaluation against nanosecond latency budgets, fail-open resilience, and operational invariants</text>

<!-- Option 1 Card: In-Line Origin Proxy -->
<g transform="translate(50, 80)" filter="url(#card-shadow)">
  <rect width="1140" height="122" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="1140" height="32" rx="10" fill="#f8f9fa" />
  <rect y="22" width="1140" height="10" fill="#f8f9fa" />
  
  <text x="20" y="21" font-family="'Google Sans', sans-serif" font-size="12.5" font-weight="700" fill="#5f6368">ALTERNATIVE 1: IN-LINE REVERSE PROXY (ENVOY / HAPROXY ON ORIGIN)</text>
  
  <rect x="975" y="6" width="150" height="20" rx="4" fill="#fce8e6"/>
  <text x="1050" y="20" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#c5221f" text-anchor="middle">REJECTED BY COUNCIL</text>
  
  <g transform="translate(20, 50)">
    <rect width="125" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="62" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Client Traffic</text>
    
    <line x1="125" y1="22" x2="158" y2="22" stroke="#5f6368" stroke-width="1.2" marker-end="url(#arrow-gray)"/>
    
    <rect x="165" width="135" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="232" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Cloudflare CDN</text>
    
    <line x1="300" y1="22" x2="333" y2="22" stroke="#5f6368" stroke-width="1.2" marker-end="url(#arrow-gray)"/>
    
    <rect x="340" width="190" height="44" rx="6" fill="#fce8e6" stroke="#d93025" stroke-width="1.2"/>
    <text x="435" y="20" font-family="'Google Sans', sans-serif" font-size="11" font-weight="700" fill="#c5221f" text-anchor="middle">In-Line Proxy Filter</text>
    <text x="435" y="35" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#d93025" text-anchor="middle">+2.0–8.0 ms Added Latency</text>
    
    <line x1="530" y1="22" x2="563" y2="22" stroke="#5f6368" stroke-width="1.2" marker-end="url(#arrow-gray)"/>
    
    <rect x="570" width="135" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="637" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Apache Origin</text>
    
    <text x="730" y="19" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#d93025">Fatal Flaws:</text>
    <text x="730" y="34" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">Violates Dean &lt; 10% latency budget. Heavy memory footprint (&gt; 200MB).</text>
    <text x="730" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">In-line proxy crash causes catastrophic origin-wide outage.</text>
  </g>
</g>

<!-- Option 2 Card: Physical Lab In-Line Appliance -->
<g transform="translate(50, 222)" filter="url(#card-shadow)">
  <rect width="1140" height="122" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="1140" height="32" rx="10" fill="#f8f9fa" />
  <rect y="22" width="1140" height="10" fill="#f8f9fa" />
  
  <text x="20" y="21" font-family="'Google Sans', sans-serif" font-size="12.5" font-weight="700" fill="#5f6368">ALTERNATIVE 2: PHYSICAL HARDWARE LAB IN-LINE APPLIANCE</text>
  
  <rect x="975" y="6" width="150" height="20" rx="4" fill="#fce8e6"/>
  <text x="1050" y="20" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#c5221f" text-anchor="middle">REJECTED BY COUNCIL</text>
  
  <g transform="translate(20, 50)">
    <rect width="125" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="62" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Client Traffic</text>
    
    <line x1="125" y1="22" x2="158" y2="22" stroke="#5f6368" stroke-width="1.2" marker-end="url(#arrow-gray)"/>
    
    <rect x="165" width="135" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="232" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Cloudflare CDN</text>
    
    <line x1="300" y1="22" x2="333" y2="22" stroke="#d93025" stroke-width="1.2" marker-end="url(#arrow-red)"/>
    
    <rect x="340" width="190" height="44" rx="6" fill="#fce8e6" stroke="#d93025" stroke-width="1.2"/>
    <text x="435" y="20" font-family="'Google Sans', sans-serif" font-size="11" font-weight="700" fill="#c5221f" text-anchor="middle">Lab WAN Hairpin Hop</text>
    <text x="435" y="35" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#d93025" text-anchor="middle">+80–150 ms WAN Roundtrip</text>
    
    <line x1="530" y1="22" x2="563" y2="22" stroke="#d93025" stroke-width="1.2" marker-end="url(#arrow-red)"/>
    
    <rect x="570" width="135" height="44" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="637" y="27" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Remote Origin</text>
    
    <text x="730" y="19" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#d93025">Fatal Flaws:</text>
    <text x="730" y="34" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">Catastrophic latency degradation (WAN roundtrip). Lab residential ISP</text>
    <text x="730" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#5f6368">lacks enterprise SLA. Unviable for geographically dispersed origins.</text>
  </g>
</g>

<!-- Option 3 Card: Chosen Sentinel System -->
<g transform="translate(50, 364)" filter="url(#card-shadow)">
  <rect width="1140" height="150" rx="10" fill="#ffffff" stroke="#137333" stroke-width="1.5"/>
  <rect width="1140" height="34" rx="10" fill="#e6f4ea" />
  <rect y="24" width="1140" height="10" fill="#e6f4ea" />
  
  <text x="20" y="22" font-family="'Google Sans', sans-serif" font-size="12.5" font-weight="700" fill="#137333">CHOSEN: ASYNCHRONOUS OBSERVER + KERNEL PRE-ROUTING DROP (SENTINEL)</text>
  
  <rect x="975" y="7" width="150" height="20" rx="4" fill="#ceead6"/>
  <text x="1050" y="21" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#0d652d" text-anchor="middle">ADOPTED BY COUNCIL</text>
  
  <g transform="translate(20, 52)">
    <rect width="125" height="46" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="62" y="28" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Client Traffic</text>
    
    <line x1="125" y1="23" x2="158" y2="23" stroke="#5f6368" stroke-width="1.2" marker-end="url(#arrow-gray)"/>
    
    <rect x="165" width="135" height="46" rx="6" fill="#ffffff" stroke="#80868b" stroke-width="1"/>
    <text x="232" y="28" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#202124" text-anchor="middle">Cloudflare CDN</text>
    
    <line x1="300" y1="23" x2="333" y2="23" stroke="#137333" stroke-width="1.5" marker-end="url(#arrow-green)"/>
    
    <rect x="340" width="190" height="46" rx="6" fill="#e6f4ea" stroke="#137333" stroke-width="1.5"/>
    <text x="435" y="21" font-family="'Google Sans', sans-serif" font-size="11" font-weight="700" fill="#137333" text-anchor="middle">Kernel nftables Hook</text>
    <text x="435" y="36" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#137333" text-anchor="middle">&lt; 1 µs Drop · 0.00 ms Added Latency</text>
    
    <line x1="530" y1="23" x2="563" y2="23" stroke="#137333" stroke-width="1.5" marker-end="url(#arrow-green)"/>
    
    <rect x="570" width="135" height="46" rx="6" fill="#ffffff" stroke="#137333" stroke-width="1.2"/>
    <text x="637" y="28" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#137333" text-anchor="middle">Apache (Protected)</text>
    
    <text x="730" y="19" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#137333">Council Invariant Compliance:</text>
    <text x="730" y="34" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#202124">Zero user-perceived hot-path latency. Pre-socket drop destroys crawler bursts</text>
    <text x="730" y="48" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="400" fill="#202124">before worker thread allocation. Fail-open availability by construction.</text>
  </g>
  
  <text x="20" y="132" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#1a73e8">Decoupled Out-of-Band Sidecar: Apache Log ──► Local Agent (&lt; 25MB RAM) ──► Cloud Relay (Vercel/Neon) ◄──► Physical Hardware Lab</text>
</g>

</svg>"""
    return svg

# ==============================================================================
# FIGURE 2A: Data Plane LR Workflow (Modelled directly after Figure 2 & 4)
# ==============================================================================
def generate_figure_2a():
    width = 1200
    height = 430
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Data Plane:</text>
<text x="185" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">Synchronous Request &amp; Sub-Microsecond Kernel Decision</text>
<text x="50" y="66" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Pure Left-to-Right data path · 0.00 ms added latency to clean users · Pre-socket kernel drop for crawler bursts</text>

<!-- Left Inbound: Client Request -->
<g transform="translate(50, 180)" filter="url(#node-shadow)">
  <rect width="170" height="74" rx="8" fill="#ffffff" stroke="#5f6368" stroke-width="1.5"/>
  <text x="85" y="34" font-family="'Google Sans', sans-serif" font-size="15" font-weight="700" fill="#202124" text-anchor="middle">Client Traffic</text>
  <text x="85" y="53" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368" text-anchor="middle">Legitimate &amp; Crawlers</text>
</g>

<!-- Arrow: Client -> Cloudflare -->
<line x1="220" y1="217" x2="265" y2="217" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)" />
<text x="242" y="205" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#5f6368" text-anchor="middle">HTTPS</text>

<!-- Stage 1: Cloudflare Edge -->
<g transform="translate(270, 180)" filter="url(#node-shadow)">
  <rect width="180" height="74" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.5"/>
  <text x="90" y="34" font-family="'Google Sans', sans-serif" font-size="15" font-weight="700" fill="#174ea6" text-anchor="middle">Cloudflare Edge</text>
  <text x="90" y="53" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#1a73e8" text-anchor="middle">TLS + CF-Connecting-IP</text>
</g>

<!-- Arrow: Cloudflare -> Kernel Hook -->
<line x1="450" y1="217" x2="535" y2="217" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)" />
<text x="492" y="205" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#5f6368" text-anchor="middle">Origin WAN</text>

<!-- Stage 2: Linux Kernel nftables Pre-Routing Hook -->
<g transform="translate(545, 172)" filter="url(#node-shadow)">
  <rect width="215" height="90" rx="8" fill="#ffffff" stroke="#1a73e8" stroke-width="2"/>
  <text x="107" y="32" font-family="'Google Sans', sans-serif" font-size="15" font-weight="700" fill="#202124" text-anchor="middle">Kernel nftables Hook</text>
  <text x="107" y="52" font-family="'Roboto Mono', monospace" font-size="11" font-weight="400" fill="#1a73e8" text-anchor="middle">set zodiac_quarantine</text>
  <text x="107" y="72" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#137333" text-anchor="middle">Lookup: &lt; 1,000 ns (1 µs)</text>
</g>

<!-- Upper Branch: Quarantined CIDR -> Kernel DROP -->
<path d="M 760 195 L 820 195 L 820 130 L 845 130" fill="none" stroke="#d93025" stroke-width="1.5" marker-end="url(#arrow-red)" />
<text x="765" y="155" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#d93025">Threat Match</text>

<g transform="translate(850, 95)" filter="url(#node-shadow)">
  <rect width="300" height="70" rx="8" fill="#fce8e6" stroke="#d93025" stroke-width="1.5"/>
  <text x="150" y="30" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#c5221f" text-anchor="middle">Kernel Packet DROP (&lt; 500 ns)</text>
  <text x="150" y="50" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#d93025" text-anchor="middle">Zero TCP socket · Zero Apache worker CPU</text>
</g>

<!-- Lower Branch: Clean Traffic -> Pass to Apache Origin -->
<path d="M 760 240 L 820 240 L 820 305 L 845 305" fill="none" stroke="#137333" stroke-width="1.5" marker-end="url(#arrow-green)" />
<text x="765" y="280" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#137333">Clean Traffic</text>

<g transform="translate(850, 270)" filter="url(#node-shadow)">
  <rect width="300" height="70" rx="8" fill="#e6f4ea" stroke="#137333" stroke-width="1.5"/>
  <text x="150" y="30" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#137333" text-anchor="middle">Forward to Apache (mpm_event)</text>
  <text x="150" y="50" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#137333" text-anchor="middle">0.00 ms Added Inspection Latency</text>
</g>

<!-- Bottom Council Invariant Box -->
<g transform="translate(50, 370)">
  <rect width="1100" height="34" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />
  <text x="20" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#202124">Dean Latency Invariant:</text>
  <text x="175" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">Kernel lookup (&lt; 1 µs) fits entirely within CPU cache reference budget. Hot path is 100% non-blocking.</text>
</g>

</svg>"""
    return svg

# ==============================================================================
# FIGURE 2B: Control Plane LR Workflow
# ==============================================================================
def generate_figure_2b():
    width = 1200
    height = 430
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Control Plane:</text>
<text x="210" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">Asynchronous Threat Intelligence &amp; Hardware Loop</text>
<text x="50" y="66" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Decoupled out-of-band telemetry · Cloud relay state store · Physical hardware acceleration</text>

<!-- Node 1: Apache Access Event -->
<g transform="translate(50, 150)" filter="url(#node-shadow)">
  <rect width="170" height="74" rx="8" fill="#ffffff" stroke="#5f6368" stroke-width="1.5"/>
  <text x="85" y="32" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#202124" text-anchor="middle">Apache Access Log</text>
  <text x="85" y="51" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368" text-anchor="middle">Non-blocking named pipe</text>
</g>

<!-- Arrow: Apache -> Agent -->
<line x1="220" y1="187" x2="270" y2="187" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)" />
<text x="245" y="175" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#5f6368" text-anchor="middle">inotify</text>

<!-- Node 2: Local Sentinel Agent -->
<g transform="translate(275, 150)" filter="url(#node-shadow)">
  <rect width="180" height="74" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.5"/>
  <text x="90" y="32" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#174ea6" text-anchor="middle">Sentinel Agent</text>
  <text x="90" y="51" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#1a73e8" text-anchor="middle">&lt; 25MB RAM · 5s Batches</text>
</g>

<!-- Arrow: Agent -> Cloud Relay -->
<line x1="455" y1="187" x2="510" y2="187" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)" />
<text x="482" y="175" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#5f6368" text-anchor="middle">HTTPS</text>

<!-- Node 3: Cloud Federation (Vercel + Neon) -->
<g transform="translate(505, 142)" filter="url(#node-shadow)">
  <rect width="180" height="90" rx="8" fill="#fef7e0" stroke="#e8710a" stroke-width="1.5"/>
  <text x="90" y="30" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#b06000" text-anchor="middle">Cloud Federation</text>
  <text x="90" y="49" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#202124" text-anchor="middle">Vercel Edge API Relay</text>
  <text x="90" y="67" font-family="'Roboto Mono', monospace" font-size="10.5" font-weight="400" fill="#e8710a" text-anchor="middle">Neon Postgres DB</text>
</g>

<!-- Arrow: Cloud -> Hardware Lab -->
<line x1="685" y1="187" x2="760" y2="187" stroke="#1a73e8" stroke-width="1.5" marker-end="url(#arrow-blue)" />
<text x="722" y="173" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#1a73e8" text-anchor="middle">Outbound</text>

<!-- Node 4: Hardware Lab Engine -->
<g transform="translate(768, 142)" filter="url(#node-shadow)">
  <rect width="200" height="90" rx="8" fill="#e8f0fe" stroke="#1a73e8" stroke-width="1.5" stroke-dasharray="6,4"/>
  <text x="100" y="30" font-family="'Google Sans', sans-serif" font-size="14" font-weight="700" fill="#174ea6" text-anchor="middle">Physical Hardware Lab</text>
  <text x="100" y="49" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#202124" text-anchor="middle">Jetson Orin GPU (0.27ms)</text>
  <text x="100" y="67" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#1a73e8" text-anchor="middle">Coral TPU INT8 Multiplier</text>
</g>

<!-- Arrow: Hardware Lab -> Symbolic Verifier -->
<line x1="960" y1="187" x2="1010" y2="187" stroke="#137333" stroke-width="1.5" marker-end="url(#arrow-green)" />
<text x="985" y="173" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#137333" text-anchor="middle">Score</text>

<!-- Node 5: Symbolic Proof Gate -->
<g transform="translate(1015, 150)" filter="url(#node-shadow)">
  <rect width="145" height="74" rx="8" fill="#e6f4ea" stroke="#137333" stroke-width="1.5"/>
  <text x="72" y="32" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#137333" text-anchor="middle">Proof Gate</text>
  <text x="72" y="51" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#137333" text-anchor="middle">Loop-Free Check</text>
</g>

<!-- Feedback Loop: Verifier Back to Host nftables via Cloud Relay -->
<path d="M 1087 224 L 1087 305 L 365 305 L 365 228" fill="none" stroke="#1a73e8" stroke-width="1.5" stroke-dasharray="6,4" marker-end="url(#arrow-blue)" />
<text x="727" y="295" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#1a73e8" text-anchor="middle">Verified Quarantine Sync (Every 5s) · Injects /24 CIDRs into Kernel with 300s TTL</text>

<!-- Council Invariant Annotation Box -->
<g transform="translate(50, 365)">
  <rect width="1110" height="34" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />
  <text x="20" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#202124">Hassabis Verification Asymmetry:</text>
  <text x="245" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">AI outputs are probabilistic and cheap; verification is deterministic and symbolic before kernel execution.</text>
</g>

</svg>"""
    return svg

# ==============================================================================
# FIGURE 3: 5-Stage Detection & Verification Pipeline
# ==============================================================================
def generate_figure_3():
    width = 1200
    height = 540
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Detection Pipeline:</text>
<text x="255" y="38" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">5-Stage Collective Detection &amp; Quarantine Pipeline</text>
<text x="50" y="60" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Multi-Agent collective analysis · Symbolic verification gate (AlphaProof paradigm) · Dual enforcement</text>

<!-- 5 Columns across Left-to-Right -->

<!-- Stage 1 -->
<g transform="translate(50, 80)" filter="url(#card-shadow)">
  <rect width="195" height="400" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="195" height="34" rx="10" fill="#e8f0fe"/>
  <rect y="24" width="195" height="10" fill="#e8f0fe"/>
  <text x="14" y="23" font-family="'Google Sans', sans-serif" font-size="11.5" font-weight="700" fill="#1a73e8">STAGE 1: INGESTION</text>
  
  <text x="14" y="60" font-family="'Google Sans', sans-serif" font-size="13.5" font-weight="700" fill="#202124">Signal Ingestion</text>
  <text x="14" y="78" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#1a73e8">Latency: &lt; 1 µs</text>
  
  <rect x="12" y="95" width="171" height="145" rx="6" fill="#f8fafd" stroke="#dadce0" stroke-width="1"/>
  <text x="20" y="118" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Extracts Request Tuple:</text>
  <text x="20" y="138" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• CF-Connecting-IP</text>
  <text x="20" y="156" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• User-Agent header</text>
  <text x="20" y="174" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• URI target &amp; method</text>
  <text x="20" y="192" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• High-res timestamp</text>
  <text x="20" y="218" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#137333">Sister-Site Trie Bypass</text>
  
  <g transform="translate(12, 255)">
    <rect width="171" height="130" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="12" y="24" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Ghemawat Invariant:</text>
    <text x="12" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">Zero-allocation parser</text>
    <text x="12" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">with strict length and</text>
    <text x="12" y="76" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">memory bounds.</text>
  </g>
</g>

<!-- Arrow 1 -> 2 -->
<line x1="245" y1="240" x2="275" y2="240" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)"/>

<!-- Stage 2 -->
<g transform="translate(280, 80)" filter="url(#card-shadow)">
  <rect width="195" height="400" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="195" height="34" rx="10" fill="#fef7e0"/>
  <rect y="24" width="195" height="10" fill="#fef7e0"/>
  <text x="14" y="23" font-family="'Google Sans', sans-serif" font-size="11.5" font-weight="700" fill="#e8710a">STAGE 2: AGGREGATION</text>
  
  <text x="14" y="60" font-family="'Google Sans', sans-serif" font-size="13.5" font-weight="700" fill="#202124">Temporal Subnets</text>
  <text x="14" y="78" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#e8710a">Window: 60s · /24 Subnet</text>
  
  <rect x="12" y="95" width="171" height="145" rx="6" fill="#fefcf5" stroke="#dadce0" stroke-width="1"/>
  <text x="20" y="118" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Subnet Vector Features:</text>
  <text x="20" y="138" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Unique IPs in /24 block</text>
  <text x="20" y="156" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Aggregate req/min velocity</text>
  <text x="20" y="174" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Path entropy (crawling)</text>
  <text x="20" y="192" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• 404 / 500 error ratio</text>
  <text x="20" y="218" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#b06000">Dynamic EMA Baseline</text>
  
  <g transform="translate(12, 255)">
    <rect width="171" height="130" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="12" y="24" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Vinyals Invariant:</text>
    <text x="12" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">The collective subnet</text>
    <text x="12" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">is the signal;</text>
    <text x="12" y="76" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">individual IPs are noise.</text>
  </g>
</g>

<!-- Arrow 2 -> 3 -->
<line x1="475" y1="240" x2="505" y2="240" stroke="#5f6368" stroke-width="1.5" marker-end="url(#arrow-gray)"/>

<!-- Stage 3 -->
<g transform="translate(510, 80)" filter="url(#card-shadow)">
  <rect width="195" height="400" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="195" height="34" rx="10" fill="#e8f0fe"/>
  <rect y="24" width="195" height="10" fill="#e8f0fe"/>
  <text x="14" y="23" font-family="'Google Sans', sans-serif" font-size="11.5" font-weight="700" fill="#1a73e8">STAGE 3: DEEP BRAIN</text>
  
  <text x="14" y="60" font-family="'Google Sans', sans-serif" font-size="13.5" font-weight="700" fill="#202124">Neural Scoring</text>
  <text x="14" y="78" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#1a73e8">Jetson GPU &amp; Coral TPU</text>
  
  <rect x="12" y="95" width="171" height="145" rx="6" fill="#f8fafd" stroke="#dadce0" stroke-width="1"/>
  <text x="20" y="118" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Parallel Inference:</text>
  <text x="20" y="138" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Jetson Orin Nano GPU:</text>
  <text x="20" y="154" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#174ea6">  Anomaly Autoencoder</text>
  <text x="20" y="174" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Google Coral Edge TPU:</text>
  <text x="20" y="190" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="500" fill="#1a73e8">  4 TOPS INT8 Matrix</text>
  <text x="20" y="218" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#1a73e8">Reputation: 0 – 100</text>
  
  <g transform="translate(12, 255)">
    <rect width="171" height="130" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="12" y="24" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Quoc Le Invariant:</text>
    <text x="12" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">Continuous distribution</text>
    <text x="12" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">learning; zero brittle</text>
    <text x="12" y="76" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">magic numbers.</text>
  </g>
</g>

<!-- Arrow 3 -> 4 -->
<line x1="705" y1="240" x2="735" y2="240" stroke="#137333" stroke-width="1.5" marker-end="url(#arrow-green)"/>

<!-- Stage 4 -->
<g transform="translate(740, 80)" filter="url(#card-shadow)">
  <rect width="195" height="400" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="195" height="34" rx="10" fill="#e6f4ea"/>
  <rect y="24" width="195" height="10" fill="#e6f4ea"/>
  <text x="14" y="23" font-family="'Google Sans', sans-serif" font-size="11.5" font-weight="700" fill="#137333">STAGE 4: VERIFICATION</text>
  
  <text x="14" y="60" font-family="'Google Sans', sans-serif" font-size="13.5" font-weight="700" fill="#202124">Symbolic Proof Gate</text>
  <text x="14" y="78" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#137333">Proof Time: &lt; 0.1 ms</text>
  
  <rect x="12" y="95" width="171" height="145" rx="6" fill="#f0faf2" stroke="#137333" stroke-width="1"/>
  <text x="20" y="118" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#137333">SymbolicRouteVerifier:</text>
  <text x="20" y="138" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Formally proves zero</text>
  <text x="20" y="152" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">  blackholing of sister sites</text>
  <text x="20" y="170" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Proves loop-free routing</text>
  <text x="20" y="188" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Enforces 300s TTL bound</text>
  <text x="20" y="218" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#137333">Cryptographic Signature</text>
  
  <g transform="translate(12, 255)">
    <rect width="171" height="130" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="12" y="24" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Hassabis Invariant:</text>
    <text x="12" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">Probabilistic models are</text>
    <text x="12" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">cheap; verification must</text>
    <text x="12" y="76" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">be formal &amp; deterministic.</text>
  </g>
</g>

<!-- Arrow 4 -> 5 -->
<line x1="935" y1="240" x2="965" y2="240" stroke="#d93025" stroke-width="1.5" marker-end="url(#arrow-red)"/>

<!-- Stage 5 -->
<g transform="translate(970, 80)" filter="url(#card-shadow)">
  <rect width="195" height="400" rx="10" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>
  <rect width="195" height="34" rx="10" fill="#fce8e6"/>
  <rect y="24" width="195" height="10" fill="#fce8e6"/>
  <text x="14" y="23" font-family="'Google Sans', sans-serif" font-size="11.5" font-weight="700" fill="#d93025">STAGE 5: ENFORCEMENT</text>
  
  <text x="14" y="60" font-family="'Google Sans', sans-serif" font-size="13.5" font-weight="700" fill="#202124">Dual Enforcement</text>
  <text x="14" y="78" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#d93025">Origin Kernel &amp; Lab SDN</text>
  
  <rect x="12" y="95" width="171" height="145" rx="6" fill="#fdf7f7" stroke="#dadce0" stroke-width="1"/>
  <text x="20" y="118" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Production Origin:</text>
  <text x="20" y="136" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Linux nftables pre-routing</text>
  <text x="20" y="152" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#d93025">• &lt; 1 µs packet DROP</text>
  <text x="20" y="172" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Hardware Lab Testbed:</text>
  <text x="20" y="190" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">• Zodiac FX OpenFlow</text>
  <text x="20" y="206" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="700" fill="#d93025">  FLOW_MOD Drop</text>
  
  <g transform="translate(12, 255)">
    <rect width="171" height="130" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="12" y="24" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="700" fill="#202124">Dean Invariant:</text>
    <text x="12" y="44" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">Drop packets before</text>
    <text x="12" y="60" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">TCP socket or memory</text>
    <text x="12" y="76" font-family="'Google Sans Text', sans-serif" font-size="10" font-weight="400" fill="#5f6368">allocation.</text>
  </g>
</g>

<!-- Footer Invariant Banner -->
<g transform="translate(50, 495)">
  <rect width="1115" height="32" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />
  <text x="20" y="21" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#202124">AlphaProof Verification Paradigm:</text>
  <text x="245" y="21" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">Every neural prediction is proven correct by a symbolic verifier before modifying active firewall state.</text>
</g>

</svg>"""
    return svg

# ==============================================================================
# FIGURE 4: 3-Tier Distributed Storage Architecture
# ==============================================================================
def generate_figure_4():
    width = 1200
    height = 430
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background-color: #ffffff;">
{SVG_FONT_STYLE}

<!-- Diagram Section Header -->
<text x="50" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#1a73e8">Storage Hierarchy:</text>
<text x="255" y="42" font-family="'Google Sans', sans-serif" font-size="20" font-weight="700" fill="#202124">3-Tier Distributed Data Hierarchy</text>
<text x="50" y="66" font-family="'Google Sans Text', sans-serif" font-size="12" font-weight="400" fill="#5f6368">Sub-microsecond kernel fast-path · Serverless pooled PostgreSQL state store · Immutable cryptographic audit log</text>

<!-- Tier 1: Local In-Memory Fast Path -->
<g transform="translate(50, 110)" filter="url(#card-shadow)">
  <rect width="295" height="230" rx="10" fill="#ffffff" stroke="#137333" stroke-width="1.5"/>
  <rect width="295" height="36" rx="10" fill="#e6f4ea"/>
  <rect y="26" width="295" height="10" fill="#e6f4ea"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#137333">TIER 1: LOCAL FAST PATH (&lt; 1 µs)</text>
  
  <g transform="translate(14, 52)">
    <rect width="267" height="70" rx="6" fill="#f0faf2" stroke="#137333" stroke-width="1"/>
    <text x="14" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">nftables set zodiac_quarantine</text>
    <text x="14" y="46" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">Kernel Interval Tree · &lt; 1,000 ns lookup</text>
    <text x="14" y="62" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#137333">300s Monotonic Kernel TTL</text>
  </g>
  
  <g transform="translate(14, 134)">
    <rect width="267" height="80" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1"/>
    <text x="14" y="24" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">Local Agent In-Memory LRU</text>
    <text x="14" y="44" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">10,000 active entries · &lt; 25MB RAM</text>
    <text x="14" y="64" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">Evaluates fast allowlists in &lt; 0.1 ms</text>
  </g>
</g>

<!-- Arrow: Tier 1 -> Tier 2 -->
<line x1="345" y1="225" x2="440" y2="225" stroke="#1a73e8" stroke-width="1.5" marker-end="url(#arrow-blue)"/>
<text x="392" y="215" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="500" fill="#1a73e8" text-anchor="middle">5s Delta Sync</text>

<!-- Tier 2: Neon Postgres State Store -->
<g transform="translate(445, 110)" filter="url(#card-shadow)">
  <rect width="295" height="230" rx="10" fill="#ffffff" stroke="#e8710a" stroke-width="1.5"/>
  <rect width="295" height="36" rx="10" fill="#fef7e0"/>
  <rect y="26" width="295" height="10" fill="#fef7e0"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#b06000">TIER 2: NEON POSTGRES (~5 ms)</text>
  
  <g transform="translate(14, 52)">
    <rect width="267" height="70" rx="6" fill="#fefcf5" stroke="#e8710a" stroke-width="1"/>
    <text x="14" y="26" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">SentinelSubnetRecord</text>
    <text x="14" y="46" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">/24 CIDR subnet clustering</text>
    <text x="14" y="62" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#e8710a">velocity · entropy_score</text>
  </g>
  
  <g transform="translate(14, 134)">
    <rect width="267" height="80" rx="6" fill="#fefcf5" stroke="#dadce0" stroke-width="1"/>
    <text x="14" y="24" font-family="'Google Sans', sans-serif" font-size="12" font-weight="700" fill="#202124">SentinelIPRecord</text>
    <text x="14" y="44" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">64-bit BigInt packet counters</text>
    <text x="14" y="64" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#5f6368">reputation_score (0-100)</text>
  </g>
</g>

<!-- Arrow: Tier 2 -> Tier 3 -->
<line x1="740" y1="225" x2="845" y2="225" stroke="#1a73e8" stroke-width="1.5" marker-end="url(#arrow-blue)"/>
<text x="792" y="215" font-family="'Google Sans Text', sans-serif" font-size="10.5" font-weight="500" fill="#1a73e8" text-anchor="middle">Audit Sync</text>

<!-- Tier 3: Immutable Cryptographic Audit Log -->
<g transform="translate(850, 110)" filter="url(#card-shadow)">
  <rect width="310" height="230" rx="10" fill="#ffffff" stroke="#1a73e8" stroke-width="1.5"/>
  <rect width="310" height="36" rx="10" fill="#e8f0fe"/>
  <rect y="26" width="310" height="10" fill="#e8f0fe"/>
  <text x="16" y="24" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#174ea6">TIER 3: IMMUTABLE AUDIT LOG (COLD)</text>
  
  <g transform="translate(16, 52)">
    <rect width="278" height="162" rx="6" fill="#f8fafd" stroke="#1a73e8" stroke-width="1"/>
    <text x="14" y="26" font-family="'Google Sans', sans-serif" font-size="13" font-weight="700" fill="#202124">SentinelQuarantineRecord</text>
    <text x="14" y="48" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">• Unique quarantine UUID</text>
    <text x="14" y="68" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">• Symbolic proof hash (AlphaProof)</text>
    <text x="14" y="88" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">• Monotonic nanosecond timestamp</text>
    <text x="14" y="108" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">• Physical silicon provenance metadata</text>
    <text x="14" y="132" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#1a73e8">verified_provenance: TRUE</text>
  </g>
</g>

<!-- Council Invariant Annotation Box -->
<g transform="translate(50, 365)">
  <rect width="1100" height="34" rx="6" fill="#f8f9fa" stroke="#dadce0" stroke-width="1" />
  <text x="20" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="700" fill="#202124">Anti-Simulation Law &amp; Epistemic Provenance:</text>
  <text x="295" y="22" font-family="'Google Sans Text', sans-serif" font-size="11" font-weight="400" fill="#5f6368">All counters use BigInt; all timestamps use nanosecond monotonic hrtime. Synthetic simulations forbidden in production.</text>
</g>

</svg>"""
    return svg

def main():
    os.makedirs("docs/archive/sentinel/figures", exist_ok=True)
    figures = [
        ("sentinel_deployment_options", generate_figure_1(), 1200, 560),
        ("sentinel_alternatives_compared", generate_figure_1b(), 1240, 550),
        ("sentinel_data_plane", generate_figure_2a(), 1200, 430),
        ("sentinel_control_plane", generate_figure_2b(), 1200, 430),
        ("sentinel_detection_pipeline", generate_figure_3(), 1200, 540),
        ("sentinel_data_model", generate_figure_4(), 1200, 430),
    ]
    
    chrome_bin = get_chrome_binary()
    sips_bin = shutil.which("sips")
    
    with tempfile.TemporaryDirectory(prefix="sentinel_figures_") as tmpdir:
        for name, svg_content, width, height in figures:
            svg_path = f"docs/archive/sentinel/figures/{name}.svg"
            html_path = os.path.join(tmpdir, f"{name}.html")
            png_path = f"docs/archive/sentinel/figures/{name}.png"
            jpg_path = f"docs/archive/sentinel/figures/{name}.jpg"
            
            with open(svg_path, "w", encoding="utf-8") as f:
                f.write(svg_content)
            print(f"Wrote {svg_path}")
            
            # HTML wrapper for headless Chrome render with embedded Google fonts
            html_wrapper = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
{HTML_FONT_HEAD}
body {{
  margin: 0;
  padding: 0;
  background-color: #ffffff;
  width: {width}px;
  height: {height}px;
}}
svg {{
  display: block;
}}
</style>
</head>
<body>
{svg_content}
</body>
</html>"""
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(html_wrapper)
                
            # Render via headless Chrome
            cmd = [
                chrome_bin,
                "--headless=new",
                "--disable-gpu",
                f"--window-size={width},{height}",
                f"--screenshot={png_path}",
                "--default-background-color=ffffff",
                html_path
            ]
            subprocess.run(cmd, check=True, timeout=120)
            print(f"Rendered {png_path} via Chrome")
            
            # Convert PNG to JPG if sips or PIL is available
            if sips_bin:
                subprocess.run([sips_bin, "-s", "format", "jpeg", png_path, "--out", jpg_path], check=True, timeout=60)
                print(f"Converted {jpg_path} via sips")
            else:
                try:
                    from PIL import Image
                    with Image.open(png_path) as im:
                        im.convert("RGB").save(jpg_path, "JPEG")
                    print(f"Converted {jpg_path} via PIL")
                except ImportError:
                    print(f"Notice: sips and PIL not found, skipping JPG conversion for {jpg_path}")

if __name__ == "__main__":
    main()
