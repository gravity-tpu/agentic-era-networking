/**
 * test/invariants/telemetry-downsampling.test.ts
 * Tests for Neon DB Historical Downsampling Engine (Council Invariants 2 & 6)
 *
 * Council Invariants:
 * - Dean Latency & Memory Budget: Querying up to 30 days of data returns < 360 points (< 50KB payload).
 * - Ghemawat Radical Simplicity: Graceful degradation when database credentials are not configured.
 * - Deterministic Arithmetic: Banish floating point; BigInt rates remain exact.
 */

import { describe, it, expect } from 'vitest';
import {
  downsamplePoints,
  downsampleJetsonPoints,
  downsampleCoralPoints,
  downsampleWorkstationPoints,
  RANGE_CONFIGS,
  RANGE_DURATION_MS,
  findCutoffIndex,
  getHistoricalTelemetry,
  getHistoricalMultiDeviceTelemetry,
  persistTelemetrySnapshot,
  pruneOldTelemetry,
} from '../../src/db/telemetry-db.js';
import { createDefaultZodiacSnapshot, type ZodiacTimeSeriesPoint } from '../../src/sdn/zodiac-telemetry.js';
import pruneCronHandler from '../../api/cron/prune-telemetry.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('Neon DB Historical Downsampling Engine', () => {
  it('strictly bounds any large dataset to maxPoints <= 360', () => {
    // Generate 1,000 synthetic raw points
    const rawPoints: ZodiacTimeSeriesPoint[] = [];
    const baseMs = 1789300000000;

    for (let i = 0; i < 1000; i++) {
      rawPoints.push({
        timestampMs: baseMs + i * 2500,
        rxBytes: BigInt(i * 100),
        txBytes: 0n,
        rxPackets: BigInt(i * 10),
        txPackets: 0n,
        rxRatePps: 10n,
        txRatePps: 0n,
        rxRateBps: 1000n,
        txRateBps: 0n,
        cpuTemperatureC: 30 + (i % 5),
        latencyNs: 500000n,
      });
    }

    // Downsample to maxPoints = 120 (1h window)
    const downsampled120 = downsamplePoints(rawPoints, 120);
    expect(downsampled120.length).toBeLessThanOrEqual(120);
    expect(downsampled120.length).toBeGreaterThan(0);

    // Downsample to maxPoints = 360 (30d window)
    const downsampled360 = downsamplePoints(rawPoints, 360);
    expect(downsampled360.length).toBeLessThanOrEqual(360);
    expect(downsampled360.length).toBeGreaterThan(0);
  });

  it('maintains BigInt precision and deterministic math in downsampled averages', () => {
    const rawPoints: ZodiacTimeSeriesPoint[] = [
      {
        timestampMs: 1000,
        rxBytes: 100n,
        txBytes: 0n,
        rxPackets: 10n,
        txPackets: 0n,
        rxRatePps: 20n,
        txRatePps: 0n,
        rxRateBps: 200n,
        txRateBps: 0n,
        cpuTemperatureC: 30,
        latencyNs: 1000000n,
      },
      {
        timestampMs: 2000,
        rxBytes: 200n,
        txBytes: 0n,
        rxPackets: 20n,
        txPackets: 0n,
        rxRatePps: 40n,
        txRatePps: 0n,
        rxRateBps: 400n,
        txRateBps: 0n,
        cpuTemperatureC: 40,
        latencyNs: 2000000n,
      },
    ];

    // Downsample 2 points to 1 point
    const result = downsamplePoints(rawPoints, 1);
    expect(result).toHaveLength(1);

    const pt = result[0]!;
    expect(pt.rxRatePps).toBe(30n); // (20 + 40) / 2
    expect(pt.rxRateBps).toBe(300n); // (200 + 400) / 2
    expect(pt.latencyNs).toBe(1500000n); // (1000000 + 2000000) / 2
    expect(pt.cpuTemperatureC).toBe(35); // (30 + 40) / 2
    expect(pt.rxBytes).toBe(200n); // Last point cumulative value
  });

  it('ensures all range configurations strictly cap maxPoints at <= 360', () => {
    const ranges = ['1h', '6h', '24h', '7d', '30d'] as const;
    for (const range of ranges) {
      const config = RANGE_CONFIGS[range];
      expect(config).toBeDefined();
      expect(config!.maxPoints).toBeLessThanOrEqual(360);
      expect(config!.bucketSeconds).toBeGreaterThan(0);
    }
  });

  it('strictly bounds Jetson time-series downsampling to maxPoints with exact BigInt rates', () => {
    const rawJetson = Array.from({ length: 500 }, (_, i) => ({
      timestampMs: 1789300000000 + i * 2500,
      cpuUtilizationPct: 20 + (i % 10),
      gpuUtilizationPct: 10 + (i % 5),
      cpuTempC: 45 + (i % 3),
      gpuTempC: 42 + (i % 3),
      junctionTempC: 48 + (i % 3),
      powerWatts: 6.5,
      ramUsedBytes: BigInt(4_000_000_000 + i * 1000),
      nvmeReadRateBps: 1048576n,
      nvmeWriteRateBps: 262144n,
      sdnPortRateBps: BigInt(10000 + i * 10),
      wifiPortRateBps: BigInt(25000 + i * 20),
    }));

    const downsampled = downsampleJetsonPoints(rawJetson, 120);
    expect(downsampled.length).toBeLessThanOrEqual(120);
    expect(downsampled.length).toBeGreaterThan(0);
    expect(typeof downsampled[0]!.sdnPortRateBps).toBe('bigint');
    expect(typeof downsampled[0]!.wifiPortRateBps).toBe('bigint');
    expect(typeof downsampled[0]!.ramUsedBytes).toBe('bigint');
    expect(Number.isInteger(downsampled[0]!.cpuTempC)).toBe(true);
  });

  it('strictly bounds Coral time-series downsampling to maxPoints with exact BigInt IPS and Tap rates', () => {
    const rawCoral = Array.from({ length: 400 }, (_, i) => ({
      timestampMs: 1789300000000 + i * 2500,
      inferencesPerSecond: BigInt(50 + (i % 15)),
      tapPacketsPerSecond: BigInt(i % 2 === 0 ? 100 : 0),
      latencyP50Us: 320n,
      latencyP99Us: 480n,
      usbThroughputKbps: 45n,
    }));

    const downsampled = downsampleCoralPoints(rawCoral, 100);
    expect(downsampled.length).toBeLessThanOrEqual(100);
    expect(downsampled.length).toBeGreaterThan(0);
    expect(typeof downsampled[0]!.inferencesPerSecond).toBe('bigint');
    expect(typeof downsampled[0]!.tapPacketsPerSecond).toBe('bigint');
    expect(typeof downsampled[0]!.latencyP50Us).toBe('bigint');
    expect(typeof downsampled[0]!.latencyP99Us).toBe('bigint');
    expect(typeof downsampled[0]!.usbThroughputKbps).toBe('bigint');
  });

  it('correctly downsamples Workstation M5 time-series with BigInt integer precision', () => {
    const rawWorkstation = Array.from({ length: 500 }, (_, i) => ({
      timestampMs: 1789300000000 + i * 2500,
      cpuUtilizationPct: 5 + (i % 20),
      gpuUtilizationPct: 15 + (i % 30),
      gpuMemoryUsedBytes: BigInt(2_000_000_000 + i * 1_000_000),
      ramUsedBytes: BigInt(50_000_000_000 + i * 10_000_000),
      tokensPerSecond: 70 + (i % 10),
      promptTokensPerSecond: 800 + (i % 50),
      totalPromptTokens: BigInt(100_000 + i * 500),
      totalCompletionTokens: BigInt(20_000 + i * 100),
      totalTokens: BigInt(120_000 + i * 600),
    }));

    const downsampled = downsampleWorkstationPoints(rawWorkstation, 120);
    expect(downsampled.length).toBeLessThanOrEqual(120);
    expect(downsampled.length).toBeGreaterThan(0);
    expect(typeof downsampled[0]!.gpuMemoryUsedBytes).toBe('bigint');
    expect(typeof downsampled[0]!.ramUsedBytes).toBe('bigint');
    expect(typeof downsampled[0]!.totalPromptTokens).toBe('bigint');
    expect(typeof downsampled[0]!.totalCompletionTokens).toBe('bigint');
    expect(typeof downsampled[0]!.totalTokens).toBe('bigint');
    expect(Number.isInteger(downsampled[0]!.cpuUtilizationPct)).toBe(true);
    expect(Number.isInteger(downsampled[0]!.gpuUtilizationPct)).toBe(true);
    expect(Number.isInteger(downsampled[0]!.tokensPerSecond)).toBe(true);
    expect(Number.isInteger(downsampled[0]!.promptTokensPerSecond)).toBe(true);
  });

  it('fails safely and returns empty array or false when DATABASE_URL is not configured', async () => {
    // In test environment, DATABASE_URL is unset
    const hist = await getHistoricalTelemetry('24h');
    expect(Array.isArray(hist)).toBe(true);
    expect(hist).toHaveLength(0);

    const snapshot = createDefaultZodiacSnapshot();
    const persisted = await persistTelemetrySnapshot(snapshot);
    expect(persisted).toBe(false);

    const pruned = await pruneOldTelemetry(30);
    expect(pruned).toBe(0);
  });
});

