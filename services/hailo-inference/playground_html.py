"""
playground_html.py
==================
Standalone HTML/CSS/JS interactive playground for Hailo-8 edge neural inference.
Served when accessing GET /infer or GET /playground from a browser.

Council Invariants:
- Zero external CDN dependencies (works fully offline/air-gapped).
- Fail-closed error handling with explicit status messages.
- Pure integer nanosecond telemetry exposition.
"""

INTERACTIVE_PLAYGROUND_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zodiac Hailo-8 Neural Inference Playground</title>
  <style>
    :root {
      --bg-primary: #090d16;
      --bg-secondary: #0f172a;
      --bg-card: #131d31;
      --border: #1e293b;
      --border-focus: #38bdf8;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #10b981;
      --accent-glow: rgba(16, 185, 129, 0.2);
      --cyan: #38bdf8;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #10b981 0%, #0284c7 100%);
      color: white;
      font-weight: 800;
      font-size: 13px;
      padding: 6px 10px;
      border-radius: 6px;
      letter-spacing: 0.05em;
    }
    .title h1 {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .title p {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .status-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pill {
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }
    .nav-links a {
      color: var(--cyan);
      text-decoration: none;
      font-size: 12px;
      font-family: var(--font-mono);
      margin-left: 12px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.15s ease;
    }
    .nav-links a:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--cyan);
    }
    main {
      flex: 1;
      padding: 24px;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 24px;
    }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .panel-title {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 24px 16px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s ease;
      background: rgba(15, 23, 42, 0.6);
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: var(--cyan);
      background: rgba(56, 189, 248, 0.05);
    }
    .dropzone p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .dropzone input[type="file"] {
      display: none;
    }
    .btn-secondary {
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      font-family: var(--font-mono);
      transition: all 0.15s ease;
      width: 100%;
    }
    .btn-secondary:hover {
      background: #1e293b;
      border-color: #334155;
    }
    .btn-primary {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      border: none;
      padding: 12px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      box-shadow: 0 4px 12px var(--accent-glow);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(16, 185, 129, 0.35);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .slider-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .slider-header {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      font-family: var(--font-mono);
    }
    .slider-header span:last-child {
      color: var(--cyan);
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--cyan);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .metric-card.highlight {
      grid-column: span 2;
      border-color: rgba(16, 185, 129, 0.4);
      background: rgba(16, 185, 129, 0.05);
    }
    .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-family: var(--font-mono);
    }
    .metric-value {
      font-size: 20px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-main);
      margin-top: 4px;
    }
    .metric-card.highlight .metric-value {
      color: var(--accent);
      font-size: 24px;
    }
    .metric-sub {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      margin-top: 2px;
    }
    .viewport-container {
      position: relative;
      background: #000;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      min-height: 420px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    canvas {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .placeholder-text {
      color: var(--text-muted);
      font-size: 14px;
      font-family: var(--font-mono);
      text-align: center;
      padding: 32px;
    }
    .table-container {
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-family: var(--font-mono);
    }
    th {
      background: var(--bg-card);
      padding: 8px 12px;
      text-align: left;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    tr:last-child td { border-bottom: none; }
    .confidence-pill {
      background: rgba(16, 185, 129, 0.15);
      color: var(--accent);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .alert {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-family: var(--font-mono);
      display: none;
    }
    .alert.error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
      display: block;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 12px 24px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--bg-secondary);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo-badge">HAILO-8 NPU</div>
      <div class="title">
        <h1>Zodiac Neural Inference Playground</h1>
        <p>Raspberry Pi 5 · agentic-node-02 · 10.0.2.51:8000</p>
      </div>
    </div>
    <div class="status-bar">
      <div class="pill">
        <div class="dot" id="status-dot"></div>
        <span id="service-status">NPU READY</span>
      </div>
      <div class="pill">
        <span>MODEL:</span>
        <strong id="active-model-name" style="color:var(--cyan)">yolov8s_h8.hef</strong>
      </div>
      <div class="pill">
        <span>CHIP TEMP:</span>
        <strong id="chip-temp">--°C</strong>
      </div>
      <div class="nav-links">
        <a href="/docs" target="_blank">Swagger /docs</a>
        <a href="/telemetry" target="_blank">/telemetry</a>
        <a href="/models" target="_blank">/models</a>
      </div>
    </div>
  </header>

  <main>
    <!-- Left Column: Controls -->
    <div class="panel">
      <div class="panel-title">1. Input Configuration</div>

      <div class="dropzone" id="dropzone" onclick="document.getElementById('file-input').click()">
        <strong>📁 Drop image file here</strong>
        <p>or click to browse from disk (JPEG, PNG)</p>
        <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp">
      </div>

      <button class="btn-secondary" id="btn-sample" type="button">
        ⚡ Load Local Test Pattern (Offline)
      </button>

      <div class="slider-group">
        <div class="slider-header">
          <span>Confidence Threshold</span>
          <span id="conf-val">0.30</span>
        </div>
        <input type="range" id="conf-slider" min="0.05" max="0.95" step="0.05" value="0.30">
      </div>

      <div class="slider-group">
        <div class="slider-header">
          <span>IOU NMS Threshold</span>
          <span id="iou-val">0.45</span>
        </div>
        <input type="range" id="iou-slider" min="0.10" max="0.90" step="0.05" value="0.45">
      </div>

      <button class="btn-primary" id="btn-infer" type="button">
        🚀 Run Hailo-8 Neural Inference
      </button>

      <div id="alert-box" class="alert"></div>

      <div class="panel-title" style="margin-top:8px;">2. Silicon Telemetry</div>
      <div class="metrics-grid">
        <div class="metric-card highlight">
          <div class="metric-label">Hailo-8 NPU Hardware DMA Latency</div>
          <div class="metric-value" id="val-hw-latency">-- ms</div>
          <div class="metric-sub" id="val-hw-latency-ns">-- ns</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Preprocessing</div>
          <div class="metric-value" id="val-prep-latency">-- ms</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Postprocessing</div>
          <div class="metric-value" id="val-post-latency">-- ms</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Total Execution</div>
          <div class="metric-value" id="val-tot-latency">-- ms</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">NPU Silicon Temp</div>
          <div class="metric-value" id="val-chip-temp">--°C</div>
        </div>
      </div>
    </div>

    <!-- Right Column: Visualizer & Detections -->
    <div class="panel">
      <div class="panel-title">3. Model Output & Bounding Boxes</div>
      <div class="viewport-container" id="viewport-container">
        <div class="placeholder-text" id="placeholder-msg">
          Select or drop an image on the left, then click <strong>Run Hailo-8 Neural Inference</strong>
        </div>
        <canvas id="viewport" style="display:none;"></canvas>
      </div>

      <div class="panel-title">4. Detected Entities (<span id="det-count">0</span>)</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Class</th>
              <th>Confidence</th>
              <th>Bounding Box [ymin, xmin, ymax, xmax]</th>
            </tr>
          </thead>
          <tbody id="det-tbody">
            <tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No detections yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <footer>
    <span>Zodiac Autonomous SDN & Inference Infrastructure · Council Invariants INV-1, INV-2, INV-3, INV-6</span>
    <span>HailoRT 4.20.0 · PCIe Gen 3.0 x1 (8.0 GT/s) · Monotonic Nanoseconds</span>
  </footer>

  <script>
    let activeImageFile = null;
    let activeImageElement = null;

    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const btnInfer = document.getElementById('btn-infer');
    const btnSample = document.getElementById('btn-sample');
    const confSlider = document.getElementById('conf-slider');
    const confVal = document.getElementById('conf-val');
    const iouSlider = document.getElementById('iou-slider');
    const iouVal = document.getElementById('iou-val');
    const alertBox = document.getElementById('alert-box');
    const canvas = document.getElementById('viewport');
    const placeholderMsg = document.getElementById('placeholder-msg');
    const detTbody = document.getElementById('det-tbody');
    const detCount = document.getElementById('det-count');

    confSlider.addEventListener('input', () => { confVal.textContent = parseFloat(confSlider.value).toFixed(2); });
    iouSlider.addEventListener('input', () => { iouVal.textContent = parseFloat(iouSlider.value).toFixed(2); });

    // Drag and drop handlers
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
    });

    function handleFileSelect(file) {
      activeImageFile = file;
      dropzone.querySelector('strong').textContent = '📄 ' + file.name;
      dropzone.querySelector('p').textContent = (file.size / 1024).toFixed(1) + ' KB selected';
      hideAlert();

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          activeImageElement = img;
          renderImageOnCanvas(img, []);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    function renderImageOnCanvas(img, detections) {
      placeholderMsg.style.display = 'none';
      canvas.style.display = 'block';

      // Set canvas dimensions to match image natural size
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Draw bounding boxes
      const colors = ['#10b981', '#38bdf8', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];
      detections.forEach((det, idx) => {
        const bbox = det.bbox;
        const color = colors[det.class_id % colors.length];

        const x = bbox.xmin * canvas.width;
        const y = bbox.ymin * canvas.height;
        const w = (bbox.xmax - bbox.xmin) * canvas.width;
        const h = (bbox.ymax - bbox.ymin) * canvas.height;

        // Rectangle stroke
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, Math.round(canvas.width / 300));
        ctx.strokeRect(x, y, w, h);

        // Label pill
        const labelText = `${det.class_name} ${(det.confidence * 100).toFixed(0)}%`;
        const fontSize = Math.max(12, Math.round(canvas.width / 50));
        ctx.font = `bold ${fontSize}px sans-serif`;
        const textMetrics = ctx.measureText(labelText);
        const textWidth = textMetrics.width;
        const textHeight = fontSize * 1.2;

        ctx.fillStyle = color;
        ctx.fillRect(x, Math.max(0, y - textHeight - 4), textWidth + 10, textHeight + 4);

        ctx.fillStyle = '#090d16';
        ctx.fillText(labelText, x + 5, Math.max(textHeight - 2, y - 4));
      });
    }

    // Sample image generator: 100% offline synthetic canvas pattern (INV-1 / Air-Gap Invariant)
    btnSample.addEventListener('click', () => {
      btnSample.disabled = true;
      btnSample.textContent = '⚡ Generating test frame...';
      try {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = 640;
        offCanvas.height = 480;
        const ctx = offCanvas.getContext('2d');

        // Dark background with technical coordinate grid
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, 640, 480);
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        for (let x = 0; x < 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 480); ctx.stroke(); }
        for (let y = 0; y < 480; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(640, y); ctx.stroke(); }

        // Synthetic subject shapes for NPU bounding verification
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(80, 120, 120, 240);
        ctx.fillStyle = '#10b981';
        ctx.fillRect(280, 180, 280, 180);

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 18px monospace';
        ctx.fillText('ZODIAC LOCAL AIR-GAPPED TEST PATTERN', 100, 60);

        offCanvas.toBlob((blob) => {
          const file = new File([blob], 'zodiac_local_test.jpg', { type: 'image/jpeg' });
          handleFileSelect(file);
        }, 'image/jpeg');
      } finally {
        btnSample.disabled = false;
        btnSample.textContent = '⚡ Load Local Test Pattern (Offline)';
      }
    });

    // Execute Inference
    btnInfer.addEventListener('click', async () => {
      if (!activeImageFile) {
        showAlert('Please select or drop an image file first, or click "Load Test Sample".');
        return;
      }

      btnInfer.disabled = true;
      btnInfer.innerHTML = '⚙️ Executing on Hailo-8 Silicon...';
      hideAlert();

      const conf = confSlider.value;
      const iou = iouSlider.value;
      const formData = new FormData();
      formData.append('file', activeImageFile);

      try {
        const url = `/infer/upload?confidence_threshold=${conf}&iou_threshold=${iou}&render_annotated=false`;
        const resp = await fetch(url, { method: 'POST', body: formData });

        if (!resp.ok) {
          const rawErr = await resp.text();
          let errDetail = rawErr;
          try {
            const parsed = JSON.parse(rawErr);
            if (parsed && parsed.detail) errDetail = parsed.detail;
          } catch (parseErr) {
            console.error('Non-JSON error response from inference backend:', parseErr, rawErr);
          }
          throw new Error(errDetail || ('Server returned HTTP ' + resp.status));
        }

        const res = await resp.json();
        updateUIWithResults(res);
      } catch (err) {
        showAlert('Inference Error: ' + err.message);
      } finally {
        btnInfer.disabled = false;
        btnInfer.innerHTML = '🚀 Run Hailo-8 Neural Inference';
      }
    });

    function updateUIWithResults(res) {
      // 1. Telemetry timings
      const timing = res.timing || {};
      const hwNs = timing.inference_ns || 0;
      const prepNs = timing.preprocess_ns || 0;
      const postNs = timing.postprocess_ns || 0;
      const totNs = timing.total_ns || 0;

      document.getElementById('val-hw-latency').textContent = (hwNs / 1e6).toFixed(2) + ' ms';
      document.getElementById('val-hw-latency-ns').textContent = hwNs.toLocaleString() + ' ns';
      document.getElementById('val-prep-latency').textContent = (prepNs / 1e6).toFixed(2) + ' ms';
      document.getElementById('val-post-latency').textContent = (postNs / 1e6).toFixed(2) + ' ms';
      document.getElementById('val-tot-latency').textContent = (totNs / 1e6).toFixed(2) + ' ms';

      const tempC = res.chip_temp_c != null ? res.chip_temp_c.toFixed(1) : '--';
      document.getElementById('val-chip-temp').textContent = tempC + ' °C';
      document.getElementById('chip-temp').textContent = tempC + ' °C';

      // 2. Render bounding boxes on canvas
      const detections = res.detections || [];
      if (activeImageElement) {
        renderImageOnCanvas(activeImageElement, detections);
      }

      // 3. Populate detections table
      detCount.textContent = detections.length;
      if (detections.length === 0) {
        detTbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No objects detected above threshold.</td></tr>';
      } else {
        detTbody.innerHTML = detections.map(d => `
          <tr>
            <td><strong>${escapeHtml(d.class_name)}</strong></td>
            <td><span class="confidence-pill">${(d.confidence * 100).toFixed(1)}%</span></td>
            <td style="color:var(--text-muted)">[${d.bbox.ymin.toFixed(3)}, ${d.bbox.xmin.toFixed(3)}, ${d.bbox.ymax.toFixed(3)}, ${d.bbox.xmax.toFixed(3)}]</td>
          </tr>
        `).join('');
      }
    }

    function showAlert(msg) {
      alertBox.textContent = msg;
      alertBox.className = 'alert error';
    }
    function hideAlert() {
      alertBox.style.display = 'none';
    }
    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Initial Health Query with fail-closed status handling (INV-1 / Zero Suppression of Reality)
    async function fetchHealth() {
      const statusDot = document.getElementById('status-dot');
      const serviceStatus = document.getElementById('service-status');
      try {
        const resp = await fetch('/health');
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        const data = await resp.json();
        if (data.status === 'HEALTHY' && data.hailo_device === 'CONNECTED') {
          statusDot.style.background = '#10b981';
          statusDot.style.boxShadow = '0 0 8px #10b981';
          serviceStatus.textContent = 'NPU READY';
        } else {
          statusDot.style.background = '#f59e0b';
          statusDot.style.boxShadow = '0 0 8px #f59e0b';
          serviceStatus.textContent = data.status || 'DEGRADED';
        }
        if (data.chip_ts0_c != null) {
          document.getElementById('chip-temp').textContent = data.chip_ts0_c.toFixed(1) + ' °C';
        }
        if (data.active_model) {
          document.getElementById('active-model-name').textContent = data.active_model;
        }
      } catch (e) {
        statusDot.style.background = '#ef4444';
        statusDot.style.boxShadow = '0 0 8px #ef4444';
        serviceStatus.textContent = 'OFFLINE / UNREACHABLE';
        document.getElementById('chip-temp').textContent = '--°C';
        showAlert('Hardware Health Warning: Unable to query /health endpoint (' + e.message + ')');
      }
    }
    fetchHealth();
  </script>
</body>
</html>
"""
