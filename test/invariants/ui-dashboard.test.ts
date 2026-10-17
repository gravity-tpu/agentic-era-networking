// @vitest-environment happy-dom
/**
 * test/invariants/ui-dashboard.test.ts
 *
 * Council Invariant Verification Suite for the Zodiac FX Observability UI.
 * Enforces Council Invariants on every push / CI run:
 * - Anti-Shortcut Law (Council Invariant 1): Zero uncaught client exceptions, NaN values, or broken canvases.
 * - Determinism & Provenance (Council Invariants 2 & 6): Accurate rendering of live hardware vs cloud snapshot vs disconnected state.
 * - Workstation Appliance & Edge AI Telemetry: Clean rendering of Apple Silicon Metal GPU, token velocity, and memory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createDefaultZodiacSnapshot,
  createDisconnectedZodiacSnapshot,
  type ZodiacFullTelemetrySnapshot,
} from '../../src/sdn/zodiac-telemetry.js';

function createMockContext2D(): CanvasRenderingContext2D {
  const operations: Array<{ method: string; args: unknown[] }> = [];

  const checkNumeric = (...nums: unknown[]) => {
    for (const n of nums) {
      if (typeof n === 'number' && Number.isNaN(n)) {
        throw new Error(`NaN coordinate detected in Canvas 2D operation: ${JSON.stringify(nums)}`);
      }
    }
  };

  return {
    canvas: {} as HTMLCanvasElement,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    setTransform: vi.fn((a, b, c, d, e, f) => {
      checkNumeric(a, b, c, d, e, f);
      operations.push({ method: 'setTransform', args: [a, b, c, d, e, f] });
    }),
    clearRect: vi.fn((x, y, w, h) => {
      checkNumeric(x, y, w, h);
      operations.push({ method: 'clearRect', args: [x, y, w, h] });
    }),
    fillRect: vi.fn((x, y, w, h) => {
      checkNumeric(x, y, w, h);
      operations.push({ method: 'fillRect', args: [x, y, w, h] });
    }),
    strokeRect: vi.fn((x, y, w, h) => {
      checkNumeric(x, y, w, h);
      operations.push({ method: 'strokeRect', args: [x, y, w, h] });
    }),
    fillText: vi.fn((text, x, y) => {
      checkNumeric(x, y);
      operations.push({ method: 'fillText', args: [text, x, y] });
    }),
    beginPath: vi.fn(() => operations.push({ method: 'beginPath', args: [] })),
    closePath: vi.fn(() => operations.push({ method: 'closePath', args: [] })),
    moveTo: vi.fn((x, y) => {
      checkNumeric(x, y);
      operations.push({ method: 'moveTo', args: [x, y] });
    }),
    lineTo: vi.fn((x, y) => {
      checkNumeric(x, y);
      operations.push({ method: 'lineTo', args: [x, y] });
    }),
    stroke: vi.fn(() => operations.push({ method: 'stroke', args: [] })),
    fill: vi.fn(() => operations.push({ method: 'fill', args: [] })),
    arc: vi.fn((x, y, r, sa, ea) => {
      checkNumeric(x, y, r, sa, ea);
      operations.push({ method: 'arc', args: [x, y, r, sa, ea] });
    }),
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    setLineDash: vi.fn(),
    getLineDash: vi.fn(() => []),
    measureText: vi.fn((text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    resetTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('Zodiac Dashboard UI & Chart Invariants', () => {
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    // 1. Mock window dimensions and bounding rects
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    const storage: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((k: string) => storage[k] ?? null),
        setItem: vi.fn((k: string, v: string) => { storage[k] = v; }),
        removeItem: vi.fn((k: string) => { delete storage[k]; }),
        clear: vi.fn(() => { for (const k in storage) delete storage[k]; }),
      },
      configurable: true,
    });

    mockCtx = createMockContext2D();
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 800,
      height: 240,
      top: 0,
      left: 0,
      right: 800,
      bottom: 240,
    });

    // 2. Mock fetch for authentication and telemetry endpoints
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            user: { email: 'operator@zodiac.net', name: 'Zodiac Operator' },
          }),
        };
      }
      if (url.includes('/api/zodiac')) {
        const snap = createDefaultZodiacSnapshot();
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(JSON.stringify(snap, (_, v) => typeof v === 'bigint' ? v.toString() : v)),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    // 3. Load actual HTML markup from public/index.html (stripping external links/scripts to prevent unmocked happy-dom fetches)
    const htmlPath = path.resolve(process.cwd(), 'public/index.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    htmlContent = htmlContent.replace(/<link\b[^>]*>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    document.documentElement.innerHTML = htmlContent;

    // 4. Execute public/zodiac-app.js in window context
    const jsPath = path.resolve(process.cwd(), 'public/zodiac-app.js');
    const jsCode = fs.readFileSync(jsPath, 'utf8');
    window.eval(jsCode);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies that all critical UI DOM elements and canvases exist in index.html', () => {
    // Device views
    expect(document.getElementById('view-device-zodiac')).not.toBeNull();
    expect(document.getElementById('view-device-orin')).not.toBeNull();
    expect(document.getElementById('view-device-rpi5')).not.toBeNull();
    expect(document.getElementById('btn-device-rpi5')).not.toBeNull();
    expect(document.getElementById('view-device-rpi3-1')).not.toBeNull();
    expect(document.getElementById('btn-device-rpi3-1')).not.toBeNull();
    expect(document.getElementById('view-device-rpi3-2')).not.toBeNull();
    expect(document.getElementById('btn-device-rpi3-2')).not.toBeNull();
    expect(document.getElementById('view-device-coral-1')).not.toBeNull();
    expect(document.getElementById('view-device-coral-2')).not.toBeNull();
    expect(document.getElementById('view-device-workstation')).not.toBeNull();
    expect(document.getElementById('openflow-device-section')).not.toBeNull();

    // Critical telemetry canvases
    expect(document.getElementById('chart-traffic-flow')).not.toBeNull();
    expect(document.getElementById('chart-cpu-temp')).not.toBeNull();
    expect(document.getElementById('chart-latency')).not.toBeNull();
    expect(document.getElementById('chart-workstation')).not.toBeNull();
    expect(document.getElementById('chart-orin-compute')).not.toBeNull();
    expect(document.getElementById('chart-orin-network')).not.toBeNull();
    expect(document.getElementById('orin-ollama-panel')).not.toBeNull();
    expect(document.getElementById('chart-orin-power')).not.toBeNull();
    expect(document.getElementById('chart-orin-nvme')).not.toBeNull();
    expect(document.getElementById('chart-rpi5-compute')).not.toBeNull();
    expect(document.getElementById('chart-rpi5-network')).not.toBeNull();
    expect(document.getElementById('chart-rpi5-thermal')).not.toBeNull();
    expect(document.getElementById('rpi5-hailo-panel')).not.toBeNull();
    expect(document.getElementById('rpi5-kpi-compute')).not.toBeNull();
    expect(document.getElementById('rpi5-kpi-hailo-rate')).not.toBeNull();
    expect(document.getElementById('rpi5-kpi-eth0-rate')).not.toBeNull();
    expect(document.getElementById('rpi5-kpi-cpu-temp')).not.toBeNull();
    expect(document.getElementById('rpi5-kpi-ram')).not.toBeNull();
    expect(document.getElementById('chart-coral1-rate')).not.toBeNull();
    expect(document.getElementById('chart-coral1-latency')).not.toBeNull();
    expect(document.getElementById('chart-coral2-rate')).not.toBeNull();
    expect(document.getElementById('chart-coral2-latency')).not.toBeNull();

    // Raspberry Pi 3B+ Dual Red Team Nodes
    expect(document.getElementById('chart-rpi3-1-network')).not.toBeNull();
    expect(document.getElementById('chart-rpi3-1-compute')).not.toBeNull();
    expect(document.getElementById('chart-rpi3-1-thermal')).not.toBeNull();
    expect(document.getElementById('rpi3-1-kpi-eth0-rate')).not.toBeNull();
    expect(document.getElementById('rpi3-1-kpi-compute')).not.toBeNull();
    expect(document.getElementById('rpi3-1-kpi-cpu-temp')).not.toBeNull();
    expect(document.getElementById('rpi3-1-kpi-throttled')).not.toBeNull();

    expect(document.getElementById('chart-rpi3-2-network')).not.toBeNull();
    expect(document.getElementById('chart-rpi3-2-compute')).not.toBeNull();
    expect(document.getElementById('chart-rpi3-2-thermal')).not.toBeNull();
    expect(document.getElementById('rpi3-2-kpi-eth0-rate')).not.toBeNull();
    expect(document.getElementById('rpi3-2-kpi-compute')).not.toBeNull();
    expect(document.getElementById('rpi3-2-kpi-cpu-temp')).not.toBeNull();
    expect(document.getElementById('rpi3-2-kpi-throttled')).not.toBeNull();

    // Executive AI Copilot Elements removed per user specification
    expect(document.getElementById('cf-copilot-card')).toBeNull();
    expect(document.getElementById('copilot-headline')).toBeNull();
    expect(document.getElementById('copilot-status-badge')).toBeNull();
    expect(document.getElementById('copilot-bullets')).toBeNull();
    expect(document.getElementById('copilot-refresh-btn')).toBeNull();
    expect(document.getElementById('btn-copilot-topbar')).toBeNull();
    expect(document.getElementById('cf-copilot-drawer')).toBeNull();

    // Workstation specific KPI cards & elements
    expect(document.getElementById('ws-kpi-gpu-util')).not.toBeNull();
    expect(document.getElementById('ws-kpi-tok-rate')).not.toBeNull();
    expect(document.getElementById('ws-kpi-total-tokens')).not.toBeNull();
    expect(document.getElementById('ws-kpi-vram-usage')).not.toBeNull();
    expect(document.getElementById('ws-chart-gpu-legend')).not.toBeNull();
    expect(document.getElementById('ws-chart-tok-legend')).not.toBeNull();
    expect(document.getElementById('ws-chart-prompt-legend')).not.toBeNull();
  });

  it('renders verified live hardware provenance and hides sandbox banner', () => {
    const defaultSnap = createDefaultZodiacSnapshot();
    const liveSnap: ZodiacFullTelemetrySnapshot = {
      ...defaultSnap,
      source: 'live_hardware',
    };

    (window as unknown as { ZodiacApp: { renderTelemetry: (s: unknown, d: boolean) => void } }).ZodiacApp.renderTelemetry(liveSnap, false);

    const sourceTag = document.getElementById('z-source-tag');
    const sandboxBanner = document.getElementById('z-sandbox-banner');

    expect(sourceTag?.textContent).toContain('Active Link');
    expect(sandboxBanner?.style.display).toBe('none');
  });

  it('renders cloud sandbox simulation banner when source is cloud_snapshot', () => {
    const sandboxSnap = createDefaultZodiacSnapshot();

    (window as unknown as { ZodiacApp: { renderTelemetry: (s: unknown, d: boolean) => void } }).ZodiacApp.renderTelemetry(sandboxSnap, false);

    const sourceTag = document.getElementById('z-source-tag');
    const sandboxBanner = document.getElementById('z-sandbox-banner');

    expect(sourceTag?.textContent).toContain('Cloud Sandbox (Simulated)');
    expect(sandboxBanner?.style.display).toBe('flex');
  });

  it('renders physical truth when hardware is disconnected', () => {
    const disconnectedSnap = createDisconnectedZodiacSnapshot();

    (window as unknown as { ZodiacApp: { renderTelemetry: (s: unknown, d: boolean) => void } }).ZodiacApp.renderTelemetry(disconnectedSnap, false);

    const sourceTag = document.getElementById('z-source-tag');
    const sandboxBanner = document.getElementById('z-sandbox-banner');
    const cpuTemp = document.getElementById('z-cpu-temp');

    expect(sourceTag?.textContent).toContain('Hardware Disconnected');
    expect(sandboxBanner?.style.display).toBe('none');
    expect(cpuTemp?.textContent).toBe('--°C');
  });

  it('switches between all appliance views cleanly and updates active tab state', () => {
    const app = (window as unknown as { ZodiacApp: { switchDevice: (d: string) => void } }).ZodiacApp;

    const devices = ['zodiac', 'orin', 'rpi5', 'coral-1', 'coral-2', 'openflow', 'workstation'] as const;

    for (const dev of devices) {
      app.switchDevice(dev);

      // Selected device view should be visible, others hidden
      if (dev === 'zodiac') {
        expect(document.getElementById('view-device-zodiac')?.style.display).toBe('block');
        expect(document.getElementById('view-device-orin')?.style.display).toBe('none');
        expect(document.getElementById('view-device-rpi5')?.style.display).toBe('none');
        expect(document.getElementById('view-device-workstation')?.style.display).toBe('none');
      } else if (dev === 'orin') {
        expect(document.getElementById('view-device-orin')?.style.display).toBe('block');
        expect(document.getElementById('view-device-zodiac')?.style.display).toBe('none');
        expect(document.getElementById('view-device-rpi5')?.style.display).toBe('none');
        expect(document.getElementById('view-device-workstation')?.style.display).toBe('none');
      } else if (dev === 'rpi5') {
        expect(document.getElementById('view-device-rpi5')?.style.display).toBe('block');
        expect(document.getElementById('view-device-zodiac')?.style.display).toBe('none');
        expect(document.getElementById('view-device-orin')?.style.display).toBe('none');
        expect(document.getElementById('view-device-workstation')?.style.display).toBe('none');
        expect(document.getElementById('cf-breadcrumb-name')?.textContent).toBe('Raspberry Pi 5 · Hailo-8 (Node 02)');
      } else if (dev === 'workstation') {
        expect(document.getElementById('view-device-workstation')?.style.display).toBe('block');
        expect(document.getElementById('view-device-zodiac')?.style.display).toBe('none');
        expect(document.getElementById('view-device-orin')?.style.display).toBe('none');
        expect(document.getElementById('view-device-rpi5')?.style.display).toBe('none');
      }
    }
  });

  it('renders workstation metrics with real token velocity and Apple Metal GPU stats', () => {
    const app = (window as unknown as {
      ZodiacApp: {
        renderTelemetry: (s: unknown, d: boolean) => void;
        switchDevice: (d: string) => void;
        updateCharts: () => void;
      };
    }).ZodiacApp;

    const snap = createDefaultZodiacSnapshot();
    const liveWorkstationSnapshot: ZodiacFullTelemetrySnapshot = {
      ...snap,
      source: 'live_hardware',
      workstation: {
        detected: true,
        hostName: 'Andy-MacBook-Pro.local',
        platform: 'darwin',
        osRelease: '25.0.0',
        chipModel: 'Apple M5 Pro',
        cpuCores: 18,
        cpuUtilizationPct: 24,
        memoryTotalBytes: 51539607552n,
        memoryUsedBytes: 25769803776n,
        memoryFreeBytes: 25769803776n,
        loadAvg: [2.5, 2.1, 1.8],
        usbTether: {
          detected: true,
          interfaceName: 'en9',
          ipv4Address: '10.0.0.1',
          gatewayAddress: '10.0.0.15',
          linkSpeedMbps: 5000,
          pingLatencyMs: 0.42,
          packetLossPct: 0,
          status: 'CONNECTED',
        },
        gpuModel: 'Apple M5 Pro',
        gpuCoreCount: 20,
        gpuUtilizationPct: 45,
        rendererUtilizationPct: 38,
        tilerUtilizationPct: 12,
        gpuMemoryUsedBytes: 8589934592n,
        gpuMemoryAllocatedBytes: 38654705664n,
        ollamaStatus: 'ONLINE',
        activeModel: 'llama3:latest',
        modelFormat: 'GGUF',
        modelParameterSize: '8.0B',
        modelQuantization: 'Q4_K_M',
        modelContextLength: 8192,
        modelVramBytes: 5368709120n,
        totalPromptTokens: 124500n,
        totalCompletionTokens: 467333n,
        totalTokens: 591833n,
        totalInferences: 42n,
        tokensPerSecond: 71,
        promptTokensPerSecond: 1140,
        peakTokensPerSecond: 85,
        peakPromptTokensPerSecond: 1320,
        lastInferenceLatencyNs: 14000000n,
        lastPromptEvalDurationNs: 870000000n,
        lastEvalDurationNs: 1200000000n,
        timeToFirstTokenNs: 45000000n,
        perTokenLatencyNs: 14084507n,
        lastTokenCount: 128,
        lastPromptTokenCount: 512,
        lastTotalTokenCount: 640,
        contextUtilizationPct: 7,
        edgeComputeRatioPct: 94,
        endpoint: 'http://10.0.0.1:11435/v1/telemetry',
        timeSeries: [
          {
            timestampMs: Date.now() - 5000,
            cpuUtilizationPct: 20,
            gpuUtilizationPct: 40,
            gpuMemoryUsedBytes: 8589934592n,
            ramUsedBytes: 25769803776n,
            tokensPerSecond: 70,
            promptTokensPerSecond: 1120,
            totalPromptTokens: 120000n,
            totalCompletionTokens: 460000n,
            totalTokens: 580000n,
          },
          {
            timestampMs: Date.now(),
            cpuUtilizationPct: 24,
            gpuUtilizationPct: 45,
            gpuMemoryUsedBytes: 8589934592n,
            ramUsedBytes: 25769803776n,
            tokensPerSecond: 71,
            promptTokensPerSecond: 1140,
            totalPromptTokens: 124500n,
            totalCompletionTokens: 467333n,
            totalTokens: 591833n,
          },
        ],
      },
    };

    app.renderTelemetry(liveWorkstationSnapshot, false);
    app.switchDevice('workstation');
    app.updateCharts();

    const tokKpi = document.getElementById('ws-kpi-tok-rate');
    const gpuKpi = document.getElementById('ws-kpi-gpu-util');
    const totalKpi = document.getElementById('ws-kpi-total-tokens');
    const chipBadge = document.getElementById('ws-chip-badge');
    const ollamaBadge = document.getElementById('ws-ollama-badge');

    expect(tokKpi?.innerText).toContain('71');
    expect(gpuKpi?.innerText).toBe('45%');
    expect(totalKpi?.innerText).toContain('591,833');
    expect(chipBadge?.innerText).toBe('Apple M5 Pro');
    expect(ollamaBadge?.innerText).toContain('ONLINE');
  });

  it('safely handles empty time-series without throwing or creating NaN coordinates', () => {
    const app = (window as unknown as {
      ZodiacApp: {
        renderTelemetry: (s: unknown, d: boolean) => void;
        switchDevice: (d: string) => void;
        updateCharts: () => void;
      };
    }).ZodiacApp;

    const emptySnap: ZodiacFullTelemetrySnapshot = {
      ...createDefaultZodiacSnapshot(),
      source: 'live_hardware',
      timeSeries: [],
      ports: [],
      jetson: undefined,
      coral: undefined,
      workstation: undefined,
    };

    expect(() => {
      app.renderTelemetry(emptySnap, false);
      app.switchDevice('zodiac');
      app.updateCharts();

      app.switchDevice('orin');
      app.updateCharts();

      app.switchDevice('coral-1');
      app.updateCharts();

      app.switchDevice('coral-2');
      app.updateCharts();

      app.switchDevice('workstation');
      app.updateCharts();
    }).not.toThrow();
  });

  it('handles time range selector interactions and preserves UI stability', () => {
    const timeSelectors = document.querySelectorAll('#cf-workstation-time-selectors .cf-time-btn');
    expect(timeSelectors.length).toBeGreaterThanOrEqual(6);

    const ranges = ['live', '1h', '6h', '24h', '7d', '30d'];

    for (const range of ranges) {
      const btn = Array.from(timeSelectors).find(
        (el) => el.getAttribute('data-range') === range
      ) as HTMLButtonElement | undefined;

      expect(btn).toBeDefined();
      expect(() => btn?.click()).not.toThrow();
    }
  });

  it('draws across all appliance canvases when valid telemetry points are supplied', () => {
    const app = (window as unknown as {
      ZodiacApp: {
        renderTelemetry: (s: unknown, d: boolean) => void;
        switchDevice: (d: string) => void;
        updateCharts: () => void;
      };
    }).ZodiacApp;

    const snap = createDefaultZodiacSnapshot();
    app.renderTelemetry(snap, false);

    const devices = ['zodiac', 'orin', 'rpi5', 'coral-1', 'coral-2', 'workstation'] as const;

    for (const dev of devices) {
      app.switchDevice(dev);
      expect(() => app.updateCharts()).not.toThrow();
    }
  });

  it('strictly verifies that Executive AI Copilot UI surface is completely removed from the DOM', () => {
    // 1. Topbar pill
    expect(document.getElementById('btn-copilot-topbar')).toBeNull();
    expect(document.getElementById('copilot-topbar-badge')).toBeNull();

    // 2. In-page banner card
    expect(document.getElementById('cf-copilot-card')).toBeNull();
    expect(document.getElementById('copilot-headline')).toBeNull();
    expect(document.getElementById('copilot-status-badge')).toBeNull();
    expect(document.getElementById('copilot-bullets')).toBeNull();
    expect(document.getElementById('copilot-refresh-btn')).toBeNull();

    // 3. Slide-over drawer and backdrop
    expect(document.getElementById('cf-copilot-drawer')).toBeNull();
    expect(document.getElementById('cf-copilot-drawer-backdrop')).toBeNull();
    expect(document.getElementById('cf-copilot-drawer-close')).toBeNull();
    expect(document.getElementById('copilot-open-drawer-btn')).toBeNull();
  });

  it('renders Raspberry Pi 5 Hailo-8 and tri-interface telemetry in accordance with Council Invariants', () => {
    const app = (window as unknown as {
      ZodiacApp: {
        renderTelemetry: (s: unknown, d: boolean) => void;
        switchDevice: (d: string) => void;
        updateCharts: () => void;
      };
    }).ZodiacApp;

    // 1. Render default snapshot (online simulated twin)
    const snap = createDefaultZodiacSnapshot();
    app.renderTelemetry(snap, false);
    app.switchDevice('rpi5');

    const kpiCompute = document.getElementById('rpi5-kpi-compute');
    const kpiHailoRate = document.getElementById('rpi5-kpi-hailo-rate');
    const kpiEth0Rate = document.getElementById('rpi5-kpi-eth0-rate');
    const kpiCpuTemp = document.getElementById('rpi5-kpi-cpu-temp');
    const kpiHailoTemp = document.getElementById('rpi5-kpi-hailo-temp');
    const hailoStatusBadge = document.getElementById('rpi5-hailo-status-badge');

    expect(kpiCompute?.textContent).toContain('14%');
    expect(kpiHailoRate?.textContent).toContain('120');
    expect(kpiEth0Rate?.textContent).toContain('/s');
    expect(kpiCpuTemp?.textContent).toBe('46.5°C');
    expect(kpiHailoTemp?.textContent).toBe('43.8°C');
    expect(hailoStatusBadge?.textContent).toContain('ACTIVE');

    // Verify all 3 canvases draw without error
    expect(() => app.updateCharts()).not.toThrow();

    // 2. Render disconnected snapshot (Council Invariant 6: physical truth)
    const disconnectedSnap = createDisconnectedZodiacSnapshot();
    app.renderTelemetry(disconnectedSnap, false);

    expect(kpiCpuTemp?.textContent).toBe('--°C');
    expect(kpiHailoTemp?.textContent).toBe('--°C');
    expect(document.getElementById('rpi5-kpi-hailo-badge')?.textContent).toBe('OFFLINE');
    expect(document.getElementById('rpi5-kpi-hailo-rate')?.textContent).toContain('--');
    expect(document.getElementById('rpi5-kpi-eth0-status')?.textContent).toBe('DOWN');
  });

  it('renders Raspberry Pi 3B+ Red Team (Node 01 & 02) telemetry and isolation matrix in accordance with Council Invariants', () => {
    const app = (window as unknown as {
      ZodiacApp: {
        renderTelemetry: (s: unknown, d: boolean) => void;
        switchDevice: (d: string) => void;
        updateCharts: () => void;
      };
    }).ZodiacApp;

    // 1. Render default snapshot (online simulated twin)
    const snap = createDefaultZodiacSnapshot();
    app.renderTelemetry(snap, false);
    app.switchDevice('rpi3-1');

    const kpiEth0Rate1 = document.getElementById('rpi3-1-kpi-eth0-rate');
    const kpiCompute1 = document.getElementById('rpi3-1-kpi-compute');
    const kpiCpuTemp1 = document.getElementById('rpi3-1-kpi-cpu-temp');
    const kpiThrottled1 = document.getElementById('rpi3-1-kpi-throttled');

    expect(kpiEth0Rate1?.textContent).toContain('/s');
    expect(kpiCompute1?.textContent).toContain('%');
    expect(kpiCpuTemp1?.textContent).toBe('35.4°C');
    expect(kpiThrottled1?.textContent).toContain('0x0');

    // Verify default unasserted isolation state (Council Invariant 6: no synthetic verification)
    expect(document.getElementById('rpi3-1-kpi-isolation-status')?.textContent).toBe('NOT INSTALLED');
    expect(document.getElementById('rpi3-1-ctrl-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-gw-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-hailo-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-peer-transit-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-kpi-gw-escape')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-kpi-port1-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-raw-sockets-count')?.textContent).toBe('0');
    expect(document.getElementById('rpi3-1-tcp-sockets-count')?.textContent).toBe('4');

    // Render snapshot with hardware-verified Port 1 isolation
    const verifiedSnap = {
      ...snap,
      port1Isolation: {
        state: 'verified' as const,
        confirmed: ['prio 200 in_port=1 -> [P2,P3]', 'prio 150 in_port=1 -> [P3]'],
        mismatches: [],
        switchErrors: [],
        checkedAtMs: Date.now(),
        checkedAtMonoNs: '1000',
        checkedAgeMs: 50,
        ageStatus: 'ok' as const,
        actions: null,
        provenForwarding: true,
      },
    };
    app.renderTelemetry(verifiedSnap, false);

    // Verify online isolation states when verified by hardware readback
    expect(document.getElementById('rpi3-1-kpi-isolation-status')?.textContent).toBe('ENFORCED');
    expect(document.getElementById('rpi3-1-ctrl-iso-status')?.textContent).toBe('100% BLOCKED');
    expect(document.getElementById('rpi3-1-gw-iso-status')?.textContent).toBe('100% DROPPED');
    expect(document.getElementById('rpi3-1-hailo-iso-status')?.textContent).toBe('PERMITTED');
    expect(document.getElementById('rpi3-1-peer-transit-status')?.textContent).toBe('PERMITTED');
    expect(document.getElementById('rpi3-1-kpi-gw-escape')?.textContent).toBe('0% LEAK');
    expect(document.getElementById('rpi3-1-kpi-port1-status')?.textContent).toBe('ACTIVE');

    // Switch to Node 02
    app.switchDevice('rpi3-2');
    const kpiEth0Rate2 = document.getElementById('rpi3-2-kpi-eth0-rate');
    const kpiCompute2 = document.getElementById('rpi3-2-kpi-compute');
    const kpiCpuTemp2 = document.getElementById('rpi3-2-kpi-cpu-temp');
    const kpiThrottled2 = document.getElementById('rpi3-2-kpi-throttled');

    expect(kpiEth0Rate2?.textContent).toContain('/s');
    expect(kpiCompute2?.textContent).toContain('%');
    expect(kpiCpuTemp2?.textContent).toBe('33.2°C');
    // Invariant 6: Real hardware provenance reflected in 0x50000 throttled register
    expect(kpiThrottled2?.textContent).toContain('0x50000');

    // Verify all charts draw without error
    expect(() => app.updateCharts()).not.toThrow();

    // 2. Render disconnected snapshot (Council Invariant 6: physical truth)
    const disconnectedSnap = createDisconnectedZodiacSnapshot();
    app.renderTelemetry(disconnectedSnap, false);

    expect(document.getElementById('rpi3-1-kpi-cpu-temp')?.textContent).toBe('--°C');
    expect(document.getElementById('rpi3-2-kpi-cpu-temp')?.textContent).toBe('--°C');
    expect(document.getElementById('rpi3-1-uptime')?.textContent).toBe('--:--:--');
    expect(document.getElementById('rpi3-2-uptime')?.textContent).toBe('--:--:--');

    // Invariant 6: Unasserted / OFFLINE states when telemetry is absent (no fabricated security success)
    expect(document.getElementById('rpi3-1-kpi-isolation-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-ctrl-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-gw-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-hailo-iso-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-peer-transit-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-kpi-gw-escape')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-kpi-port1-status')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-raw-sockets-count')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-tcp-sockets-count')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-udp-sockets-count')?.textContent).toBe('--');
    expect(document.getElementById('rpi3-1-containment-status-badge')?.textContent).toBe('UNKNOWN');
  });
});

