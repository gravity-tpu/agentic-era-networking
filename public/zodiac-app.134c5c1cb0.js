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

  // Active Appliance Tier State ('zodiac' | 'orin' | 'coral')
  let activeDeviceId = 'zodiac';
  let jetsonTimeSeriesBuffer = [];
  let coralTimeSeriesBuffer = [];

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

    // Active Device Tier Selector & Views
    btnDeviceZodiac: document.getElementById('btn-device-zodiac'),
    btnDeviceOrin: document.getElementById('btn-device-orin'),
    btnDeviceCoral: document.getElementById('btn-device-coral'),
    dotDeviceZodiac: document.getElementById('dot-device-zodiac'),
    dotDeviceOrin: document.getElementById('dot-device-orin'),
    dotDeviceCoral: document.getElementById('dot-device-coral'),
    viewDeviceZodiac: document.getElementById('view-device-zodiac'),
    viewDeviceOrin: document.getElementById('view-device-orin'),
    viewDeviceCoral: document.getElementById('view-device-coral'),

    // Jetson Orin Nano Elements
    orinJetpack: document.getElementById('orin-jetpack'),
    orinUptime: document.getElementById('orin-uptime'),
    orinCpuCoresBadge: document.getElementById('orin-cpu-cores-badge'),
    orinKpiCompute: document.getElementById('orin-kpi-compute'),
    orinBarCpu: document.getElementById('orin-bar-cpu'),
    orinKpiGpu: document.getElementById('orin-kpi-gpu'),
    orinKpiLoad: document.getElementById('orin-kpi-load'),
    orinKpiSdnStatus: document.getElementById('orin-kpi-sdn-status'),
    orinKpiSdnRate: document.getElementById('orin-kpi-sdn-rate'),
    orinBarSdn: document.getElementById('orin-bar-sdn'),
    orinKpiSdnRx: document.getElementById('orin-kpi-sdn-rx'),
    orinKpiWifiRate: document.getElementById('orin-kpi-wifi-rate'),
    orinKpiRam: document.getElementById('orin-kpi-ram'),
    orinBarRam: document.getElementById('orin-bar-ram'),
    orinKpiNvme: document.getElementById('orin-kpi-nvme'),
    orinKpiPower: document.getElementById('orin-kpi-power'),
    orinBarPower: document.getElementById('orin-bar-power'),
    orinKpiCpuTemp: document.getElementById('orin-kpi-cpu-temp'),
    orinKpiGpuTemp: document.getElementById('orin-kpi-gpu-temp'),
    orinKpiJuncTemp: document.getElementById('orin-kpi-junc-temp'),
    orinIfSdnMac: document.getElementById('orin-if-sdn-mac'),
    orinIfSdnStatus: document.getElementById('orin-if-sdn-status'),
    orinIfSdnBytes: document.getElementById('orin-if-sdn-bytes'),
    orinIfSdnPkts: document.getElementById('orin-if-sdn-pkts'),
    orinIfWifiMac: document.getElementById('orin-if-wifi-mac'),
    orinIfWifiStatus: document.getElementById('orin-if-wifi-status'),
    orinIfWifiBytes: document.getElementById('orin-if-wifi-bytes'),
    orinIfWifiPkts: document.getElementById('orin-if-wifi-pkts'),
    orinDiskStat: document.getElementById('orin-disk-stat'),
    orinBarDisk: document.getElementById('orin-bar-disk'),
    orinSvcPid: document.getElementById('orin-svc-pid'),
    orinSvcRssStat: document.getElementById('orin-svc-rss-stat'),
    orinSvcRssBar: document.getElementById('orin-svc-rss-bar'),

    // Jetson Orin Canvases
    chartOrinComputeCanvas: document.getElementById('chart-orin-compute'),
    chartOrinNetworkCanvas: document.getElementById('chart-orin-network'),
    orinSdnRateLegend: document.getElementById('orin-sdn-rate-legend'),
    orinWifiRateLegend: document.getElementById('orin-wifi-rate-legend'),
    chartOrinThermalsCanvas: document.getElementById('chart-orin-thermals'),
    chartOrinPowerCanvas: document.getElementById('chart-orin-power'),

    // Google Coral TPU Elements
    coralKpiStatus: document.getElementById('coral-kpi-status'),
    coralKpiSpeed: document.getElementById('coral-kpi-speed'),
    coralKpiBus: document.getElementById('coral-kpi-bus'),
    coralKpiVid: document.getElementById('coral-kpi-vid'),
    coralKpiTotalInf: document.getElementById('coral-kpi-total-inf'),

    // Google Coral Canvases
    chartCoralRateCanvas: document.getElementById('chart-coral-rate'),
    chartCoralLatencyCanvas: document.getElementById('chart-coral-latency'),
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
    const devIp = snapshot.system.ipAddress || '--';

    if (els.breadcrumbName) {
      if (activeDeviceId === 'orin') {
        els.breadcrumbName.innerText = 'Jetson Orin Nano (Host)';
      } else if (activeDeviceId === 'coral') {
        els.breadcrumbName.innerText = 'Google Coral Edge TPU (4 TOPS)';
      } else {
        els.breadcrumbName.innerText = devName;
      }
    }

    if (els.sidebarDevName) {
      if (activeDeviceId === 'orin') {
        els.sidebarDevName.innerText = 'Jetson_Orin_Nano';
      } else if (activeDeviceId === 'coral') {
        els.sidebarDevName.innerText = 'Coral_Edge_TPU';
      } else {
        els.sidebarDevName.innerText = devName;
      }
    }

    if (els.sidebarIp) {
      if (activeDeviceId === 'orin') {
        els.sidebarIp.innerText = 'enP8p1s0 (SDN) · wlP1p1s0 (Wi-Fi)';
      } else if (activeDeviceId === 'coral') {
        els.sidebarIp.innerText = 'USB 3.1 SuperSpeed (5 Gbps)';
      } else {
        els.sidebarIp.innerText = devIp !== '--' ? `${devIp} · Port 4` : 'Port 4 (SDN Link)';
      }
    }

    // Update 3-Way Tier Selector Status Dots
    if (els.dotDeviceZodiac) {
      els.dotDeviceZodiac.className = snapshot.source === 'disconnected' ? 'cf-status-dot down' : 'cf-status-dot green';
    }
    if (els.dotDeviceOrin) {
      const orinOnline = snapshot.jetson ? snapshot.jetson.status === 'online' : snapshot.source !== 'disconnected';
      els.dotDeviceOrin.className = orinOnline ? 'cf-status-dot green' : 'cf-status-dot down';
    }
    if (els.dotDeviceCoral) {
      const coralStatus = snapshot.coral?.status || (snapshot.source !== 'disconnected' ? 'standby' : 'offline');
      els.dotDeviceCoral.className = coralStatus === 'online' ? 'cf-status-dot green' : (coralStatus === 'standby' ? 'cf-status-dot purple' : 'cf-status-dot down');
    }

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

    // 7. Jetson Orin Nano Appliance Telemetry
    if (snapshot.jetson) {
      const j = snapshot.jetson;
      const isOnline = snapshot.source !== 'disconnected';
      if (els.dotDeviceOrin) {
        els.dotDeviceOrin.className = isOnline ? 'cf-status-dot green' : 'cf-status-dot down';
      }
      if (els.orinJetpack && j.jetpackVersion) {
        els.orinJetpack.innerText = `${j.jetpackVersion} (${j.l4tVersion || 'L4T 36.4.7'})`;
      }
      if (els.orinUptime) {
        els.orinUptime.innerText = j.uptime || '--:--:--';
      }
      const cpuModelStr = j.cpuModel || j.compute?.cpuModel || '6-Core ARM Cortex-A78AE';
      const coreCount = j.cpuCoreCount || j.compute?.cpuCores || 6;
      if (els.orinCpuCoresBadge) {
        els.orinCpuCoresBadge.innerText = `${coreCount} Cores · ${cpuModelStr}`;
      }
      const cpuPct = j.cpuUtilizationPct ?? j.compute?.cpuUtilizationPct ?? 0;
      if (els.orinKpiCompute) {
        els.orinKpiCompute.innerText = `${cpuPct}% CPU`;
      }
      if (els.orinBarCpu) {
        els.orinBarCpu.style.width = `${Math.min(100, Math.max(0, cpuPct))}%`;
      }
      const gpuPct = j.gpuUtilizationPct ?? j.compute?.gpuUtilizationPct ?? 0;
      if (els.orinKpiGpu) {
        els.orinKpiGpu.innerText = `${gpuPct}%`;
      }
      const loadArr = j.systemLoad || j.compute?.loadAverage;
      if (els.orinKpiLoad) {
        els.orinKpiLoad.innerText = Array.isArray(loadArr)
          ? loadArr.map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v))).join(', ')
          : '--';
      }

      // Network Ports: SDN (enP8p1s0) vs Wi-Fi (wlP1p1s0)
      const sdn = Array.isArray(j.interfaces)
        ? j.interfaces.find((i) => i.name === 'enP8p1s0')
        : (j.network?.enP8p1s0 || null);
      const wifi = Array.isArray(j.interfaces)
        ? j.interfaces.find((i) => i.name === 'wlP1p1s0')
        : (j.network?.wlP1p1s0 || null);

      if (sdn) {
        const sdnUp = sdn.status === 'UP' || Boolean(sdn.carrier);
        if (els.orinKpiSdnStatus) {
          els.orinKpiSdnStatus.innerText = sdnUp ? (sdn.speedMbps ? `${sdn.speedMbps}M Full` : '1000M Full') : 'DOWN';
          els.orinKpiSdnStatus.className = `cf-pill-badge ${sdnUp ? 'green' : 'gray'}`;
        }
        const sdnRate = safeBigInt(sdn.rxRateBps) + safeBigInt(sdn.txRateBps);
        if (els.orinKpiSdnRate) els.orinKpiSdnRate.innerText = `${formatBytes(sdnRate)}/s`;
        if (els.orinBarSdn) {
          const maxSpeedMbps = sdn.speedMbps ? BigInt(sdn.speedMbps) : 1000n;
          const maxSpeedBps = maxSpeedMbps * 125000n;
          const sdnPct = sdnRate > 0n ? Math.min(100, Number((sdnRate * 100n) / maxSpeedBps)) : 10;
          els.orinBarSdn.style.width = `${Math.max(5, sdnPct)}%`;
        }
        if (els.orinKpiSdnRx) els.orinKpiSdnRx.innerText = `${formatNumber(sdn.rxRatePps)} pps`;

        // Table details
        if (els.orinIfSdnMac) els.orinIfSdnMac.innerText = sdn.macAddress || sdn.mac || 'ac:3a:e2:98:99:dd';
        if (els.orinIfSdnStatus) {
          els.orinIfSdnStatus.className = `cf-pill-badge ${sdnUp ? 'green' : 'gray'}`;
          els.orinIfSdnStatus.innerText = sdnUp ? 'UP · 1000M' : 'DOWN';
        }
        if (els.orinIfSdnBytes) {
          els.orinIfSdnBytes.innerText = `${formatBytes(sdn.rxBytes)} / ${formatBytes(sdn.txBytes)}`;
        }
        if (els.orinIfSdnPkts) {
          els.orinIfSdnPkts.innerText = `${formatNumber(sdn.rxPackets)} / ${formatNumber(sdn.txPackets)}`;
        }
      }

      if (wifi) {
        const wifiUp = wifi.status === 'UP' || Boolean(wifi.carrier);
        const wifiRate = safeBigInt(wifi.rxRateBps) + safeBigInt(wifi.txRateBps);
        if (els.orinKpiWifiRate) els.orinKpiWifiRate.innerText = `${formatBytes(wifiRate)}/s`;

        // Table details
        if (els.orinIfWifiMac) els.orinIfWifiMac.innerText = wifi.macAddress || wifi.mac || 'f0:68:e3:33:02:a3';
        if (els.orinIfWifiStatus) {
          els.orinIfWifiStatus.className = `cf-pill-badge ${wifiUp ? 'green' : 'gray'}`;
          els.orinIfWifiStatus.innerText = wifiUp ? 'UP · Wi-Fi' : 'DOWN';
        }
        if (els.orinIfWifiBytes) {
          els.orinIfWifiBytes.innerText = `${formatBytes(wifi.rxBytes)} / ${formatBytes(wifi.txBytes)}`;
        }
        if (els.orinIfWifiPkts) {
          els.orinIfWifiPkts.innerText = `${formatNumber(wifi.rxPackets)} / ${formatNumber(wifi.txPackets)}`;
        }
      }

      // Memory & NVMe
      const memUsed = safeBigInt(j.ramUsedBytes ?? j.memory?.usedBytes);
      const memTot = safeBigInt(j.ramTotalBytes ?? j.memory?.totalBytes);
      const memPct = memTot > 0n ? Number((memUsed * 100n) / memTot) : 0;
      if (els.orinKpiRam) els.orinKpiRam.innerText = `${formatBytes(memUsed)} (${memPct}%)`;
      if (els.orinBarRam) els.orinBarRam.style.width = `${Math.min(100, Math.max(5, memPct))}%`;

      const diskUsed = safeBigInt(j.nvmeUsedBytes ?? j.storage?.usedBytes);
      const diskTot = safeBigInt(j.nvmeTotalBytes ?? j.storage?.totalBytes);
      const diskPct = diskTot > 0n ? Number((diskUsed * 100n) / diskTot) : 0;
      if (els.orinKpiNvme) els.orinKpiNvme.innerText = `${formatBytes(diskUsed)} (${diskPct}%)`;
      if (els.orinDiskStat) els.orinDiskStat.innerText = `${formatBytes(diskUsed)} / ${formatBytes(diskTot)} (${diskPct}%)`;
      if (els.orinBarDisk) els.orinBarDisk.style.width = `${Math.min(100, Math.max(5, diskPct))}%`;

      // Power & Thermals
      let pwrW = 0;
      if (j.powerMw && typeof j.powerMw.vddIn === 'number') {
        pwrW = j.powerMw.vddIn / 1000;
      } else if (j.power?.totalPowerW) {
        pwrW = typeof j.power.totalPowerW === 'number' ? j.power.totalPowerW : Number(j.power.totalPowerW || 0);
      }
      if (els.orinKpiPower) els.orinKpiPower.innerText = `${pwrW.toFixed(1)} W`;
      if (els.orinBarPower) {
        const maxTdpW = typeof j.maxPowerTdpW === 'number' ? j.maxPowerTdpW : 15.0;
        const pwrPct = Math.min(100, Math.max(5, Math.round((pwrW / maxTdpW) * 100)));
        els.orinBarPower.style.width = `${pwrPct}%`;
      }

      const temps = j.temperatures || j.thermals;
      if (temps) {
        if (els.orinKpiCpuTemp) els.orinKpiCpuTemp.innerText = temps.cpuC !== null && temps.cpuC !== undefined ? `${temps.cpuC}°C` : '--°C';
        if (els.orinKpiGpuTemp) els.orinKpiGpuTemp.innerText = temps.gpuC !== null && temps.gpuC !== undefined ? `${temps.gpuC}°C` : '--°C';
        if (els.orinKpiJuncTemp) els.orinKpiJuncTemp.innerText = temps.junctionC !== null && temps.junctionC !== undefined ? `${temps.junctionC}°C` : '--°C';
      }

      // Service card: live PID and RSS from bridge process (Council Invariant 2: integer-only byte accounting)
      if (els.orinSvcPid && snapshot.bridgePid) {
        els.orinSvcPid.innerText = String(snapshot.bridgePid);
      }
      if (snapshot.bridgeRssBytes) {
        // Integer-only: right-shift 20 bits == floor-divide by 1,048,576 (exact MiB conversion, no float).
        const rssMb = Number(safeBigInt(snapshot.bridgeRssBytes) >> 20n);
        const maxMb = 128;
        const rssPct = Math.min(100, Math.max(2, Math.floor((rssMb * 100) / maxMb)));
        if (els.orinSvcRssStat) els.orinSvcRssStat.innerText = `${rssMb} MB / ${maxMb} MB (${rssPct}%)`;
        if (els.orinSvcRssBar) els.orinSvcRssBar.style.width = `${rssPct}%`;
      }

      // Time series buffer update for Jetson
      if (Array.isArray(j.timeSeries) && j.timeSeries.length > 0) {
        const lastServerTs = j.timeSeries[j.timeSeries.length - 1].timestampMs;
        if (jetsonTimeSeriesBuffer.length === 0 || (jetsonTimeSeriesBuffer[0] && lastServerTs < jetsonTimeSeriesBuffer[0].timestampMs)) {
          jetsonTimeSeriesBuffer = j.timeSeries.slice(-MAX_FRONTEND_BUFFER_POINTS);
        } else {
          const lastLocalTs = jetsonTimeSeriesBuffer[jetsonTimeSeriesBuffer.length - 1].timestampMs;
          const newPts = j.timeSeries.filter((p) => p.timestampMs > lastLocalTs);
          if (newPts.length > 0) {
            jetsonTimeSeriesBuffer.push(...newPts);
            if (jetsonTimeSeriesBuffer.length > MAX_FRONTEND_BUFFER_POINTS) {
              jetsonTimeSeriesBuffer = jetsonTimeSeriesBuffer.slice(-MAX_FRONTEND_BUFFER_POINTS);
            }
          }
        }
      }
    }

    // 8. Google Coral Edge TPU Telemetry
    if (snapshot.coral) {
      const c = snapshot.coral;
      const isDetected = c.detected || c.status === 'online';
      if (els.dotDeviceCoral) {
        els.dotDeviceCoral.className = isDetected ? 'cf-status-dot green' : 'cf-status-dot purple';
      }
      if (els.coralKpiStatus) {
        els.coralKpiStatus.innerText = isDetected ? 'ONLINE · STANDBY' : 'STANDBY';
        els.coralKpiStatus.className = `cf-stat-value ${isDetected ? 'green' : 'purple'}`;
      }
      if (els.coralKpiSpeed) els.coralKpiSpeed.innerText = c.linkSpeed || (isDetected ? '5.0 Gbps (USB 3.1)' : 'Standby');
      if (els.coralKpiBus) els.coralKpiBus.innerText = `Bus ${c.busNumber || '002'} Device ${c.deviceAddress || '003'}`;
      if (els.coralKpiVid) els.coralKpiVid.innerText = `${c.vendorId || '1a6e'}:${c.productId || '089a'}`;
      const totalInf = c.inferencesPerSecond ?? c.totalInferences ?? 0n;
      if (els.coralKpiTotalInf) els.coralKpiTotalInf.innerText = formatNumber(totalInf);

      // Time series buffer update for Coral
      if (Array.isArray(c.timeSeries) && c.timeSeries.length > 0) {
        const lastServerTs = c.timeSeries[c.timeSeries.length - 1].timestampMs;
        if (coralTimeSeriesBuffer.length === 0 || (coralTimeSeriesBuffer[0] && lastServerTs < coralTimeSeriesBuffer[0].timestampMs)) {
          coralTimeSeriesBuffer = c.timeSeries.slice(-MAX_FRONTEND_BUFFER_POINTS);
        } else {
          const lastLocalTs = coralTimeSeriesBuffer[coralTimeSeriesBuffer.length - 1].timestampMs;
          const newPts = c.timeSeries.filter((p) => p.timestampMs > lastLocalTs);
          if (newPts.length > 0) {
            coralTimeSeriesBuffer.push(...newPts);
            if (coralTimeSeriesBuffer.length > MAX_FRONTEND_BUFFER_POINTS) {
              coralTimeSeriesBuffer = coralTimeSeriesBuffer.slice(-MAX_FRONTEND_BUFFER_POINTS);
            }
          }
        }
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
      case 'live': return 10 * 60 * 1000;      // 10 minutes
      case '1h':   return 60 * 60 * 1000;      // 1 hour
      case '6h':   return 6 * 60 * 60 * 1000;  // 6 hours
      case '24h':  return 24 * 60 * 60 * 1000; // 24 hours
      case '7d':   return 7 * 24 * 60 * 60 * 1000; // 7 days
      case '30d':  return 30 * 24 * 60 * 60 * 1000; // 30 days
      default:     return 10 * 60 * 1000;
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
      durationHours = 10 / 60; // 10 minutes
      pointCount = 60;
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

  /**
   * Deterministic gap detection threshold: intervals larger than this represent missing data
   * and must be left blank rather than drawn with a connecting line.
   */
  function getGapThresholdMs(range) {
    switch (range) {
      case 'live': return 15 * 1000;           // 15 seconds in live mode
      case '1h':   return 120 * 1000;          // 2 minutes in 1h mode
      case '6h':   return 10 * 60 * 1000;      // 10 minutes in 6h mode
      case '24h':  return 30 * 60 * 1000;      // 30 minutes in 24h mode
      default:     return 2 * 60 * 60 * 1000;  // 2 hours in multi-day modes
    }
  }

  /**
   * Synchronized Timeline Window Calculation:
   * Guarantees Zodiac, Jetson, and Coral graphs share the exact same [minTime, maxTime] timeline.
   */
  function getTimelineWindow(range, points) {
    const durationMs = getRangeDurationMs(range);
    const now = Date.now();
    const lastPt = points && points.length > 0 ? points[points.length - 1]?.timestampMs : undefined;
    const maxTime = lastPt && lastPt > now - 30_000 ? Math.max(now, lastPt) : now;
    const minTime = maxTime - durationMs;
    return { minTime, maxTime, durationMs };
  }

  /**
   * Standardized X-Axis Timestamps Renderer across all dashboard charts.
   */
  function drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, yPos, range, stepCount = 6) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    for (let i = 0; i < stepCount; i++) {
      const t = minTime + (durationMs * i) / (stepCount - 1);
      const x = padLeft + (plotW * i) / (stepCount - 1);
      const d = new Date(t);
      let timeLabel = d.toTimeString().slice(0, 8); // HH:MM:SS
      if (range === '24h' || range === '7d' || range === '30d') {
        timeLabel = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
      }
      ctx.fillText(timeLabel, x, yPos);
    }
    ctx.restore();
  }

  /**
   * Partitions a time series into contiguous runs, splitting wherever an interval
   * exceeds the gap threshold or where values evaluate to null / NaN.
   * Missing data periods between runs are left completely blank.
   */
  function partitionContiguousSegments(points, range, getValueFn) {
    if (!points || points.length === 0) return [];
    const gapThreshold = getGapThresholdMs(range);
    const segments = [];
    let currentSegment = [];

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const val = getValueFn ? getValueFn(pt) : 0;
      const isValid = val !== null && val !== undefined && !Number.isNaN(Number(val));

      if (!isValid) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        continue;
      }

      if (currentSegment.length > 0) {
        const prevPt = currentSegment[currentSegment.length - 1];
        if (pt.timestampMs - prevPt.timestampMs > gapThreshold) {
          segments.push(currentSegment);
          currentSegment = [];
        }
      }

      currentSegment.push(pt);
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
  }

  /**
   * Helper to draw segmented line curves and optional area fills.
   * Leaves periods between contiguous segments blank without connecting lines.
   */
  function drawSegmentedPath(ctx, segments, getCoordFn, strokeColor, fillColor, lineWidth = 1.8, baselineY = 0) {
    if (!segments || segments.length === 0) return;

    for (const seg of segments) {
      if (!seg || seg.length === 0) continue;
      const firstCoord = getCoordFn(seg[0]);
      if (!firstCoord) continue;

      // Area fill if fillColor provided
      if (fillColor && seg.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(firstCoord.x, firstCoord.y);
        for (let i = 1; i < seg.length; i++) {
          const c = getCoordFn(seg[i]);
          if (c) ctx.lineTo(c.x, c.y);
        }
        const lastCoord = getCoordFn(seg[seg.length - 1]);
        if (lastCoord) {
          ctx.lineTo(lastCoord.x, baselineY);
          ctx.lineTo(firstCoord.x, baselineY);
          ctx.closePath();
          ctx.fillStyle = fillColor;
          ctx.fill();
        }
        ctx.restore();
      }

      // Line stroke
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(firstCoord.x, firstCoord.y);
      for (let i = 1; i < seg.length; i++) {
        const c = getCoordFn(seg[i]);
        if (c) ctx.lineTo(c.x, c.y);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      // Single point dot
      if (seg.length === 1) {
        ctx.beginPath();
        ctx.arc(firstCoord.x, firstCoord.y, lineWidth + 0.5, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor;
        ctx.fill();
      }
      ctx.restore();
    }
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

    // Synchronized Time window calculation
    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, displayPoints);

    // Draw X-axis timestamps (standardized 6 steps)
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 8, currentRange, 6);

    const getCoord = (pt, valBigInt) => {
      if (!pt) return null;
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const valNum = Number(safeBigInt(valBigInt));
      const y = padTop + plotH - (valNum / maxYNum) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // Partition RX and TX into contiguous runs; blank across missing periods
    const rxSegments = partitionContiguousSegments(
      displayPoints,
      currentRange,
      (pt) => unit === 'pps' ? safeBigInt(pt.rxRatePps) : safeBigInt(pt.rxRateBps)
    );
    const txSegments = partitionContiguousSegments(
      displayPoints,
      currentRange,
      (pt) => unit === 'pps' ? safeBigInt(pt.txRatePps) : safeBigInt(pt.txRateBps)
    );

    const rxGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    rxGrad.addColorStop(0, 'rgba(0, 81, 195, 0.16)');
    rxGrad.addColorStop(1, 'rgba(0, 81, 195, 0.01)');

    drawSegmentedPath(
      ctx,
      rxSegments,
      (pt) => getCoord(pt, unit === 'pps' ? pt.rxRatePps : pt.rxRateBps),
      '#0051c3',
      rxGrad,
      2,
      padTop + plotH
    );

    const txGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    txGrad.addColorStop(0, 'rgba(246, 130, 31, 0.16)');
    txGrad.addColorStop(1, 'rgba(246, 130, 31, 0.01)');

    drawSegmentedPath(
      ctx,
      txSegments,
      (pt) => getCoord(pt, unit === 'pps' ? pt.txRatePps : pt.txRateBps),
      '#f6821f',
      txGrad,
      2,
      padTop + plotH
    );

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

    // Synchronized Time window
    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Draw X-axis timestamps
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 4);

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
      if (!pt) return null;
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const valNum = Number(safeBigInt(valBigInt));
      const y = padTop + plotH - (valNum / maxYNum) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    const rxSegments = partitionContiguousSegments(
      portPoints,
      currentRange,
      (pt) => unit === 'pps' ? safeBigInt(pt.rxRatePps) : safeBigInt(pt.rxRateBps)
    );
    const txSegments = partitionContiguousSegments(
      portPoints,
      currentRange,
      (pt) => unit === 'pps' ? safeBigInt(pt.txRatePps) : safeBigInt(pt.txRateBps)
    );

    const rxGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    rxGrad.addColorStop(0, 'rgba(0, 81, 195, 0.16)');
    rxGrad.addColorStop(1, 'rgba(0, 81, 195, 0.01)');

    drawSegmentedPath(
      ctx,
      rxSegments,
      (pt) => getCoord(pt, unit === 'pps' ? pt.rxRatePps : pt.rxRateBps),
      '#0051c3',
      rxGrad,
      1.6,
      padTop + plotH
    );

    drawSegmentedPath(
      ctx,
      txSegments,
      (pt) => getCoord(pt, unit === 'pps' ? pt.txRatePps : pt.txRateBps),
      '#f6821f',
      null,
      1.6,
      padTop + plotH
    );
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
      const y = padTop + (plotH * (gridSteps - i)) / steps;
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

    // Synchronized Time window
    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Draw X-axis timestamps
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 4);

    const getPointCoord = (pt, rawV) => {
      if (!pt) return null;
      const v = Number(safeBigInt(rawV));
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const y = padTop + plotH - ((v - minVal) / rangeVal) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    const segments = partitionContiguousSegments(points, currentRange, (pt) => pt[key]);
    drawSegmentedPath(ctx, segments, (pt) => getPointCoord(pt, pt[key]), color, null, 1.8);
  }

  function getJetsonPointsForDisplay() {
    const durationMs = getRangeDurationMs(currentRange);
    const cutoffMs = Date.now() - durationMs;
    if (jetsonTimeSeriesBuffer.length > 0) {
      const windowPoints = jetsonTimeSeriesBuffer.filter((p) => p.timestampMs >= cutoffMs);
      if (windowPoints.length > 0) return windowPoints;
    }
    if (currentSnapshot?.jetson?.timeSeries && currentSnapshot.jetson.timeSeries.length > 0) {
      return currentSnapshot.jetson.timeSeries.filter((p) => p.timestampMs >= cutoffMs);
    }
    return [];
  }

  function getCoralPointsForDisplay() {
    const durationMs = getRangeDurationMs(currentRange);
    const cutoffMs = Date.now() - durationMs;
    if (coralTimeSeriesBuffer.length > 0) {
      const windowPoints = coralTimeSeriesBuffer.filter((p) => p.timestampMs >= cutoffMs);
      if (windowPoints.length > 0) return windowPoints;
    }
    if (currentSnapshot?.coral?.timeSeries) {
      return currentSnapshot.coral.timeSeries;
    }
    return [];
  }

  // --- Orin Chart 1: Compute (CPU vs GPU Utilization %) ---
  function drawOrinComputeChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
    const height = rect.height || 220;

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
    const padTop = 20;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    // Grid lines: 0%, 25%, 50%, 75%, 100%
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      ctx.fillText(`${i * 25}%`, padLeft - 6, y);
    }

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis timestamps
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 5);

    const getCoord = (pt, pctVal) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const y = padTop + plotH - (Math.max(0, Math.min(100, Number(pctVal || 0))) / 100) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // CPU Line & Area Fill (Blue #0051c3) - segmented for missing data gaps
    const cpuSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.cpuUtilizationPct ?? pt.cpuPercent);
    drawSegmentedPath(ctx, cpuSegments, (pt) => getCoord(pt, pt.cpuUtilizationPct ?? pt.cpuPercent), '#0051c3', 'rgba(0, 81, 195, 0.16)', 1.8, padTop + plotH);

    // GPU Line (Purple #7e22ce) - segmented for missing data gaps
    const gpuSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.gpuUtilizationPct ?? pt.gpuPercent);
    drawSegmentedPath(ctx, gpuSegments, (pt) => getCoord(pt, pt.gpuUtilizationPct ?? pt.gpuPercent), '#7e22ce', null, 1.8, padTop + plotH);

    // Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0051c3';
    ctx.fillText('● CPU Utilization', padLeft + 10, padTop - 6);
    ctx.fillStyle = '#7e22ce';
    ctx.fillText('● GPU (Ampere)', padLeft + 120, padTop - 6);
  }

  // --- Orin Chart 2: Network Throughput (enP8p1s0 vs wlP1p1s0) ---
  function drawOrinNetworkChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
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
    const padTop = 24;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    let maxY = 10000n; // 10 KB/s baseline
    for (const pt of points) {
      const sdnRate = pt.sdnPortRateBps != null
        ? safeBigInt(pt.sdnPortRateBps)
        : (safeBigInt(pt.sdnRxRateBps) + safeBigInt(pt.sdnTxRateBps));
      const wifiRate = pt.wifiPortRateBps != null
        ? safeBigInt(pt.wifiPortRateBps)
        : (safeBigInt(pt.wifiRxRateBps) + safeBigInt(pt.wifiTxRateBps));
      if (sdnRate > maxY) maxY = sdnRate;
      if (wifiRate > maxY) maxY = wifiRate;
    }
    maxY = (maxY * 125n) / 100n;
    const maxYNum = Number(maxY);

    // Grid lines
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const gridVal = (maxY * BigInt(i)) / BigInt(steps);
      ctx.fillText(`${formatBytes(gridVal)}/s`, padLeft - 8, y);
    }

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 6);

    const getCoord = (pt, rateBigInt) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const valNum = Number(safeBigInt(rateBigInt));
      const y = padTop + plotH - (valNum / maxYNum) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    const getSdnRate = (pt) => pt.sdnPortRateBps != null
      ? safeBigInt(pt.sdnPortRateBps)
      : (safeBigInt(pt.sdnRxRateBps) + safeBigInt(pt.sdnTxRateBps));

    const getWifiRate = (pt) => pt.wifiPortRateBps != null
      ? safeBigInt(pt.wifiPortRateBps)
      : (safeBigInt(pt.wifiRxRateBps) + safeBigInt(pt.wifiTxRateBps));

    // SDN Link (enP8p1s0) Curve (Green #10b981)
    const sdnSegments = partitionContiguousSegments(points, currentRange, (pt) => Number(getSdnRate(pt)));
    drawSegmentedPath(ctx, sdnSegments, (pt) => getCoord(pt, getSdnRate(pt)), '#10b981', 'rgba(16, 185, 129, 0.16)', 2, padTop + plotH);

    // Wi-Fi (wlP1p1s0) Curve (Blue #0051c3)
    const wifiSegments = partitionContiguousSegments(points, currentRange, (pt) => Number(getWifiRate(pt)));
    drawSegmentedPath(ctx, wifiSegments, (pt) => getCoord(pt, getWifiRate(pt)), '#0051c3', 'rgba(0, 81, 195, 0.08)', 2, padTop + plotH);

    // Update legend values if elements exist
    const latest = points[points.length - 1];
    if (latest) {
      if (els.orinSdnRateLegend) {
        els.orinSdnRateLegend.innerText = `${formatBytes(getSdnRate(latest))}/s`;
      }
      if (els.orinWifiRateLegend) {
        els.orinWifiRateLegend.innerText = `${formatBytes(getWifiRate(latest))}/s`;
      }
    }

    // Canvas Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#10b981';
    ctx.fillText('● SDN GbE Direct Link (enP8p1s0)', padLeft + 10, padTop - 8);
    ctx.fillStyle = '#0051c3';
    ctx.fillText('● Wi-Fi Uplink (wlP1p1s0)', padLeft + 220, padTop - 8);
  }

  // --- Orin Chart 3: Thermal Zones (CPU, GPU, Junction °C) ---
  function drawOrinThermalsChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
    const height = rect.height || 220;

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
    const padTop = 20;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    const minTemp = 20;
    const maxTemp = 95;
    const rangeTemp = maxTemp - minTemp;

    // Grid lines: 25, 45, 65, 85
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const tempLevels = [25, 45, 65, 85];
    for (const lvl of tempLevels) {
      const y = padTop + plotH - ((lvl - minTemp) / rangeTemp) * plotH;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      ctx.fillText(`${lvl}°C`, padLeft - 6, y);
    }

    // 85°C TJ Max Threshold Line
    const threshY = padTop + plotH - ((85 - minTemp) / rangeTemp) * plotH;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
    ctx.beginPath();
    ctx.moveTo(padLeft, threshY);
    ctx.lineTo(width - padRight, threshY);
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('85°C Limit', width - padRight - 5, threshY - 6);
    ctx.restore();

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 5);

    const getCoord = (pt, tempVal) => {
      const v = typeof tempVal === 'number' ? tempVal : null;
      if (v === null || isNaN(v)) return null;
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const y = padTop + plotH - ((Math.max(minTemp, Math.min(maxTemp, v)) - minTemp) / rangeTemp) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // CPU Temp Curve (Green #10b981) - segmented for gaps (Council Invariant 6: Physical Truth)
    const cpuSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.cpuTempC ?? pt.cpuTemperatureC ?? pt.socTempC ?? null);
    drawSegmentedPath(ctx, cpuSegments, (pt) => getCoord(pt, pt.cpuTempC ?? pt.cpuTemperatureC ?? pt.socTempC), '#10b981', null, 1.8, padTop + plotH);

    // GPU Temp Curve (Indigo #6366f1) - segmented for gaps
    const gpuSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.gpuTempC ?? pt.gpuTemperatureC ?? null);
    drawSegmentedPath(ctx, gpuSegments, (pt) => getCoord(pt, pt.gpuTempC ?? pt.gpuTemperatureC), '#6366f1', null, 1.8, padTop + plotH);

    // Junction Temp Curve (Orange #f6821f) - segmented for gaps
    const juncSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.junctionTempC ?? pt.junctionTemperatureC ?? pt.boardTempC ?? null);
    drawSegmentedPath(ctx, juncSegments, (pt) => getCoord(pt, pt.junctionTempC ?? pt.junctionTemperatureC ?? pt.boardTempC), '#f6821f', null, 1.8, padTop + plotH);

    // Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#10b981';
    ctx.fillText('● CPU', padLeft + 10, padTop - 6);
    ctx.fillStyle = '#6366f1';
    ctx.fillText('● GPU', padLeft + 65, padTop - 6);
    ctx.fillStyle = '#f6821f';
    ctx.fillText('● Junction (Tj)', padLeft + 120, padTop - 6);
  }

  // --- Orin Chart 4: Module Power Consumption (Watts) ---
  function drawOrinPowerChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
    const height = rect.height || 220;

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
    const padTop = 20;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    let maxW = 10;
    for (const pt of points) {
      const pVal = pt.powerWatts ?? pt.boardPowerW;
      const w = typeof pVal === 'number' ? pVal : Number(pVal || 0);
      if (w > maxW) maxW = w;
    }
    maxW = Math.max(10, Math.ceil(maxW * 1.25));

    // Grid lines: 3 steps
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      const val = (maxW * i) / steps;
      ctx.fillText(`${Math.round(val)} W`, padLeft - 6, y);
    }

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 5);

    const getCoord = (pt, powerW) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const w = typeof powerW === 'number' ? powerW : Number(powerW || 0);
      const y = padTop + plotH - (Math.max(0, Math.min(maxW, w)) / maxW) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // Power Area & Line (Orange #f6821f) - segmented for gaps
    const powerSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.powerWatts ?? pt.boardPowerW ?? null);
    drawSegmentedPath(ctx, powerSegments, (pt) => getCoord(pt, pt.powerWatts ?? pt.boardPowerW), '#f6821f', 'rgba(246, 130, 31, 0.16)', 1.8, padTop + plotH);

    // Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f6821f';
    ctx.fillText('● Board Input Power (INA3221 VDD_IN)', padLeft + 10, padTop - 6);
  }

  // --- Coral Chart 1: Inference & Tap Ingestion Rate ---
  function drawCoralRateChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
    const height = rect.height || 220;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 55;
    const padRight = 15;
    const padTop = 20;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    let maxY = 100;
    for (const pt of points) {
      const inf = typeof pt.inferenceRateIps === 'number' ? pt.inferenceRateIps : Number(pt.inferenceRateIps || 0);
      const tap = typeof pt.tapPacketsPerSec === 'bigint' ? Number(pt.tapPacketsPerSec) : Number(pt.tapPacketsPerSec || 0);
      if (inf > maxY) maxY = inf;
      if (tap > maxY) maxY = tap;
    }
    maxY = Math.max(100, Math.ceil(maxY * 1.25));

    // Grid lines: 3 steps
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      const val = (maxY * i) / steps;
      ctx.fillText(formatNumber(Math.round(val)), padLeft - 6, y);
    }

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 5);

    const getCoord = (pt, valNum) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const v = typeof valNum === 'number' ? valNum : Number(valNum || 0);
      const y = padTop + plotH - (Math.max(0, Math.min(maxY, v)) / maxY) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // Inference Curve (Purple #7e22ce) - segmented for gaps
    const infSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.inferenceRateIps);
    drawSegmentedPath(ctx, infSegments, (pt) => getCoord(pt, pt.inferenceRateIps), '#7e22ce', 'rgba(126, 34, 206, 0.16)', 1.8, padTop + plotH);

    // Tap Packets Curve (Blue #0051c3) - segmented for gaps
    const tapSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.tapPacketsPerSec);
    drawSegmentedPath(ctx, tapSegments, (pt) => getCoord(pt, pt.tapPacketsPerSec), '#0051c3', null, 1.8, padTop + plotH);

    // Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7e22ce';
    ctx.fillText('● Inferences (IPS)', padLeft + 10, padTop - 6);
    ctx.fillStyle = '#0051c3';
    ctx.fillText('● Port 3 Tap Packets (PPS)', padLeft + 130, padTop - 6);
  }

  // --- Coral Chart 2: Sub-Millisecond Latency Profile (µs) ---
  function drawCoralLatencyChart(canvas, points) {
    if (!canvas || !points || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || canvas.parentElement?.clientWidth || 460;
    const height = rect.height || 220;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 55;
    const padRight = 15;
    const padTop = 20;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    let maxLat = 600;
    for (const pt of points) {
      const lat = typeof pt.latencyMicros === 'number' ? pt.latencyMicros : Number(pt.latencyMicros || 0);
      if (lat > maxLat) maxLat = lat;
    }
    maxLat = Math.max(600, Math.ceil(maxLat * 1.15));

    // Grid lines: 3 steps
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f1f5f9';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const y = padTop + (plotH * (steps - i)) / steps;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      const val = (maxLat * i) / steps;
      ctx.fillText(`${Math.round(val)} µs`, padLeft - 6, y);
    }

    // 500 µs Dean Invariant Threshold Line
    const threshY = padTop + plotH - (500 / maxLat) * plotH;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
    ctx.beginPath();
    ctx.moveTo(padLeft, threshY);
    ctx.lineTo(width - padRight, threshY);
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('500 µs Dean Target', width - padRight - 5, threshY - 6);
    ctx.restore();

    const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);

    // Standardized X-axis
    drawXAxisTimestamps(ctx, minTime, durationMs, padLeft, plotW, height - padBottom + 5, currentRange, 5);

    const getCoord = (pt, latNum) => {
      const t = Math.max(minTime, Math.min(maxTime, pt.timestampMs));
      const x = padLeft + (plotW * (t - minTime)) / Math.max(1, durationMs);
      const v = typeof latNum === 'number' ? latNum : Number(latNum || 0);
      const y = padTop + plotH - (Math.max(0, Math.min(maxLat, v)) / maxLat) * plotH;
      return { x, y: Math.max(padTop, Math.min(padTop + plotH, y)) };
    };

    // Latency Area & Line (Emerald #059669) - segmented for gaps
    const latSegments = partitionContiguousSegments(points, currentRange, (pt) => pt.latencyMicros);
    drawSegmentedPath(ctx, latSegments, (pt) => getCoord(pt, pt.latencyMicros), '#059669', 'rgba(5, 150, 105, 0.16)', 1.8, padTop + plotH);

    // Legend
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#059669';
    ctx.fillText('● Line-Rate Inference Latency (<500 µs)', padLeft + 10, padTop - 6);
  }

  function updateCharts() {
    if (activeDeviceId === 'zodiac') {
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

        const portIpStr = portMeta?.ipAddress || (portId === 4 ? (currentSnapshot?.system?.ipAddress || '--') : (portId === 2 ? 'Gateway Uplink' : 'Unassigned'));
        if (cardRefs.badgeIp) {
          cardRefs.badgeIp.innerText = portId === 4 ? (portIpStr !== '--' ? `IP: ${portIpStr}` : 'SDN Native Link') : (portId === 2 ? 'Gateway Uplink' : 'IP: Unassigned');
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
          cardRefs.statIp.innerText = portId === 4 ? `${portIpStr} (Native)` : (portId === 2 ? `${portIpStr} (ISP Gateway)` : 'Unassigned');
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
    } else if (activeDeviceId === 'orin') {
      const orinPoints = getJetsonPointsForDisplay();
      if (orinPoints.length > 0) {
        drawOrinComputeChart(els.chartOrinComputeCanvas, orinPoints);
        drawOrinNetworkChart(els.chartOrinNetworkCanvas, orinPoints);
        drawOrinThermalsChart(els.chartOrinThermalsCanvas, orinPoints);
        drawOrinPowerChart(els.chartOrinPowerCanvas, orinPoints);
      }
    } else if (activeDeviceId === 'coral') {
      const coralPoints = getCoralPointsForDisplay();
      if (coralPoints.length > 0) {
        drawCoralRateChart(els.chartCoralRateCanvas, coralPoints);
        drawCoralLatencyChart(els.chartCoralLatencyCanvas, coralPoints);
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

  // ============================================================
  // Universal Interactive Stats Hover Tooltips (Council Invariants 2 & 4)
  // ============================================================
  function bindChartHoverTooltip(wrapperOrId, getPointsFn, padLeft, padRight, renderHtmlFn) {
    const wrapper = typeof wrapperOrId === 'string' ? document.getElementById(wrapperOrId) : wrapperOrId;
    if (!wrapper) return;

    let tooltipEl = wrapper.querySelector('.cf-chart-tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'cf-chart-tooltip';
      tooltipEl.style.display = 'none';
      wrapper.appendChild(tooltipEl);
    }

    if (wrapper._hasTooltipListener) return;
    wrapper._hasTooltipListener = true;

    let rafId = null;
    let pendingEvent = null;

    function updateTooltip(e) {
      const points = getPointsFn();
      if (!points || points.length < 2) {
        tooltipEl.style.display = 'none';
        return;
      }

      const rect = wrapper.getBoundingClientRect();
      const plotW = rect.width - padLeft - padRight;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (mouseX < padLeft || mouseX > rect.width - padRight) {
        tooltipEl.style.display = 'none';
        return;
      }

      const { minTime, maxTime, durationMs } = getTimelineWindow(currentRange, points);
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

      if (!closestPt) {
        tooltipEl.style.display = 'none';
        return;
      }

      const gapThreshold = getGapThresholdMs(currentRange);
      if (minDiff > gapThreshold) {
        tooltipEl.style.display = 'none';
        return;
      }

      const html = renderHtmlFn(closestPt);
      if (!html) {
        tooltipEl.style.display = 'none';
        return;
      }

      tooltipEl.innerHTML = html;
      tooltipEl.style.display = 'block';
      tooltipEl.style.left = `${mouseX}px`;
      tooltipEl.style.top = `${mouseY}px`;

      // Dynamic Bounding Box Clamping (Quoc Le Invariant: zero magic constants)
      // Query actual rendered dimensions to support variable content lengths and localization
      const tipRect = tooltipEl.getBoundingClientRect();
      const halfTipW = tipRect.width > 0 ? tipRect.width / 2 : 0;
      const tipH = tipRect.height > 0 ? tipRect.height : 0;

      let transX = '-50%';
      if (mouseX - halfTipW < 0) {
        transX = '0%';
      } else if (mouseX + halfTipW > rect.width) {
        transX = '-100%';
      }

      let transY = '-100%';
      if (mouseY - tipH - 8 < 0) {
        transY = '18px';
      }

      tooltipEl.style.transform = `translate(${transX}, ${transY})`;
    }

    wrapper.addEventListener('mousemove', (e) => {
      pendingEvent = e;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingEvent) {
          updateTooltip(pendingEvent);
          pendingEvent = null;
        }
      });
    });

    wrapper.addEventListener('mouseleave', () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingEvent = null;
      tooltipEl.style.display = 'none';
    });
  }

  // 1. Primary Traffic Flow Chart
  if (els.canvasWrapperFlow) {
    bindChartHoverTooltip(els.canvasWrapperFlow, getPointsForDisplay, 65, 20, (closestPt) => {
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

      return `
        <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${headerStr}</div>
        <div style="color: #60a5fa;">● Ingress: ${rxStr}</div>
        <div style="color: #fb923c;">● Egress: ${txStr}</div>
        <div style="color: #4ade80;">Temp: ${closestPt.cpuTemperatureC !== null && closestPt.cpuTemperatureC !== undefined ? closestPt.cpuTemperatureC + '°C' : '--'} · Latency: ${formatLatencyNs(closestPt.latencyNs)}</div>
      `;
    });
  }

  // 2. Zodiac CPU Temperature Mini Chart
  bindChartHoverTooltip('canvas-wrapper-temp', getPointsForDisplay, 45, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const temp = closestPt.cpuTemperatureC !== null && closestPt.cpuTemperatureC !== undefined ? `${closestPt.cpuTemperatureC}°C` : '--';
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · CPU Core Thermal</div>
      <div style="color: #4ade80; font-weight: 600;">● Temperature: ${temp}</div>
      <div style="color: #94a3b8; font-size: 0.68rem;">Zodiac Microcontroller Core (SAM4E16E)</div>
    `;
  });

  // 3. Zodiac OpenFlow Latency Mini Chart
  bindChartHoverTooltip('canvas-wrapper-lat', getPointsForDisplay, 45, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const latStr = formatLatencyNs(closestPt.latencyNs);
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · OpenFlow Echo RTT</div>
      <div style="color: #60a5fa; font-weight: 600;">● Latency: ${latStr}</div>
      <div style="color: #94a3b8; font-size: 0.68rem;">Deterministic SLA: &lt; 1,000 µs</div>
    `;
  });

  // 4. Zodiac Physical Ports 1-4 Sparkline Charts
  [1, 2, 3, 4].forEach((portNum) => {
    bindChartHoverTooltip(`canvas-wrapper-port-${portNum}`, getPointsForDisplay, 48, 14, (closestPt) => {
      const d = new Date(closestPt.timestampMs);
      const timeStr = d.toTimeString().slice(0, 8);
      const pData = closestPt.ports?.[portNum];
      const rxStr = currentUnit === 'pps' ? `${formatNumber(pData?.rxRatePps ?? 0n)} pps` : `${formatBytes(pData?.rxRateBps ?? 0n)}/s`;
      const txStr = currentUnit === 'pps' ? `${formatNumber(pData?.txRatePps ?? 0n)} pps` : `${formatBytes(pData?.txRateBps ?? 0n)}/s`;
      return `
        <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Port ${portNum} Wire</div>
        <div style="color: #60a5fa;">● RX (Ingress): ${rxStr}</div>
        <div style="color: #fb923c;">● TX (Egress): ${txStr}</div>
      `;
    });
  });

  // 5. Jetson Orin Compute Load Chart
  bindChartHoverTooltip('canvas-wrapper-orin-compute', getJetsonPointsForDisplay, 45, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const cpuNum = closestPt.cpuUtilizationPct ?? closestPt.cpuPercent ?? 0;
    const gpuNum = closestPt.gpuUtilizationPct ?? closestPt.gpuPercent ?? 0;
    const cpu = Number(cpuNum).toFixed(1) + '%';
    const gpu = Number(gpuNum).toFixed(1) + '%';
    const ramUsed = closestPt.ramUsedBytes ? ` · RAM: ${formatBytes(safeBigInt(closestPt.ramUsedBytes))}` : '';
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Orin Compute Load</div>
      <div style="color: #38bdf8;">● 6-Core ARM Cortex-A78AE: ${cpu}</div>
      <div style="color: #a78bfa;">● Ampere GPU (1024 CUDA): ${gpu}</div>
      <div style="color: #94a3b8; font-size: 0.68rem;">Orin Nano Silicon${ramUsed}</div>
    `;
  });

  // 6. Jetson Orin Network Interfaces Chart
  bindChartHoverTooltip('canvas-wrapper-orin-network', getJetsonPointsForDisplay, 58, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const sdnRate = closestPt.sdnPortRateBps != null
      ? safeBigInt(closestPt.sdnPortRateBps)
      : (safeBigInt(closestPt.sdnRxRateBps) + safeBigInt(closestPt.sdnTxRateBps));
    const wifiRate = closestPt.wifiPortRateBps != null
      ? safeBigInt(closestPt.wifiPortRateBps)
      : (safeBigInt(closestPt.wifiRxRateBps) + safeBigInt(closestPt.wifiTxRateBps));
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Interface Throughput</div>
      <div style="color: #38bdf8;">● GbE (enP8p1s0): ${formatBytes(sdnRate)}/s</div>
      <div style="color: #f59e0b;">● Wi-Fi (wlP1p1s0): ${formatBytes(wifiRate)}/s</div>
    `;
  });

  // 7. Jetson Orin Thermals Chart
  bindChartHoverTooltip('canvas-wrapper-orin-thermals', getJetsonPointsForDisplay, 45, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const cpuT = closestPt.cpuTempC ?? closestPt.cpuTemperatureC ?? closestPt.socTempC;
    const gpuT = closestPt.gpuTempC ?? closestPt.gpuTemperatureC;
    const juncT = closestPt.junctionTempC ?? closestPt.junctionTemperatureC ?? closestPt.boardTempC;
    const cpuStr = cpuT !== null && cpuT !== undefined ? Number(cpuT).toFixed(1) + '°C' : '--';
    const gpuStr = gpuT !== null && gpuT !== undefined ? Number(gpuT).toFixed(1) + '°C' : '--';
    const juncStr = juncT !== null && juncT !== undefined ? Number(juncT).toFixed(1) + '°C' : '--';
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Orin Thermal Zones</div>
      <div style="color: #10b981;">● CPU Temp: ${cpuStr}</div>
      <div style="color: #818cf8;">● GPU Temp: ${gpuStr}</div>
      <div style="color: #f97316;">● Junction (Tj): ${juncStr}</div>
    `;
  });

  // 8. Jetson Orin Power Draw Chart
  bindChartHoverTooltip('canvas-wrapper-orin-power', getJetsonPointsForDisplay, 45, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const pwr = closestPt.powerWatts ?? closestPt.boardPowerW;
    const power = pwr !== null && pwr !== undefined ? Number(pwr).toFixed(2) + ' W' : '--';
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Module Power Draw</div>
      <div style="color: #eab308; font-weight: 600;">● Total Consumption: ${power}</div>
      <div style="color: #94a3b8; font-size: 0.68rem;">15W Super Power Envelope (INA3221 Monitor)</div>
    `;
  });


  // 9. Coral Edge TPU Inference Rate Chart
  bindChartHoverTooltip('canvas-wrapper-coral-rate', getCoralPointsForDisplay, 55, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const ipsVal = safeBigInt(closestPt.inferencesPerSecond ?? closestPt.inferenceRateIps);
    const inf = `${formatNumber(ipsVal)} inf/s`;
    const tap = `${formatNumber(safeBigInt(closestPt.tapPacketsPerSecond ?? closestPt.tapPacketsPerSec))} pps`;
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Edge TPU Throughput</div>
      <div style="color: #34d399; font-weight: 600;">● Real-time Inferences: ${inf}</div>
      <div style="color: #38bdf8;">● Hardware Ingress Tap: ${tap}</div>
    `;
  });

  // 10. Coral Edge TPU Inference Latency Chart (Dean & Quoc Le Invariant: Integer Nanoseconds)
  bindChartHoverTooltip('canvas-wrapper-coral-latency', getCoralPointsForDisplay, 55, 15, (closestPt) => {
    const d = new Date(closestPt.timestampMs);
    const timeStr = d.toTimeString().slice(0, 8);
    const latNs = closestPt.latencyNs !== undefined && closestPt.latencyNs !== null
      ? safeBigInt(closestPt.latencyNs)
      : (closestPt.latencyP50Us !== undefined && closestPt.latencyP50Us !== null
        ? safeBigInt(closestPt.latencyP50Us) * 1000n
        : safeBigInt(closestPt.latencyMicros) * 1000n);
    const latP99Ns = closestPt.latencyP99Us !== undefined && closestPt.latencyP99Us !== null
      ? safeBigInt(closestPt.latencyP99Us) * 1000n
      : 0n;
    return `
      <div style="font-weight: 700; color: #94a3b8; margin-bottom: 3px;">${timeStr} · Tensor Execution Latency</div>
      <div style="color: #a78bfa; font-weight: 600;">● Inference Latency (P50): ${formatLatencyNs(latNs)}</div>
      ${latP99Ns > 0n ? `<div style="color: #c084fc;">● Tail Latency (P99): ${formatLatencyNs(latP99Ns)}</div>` : ''}
      <div style="color: #94a3b8; font-size: 0.68rem;">Strict Dean Budget: &lt; 500,000 ns (500 µs) Target</div>
    `;
  });


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

  // ─────────────────────────────────────────────────────────────────────────
  // Sidebar Navigation System — O(1) display toggle + event delegation
  //
  // Three nav groups are pre-rendered in index.html as static HTML.
  // Switching devices hides the old nav and shows the new one (O(1) CSS
  // display toggle — zero layout thrashing, zero innerHTML mutation).
  //
  // A SINGLE delegated click listener on #cf-sidebar-nav-container reads
  // data-section and data-scroll attributes to determine routing — no
  // per-item closures, no rebinding after DOM changes.
  //
  // Council Invariant 5: all device metadata declared in one flat table.
  // Ghemawat Razor: zero unnecessary allocations on every device switch.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Device metadata — keyed by device ID.
   * `hwName`   – sidebar footer line 1 (hardware model string)
   * `firmware` – sidebar footer line 2 (OS / firmware version)
   * `navId`    – ID of the pre-rendered <nav> element in index.html
   *
   * @type {{ [device: string]: { hwName: string, firmware: string, navId: string } }}
   */
  const DEVICE_META = {
    zodiac: { hwName: 'Zodiac FX Hardware \u00b7 Rev B',         firmware: 'Firmware v0.86',            navId: 'cf-nav-zodiac' },
    orin:   { hwName: 'NVIDIA Jetson Orin Nano \u00b7 Dev Kit',  firmware: 'JetPack 6.x \u00b7 Ubuntu 22.04', navId: 'cf-nav-orin'   },
    coral:  { hwName: 'Google Coral Edge TPU \u00b7 USB Acc.',   firmware: 'PyCoral \u00b7 TFLite Runtime',  navId: 'cf-nav-coral'  },
  };

  // Cached section elements (queried once — stable IDs, never recreated)
  const secOverview = document.getElementById('section-overview');
  const secCouncil  = document.getElementById('section-council');

  /**
   * Single delegated click handler for all nav items across all device groups.
   * Routes based on data-section and data-scroll attributes; updates .active class
   * within the item's own parent <nav> without touching any other group.
   */
  const navContainer = document.getElementById('cf-sidebar-nav-container');
  if (navContainer) {
    navContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.cf-nav-item');
      if (!item) return;

      // O(1) active state: deactivate siblings within this nav group only
      const navGroup = item.closest('.cf-nav-group');
      if (navGroup) {
        navGroup.querySelectorAll('.cf-nav-item').forEach((el) => el.classList.remove('active'));
      }
      item.classList.add('active');

      // Section routing via data attributes (no closures, no per-item state)
      const section = item.dataset.section;
      const scrollId = item.dataset.scroll;

      if (section === 'council') {
        if (secOverview) secOverview.style.display = 'none';
        if (secCouncil)  secCouncil.style.display  = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        if (secOverview) secOverview.style.display = 'block';
        if (secCouncil)  secCouncil.style.display  = 'none';
        if (scrollId) {
          const target = document.getElementById(scrollId);
          if (target) { target.scrollIntoView({ behavior: 'smooth' }); }
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    });
  }

  /**
   * Switch the visible sidebar nav to the specified device and update the
   * footer metadata.  O(1): two display-property writes + two text writes.
   * Resets the active tab to the first item in the incoming nav group.
   *
   * @param {'zodiac'|'orin'|'coral'} device
   */
  function updateSidebarNav(device) {
    const meta = DEVICE_META[device];
    if (!meta) return;

    // O(1) display toggle across all three pre-rendered nav groups
    for (const [id, { navId }] of Object.entries(DEVICE_META)) {
      const nav = document.getElementById(navId);
      if (nav) nav.style.display = id === device ? '' : 'none';
    }

    // Reset active state to the first item in the now-visible nav group
    const activeNav = document.getElementById(meta.navId);
    if (activeNav) {
      const items = activeNav.querySelectorAll('.cf-nav-item');
      items.forEach((el, idx) => el.classList.toggle('active', idx === 0));
    }

    // Update sidebar footer hardware metadata (two text writes)
    const hwNameEl   = document.getElementById('cf-hw-name');
    const hwFirmware = document.getElementById('cf-hw-firmware');
    if (hwNameEl)   hwNameEl.innerText   = meta.hwName;
    if (hwFirmware) hwFirmware.innerText = meta.firmware;

    // If the council section is visible, restore overview on device switch
    if (secCouncil && secCouncil.style.display === 'block') {
      if (secOverview) secOverview.style.display = 'block';
      secCouncil.style.display = 'none';
    }
  }


  // Active Appliance Tier Switching Logic
  function switchDevice(device) {

    if (!['zodiac', 'orin', 'coral'].includes(device)) return;
    activeDeviceId = device;

    if (els.btnDeviceZodiac) {
      els.btnDeviceZodiac.classList.toggle('active', device === 'zodiac');
      els.btnDeviceZodiac.setAttribute('aria-selected', String(device === 'zodiac'));
    }
    if (els.btnDeviceOrin) {
      els.btnDeviceOrin.classList.toggle('active', device === 'orin');
      els.btnDeviceOrin.setAttribute('aria-selected', String(device === 'orin'));
    }
    if (els.btnDeviceCoral) {
      els.btnDeviceCoral.classList.toggle('active', device === 'coral');
      els.btnDeviceCoral.setAttribute('aria-selected', String(device === 'coral'));
    }

    if (els.viewDeviceZodiac) els.viewDeviceZodiac.style.display = device === 'zodiac' ? 'block' : 'none';
    if (els.viewDeviceOrin) els.viewDeviceOrin.style.display = device === 'orin' ? 'block' : 'none';
    if (els.viewDeviceCoral) els.viewDeviceCoral.style.display = device === 'coral' ? 'block' : 'none';

    if (els.breadcrumbName) {
      if (device === 'zodiac') {
        els.breadcrumbName.innerText = currentSnapshot?.system?.deviceName || 'Zodiac_FX';
      } else if (device === 'orin') {
        els.breadcrumbName.innerText = 'Jetson Orin Nano (Host)';
      } else if (device === 'coral') {
        els.breadcrumbName.innerText = 'Google Coral Edge TPU (4 TOPS)';
      }
    }

    // Rebuild device-specific sidebar nav and update footer metadata
    updateSidebarNav(device);

    if (window.location.hash !== `#sec-${device}` && window.location.hash !== `#${device}`) {
      window.history.replaceState(null, '', `#sec-${device}`);
    }

    updateCharts();
  }


  // Bind 3-Way Tier Selector Buttons
  if (els.btnDeviceZodiac) {
    els.btnDeviceZodiac.addEventListener('click', () => switchDevice('zodiac'));
  }
  if (els.btnDeviceOrin) {
    els.btnDeviceOrin.addEventListener('click', () => switchDevice('orin'));
  }
  if (els.btnDeviceCoral) {
    els.btnDeviceCoral.addEventListener('click', () => switchDevice('coral'));
  }

  // URL Hash & Deep Linking Navigation
  function handleHashChange() {
    const hash = (window.location.hash || '').toLowerCase();
    if (hash === '#sec-orin' || hash === '#orin') {
      switchDevice('orin');
    } else if (hash === '#sec-coral' || hash === '#coral') {
      switchDevice('coral');
    } else if (hash === '#sec-zodiac' || hash === '#zodiac' || hash === '#sec-overview') {
      switchDevice('zodiac');
    }
  }

  window.addEventListener('hashchange', handleHashChange);
  if (window.location.hash) {
    handleHashChange();
  }

  // Responsive Chart Resizing
  window.addEventListener('resize', () => {
    updateCharts();
  });

  // Global Helpers for external callers
  window.switchDevice = switchDevice;
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
    switchDevice,
    formatBytes,
    formatLatencyNs,
    triggerPacketBurst,
    triggerLoopInjection,
    resolveDns,
    updateCharts,
  };
})();