describe('30-Day Retention Pruning Cron (api/cron/prune-telemetry)', () => {
  function createMockHttp(options: {
    method?: string;
    headers?: Record<string, string>;
  }) {
    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    let responseBody = '';

    const req = {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    } as unknown as IncomingMessage;

    const res = {
      setHeader: (k: string, v: string) => { responseHeaders[k.toLowerCase()] = v; },
      get statusCode() { return statusCode; },
      set statusCode(c: number) { statusCode = c; },
      end: (chunk?: string) => { if (chunk) responseBody += chunk; },
    } as unknown as ServerResponse;

    return { req, res, getStatus: () => statusCode, getBody: () => responseBody };
  }

  it('rejects unsupported HTTP methods with 405 (Fail-Closed Default Drop)', async () => {
    const { req, res, getStatus, getBody } = createMockHttp({ method: 'DELETE' });
    await pruneCronHandler(req, res);
    expect(getStatus()).toBe(405);
    expect(getBody()).toContain('Method Not Allowed');
  });

  it('rejects unauthenticated cron invocation with 401 when CRON_SECRET is required', async () => {
    const prevSecret = process.env['CRON_SECRET'];
    process.env['CRON_SECRET'] = 'secret-test-key-12345';

    try {
      const { req, res, getStatus } = createMockHttp({ method: 'GET', headers: {} });
      await pruneCronHandler(req, res);
      expect(getStatus()).toBe(401);
    } finally {
      if (prevSecret !== undefined) {
        process.env['CRON_SECRET'] = prevSecret;
      } else {
        delete process.env['CRON_SECRET'];
      }
    }
  });

  it('executes pruning and returns 200 when authenticated with Bearer CRON_SECRET', async () => {
    const prevSecret = process.env['CRON_SECRET'];
    process.env['CRON_SECRET'] = 'secret-test-key-12345';

    try {
      const { req, res, getStatus, getBody } = createMockHttp({
        method: 'GET',
        headers: { authorization: 'Bearer secret-test-key-12345' },
      });
      await pruneCronHandler(req, res);
      expect(getStatus()).toBe(200);
      const parsed = JSON.parse(getBody());
      expect(parsed.status).toBe('ok');
      expect(parsed.retentionDays).toBe(30);
      expect(typeof parsed.prunedCount).toBe('number');
    } finally {
      if (prevSecret !== undefined) {
        process.env['CRON_SECRET'] = prevSecret;
      } else {
        delete process.env['CRON_SECRET'];
      }
    }
  });

  it('anchors the final downsampled bucket to the latest raw timestamp to eliminate trailing gaps', () => {
    const rawPoints: ZodiacTimeSeriesPoint[] = [];
    const baseMs = 1000000;
    // 100 points spaced 2500ms apart
    for (let i = 0; i < 100; i++) {
      rawPoints.push({
        timestampMs: baseMs + i * 2500,
        rxBytes: BigInt(i * 10),
        txBytes: 0n,
        rxPackets: BigInt(i),
        txPackets: 0n,
        rxRatePps: 1n,
        txRatePps: 0n,
        rxRateBps: 100n,
        txRateBps: 0n,
        cpuTemperatureC: 40,
        latencyNs: 1000n,
      });
    }

    const latestRawTimestamp = rawPoints[rawPoints.length - 1]!.timestampMs;
    // Downsample into 10 buckets
    const downsampled = downsamplePoints(rawPoints, 10);
    expect(downsampled.length).toBeLessThanOrEqual(10);
    // Crucial invariant: The very last downsampled point must match the newest raw point's timestamp
    const lastDownsampled = downsampled[downsampled.length - 1]!;
    expect(lastDownsampled.timestampMs).toBe(latestRawTimestamp);
  });

  it('provides exact integer millisecond duration mappings in RANGE_DURATION_MS', () => {
    expect(RANGE_DURATION_MS['1h']).toBe(3600 * 1000);
    expect(RANGE_DURATION_MS['6h']).toBe(6 * 3600 * 1000);
    expect(RANGE_DURATION_MS['24h']).toBe(24 * 3600 * 1000);
    expect(RANGE_DURATION_MS['7d']).toBe(7 * 24 * 3600 * 1000);
    expect(RANGE_DURATION_MS['30d']).toBe(30 * 24 * 3600 * 1000);
  });

  describe('findCutoffIndex (Sanjay Ghemawat O(log N) bisection)', () => {
    it('handles empty array', () => {
      expect(findCutoffIndex([], 1000)).toBe(0);
    });

    it('returns 0 when all points are newer than cutoff', () => {
      const pts = [{ timestampMs: 100 }, { timestampMs: 200 }, { timestampMs: 300 }];
      expect(findCutoffIndex(pts, 50)).toBe(0);
      expect(findCutoffIndex(pts, 100)).toBe(0);
    });

    it('returns length when all points are older than cutoff', () => {
      const pts = [{ timestampMs: 100 }, { timestampMs: 200 }, { timestampMs: 300 }];
      expect(findCutoffIndex(pts, 350)).toBe(3);
    });

    it('finds the exact lower bound index in O(log N) steps', () => {
      const pts = [
        { timestampMs: 10 },
        { timestampMs: 20 },
        { timestampMs: 30 },
        { timestampMs: 40 },
        { timestampMs: 50 },
      ];
      expect(findCutoffIndex(pts, 25)).toBe(2); // pts[2] is 30 >= 25
      expect(findCutoffIndex(pts, 30)).toBe(2); // pts[2] is 30 >= 30
      expect(findCutoffIndex(pts, 31)).toBe(3); // pts[3] is 40 >= 31

      // Verify slicing with the cutoff index produces exact subset
      const sliced = pts.slice(findCutoffIndex(pts, 30));
      expect(sliced).toHaveLength(3);
      expect(sliced[0]!.timestampMs).toBe(30);
      expect(sliced[2]!.timestampMs).toBe(50);
    });
  });
});
