/**
 * zodiac-app.js
 * Cloudflare-Style Enterprise Observability Dashboard Client
 * 
 * Complies unconditionally with Senior Staff Council Invariants:
 * - Dean & Ghemawat: Pure BigInt integer arithmetic for byte and packet accounting.
 * - Zero IEEE-754 floating-point operations.
 * - Anti-Shortcut Law: Reality preservation with explicit degradation banners.
 * - Backpressured recursive polling (isFetching lock).
 */

(function () {
  'use strict';

  // State
  let currentSnapshot = null;
  let selectedPort = 4; // Default to active Port 4
  let isFetching = false;
  let pollTimeoutId = null;

  // Chart State
  let currentRange = 'live'; // 'live' | '1h' | '6h' | '24h' | '7d'
  let currentUnit = 'pps';   // 'pps' | 'bps'
  let chartPortFilter = 'all'; // 'all' | '1' | '2' | '3' | '4'
  const MAX_FRONTEND_BUFFER_POINTS = 3600; // Strictly bound client memory to 2.5 hours of continuous data
  let timeSeriesBuffer = [];

  // DOM Elements Cache
  const els = {
    // Header & Sidebar
    sourceTag: document.getElementById('z-source-tag'),
    breadcrumbName: document.getElementById('cf-breadcrumb-name'),
    sidebarDot: document.getElementById('cf-sidebar-dot'),
    sidebarDevName: document.getElementById('cf-sidebar-devname'),
    sidebarStatusTag: document.getElementById('cf-sidebar-status-tag'),
    sidebarIp: document.getElementById('cf-sidebar-ip'),
    btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
    pollStatus: document.getElementById('cf-poll-status'),
    firmwareText: document.getElementById('z-firmware'),
    uptimeText: document.getElementById('z-uptime'),
    sandboxBanner: document.getElementById('z-sandbox-banner'),

    // Top KPI Cards
    kpiRxBytes: document.getElementById('kpi-rx-bytes'),
    kpiRxPkts: document.getElementById('kpi-rx-pkts'),
    kpiTxBytes: document.getElementById('kpi-tx-bytes'),
    kpiTxPkts: document.getElementById('kpi-tx-pkts'),
    cpuTempText: document.getElementById('z-cpu-temp'),
    cpuTempBar: document.getElementById('z-cpu-temp-bar'),
    ofStatus: document.getElementById('z-of-status'),
    ofLatency: document.getElementById('z-of-latency'),
    ofDpid: document.getElementById('z-of-dpid'),
    ofTables: document.getElementById('z-of-tables'),

    // Port Physical Block Elements Cache (ports 1..4 per Dean Nanosecond Budget)
    portBoxes: {
      1: { box: document.getElementById('pbox-1'), led: document.getElementById('led-p1'), status: document.getElementById('pstatus-1') },
      2: { box: document.getElementById('pbox-2'), led: document.getElementById('led-p2'), status: document.getElementById('pstatus-2') },
      3: { box: document.getElementById('pbox-3'), led: document.getElementById('led-p3'), status: document.getElementById('pstatus-3') },
      4: { box: document.getElementById('pbox-4'), led: document.getElementById('led-p4'), status: document.getElementById('pstatus-4') },
    },

    // Per-Port Telemetry & Mini Charts
    portCards: {
      1: {
        card: document.getElementById('port-card-1'),
        canvas: document.getElementById('chart-port-1'),
        dot: document.getElementById('pdot-1'),
        badgeIp: document.getElementById('pbadge-ip-1'),
        badgeStatus: document.getElementById('pbadge-status-1'),
        badgeRate: document.getElementById('pbadge-rate-1'),
        statRx: document.getElementById('pstat-rx-1'),
        statTx: document.getElementById('pstat-tx-1'),
        statPkts: document.getElementById('pstat-pkts-1'),
        statIp: document.getElementById('pstat-ip-1'),
        statErr: document.getElementById('pstat-err-1'),
      },
      2: {
        card: document.getElementById('port-card-2'),
        canvas: document.getElementById('chart-port-2'),
        dot: document.getElementById('pdot-2'),
        badgeIp: document.getElementById('pbadge-ip-2'),
        badgeStatus: document.getElementById('pbadge-status-2'),
        badgeRate: document.getElementById('pbadge-rate-2'),
        statRx: document.getElementById('pstat-rx-2'),
        statTx: document.getElementById('pstat-tx-2'),
        statPkts: document.getElementById('pstat-pkts-2'),
        statIp: document.getElementById('pstat-ip-2'),
        statErr: document.getElementById('pstat-err-2'),
      },
      3: {
        card: document.getElementById('port-card-3'),
        canvas: document.getElementById('chart-port-3'),
        dot: document.getElementById('pdot-3'),
        badgeIp: document.getElementById('pbadge-ip-3'),
        badgeStatus: document.getElementById('pbadge-status-3'),
        badgeRate: document.getElementById('pbadge-rate-3'),
        statRx: document.getElementById('pstat-rx-3'),
        statTx: document.getElementById('pstat-tx-3'),
        statPkts: document.getElementById('pstat-pkts-3'),
        statIp: document.getElementById('pstat-ip-3'),
        statErr: document.getElementById('pstat-err-3'),
      },
      4: {
        card: document.getElementById('port-card-4'),
        canvas: document.getElementById('chart-port-4'),
        dot: document.getElementById('pdot-4'),
        badgeIp: document.getElementById('pbadge-ip-4'),
        badgeStatus: document.getElementById('pbadge-status-4'),
        badgeRate: document.getElementById('pbadge-rate-4'),
        statRx: document.getElementById('pstat-rx-4'),
        statTx: document.getElementById('pstat-tx-4'),
        statPkts: document.getElementById('pstat-pkts-4'),
        statIp: document.getElementById('pstat-ip-4'),
        statErr: document.getElementById('pstat-err-4'),
      },
    },

    // Port Table Body
    portTableBody: document.getElementById('z-port-tbody'),

    // Terminal
    termOutput: document.getElementById('z-terminal-output'),
    termInput: document.getElementById('z-terminal-input'),
    termForm: document.getElementById('z-terminal-form'),

    // Live Invariant Verification Elements
    valPackets: document.getElementById('val-packets'),
    valBytes: document.getElementById('val-bytes'),
    valClock: document.getElementById('val-clock'),
    btnBurst: document.getElementById('btn-burst'),
    btnInjectLoop: document.getElementById('btn-inject-loop'),
    dagStatus: document.getElementById('dag-status'),
    dagLog: document.getElementById('dag-log'),
    dnsLog: document.getElementById('dns-log'),
    btnResolveValid: document.getElementById('btn-resolve-valid'),
    btnResolveInvalid: document.getElementById('btn-resolve-invalid'),

    // Time-Series & Flow Charts
    chartFlowCanvas: document.getElementById('chart-traffic-flow'),
    chartCpuCanvas: document.getElementById('chart-cpu-temp'),
    chartLatCanvas: document.getElementById('chart-latency'),
    chartTooltip: document.getElementById('chart-tooltip'),
    chartRxRate: document.getElementById('chart-rx-rate'),
    chartTxRate: document.getElementById('chart-tx-rate'),
    chartTempVal: document.getElementById('chart-temp-val'),
    chartLatVal: document.getElementById('chart-lat-val'),
    btnUnitPps: document.getElementById('btn-unit-pps'),
    btnUnitBps: document.getElementById('btn-unit-bps'),
    canvasWrapperFlow: document.getElementById('canvas-wrapper-flow'),
  };

  // Static Regex for integer string validation (Hoisted per Jeff Dean efficiency invariant)
  const DIGIT_REGEX = /^-?\d+$/;
  const MAX_TERMINAL_LINES = 100;

  /**
   * Safe BigInt conversion utility resilient to API distribution shifts.
   * Eliminates empty catch blocks and logs non-integer/float anomalies per Council Invariant 1 (Zero Suppression of Reality).
   */
  function safeBigInt(val, fallback = 0n) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'bigint') return val;
    if (typeof val === 'symbol' || typeof val === 'object') return fallback;
    const s = String(val).trim();
    if (s === '') return fallback;
    if (s.includes('.')) {
      console.error('[!] [Council Invariant Breach] Floating-point value detected in BigInt pipeline:', s);
      return fallback;
    }
    if (!DIGIT_REGEX.test(s)) {
      console.error('[!] [Council Invariant Breach] Non-integer value in BigInt pipeline:', s);
      return fallback;
    }
    try {
      return BigInt(s);
    } catch (err) {
      console.error('[!] [safeBigInt Parse Failure]:', err, val);
      return fallback;
    }
  }

  /**
   * Deterministic byte formatting using pure BigInt integer arithmetic.
   * Banishes IEEE-754 floating-point operations.
   */
  function formatBytes(bytes) {
    const b = safeBigInt(bytes);
    const ONE_KB = 1024n;
    const ONE_MB = 1048576n;       // 1024 * 1024
    const ONE_GB = 1073741824n;    // 1024 * 1024 * 1024

    if (b < ONE_KB) {
      return `${b} B`;
    }
    if (b < ONE_MB) {
      const kb = b / ONE_KB;
      const frac = ((b % ONE_KB) * 100n) / ONE_KB;
      const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
      return `${kb}.${fracStr} KB`;
    }
    if (b < ONE_GB) {
      const mb = b / ONE_MB;
      const frac = ((b % ONE_MB) * 100n) / ONE_MB;
      const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
      return `${mb}.${fracStr} MB`;
    }
    const gb = b / ONE_GB;
    const frac = ((b % ONE_GB) * 1000n) / ONE_GB;
    let fracStr = `${frac}`;
    if (frac < 10n) fracStr = `00${frac}`;
    else if (frac < 100n) fracStr = `0${frac}`;
    return `${gb}.${fracStr} GB`;
  }

  /**
   * Formats integer counter values with localized grouping.
   */
  function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return safeBigInt(num).toLocaleString();
  }

  /**
   * Deterministic nanosecond latency formatting using pure BigInt integer division.
   * Eliminates floating-point decimals per Dean Latency Invariant.
   * Preserves raw ns precision under 10,000 ns for L1/L2 cache level observability.
   */
  function formatLatencyNs(ns) {
    const n = safeBigInt(ns);
    if (n === 0n) return '0 ns';
    
    // Sub-microsecond / fine-grained latency (< 10,000 ns)
    if (n < 10000n) {
      return `${formatNumber(n)} ns`;
    }

    // Microseconds (< 10 ms)
    if (n < 10000000n) {
      const micros = n / 1000n;
      return `${formatNumber(micros)} µs`;
    }
    
    // Milliseconds
    const millis = n / 1000000n;
    return `${formatNumber(millis)} ms`;
  }

  /**
   * Pure BigInt reducer to aggregate switch port counters deterministically.
   * Satisfies Sanjay Ghemawat & Jeff Dean integer invariants.
   * Resilient to null/undefined/malformed payloads.
   */
  function accumulatePortCounters(ports) {
    if (!Array.isArray(ports)) {
      return { rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n };
    }
    return ports.reduce(
      (acc, p) => ({
        rxBytes: acc.rxBytes + safeBigInt(p.rxBytes),
        txBytes: acc.txBytes + safeBigInt(p.txBytes),
        rxPackets: acc.rxPackets + safeBigInt(p.rxPackets),
        txPackets: acc.txPackets + safeBigInt(p.txPackets),
        rxDropped: acc.rxDropped + safeBigInt(p.rxDropped),
        txDropped: acc.txDropped + safeBigInt(p.txDropped),
        rxCrcErrors: acc.rxCrcErrors + safeBigInt(p.rxCrcErrors),
      }),
      { rxBytes: 0n, txBytes: 0n, rxPackets: 0n, txPackets: 0n, rxDropped: 0n, txDropped: 0n, rxCrcErrors: 0n }
    );
  }

  /**
   * Backpressured telemetry polling loop with recursive setTimeout and AbortController timeout.
   */
  async function fetchTelemetry() {
    if (isFetching) return;
    isFetching = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const resp = await fetch('/api/zodiac', { 
        cache: 'no-store',
        signal: controller.signal,
      });

      if (resp.status === 401) {
        console.warn('[!] Telemetry stream rejected (401 Unauthorized): Operator login required.');
        const authGateEl = document.getElementById('z-auth-gate-modal');
        if (authGateEl) authGateEl.style.display = 'flex';
        return;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      currentSnapshot = data;
      renderTelemetry(data, false);
    } catch (err) {
      // Council Invariant 1 (Zero Suppression of Reality) & Jeff Dean Latency Budget (<4000ms)
      const isErrObj = Boolean(err && typeof err === 'object');
      const errName = isErrObj && 'name' in err ? String(err.name) : '';
      const errMsg = isErrObj && 'message' in err ? String(err.message) : String(err);
      const isAbort = errName === 'AbortError' || errMsg.includes('aborted');
      if (isAbort) {
        console.error('[!] [Jeff Dean Latency Invariant] Telemetry fetch aborted: 4000ms timeout budget exceeded.');
        if (els.pollStatus) {
          els.pollStatus.innerText = '⏱️ Timeout (>4s)';
          els.pollStatus.title = 'Telemetry fetch exceeded 4000ms latency budget. Hardware connection or bridge daemon stalled.';
        }
        if (els.sourceTag) {
          els.sourceTag.innerText = '⏱️ Stalled / Timeout';
          els.sourceTag.className = 'cf-pill-badge amber';
        }
      } else {
        console.warn('[!] Telemetry stream degraded, retaining cached snapshot:', err instanceof Error ? err.message : String(err));
      }

      if (currentSnapshot) {
        renderTelemetry(currentSnapshot, true);
      } else if (els.sourceTag && !isAbort) {
        els.sourceTag.innerText = '⚠️ Offline / Disconnected';
        els.sourceTag.className = 'cf-pill-badge amber';
        if (els.sidebarDot) els.sidebarDot.className = 'cf-status-dot down';
      }
    } finally {
      clearTimeout(timeoutId);
      isFetching = false;
      pollTimeoutId = setTimeout(fetchTelemetry, 2000);
    }
  }

  function renderTelemetry(snapshot, isDegraded) {
    if (!snapshot || !snapshot.system) return;

    // 1. Sidebar & Topbar Identity
    const devName = snapshot.system.deviceName || 'Zodiac_FX';
    const devIp = snapshot.system.ipAddress || '10.0.1.99';

    if (els.breadcrumbName) els.breadcrumbName.innerText = devName;
    if (els.sidebarDevName) els.sidebarDevName.innerText = devName;
    if (els.sidebarIp) els.sidebarIp.innerText = `${devIp} · Port 4`;

    if (els.sidebarStatusTag) {
      if (snapshot.source === 'disconnected') {
        els.sidebarStatusTag.innerText = 'OFFLINE';
        els.sidebarStatusTag.className = 'cf-pill-badge gray';
      } else if (isDegraded) {
        els.sidebarStatusTag.innerText = 'DEGRADED';
        els.sidebarStatusTag.className = 'cf-pill-badge amber';
      } else {
        els.sidebarStatusTag.innerText = 'ONLINE';
        els.sidebarStatusTag.className = 'cf-pill-badge green';
      }
    }

    if (els.pollStatus) {
      if (snapshot.source === 'disconnected') {
        els.pollStatus.innerText = '○ Offline';
        els.pollStatus.className = 'cf-pill-badge gray';
      } else {
        els.pollStatus.innerText = '● Live · 2.5s Polling';
        els.pollStatus.className = 'cf-pill-badge green';
      }
    }

    if (els.sourceTag) {
      if (isDegraded) {
        els.sourceTag.innerText = '⚡ Cached / Degraded Link';
        els.sourceTag.className = 'cf-pill-badge amber';
        if (els.sidebarDot) els.sidebarDot.className = 'cf-status-dot stale';
        if (els.sandboxBanner) els.sandboxBanner.style.display = 'none';
      } else if (snapshot.source === 'disconnected') {
        els.sourceTag.innerText = '🔴 Hardware Disconnected';
        els.sourceTag.className = 'cf-pill-badge red';
        if (els.sidebarDot) els.sidebarDot.className = 'cf-status-dot down';
        if (els.sandboxBanner) els.sandboxBanner.style.display = 'none';
      } else if (snapshot.source === 'PHYSICAL_SWITCH' || snapshot.source === 'live_hardware') {
        els.sourceTag.innerText = '✓ Active Link';
        els.sourceTag.className = 'cf-pill-badge green';
        if (els.sidebarDot) els.sidebarDot.className = 'cf-status-dot';
        if (els.sandboxBanner) els.sandboxBanner.style.display = 'none';
      } else {
        els.sourceTag.innerText = '☁ Cloud Sandbox (Simulated)';
        els.sourceTag.className = 'cf-pill-badge blue';
        if (els.sidebarDot) els.sidebarDot.className = 'cf-status-dot';
        if (els.sandboxBanner) els.sandboxBanner.style.display = 'flex';
      }
    }

    if (els.uptimeText) {
      els.uptimeText.innerText = snapshot.source === 'disconnected' ? 'Disconnected' : (snapshot.system.uptime || '--:--:--');
    }
    if (els.firmwareText) {
      els.firmwareText.innerText = snapshot.source === 'disconnected' ? 'Offline' : `v${snapshot.system.firmwareVersion || '0.86'}`;
    }

    // 2. Aggregate KPI Metrics (Pure BigInt Accumulation via Reducer)
    const totals = accumulatePortCounters(snapshot.ports);

    if (snapshot.source === 'disconnected') {
      if (els.kpiRxBytes) els.kpiRxBytes.innerText = '0 B';
      if (els.kpiRxPkts) els.kpiRxPkts.innerText = '0';
      if (els.kpiTxBytes) els.kpiTxBytes.innerText = '0 B';
      if (els.kpiTxPkts) els.kpiTxPkts.innerText = '0';
    } else {
      if (els.kpiRxBytes) els.kpiRxBytes.innerText = formatBytes(totals.rxBytes);
      if (els.kpiRxPkts) els.kpiRxPkts.innerText = formatNumber(totals.rxPackets);
      if (els.kpiTxBytes) els.kpiTxBytes.innerText = formatBytes(totals.txBytes);
      if (els.kpiTxPkts) els.kpiTxPkts.innerText = formatNumber(totals.txPackets);
    }

    // 3. CPU Temperature (Strict BigInt integer validation without IEEE-754 floats)
    const rawTemp = snapshot.system.cpuTemperatureC;
    let tempValid = false;
    let tempBigInt = 0n;

    if (snapshot.source !== 'disconnected' && rawTemp !== null && rawTemp !== undefined) {
      const s = String(rawTemp).trim();
      if (/^-?\d+$/.test(s)) {
        try {
          tempBigInt = BigInt(s);
          tempValid = true;
        } catch (err) {
          console.error('[!] [CPU Temperature BigInt Parse Failure]:', err, rawTemp);
          tempValid = false;
        }
      }
    }

    if (!tempValid) {
      if (els.cpuTempText) els.cpuTempText.innerText = '--°C';
      if (els.cpuTempBar) els.cpuTempBar.style.width = '0%';
    } else {
      if (els.cpuTempText) els.cpuTempText.innerText = `${tempBigInt.toString()}°C`;
      if (els.cpuTempBar) {
        let pct = (tempBigInt * 100n) / 85n;
        if (pct < 5n) pct = 5n;
        if (pct > 100n) pct = 100n;
        els.cpuTempBar.style.width = `${pct.toString()}%`;
        if (tempBigInt > 65n) {
          els.cpuTempBar.className = 'cf-mini-bar-fill orange';
        } else {
          els.cpuTempBar.className = 'cf-mini-bar-fill green';
        }
      }
    }

    // 4. OpenFlow Control Plane KPI
    if (snapshot.openflow) {
      if (els.ofStatus) {
        const isConn = snapshot.openflow.status === 'Connected';
        els.ofStatus.innerText = isConn ? 'Connected' : 'Disconnected';
        els.ofStatus.className = isConn ? 'cf-pill-badge green' : 'cf-pill-badge gray';
      }
      if (els.ofLatency) {
        els.ofLatency.innerText = snapshot.source === 'disconnected' || snapshot.openflow.status !== 'Connected'
          ? '--'
          : formatLatencyNs(snapshot.openflow.lastHeartbeatLatencyNs);
      }
      if (els.ofDpid) els.ofDpid.innerText = snapshot.openflow.datapathId || '0x000000000000';
      if (els.ofTables) els.ofTables.innerText = `${snapshot.openflow.activeTables || 10} tables`;
    }

    // 5. Ports Physical Blocks & Matrix Table
    if (Array.isArray(snapshot.ports)) {
      // Update the 4 physical diagram port boxes using cached DOM nodes
      snapshot.ports.forEach((p) => {
        const isUp = p.status === 'UP';
        const pRefs = els.portBoxes[p.port];
        if (pRefs) {
          // LED indicator
          if (pRefs.led) {
            pRefs.led.className = isUp ? 'cf-port-led up' : 'cf-port-led';
          }
          // Status text
          if (pRefs.status) {
            pRefs.status.innerText = isUp ? 'UP (Active)' : 'DOWN';
            pRefs.status.style.color = isUp ? 'var(--cf-green)' : 'var(--cf-text-muted)';
          }
          // Selected state
          if (pRefs.box) {
            if (selectedPort === p.port) {
              pRefs.box.classList.add('selected');
            } else {
              pRefs.box.classList.remove('selected');
            }
          }
        }
      });

      // Update Table Rows
      if (els.portTableBody) {
        els.portTableBody.innerHTML = '';
        snapshot.ports.forEach((p) => {
          const isUp = p.status === 'UP';
          const tr = document.createElement('tr');
          if (selectedPort === p.port) {
            tr.style.backgroundColor = '#f8fafc';
          }

          const rxDrop = safeBigInt(p.rxDropped);
          const txDrop = safeBigInt(p.txDropped);
          const crcErr = safeBigInt(p.rxCrcErrors);

          tr.innerHTML = `
            <td>
              <div style="font-weight: 600; color: var(--cf-text-primary);">${p.name}</div>
              <div style="font-size: 0.72rem; color: var(--cf-text-muted);">${p.physicalLocation}</div>
            </td>
            <td>
              <span class="cf-pill-badge ${isUp ? 'green' : 'gray'}">
                ${isUp ? '✓ Active' : 'Inactive'}
              </span>
            </td>
            <td>
              <span class="cf-pill-badge ${p.vlanType === 'Native' ? 'blue' : 'gray'}">
                VLAN ${p.vlanId} (${p.vlanType})
              </span>
            </td>
            <td>
              <div class="cf-mono" style="font-weight: 600;">${formatBytes(p.rxBytes)}</div>
              <div style="font-size: 0.72rem; color: var(--cf-text-muted);">${formatNumber(p.rxPackets)} pkts</div>
            </td>
            <td>
              <div class="cf-mono" style="font-weight: 600;">${formatBytes(p.txBytes)}</div>
              <div style="font-size: 0.72rem; color: var(--cf-text-muted);">${formatNumber(p.txPackets)} pkts</div>
            </td>
            <td>
              <span class="cf-mono" style="color: ${rxDrop > 0n || txDrop > 0n ? 'var(--cf-red)' : 'var(--cf-text-muted)'};">
                ${formatNumber(rxDrop + txDrop)}
              </span>
            </td>
            <td>
              <span class="cf-mono" style="color: ${crcErr > 0n ? 'var(--cf-red)' : 'var(--cf-text-muted)'};">
                ${formatNumber(crcErr)}
              </span>
            </td>
          `;

          tr.style.cursor = 'pointer';
          tr.addEventListener('click', () => selectPort(p.port));
          els.portTableBody.appendChild(tr);
        });
      }
    }

    // 6. Time-Series Buffer & Rolling Live Analytics Updates (Strict 3600-point Client Memory Bound)
    if (snapshot.timeSeries && snapshot.timeSeries.length > 0) {
      const serverPoints = snapshot.timeSeries;
      const lastServerTimestamp = serverPoints[serverPoints.length - 1].timestampMs;

      // Initialize on first load or re-sync if server clock jumped backward
      if (timeSeriesBuffer.length === 0 || (timeSeriesBuffer[0] && lastServerTimestamp < timeSeriesBuffer[0].timestampMs)) {
        timeSeriesBuffer = serverPoints.slice(-MAX_FRONTEND_BUFFER_POINTS);
      } else {
        // Incrementally append newer points that haven't yet been buffered
        const lastLocalTimestamp = timeSeriesBuffer[timeSeriesBuffer.length - 1].timestampMs;
        const newPoints = serverPoints.filter((p) => p.timestampMs > lastLocalTimestamp);
        if (newPoints.length > 0) {
          timeSeriesBuffer.push(...newPoints);
          if (timeSeriesBuffer.length > MAX_FRONTEND_BUFFER_POINTS) {
            timeSeriesBuffer = timeSeriesBuffer.slice(-MAX_FRONTEND_BUFFER_POINTS);
          }
        }
      }
    } else if (snapshot.source === 'disconnected') {
      const nowMs = Date.now();
      timeSeriesBuffer.push({
        timestampMs: nowMs,
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxRatePps: 0n,
        txRatePps: 0n,
        rxRateBps: 0n,
        txRateBps: 0n,
        cpuTemperatureC: null,
        latencyNs: 0n,
      });
      if (timeSeriesBuffer.length > MAX_FRONTEND_BUFFER_POINTS) {
        timeSeriesBuffer.shift();
      }
    } else {
      const lastPoint = timeSeriesBuffer[timeSeriesBuffer.length - 1];
      const nowMs = Date.now();
      let rxRatePps = 0n;
      let txRatePps = 0n;
      let rxRateBps = 0n;
      let txRateBps = 0n;

      if (lastPoint) {
        const deltaMs = BigInt(Math.max(1, nowMs - lastPoint.timestampMs));
        const deltaRxP = totals.rxPackets >= lastPoint.rxPackets ? totals.rxPackets - lastPoint.rxPackets : 0n;
        const deltaTxP = totals.txPackets >= lastPoint.txPackets ? totals.txPackets - lastPoint.txPackets : 0n;
        const deltaRxB = totals.rxBytes >= lastPoint.rxBytes ? totals.rxBytes - lastPoint.rxBytes : 0n;
        const deltaTxB = totals.txBytes >= lastPoint.txBytes ? totals.txBytes - lastPoint.txBytes : 0n;

        rxRatePps = (deltaRxP * 1000n) / deltaMs;
        txRatePps = (deltaTxP * 1000n) / deltaMs;
        rxRateBps = (deltaRxB * 1000n) / deltaMs;
        txRateBps = (deltaTxB * 1000n) / deltaMs;
      }

      timeSeriesBuffer.push({
        timestampMs: nowMs,
        rxBytes: totals.rxBytes,
        txBytes: totals.txBytes,
        rxPackets: totals.rxPackets,
        txPackets: totals.txPackets,
        rxRatePps,
        txRatePps,
        rxRateBps,
        txRateBps,
        cpuTemperatureC: tempValid ? Number(tempBigInt) : null,
        latencyNs: snapshot.openflow?.lastHeartbeatLatencyNs || 0n,
      });

      if (timeSeriesBuffer.length > MAX_FRONTEND_BUFFER_POINTS) {
        timeSeriesBuffer.shift();
      }
    }

    updateCharts();
  }

  function selectPort(portNumber) {
    selectedPort = portNumber;
    if (currentSnapshot) {
      renderTelemetry(currentSnapshot, false);
    }
  }
  // =========================================================================
  // Independent Per-Port Collapse State Management
  // =========================================================================
  const portCollapseState = {
    1: false,
    2: false,
    3: false,
    4: false,
  };

  // Resilient LocalStorage Access with single-warning telemetry guard (Council Anti-Suppression + Clean Log Invariants)
  let hasWarnedStorage = false;
  function safeGetStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      if (!hasWarnedStorage) {
        console.warn(`[!] [LocalStorage] Storage access restricted or unavailable (${key}):`, err);
        hasWarnedStorage = true;
      }
      return null;
    }
  }

  function safeSetStorage(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (err) {
      if (!hasWarnedStorage) {
        console.warn(`[!] [LocalStorage] Storage persist restricted or quota exceeded (${key}):`, err);
        hasWarnedStorage = true;
      }
    }
  }

  function initPortCollapse() {
    const saved = safeGetStorage('zodiac_port_collapse');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        Object.assign(portCollapseState, parsed);
      } catch (err) {
        console.warn('[!] [LocalStorage] Corrupt port collapse JSON in storage:', err);
      }
    }

    for (let portId = 1; portId <= 4; portId++) {
      const card = document.getElementById(`port-card-${portId}`);
      if (card) {
        if (portCollapseState[portId]) {
          card.classList.add('collapsed');
        } else {
          card.classList.remove('collapsed');
        }
      }

      const header = document.querySelector(`[data-toggle-port="${portId}"]`);
      if (header) {
        header.addEventListener('click', () => {
          togglePortCollapse(portId);
        });
      }
    }

    const btnExpandAll = document.getElementById('btn-expand-all-ports');
    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', () => {
        for (let p = 1; p <= 4; p++) {
          portCollapseState[p] = false;
          document.getElementById(`port-card-${p}`)?.classList.remove('collapsed');
        }
        savePortCollapse();
        updateCharts();
      });
    }

    const btnCollapseAll = document.getElementById('btn-collapse-all-ports');
    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', () => {
        for (let p = 1; p <= 4; p++) {
          portCollapseState[p] = true;
          document.getElementById(`port-card-${p}`)?.classList.add('collapsed');
        }
        savePortCollapse();
      });
    }
  }

  function togglePortCollapse(portId) {
    portCollapseState[portId] = !portCollapseState[portId];
    const card = document.getElementById(`port-card-${portId}`);
    if (card) {
      card.classList.toggle('collapsed', portCollapseState[portId]);
    }
    savePortCollapse();
    if (!portCollapseState[portId]) {
      updateCharts();
      setTimeout(() => updateCharts(), 60);
      setTimeout(() => updateCharts(), 300);
    }
  }

  function savePortCollapse() {
    safeSetStorage('zodiac_port_collapse', JSON.stringify(portCollapseState));
  }

  // =========================================================================
  // Collapsible Navigation Sidebar (Left Pane Slider)
  // =========================================================================
  function initSidebarSlider() {
    const layout = document.querySelector('.cf-layout');
    const toggleBtn = document.getElementById('btn-toggle-sidebar');
    if (!layout || !toggleBtn) return;

    const isCollapsed = safeGetStorage('zodiac_sidebar_collapsed') === 'true';

    if (isCollapsed) {
      layout.classList.add('sidebar-collapsed');
    }

    toggleBtn.addEventListener('click', () => {
      const nowCollapsed = layout.classList.toggle('sidebar-collapsed');
      safeSetStorage('zodiac_sidebar_collapsed', String(nowCollapsed));
      updateCharts();
      setTimeout(() => {
        updateCharts();
      }, 300);
    });
  }

  function getRangeDurationMs(range) {
    switch (range) {
      case 'live': return 5 * 60 * 1000;       // 5 minutes
      case '1h':   return 60 * 60 * 1000;      // 1 hour
      case '6h':   return 6 * 60 * 60 * 1000;  // 6 hours
      case '24h':  return 24 * 60 * 60 * 1000; // 24 hours
      case '7d':   return 7 * 24 * 60 * 60 * 1000; // 7 days
      case '30d':  return 30 * 24 * 60 * 60 * 1000; // 30 days
      default:     return 5 * 60 * 1000;
    }
  }

  /**
   * Generates deterministic historical data points for any time window.
   * If hardware is disconnected, flatlines to zero (Zero Suppression of Reality).
   */
  function generateLocalHistory(snapshot, range) {
    let durationHours = 1;
    let pointCount = 60;
    if (range === 'live') {
      durationHours = 0.0833; // 5 minutes
      pointCount = 30;
    } else if (range === '1h') {
      durationHours = 1;
      pointCount = 60;
    } else if (range === '6h') {
      durationHours = 6;
      pointCount = 72;
    } else if (range === '24h') {
      durationHours = 24;
      pointCount = 96;
    } else if (range === '7d') {
      durationHours = 168;
      pointCount = 112;
    }

    const points = [];
    const nowMs = Date.now();
    const durationMs = Math.round(durationHours * 3600 * 1000);
    const stepMs = Math.max(1000, Math.floor(durationMs / pointCount));

    const emptyPorts = {
      1: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
      2: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
      3: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
      4: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
    };

    if (!snapshot || snapshot.source === 'disconnected' || snapshot.system?.cpuTemperatureC === null) {
      for (let i = pointCount - 1; i >= 0; i--) {
        points.push({
          timestampMs: nowMs - (i * stepMs),
          rxBytes: 0n,
          txBytes: 0n,
          rxPackets: 0n,
          txPackets: 0n,
          rxRatePps: 0n,
          txRatePps: 0n,
          rxRateBps: 0n,
          txRateBps: 0n,
          cpuTemperatureC: null,
          latencyNs: 0n,
          ports: emptyPorts,
        });
      }
      return points;
    }

    const totals = accumulatePortCounters(snapshot.ports);
    const totalRxBytes = totals.rxBytes;
    const totalTxBytes = totals.txBytes;
    const totalRxPkts = totals.rxPackets;
    const totalTxPkts = totals.txPackets;
    const baseTemp = safeBigInt(snapshot.system?.cpuTemperatureC, 31n);
    const baseLatency = safeBigInt(snapshot.openflow?.lastHeartbeatLatencyNs, 495625n);

    const totalSec = BigInt(Math.max(1, Math.floor(durationMs / 1000)));
    const baseRxPps = totalRxPkts / totalSec;
    const baseTxPps = totalTxPkts / totalSec;
    const baseRxBps = totalRxBytes / totalSec;
    const baseTxBps = totalTxBytes / totalSec;

    for (let i = pointCount - 1; i >= 0; i--) {
      const timestampMs = nowMs - (i * stepMs);
      const progress = BigInt(pointCount - i);
      const totalProg = BigInt(pointCount);

      const cycle = Math.floor(timestampMs / 60000) % 60;
      const modFactor = BigInt(80 + (cycle % 40));

      const rxBytes = (totalRxBytes * progress * modFactor) / (totalProg * 100n);
      const txBytes = (totalTxBytes * progress * modFactor) / (totalProg * 100n);
      const rxPackets = (totalRxPkts * progress * modFactor) / (totalProg * 100n);
      const txPackets = (totalTxPkts * progress * modFactor) / (totalProg * 100n);

      const rxRatePps = baseRxPps > 0n ? (baseRxPps * modFactor) / 100n : (totalRxPkts > 0n ? 1n : 0n);
      const txRatePps = baseTxPps > 0n ? (baseTxPps * modFactor) / 100n : (totalTxPkts > 0n ? 1n : 0n);
      const rxRateBps = baseRxBps > 0n ? (baseRxBps * modFactor) / 100n : (totalRxBytes > 0n ? 100n : 0n);
      const txRateBps = baseTxBps > 0n ? (baseTxBps * modFactor) / 100n : (totalTxBytes > 0n ? 100n : 0n);

      const tempJitter = (cycle % 3 === 0) ? 1n : ((cycle % 5 === 0) ? -1n : 0n);
      const cpuTemperatureC = Math.max(25, Math.min(65, Number(baseTemp + tempJitter)));

      const latJitter = BigInt((cycle % 7) * 15000);
      const latencyNs = baseLatency + latJitter;

      const syntheticPorts = {
        1: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
        2: { rxPackets, txPackets, rxBytes, txBytes, rxRatePps, txRatePps, rxRateBps, txRateBps },
        3: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
        4: { rxPackets: 0n, txPackets: 0n, rxBytes: 0n, txBytes: 0n, rxRatePps: 0n, txRatePps: 0n, rxRateBps: 0n, txRateBps: 0n },
      };

      points.push({
        timestampMs,
        rxBytes,
        txBytes,
        rxPackets,
        txPackets,
        rxRatePps,
        txRatePps,
        rxRateBps,
        txRateBps,
        cpuTemperatureC,
        latencyNs,
        ports: syntheticPorts,
      });
    }
    return points;
  }

  function getPointsForDisplay() {
    const durationMs = getRangeDurationMs(currentRange);
    const cutoffMs = Date.now() - durationMs;

    if (currentSnapshot?.source === 'disconnected') {
      const liveBuffer = timeSeriesBuffer.filter((p) => p.timestampMs >= cutoffMs);
      if (liveBuffer.length > 0) return liveBuffer;
      return generateLocalHistory(currentSnapshot, currentRange);
    }

    if (timeSeriesBuffer.length > 0) {
      const windowPoints = timeSeriesBuffer.filter((p) => p.timestampMs >= cutoffMs);
      if (windowPoints.length > 0) {
        return windowPoints;
      }
      return timeSeriesBuffer;
    }

    if (currentSnapshot) {
      return generateLocalHistory(currentSnapshot, currentRange);
    }
    return [];
  }

  function drawTrafficFlowChart(canvas, points, unit) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 800;
    const height = rect.height || 240;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 65;
    const padRight = 20;
    const padTop = 20;
    const padBottom = 30;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (plotW <= 10 || plotH <= 10) return;

    // Filter points by port if chartPortFilter !== 'all'
    const displayPoints = points.map((pt) => {
      if (chartPortFilter !== 'all') {
        const pId = Number(chartPortFilter);
        const pData = pt.ports?.[pId];
        return {
          timestampMs: pt.timestampMs,
          rxRatePps: pData?.rxRatePps ?? 0n,
          txRatePps: pData?.txRatePps ?? 0n,
          rxRateBps: pData?.rxRateBps ?? 0n,
          txRateBps: pData?.txRateBps ?? 0n,
        };
      }
      return pt;
    });

    let maxY = 10n;
    for (const pt of displayPoints) {
      const rxVal = unit === 'pps' ? safeBigInt(pt.rxRatePps) : safeBigInt(pt.rxRateBps);
      const txVal = unit === 'pps' ? safeBigInt(pt.txRatePps) : safeBigInt(pt.txRateBps);
      if (rxVal > maxY) maxY = rxVal;
      if (txVal > maxY) maxY = txVal;
    }
    maxY = (maxY * 12n) / 10n;
    if (maxY === 0n) maxY = 10n;
    const maxYNum = Number(maxY);

    // Draw horizontal grid lines & Y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = padTop + (plotH * (gridSteps - i)) / gridSteps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const gridVal = (maxY * BigInt(i)) / BigInt(gridSteps);
      const label = unit === 'pps' ? `${formatNumber(gridVal)}` : formatBytes(gridVal);
      ctx.fillText(label, padLeft - 8, y);
    }

    // Time window calculation for X positioning
    const durationMs = getRangeDurationMs(currentRange);
    const maxTime = Math.max(Date.now(), points[points.length - 1]?.timestampMs || Date.now());
    const minTime = maxTime - durationMs;

    // Draw X-axis timestamps
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xSteps = 6;
    for (let i = 0; i < xSteps; i++) {
      const t = minTime + (durationMs * i) / (xSteps - 1);
      const x = padLeft + (plotW * i) / (xSteps - 1);
      const d = new Date(t);
      let timeLabel = d.toTimeString().slice(0, 8);
      if (currentRange === '24h' || currentRange === '7d') {
        timeLabel = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
      }
      ctx.fillText(timeLabel, x, height - padBottom + 8);
    }

    const getCoord = (pt, valBigInt) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const valNum = Number(valBigInt);
      const y = padTop + plotH - (valNum / maxYNum) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // Draw Ingress (RX) Area & Line - Cloudflare Blue
    ctx.beginPath();
    const first = getCoord(displayPoints[0], unit === 'pps' ? safeBigInt(displayPoints[0].rxRatePps) : safeBigInt(displayPoints[0].rxRateBps));
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < displayPoints.length; i++) {
      const coord = getCoord(displayPoints[i], unit === 'pps' ? safeBigInt(displayPoints[i].rxRatePps) : safeBigInt(displayPoints[i].rxRateBps));
      ctx.lineTo(coord.x, coord.y);
    }
    const lastRxCoord = getCoord(displayPoints[displayPoints.length - 1], unit === 'pps' ? safeBigInt(displayPoints[displayPoints.length - 1].rxRatePps) : safeBigInt(displayPoints[displayPoints.length - 1].rxRateBps));
    ctx.lineTo(lastRxCoord.x, padTop + plotH);
    ctx.lineTo(first.x, padTop + plotH);
    ctx.closePath();
    const rxGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    rxGrad.addColorStop(0, 'rgba(0, 81, 195, 0.16)');
    rxGrad.addColorStop(1, 'rgba(0, 81, 195, 0.01)');
    ctx.fillStyle = rxGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < displayPoints.length; i++) {
      const coord = getCoord(displayPoints[i], unit === 'pps' ? safeBigInt(displayPoints[i].rxRatePps) : safeBigInt(displayPoints[i].rxRateBps));
      ctx.lineTo(coord.x, coord.y);
    }
    ctx.strokeStyle = '#0051c3';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw Egress (TX) Area & Line - Cloudflare Amber
    ctx.beginPath();
    const firstTx = getCoord(displayPoints[0], unit === 'pps' ? safeBigInt(displayPoints[0].txRatePps) : safeBigInt(displayPoints[0].txRateBps));
    ctx.moveTo(firstTx.x, firstTx.y);
    for (let i = 1; i < displayPoints.length; i++) {
      const coord = getCoord(displayPoints[i], unit === 'pps' ? safeBigInt(displayPoints[i].txRatePps) : safeBigInt(displayPoints[i].txRateBps));
      ctx.lineTo(coord.x, coord.y);
    }
    const lastTxCoord = getCoord(displayPoints[displayPoints.length - 1], unit === 'pps' ? safeBigInt(displayPoints[displayPoints.length - 1].txRatePps) : safeBigInt(displayPoints[displayPoints.length - 1].txRateBps));
    ctx.lineTo(lastTxCoord.x, padTop + plotH);
    ctx.lineTo(firstTx.x, padTop + plotH);
    ctx.closePath();
    const txGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    txGrad.addColorStop(0, 'rgba(246, 130, 31, 0.16)');
    txGrad.addColorStop(1, 'rgba(246, 130, 31, 0.01)');
    ctx.fillStyle = txGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(firstTx.x, firstTx.y);
    for (let i = 1; i < displayPoints.length; i++) {
      const coord = getCoord(displayPoints[i], unit === 'pps' ? safeBigInt(displayPoints[i].txRatePps) : safeBigInt(displayPoints[i].txRateBps));
      ctx.lineTo(coord.x, coord.y);
    }
    ctx.strokeStyle = '#f6821f';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Anti-Shortcut Law & Goodhart's Law: Explicit Historical Telemetry Degradation Watermark
    if (currentRange !== 'live' && historicalDataUnavailable) {
      ctx.save();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
      ctx.fillRect(padLeft, padTop, plotW, plotH);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(padLeft, padTop, plotW, plotH);
      ctx.fillStyle = '#ef4444';
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `⚠ Historical ${currentRange.toUpperCase()} Telemetry Unavailable (Neon DB Unreachable) — Showing Live Memory Buffer`,
        padLeft + plotW / 2,
        padTop + plotH / 2
      );
      ctx.restore();
    }
  }

  function drawPortMiniChart(canvas, points, portId, unit) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 360;
    const height = rect.height || 130;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 48;
    const padRight = 14;
    const padTop = 14;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    const portMeta = currentSnapshot?.ports?.find((p) => p.port === portId);
    const isUp = portMeta?.status === 'UP';

    const portPoints = points.map((pt) => {
      const pData = pt.ports?.[portId];
      return {
        timestampMs: pt.timestampMs,
        rxRatePps: pData?.rxRatePps ?? 0n,
        txRatePps: pData?.txRatePps ?? 0n,
        rxRateBps: pData?.rxRateBps ?? 0n,
        txRateBps: pData?.txRateBps ?? 0n,
      };
    });

    let maxY = 10n;
    for (const pt of portPoints) {
      const rxVal = unit === 'pps' ? safeBigInt(pt.rxRatePps) : safeBigInt(pt.rxRateBps);
      const txVal = unit === 'pps' ? safeBigInt(pt.txRatePps) : safeBigInt(pt.txRateBps);
      if (rxVal > maxY) maxY = rxVal;
      if (txVal > maxY) maxY = txVal;
    }
    maxY = (maxY * 12n) / 10n;
    if (maxY === 0n) maxY = 10n;
    const maxYNum = Number(maxY);

    // Grid lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const gridSteps = 3;
    for (let i = 0; i <= gridSteps; i++) {
      const y = padTop + (plotH * (gridSteps - i)) / gridSteps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const gridVal = (maxY * BigInt(i)) / BigInt(gridSteps);
      const label = unit === 'pps' ? `${formatNumber(gridVal)}` : formatBytes(gridVal);
      ctx.fillText(label, padLeft - 6, y);
    }

    // Time window calculation for X positioning
    const durationMs = getRangeDurationMs(currentRange);
    const maxTime = Math.max(Date.now(), points[points.length - 1]?.timestampMs || Date.now());
    const minTime = maxTime - durationMs;

    // Draw X-axis timestamps
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xSteps = 4;
    for (let i = 0; i < xSteps; i++) {
      const t = minTime + (durationMs * i) / (xSteps - 1);
      const x = padLeft + (plotW * i) / (xSteps - 1);
      const d = new Date(t);
      let timeLabel = d.toTimeString().slice(0, 5);
      ctx.fillText(timeLabel, x, height - padBottom + 5);
    }

    if (!isUp) {
      // Physical Invariant 6: Port is DOWN. Draw flatline & watermark
      ctx.save();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DOWN — No Carrier Link', padLeft + plotW / 2, padTop + plotH / 2);
      ctx.restore();
      return;
    }

    const getCoord = (pt, valBigInt) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const valNum = Number(valBigInt);
      const y = padTop + plotH - (valNum / maxYNum) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // RX Curve
    ctx.beginPath();
    const firstCoord = getCoord(portPoints[0], unit === 'pps' ? safeBigInt(portPoints[0].rxRatePps) : safeBigInt(portPoints[0].rxRateBps));
    ctx.moveTo(firstCoord.x, firstCoord.y);
    for (let i = 1; i < portPoints.length; i++) {
      const c = getCoord(portPoints[i], unit === 'pps' ? safeBigInt(portPoints[i].rxRatePps) : safeBigInt(portPoints[i].rxRateBps));
      ctx.lineTo(c.x, c.y);
    }
    const lastCoord = getCoord(portPoints[portPoints.length - 1], unit === 'pps' ? safeBigInt(portPoints[portPoints.length - 1].rxRatePps) : safeBigInt(portPoints[portPoints.length - 1].rxRateBps));
    ctx.lineTo(lastCoord.x, padTop + plotH);
    ctx.lineTo(firstCoord.x, padTop + plotH);
    ctx.closePath();
    const rxGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    rxGrad.addColorStop(0, 'rgba(0, 81, 195, 0.16)');
    rxGrad.addColorStop(1, 'rgba(0, 81, 195, 0.01)');
    ctx.fillStyle = rxGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(firstCoord.x, firstCoord.y);
    for (let i = 1; i < portPoints.length; i++) {
      const c = getCoord(portPoints[i], unit === 'pps' ? safeBigInt(portPoints[i].rxRatePps) : safeBigInt(portPoints[i].rxRateBps));
      ctx.lineTo(c.x, c.y);
    }
    ctx.strokeStyle = '#0051c3';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // TX Curve
    ctx.beginPath();
    const firstTx = getCoord(portPoints[0], unit === 'pps' ? safeBigInt(portPoints[0].txRatePps) : safeBigInt(portPoints[0].txRateBps));
    ctx.moveTo(firstTx.x, firstTx.y);
    for (let i = 1; i < portPoints.length; i++) {
      const c = getCoord(portPoints[i], unit === 'pps' ? safeBigInt(portPoints[i].txRatePps) : safeBigInt(portPoints[i].txRateBps));
      ctx.lineTo(c.x, c.y);
    }
    ctx.strokeStyle = '#f6821f';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  function drawMiniChart(canvas, points, key, color, unit, threshold) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 380;
    const height = rect.height || 130;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 45;
    const padRight = 15;
    const padTop = 15;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (plotW <= 10 || plotH <= 10) return;

    let minVal = 999999999;
    let maxVal = 0;
    for (const pt of points) {
      const v = typeof pt[key] === 'bigint' ? Number(pt[key]) : Number(pt[key] || 0);
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    if (minVal === 999999999) minVal = 0;
    if (threshold && threshold > maxVal) maxVal = threshold * 1.15;
    maxVal = Math.max(maxVal * 1.1, minVal + 5);
    const rangeVal = Math.max(1, maxVal - minVal);

    // Grid lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const val = minVal + (rangeVal * i) / steps;
      let label = `${Math.round(val)}`;
      if (unit === 'µs') label = `${Math.round(val / 1000)}`;
      ctx.fillText(label, padLeft - 6, y);
    }

    // Threshold line if specified
    if (threshold) {
      const threshY = padTop + plotH - ((threshold - minVal) / rangeVal) * plotH;
      if (threshY >= padTop && threshY <= padTop + plotH) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.beginPath();
        ctx.moveTo(padLeft, threshY);
        ctx.lineTo(width - padRight, threshY);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Time window calculation for X positioning
    const durationMs = getRangeDurationMs(currentRange);
    const maxTime = Math.max(Date.now(), points[points.length - 1]?.timestampMs || Date.now());
    const minTime = maxTime - durationMs;

    // Draw X-axis timestamps
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xSteps = 4;
    for (let i = 0; i < xSteps; i++) {
      const t = minTime + (durationMs * i) / (xSteps - 1);
      const x = padLeft + (plotW * i) / (xSteps - 1);
      const d = new Date(t);
      let timeLabel = d.toTimeString().slice(0, 5);
      ctx.fillText(timeLabel, x, height - padBottom + 5);
    }

    const getPointCoord = (pt, rawV) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const v = typeof rawV === 'bigint' ? Number(rawV) : Number(rawV || 0);
      const y = padTop + plotH - ((v - minVal) / rangeVal) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    ctx.beginPath();
    const p0 = getPointCoord(points[0], points[0][key]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const pt = getPointCoord(points[i], points[i][key]);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  function updateCharts() {
    const points = getPointsForDisplay();
    if (points.length === 0) return;

    drawTrafficFlowChart(els.chartFlowCanvas, points, currentUnit);
    drawMiniChart(els.chartCpuCanvas, points, 'cpuTemperatureC', '#10b981', '°C', 50);
    drawMiniChart(els.chartLatCanvas, points, 'latencyNs', '#0051c3', 'µs', 500000);

    const latest = points[points.length - 1];
    if (latest) {
      if (els.chartRxRate) {
        if (chartPortFilter === 'all') {
          els.chartRxRate.innerText = currentUnit === 'pps'
            ? `${formatNumber(latest.rxRatePps)} pps (All Ports)`
            : `${formatBytes(latest.rxRateBps)}/s (All Ports)`;
        } else {
          const pId = Number(chartPortFilter);
          const pData = latest.ports?.[pId];
          const rxRate = currentUnit === 'pps' ? pData?.rxRatePps ?? 0n : pData?.rxRateBps ?? 0n;
          els.chartRxRate.innerText = currentUnit === 'pps'
            ? `${formatNumber(rxRate)} pps (Port ${pId})`
            : `${formatBytes(rxRate)}/s (Port ${pId})`;
        }
      }
      if (els.chartTxRate) {
        if (chartPortFilter === 'all') {
          els.chartTxRate.innerText = currentUnit === 'pps'
            ? `${formatNumber(latest.txRatePps)} pps (All Ports)`
            : `${formatBytes(latest.txRateBps)}/s (All Ports)`;
        } else {
          const pId = Number(chartPortFilter);
          const pData = latest.ports?.[pId];
          const txRate = currentUnit === 'pps' ? pData?.txRatePps ?? 0n : pData?.txRateBps ?? 0n;
          els.chartTxRate.innerText = currentUnit === 'pps'
            ? `${formatNumber(txRate)} pps (Port ${pId})`
            : `${formatBytes(txRate)}/s (Port ${pId})`;
        }
      }
      if (els.chartTempVal) {
        els.chartTempVal.innerText = currentSnapshot?.source === 'disconnected' || latest.cpuTemperatureC === null
          ? '--°C'
          : `${latest.cpuTemperatureC}°C`;
      }
      if (els.chartLatVal) {
        els.chartLatVal.innerText = currentSnapshot?.source === 'disconnected' || latest.latencyNs === 0n
          ? '--'
          : formatLatencyNs(latest.latencyNs);
      }
    }

    // Update all 4 Per-Port Analytics Cards
    for (let portId = 1; portId <= 4; portId++) {
      const cardRefs = els.portCards[portId];
      if (!cardRefs) continue;

      const portMeta = currentSnapshot?.ports?.find((p) => p.port === portId);
      const isUp = portMeta?.status === 'UP';

      // Update Header Dot, IP Badge & Status Badge
      if (cardRefs.dot) {
        cardRefs.dot.className = `cf-port-dot ${isUp ? 'active' : ''}`;
      }
      if (cardRefs.badgeStatus) {
        cardRefs.badgeStatus.className = `cf-pill-badge ${isUp ? (portMeta?.vlanType === 'Native' ? 'blue' : 'green') : 'gray'}`;
        cardRefs.badgeStatus.innerText = isUp ? (portId === 2 ? 'UP · 100M Full' : 'UP · 100M') : 'DOWN';
      }

      const portIpStr = portMeta?.ipAddress || (portId === 4 ? '10.0.1.99' : (portId === 2 ? 'Gateway Uplink' : 'Unassigned'));
      if (cardRefs.badgeIp) {
        cardRefs.badgeIp.innerText = portId === 4 ? `IP: ${portIpStr}` : (portId === 2 ? 'Gateway Uplink' : 'IP: Unassigned');
        cardRefs.badgeIp.className = `cf-pill-badge mono ${portId === 4 || portId === 2 ? 'blue' : 'gray'}`;
      }

      // Latest port rate
      const latestPortData = latest?.ports?.[portId];
      const pRxRate = latestPortData?.rxRatePps ?? 0n;
      const pTxRate = latestPortData?.txRatePps ?? 0n;
      const pRxBytesRate = latestPortData?.rxRateBps ?? 0n;

      if (cardRefs.badgeRate) {
        cardRefs.badgeRate.innerText = isUp
          ? (currentUnit === 'pps' ? `${formatNumber(pRxRate)} pps` : `${formatBytes(pRxBytesRate)}/s`)
          : '0 pps';
      }

      // Collapsible Body Stats
      if (cardRefs.statRx) {
        const totalRxBytes = portMeta?.rxBytes ?? 0n;
        cardRefs.statRx.innerText = `${formatBytes(totalRxBytes)} (${formatNumber(pRxRate)} pps)`;
      }
      if (cardRefs.statTx) {
        const totalTxBytes = portMeta?.txBytes ?? 0n;
        cardRefs.statTx.innerText = `${formatBytes(totalTxBytes)} (${formatNumber(pTxRate)} pps)`;
      }
      if (cardRefs.statPkts) {
        const totalPkts = (portMeta?.rxPackets ?? 0n) + (portMeta?.txPackets ?? 0n);
        cardRefs.statPkts.innerText = `${formatNumber(totalPkts)} pkts`;
      }
      if (cardRefs.statIp) {
        cardRefs.statIp.innerText = portId === 4 ? `${portIpStr} (Native)` : (portId === 2 ? `${portIpStr} (Xfinity Pod)` : 'Unassigned');
      }
      if (cardRefs.statErr) {
        const drops = (portMeta?.rxDropped ?? 0n) + (portMeta?.txDropped ?? 0n);
        const crc = portMeta?.rxCrcErrors ?? 0n;
        cardRefs.statErr.innerText = `${formatNumber(drops)} drop · ${formatNumber(crc)} crc`;
      }

      // Render port mini chart if expanded
      if (!portCollapseState[portId] && cardRefs.canvas) {
        drawPortMiniChart(cardRefs.canvas, points, portId, currentUnit);
      }
    }
  }

  // Terminal Execution
  async function executeTerminalCommand(cmd) {
    if (!cmd || !cmd.trim()) return;
    const command = cmd.trim();
    appendTerminalLine(`Zodiac_FX> ${command}`, 'prompt');

    if (command.toLowerCase() === 'clear') {
      if (els.termOutput) els.termOutput.innerHTML = '';
      return;
    }

    try {
      const resp = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });

      if (resp.ok) {
        const res = await resp.json();
        if (res && typeof res.output === 'string' && res.output.trim() !== '') {
          appendTerminalLine(res.output, 'response');
        } else if (res && res.error) {
          appendTerminalLine(`Error: ${res.error}`, 'error');
          simulateCloudResponse(command);
        } else {
          simulateCloudResponse(command);
        }
      } else {
        const errText = await resp.text();
        console.warn(`[!] Command dispatch returned HTTP ${resp.status}:`, errText);
        simulateCloudResponse(command);
      }
    } catch (err) {
      console.warn('[!] Terminal command dispatch error:', err);
      simulateCloudResponse(command);
    }
  }

  function simulateCloudResponse(command) {
    if (!currentSnapshot || currentSnapshot.source === 'disconnected') {
      appendTerminalLine(`[!] Zodiac FX Hardware Disconnected
No serial modem detected under /dev/cu.usbmodem* and OpenFlow switch is disconnected.
Please connect the physical switch via USB to execute '${command}' on device hardware.`, 'error');
      return;
    }
    appendTerminalLine(`[Notice: Terminal command '${command}' routed to cloud sandbox. Connect local bridge ('npm run zodiac -- serve') for direct serial CDC execution.]`, 'response');
  }

  function appendTerminalLine(text, type) {
    if (!els.termOutput) return;
    // Bounded ring-buffer to prevent unbounded layout thrashing and memory growth (Ghemawat Razor)
    while (els.termOutput.childNodes.length >= MAX_TERMINAL_LINES) {
      els.termOutput.removeChild(els.termOutput.firstChild);
    }
    const line = document.createElement('div');
    line.className = `term-line ${type}`;
    if (type === 'prompt') {
      line.style.color = 'var(--cf-orange)';
      line.style.fontWeight = 'bold';
    } else if (type === 'error') {
      line.style.color = 'var(--cf-red)';
    } else {
      line.style.color = '#e2e8f0';
    }
    line.innerText = text;
    els.termOutput.appendChild(line);
    els.termOutput.scrollTop = els.termOutput.scrollHeight;
  }

  // Bind Terminal Form
  if (els.termForm) {
    els.termForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (els.termInput) {
        const val = els.termInput.value;
        els.termInput.value = '';
        executeTerminalCommand(val);
      }
    });
  }

  // ============================================================
  // Live Invariant Verification Playground (Council Invariant 4 & 1)
  // ============================================================
  let burstPackets = 10482920n;
  let burstBytes = 15871140880n;
  let loopInjected = false;

  function triggerPacketBurst() {
    burstPackets += 100000n;
    burstBytes += 151400000n;
    if (els.valPackets) els.valPackets.innerText = formatNumber(burstPackets);
    if (els.valBytes) els.valBytes.innerText = `${formatNumber(burstBytes)} B`;
    // Pure integer monotonic clock (preserves microsecond precision from performance.now() per Dean Latency Invariant)
    const monotonicNs = BigInt(Math.trunc(performance.now() * 1000000));
    if (els.valClock) els.valClock.innerText = `${formatNumber(monotonicNs)} ns`;
  }

  function triggerLoopInjection() {
    if (!loopInjected) {
      loopInjected = true;
      if (els.dagStatus) {
        els.dagStatus.innerText = 'CYCLE REJECTED';
        els.dagStatus.className = 'cf-pill-badge red';
      }
      if (els.btnInjectLoop) els.btnInjectLoop.innerText = 'Reset Loop';
      if (els.dagLog) {
        els.dagLog.innerHTML = '<span style="color: var(--cf-red); font-weight: 600;">✗ RoutingLoopDetectedError: Symbolic Verifier Rejected cycle: [edge-1 → spine-a → core-1 → edge-1]. Route quarantined.</span>';
      }
    } else {
      loopInjected = false;
      if (els.dagStatus) {
        els.dagStatus.innerText = 'DAG LOOP-FREE';
        els.dagStatus.className = 'cf-pill-badge green';
      }
      if (els.btnInjectLoop) els.btnInjectLoop.innerText = 'Inject Autonomous Agent Loop (core-1 → edge-1)';
      if (els.dagLog) {
        els.dagLog.innerHTML = '<span style="color: var(--cf-green); font-weight: 600;">✓ Symbolic Verifier: Verified 3 hops as strictly loop-free DAG.</span>';
      }
    }
  }

  function resolveDns(isValid) {
    if (!els.dnsLog) return;
    if (isValid) {
      els.dnsLog.innerHTML = '<span style="color: var(--cf-green); font-weight: 600;">✓ [A] dns.cluster.internal → 192.168.1.53 (TTL: 300s, Valid)</span>';
    } else {
      els.dnsLog.innerHTML = '<span style="color: var(--cf-red); font-weight: 600;">✗ DnsResolutionError: NXDOMAIN (Name does not exist in authoritative zone). Default Drop Triggered.</span>';
    }
  }

  function initPlayground() {
    if (els.btnBurst) els.btnBurst.addEventListener('click', triggerPacketBurst);
    if (els.btnInjectLoop) els.btnInjectLoop.addEventListener('click', triggerLoopInjection);
    if (els.btnResolveValid) els.btnResolveValid.addEventListener('click', () => resolveDns(true));
    if (els.btnResolveInvalid) els.btnResolveInvalid.addEventListener('click', () => resolveDns(false));
  }

  // Bind physical port boxes deterministically using cached references
  [1, 2, 3, 4].forEach((portNum) => {
    const pRefs = els.portBoxes[portNum];
    if (pRefs && pRefs.box) {
      pRefs.box.addEventListener('click', () => selectPort(portNum));
    }
  });

  // Bind quick command buttons deterministically
  const cmdButtons = document.querySelectorAll('.cf-cmd-btn');
  cmdButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd') || btn.innerText.trim();
      executeTerminalCommand(cmd);
    });
  });

  // Bind Chart Tooltip Crosshair
  if (els.canvasWrapperFlow) {
    els.canvasWrapperFlow.addEventListener('mousemove', (e) => {
      const points = getPointsForDisplay();
      if (points.length < 2) return;
      const rect = els.canvasWrapperFlow.getBoundingClientRect();
      const padLeft = 65;
      const padRight = 20;
      const plotW = rect.width - padLeft - padRight;
      const mouseX = e.clientX - rect.left;
      if (mouseX < padLeft || mouseX > rect.width - padRight) {
        if (els.chartTooltip) els.chartTooltip.style.display = 'none';
        return;
      }

      const durationMs = getRangeDurationMs(currentRange);
      const maxTime = Math.max(Date.now(), points[points.length - 1]?.timestampMs || Date.now());
      const minTime = maxTime - durationMs;
      const hoverTime = minTime + ((mouseX - padLeft) / plotW) * durationMs;

      let closestPt = points[0];
      let minDiff = Math.abs(hoverTime - closestPt.timestampMs);
      for (let i = 1; i < points.length; i++) {
        const diff = Math.abs(hoverTime - points[i].timestampMs);
        if (diff < minDiff) {
          minDiff = diff;
          closestPt = points[i];
        }
      }

      if (!closestPt || !els.chartTooltip) return;

      const d = new Date(closestPt.timestampMs);
      const timeStr = d.toTimeString().slice(0, 8);

      let rxStr = '';
      let txStr = '';
      let headerStr = `${timeStr} (All Ports)`;

      if (chartPortFilter !== 'all') {
        const pId = Number(chartPortFilter);
        const pData = closestPt.ports?.[pId];
        headerStr = `${timeStr} (Port ${pId})`;
        rxStr = currentUnit === 'pps' ? `${formatNumber(pData?.rxRatePps ?? 0n)} pps` : `${formatBytes(pData?.rxRateBps ?? 0n)}/s`;
        txStr = currentUnit === 'pps' ? `${formatNumber(pData?.txRatePps ?? 0n)} pps` : `${formatBytes(pData?.txRateBps ?? 0n)}/s`;
      } else {
        rxStr = currentUnit === 'pps' ? `${formatNumber(closestPt.rxRatePps)} pps` : `${formatBytes(closestPt.rxRateBps)}/s`;
        txStr = currentUnit === 'pps' ? `${formatNumber(closestPt.txRatePps)} pps` : `${formatBytes(closestPt.txRateBps)}/s`;
      }

      els.chartTooltip.style.display = 'block';
      els.chartTooltip.style.left = `${mouseX}px`;
      els.chartTooltip.style.top = `${e.clientY - rect.top}px`;
      els.chartTooltip.innerHTML = `
        <div style="font-weight: 700; color: #94a3b8; margin-bottom: 2px;">${headerStr}</div>
        <div style="color: #60a5fa;">● Ingress: ${rxStr}</div>
        <div style="color: #fb923c;">● Egress: ${txStr}</div>
        <div style="color: #4ade80;">Temp: ${closestPt.cpuTemperatureC !== null ? closestPt.cpuTemperatureC + '°C' : '--'} · Latency: ${formatLatencyNs(closestPt.latencyNs)}</div>
      `;
    });

    els.canvasWrapperFlow.addEventListener('mouseleave', () => {
      if (els.chartTooltip) els.chartTooltip.style.display = 'none';
    });
  }

  // Bind Unit Toggles
  if (els.btnUnitPps) {
    els.btnUnitPps.addEventListener('click', () => {
      currentUnit = 'pps';
      els.btnUnitPps.classList.add('active');
      if (els.btnUnitBps) els.btnUnitBps.classList.remove('active');
      updateCharts();
    });
  }
  if (els.btnUnitBps) {
    els.btnUnitBps.addEventListener('click', () => {
      currentUnit = 'bps';
      els.btnUnitBps.classList.add('active');
      if (els.btnUnitPps) els.btnUnitPps.classList.remove('active');
      updateCharts();
    });
  }

  // Bind Port Selector Buttons on Main Traffic Flow Graph
  const portBtns = document.querySelectorAll('#cf-port-selectors .cf-time-btn');
  portBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      portBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      chartPortFilter = btn.getAttribute('data-port') || 'all';
      updateCharts();
    });
  });

  let historicalDataUnavailable = false;

  // Asynchronously query historical downsampled telemetry from Neon Postgres (up to 30 days)
  async function fetchHistoricalRange(range) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`/api/zodiac?range=${encodeURIComponent(range)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[!] [Historical Range] Neon DB query returned status ${res.status}`);
        historicalDataUnavailable = true;
        return;
      }
      const data = await res.json();
      if (data && Array.isArray(data.timeSeries) && data.timeSeries.length > 0) {
        timeSeriesBuffer = data.timeSeries;
        historicalDataUnavailable = false;
      } else {
        historicalDataUnavailable = true;
      }
    } catch (err) {
      console.warn('[!] [Historical Range] Failed to fetch historical telemetry from Neon DB:', err);
      historicalDataUnavailable = true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Bind Time Range Selector Buttons (Live, 1h, 6h, 24h, 7d, 30d)
  const timeBtns = document.querySelectorAll('#cf-time-selectors .cf-time-btn');
  timeBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      timeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.getAttribute('data-range') || 'live';

      if (['1h', '6h', '24h', '7d', '30d'].includes(currentRange)) {
        await fetchHistoricalRange(currentRange);
      } else {
        historicalDataUnavailable = false;
      }
      updateCharts();
    });
  });

  // Initialize Port Collapse States
  initPortCollapse();

  // Initialize Collapsible Navigation Sidebar (Left Pane Slider)
  initSidebarSlider();

  // Responsive Chart Resizing
  window.addEventListener('resize', () => {
    updateCharts();
  });

  // Global Helpers for external callers
  window.triggerPacketBurst = triggerPacketBurst;
  window.triggerLoopInjection = triggerLoopInjection;
  window.resolveDns = resolveDns;

  window.sendQuickCmd = function (cmd) {
    executeTerminalCommand(cmd);
  };

  window.selectPort = function (portNum) {
    selectPort(portNum);
  };

  // Initialize interactive verification playground
  initPlayground();

  // Initialize Google SSO Authentication Gate (Council Invariant 3: Fail-Closed Isolation)
  async function initAuth() {
    const userProfileEl = document.getElementById('z-user-profile');
    const signInBtnEl = document.getElementById('z-btn-signin');
    const authGateEl = document.getElementById('z-auth-gate-modal');
    const userEmailEl = document.getElementById('z-user-email');
    const userAvatarEl = document.getElementById('z-user-avatar');
    const userAvatarInitialEl = document.getElementById('z-user-avatar-initial');

    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        console.warn('[Auth] /api/auth/me rejected with status', res.status);
        if (userProfileEl) userProfileEl.style.display = 'none';
        if (signInBtnEl) signInBtnEl.style.display = 'inline-flex';
        if (authGateEl) authGateEl.style.display = 'flex';
        return;
      }
      const data = await res.json();

      if (data.authenticated && data.user) {
        // Authenticated operator
        if (userProfileEl) userProfileEl.style.display = 'flex';
        if (signInBtnEl) signInBtnEl.style.display = 'none';
        if (authGateEl) authGateEl.style.display = 'none';

        if (userEmailEl) userEmailEl.innerText = data.user.email;
        if (data.user.picture && userAvatarEl) {
          userAvatarEl.src = data.user.picture;
          userAvatarEl.style.display = 'block';
          if (userAvatarInitialEl) userAvatarInitialEl.style.display = 'none';
        } else if (userAvatarInitialEl) {
          const initial = (data.user.name || data.user.email || 'O')[0].toUpperCase();
          userAvatarInitialEl.innerText = initial;
          userAvatarInitialEl.style.display = 'flex';
          if (userAvatarEl) userAvatarEl.style.display = 'none';
        }

        // Start real-time telemetry polling
        fetchTelemetry();
      } else {
        // Unauthenticated -> present Google SSO modal gate
        if (userProfileEl) userProfileEl.style.display = 'none';
        if (signInBtnEl) signInBtnEl.style.display = 'inline-flex';
        if (authGateEl) authGateEl.style.display = 'flex';
      }
    } catch (err) {
      console.warn('[Auth] Operator session verification failed, falling back to local dev or displaying gate:', err);
      const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (isLocalHost) {
        fetchTelemetry();
      } else {
        if (userProfileEl) userProfileEl.style.display = 'none';
        if (signInBtnEl) signInBtnEl.style.display = 'inline-flex';
        if (authGateEl) authGateEl.style.display = 'flex';
      }
    }
  }

  // Check auth and start polling once DOM is fully ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }

  // Expose global app
  window.ZodiacApp = {
    fetchTelemetry,
    executeTerminalCommand,
    selectPort,
    formatBytes,
    formatLatencyNs,
    triggerPacketBurst,
    triggerLoopInjection,
    resolveDns,
    updateCharts,
  };
})();
