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
  RANGE_CONFIGS,
  getHistoricalTelemetry,
  persistTelemetrySnapshot,
} from '../../src/db/telemetry-db.js';
import { createDefaultZodiacSnapshot, type ZodiacTimeSeriesPoint } from '../../src/sdn/zodiac-telemetry.js';

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

  it('fails safely and returns empty array or false when DATABASE_URL is not configured', async () => {
    // In test environment, DATABASE_URL is unset
    const hist = await getHistoricalTelemetry('24h');
    expect(Array.isArray(hist)).toBe(true);
    expect(hist).toHaveLength(0);

    const snapshot = createDefaultZodiacSnapshot();
    const persisted = await persistTelemetrySnapshot(snapshot);
    expect(persisted).toBe(false);
  });
});
