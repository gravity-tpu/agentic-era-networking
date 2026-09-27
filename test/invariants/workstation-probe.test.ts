import { describe, it, expect } from 'vitest';
import os from 'node:os';
import {
  parseAppleSiliconGpuXml,
  probeWorkstationHardware,
} from '../../src/sdn/hardware-probe.js';
import {
  createDefaultWorkstationSnapshot,
  generateWorkstationHistoricalTelemetry,
} from '../../src/sdn/zodiac-telemetry.js';
import {
  recordOllamaInferenceMetrics,
} from '../../scripts/ai-utils.mjs';
import fs from 'node:fs';

const SAMPLE_IOREG_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>model</key>
    <string>Apple M5 Pro</string>
    <key>gpu-core-count</key>
    <integer>20</integer>
    <key>PerformanceStatistics</key>
    <dict>
      <key>Device Utilization %</key>
      <integer>28</integer>
      <key>Renderer Utilization %</key>
      <integer>19</integer>
      <key>Tiler Utilization %</key>
      <integer>5</integer>
      <key>In use system memory</key>
      <integer>2147483648</integer>
      <key>Alloc system memory</key>
      <integer>5368709120</integer>
    </dict>
  </dict>
</array>
</plist>
`;

describe('Workstation Telemetry & Token Accounting Invariants', () => {
  it('parses Apple Silicon GPU metrics from IOKit XML correctly', () => {
    const gpu = parseAppleSiliconGpuXml(SAMPLE_IOREG_XML);

    expect(gpu.gpuModel).toBe('Apple M5 Pro Metal GPU');
    expect(gpu.gpuCoreCount).toBe(20);
    expect(gpu.gpuUtilizationPct).toBe(28);
    expect(gpu.rendererUtilizationPct).toBe(19);
    expect(gpu.tilerUtilizationPct).toBe(5);
    expect(gpu.gpuMemoryUsedBytes).toBe(2147483648n);
    expect(gpu.gpuMemoryAllocatedBytes).toBe(5368709120n);
  });

  it('fails closed to safe defaults on malformed or empty GPU XML', () => {
    const gpu = parseAppleSiliconGpuXml('<plist></plist>');

    expect(gpu.gpuModel).toBe('Apple Silicon Metal GPU');
    expect(gpu.gpuCoreCount).toBe(0);
    expect(gpu.gpuUtilizationPct).toBe(0);
    expect(gpu.rendererUtilizationPct).toBe(0);
    expect(gpu.tilerUtilizationPct).toBe(0);
    expect(gpu.gpuMemoryUsedBytes).toBe(0n);
    expect(gpu.gpuMemoryAllocatedBytes).toBe(0n);
  });

  it('enforces Council Invariant 6 (Fail-Closed Disconnected State)', () => {
    const disconnected = createDefaultWorkstationSnapshot(true);

    expect(disconnected.detected).toBe(false);
    expect(disconnected.ollamaStatus).toBe('OFFLINE');
    expect(disconnected.cpuUtilizationPct).toBe(0);
    expect(disconnected.gpuUtilizationPct).toBe(0);
    expect(disconnected.totalPromptTokens).toBe(0n);
    expect(disconnected.totalCompletionTokens).toBe(0n);
    expect(disconnected.totalTokens).toBe(0n);
    expect(disconnected.tokensPerSecond).toBe(0);
    expect(disconnected.promptTokensPerSecond).toBe(0);
    expect(disconnected.peakTokensPerSecond).toBe(0);
    expect(disconnected.peakPromptTokensPerSecond).toBe(0);
    expect(disconnected.timeToFirstTokenNs).toBe(0n);
    expect(disconnected.perTokenLatencyNs).toBe(0n);
    expect(disconnected.lastPromptTokenCount).toBe(0);
    expect(disconnected.lastTokenCount).toBe(0);
    expect(disconnected.lastTotalTokenCount).toBe(0);
    expect(disconnected.contextUtilizationPct).toBe(0);
    expect(disconnected.edgeComputeRatioPct).toBe(100.0);
    expect(disconnected.gpuMemoryUsedBytes).toBe(0n);
  });

  it('generates zeroed historical time series when workstation is offline', () => {
    const disconnected = createDefaultWorkstationSnapshot(true);
    const series = generateWorkstationHistoricalTelemetry(disconnected, 1, 10);

    expect(series.length).toBe(10);
    for (const pt of series) {
      expect(pt.cpuUtilizationPct).toBe(0);
      expect(pt.gpuUtilizationPct).toBe(0);
      expect(pt.tokensPerSecond).toBe(0);
      expect(pt.promptTokensPerSecond).toBe(0);
      expect(pt.gpuMemoryUsedBytes).toBe(0n);
      expect(pt.totalPromptTokens).toBe(0n);
      expect(pt.totalCompletionTokens).toBe(0n);
      expect(pt.totalTokens).toBe(0n);
    }
  });

  it('records cumulative token accounting metrics accurately to disk', async () => {
    const testFile = `/tmp/test-token-accounting-${Date.now()}.json`;

    try {
      // First inference
      await recordOllamaInferenceMetrics({
        prompt_eval_count: 50,
        prompt_eval_duration: 250_000_000, // 250 ms -> 200 tok/s
        eval_count: 100,
        eval_duration: 1_000_000_000, // 1000 ms -> 100 tok/s
        total_duration: 1_250_000_000,
      }, 'gemma4:26b', testFile);

      let raw = fs.readFileSync(testFile, 'utf8');
      let data = JSON.parse(raw);
      expect(BigInt(data.totalPromptTokens)).toBe(50n);
      expect(BigInt(data.totalCompletionTokens)).toBe(100n);
      expect(BigInt(data.totalTokens)).toBe(150n);
      expect(BigInt(data.totalInferences)).toBe(1n);
      expect(data.tokensPerSecond).toBe(100);
      expect(data.promptTokensPerSecond).toBe(200);
      expect(data.peakTokensPerSecond).toBe(100);
      expect(data.peakPromptTokensPerSecond).toBe(200);
      expect(data.lastPromptTokenCount).toBe(50);
      expect(data.lastTokenCount).toBe(100);
      expect(data.lastTotalTokenCount).toBe(150);
      expect(BigInt(data.timeToFirstTokenNs)).toBe(250_000_000n);
      expect(BigInt(data.perTokenLatencyNs)).toBe(10_000_000n); // 10 ms/tok
      expect(data.edgeComputeRatioPct).toBe(100.0);

      // Second inference — accumulation
      await recordOllamaInferenceMetrics({
        prompt_eval_count: 30,
        prompt_eval_duration: 150_000_000,
        eval_count: 70,
        eval_duration: 700_000_000,
        total_duration: 850_000_000,
      }, 'gemma4:26b', testFile);

      raw = fs.readFileSync(testFile, 'utf8');
      data = JSON.parse(raw);
      expect(BigInt(data.totalPromptTokens)).toBe(80n);
      expect(BigInt(data.totalCompletionTokens)).toBe(170n);
      expect(BigInt(data.totalTokens)).toBe(250n);
      expect(BigInt(data.totalInferences)).toBe(2n);
      expect(data.tokensPerSecond).toBe(100);
      expect(data.promptTokensPerSecond).toBe(200);

      // Third inference: Council Invariant 2 (Token accounting exceeding 2^53 - 1 without IEEE 754 float drift)
      await recordOllamaInferenceMetrics({
        prompt_eval_count: 9_007_199_254_740_992n,
        eval_count: 10n,
      }, 'gemma4:26b', testFile);

      raw = fs.readFileSync(testFile, 'utf8');
      data = JSON.parse(raw);
      expect(BigInt(data.totalPromptTokens)).toBe(9_007_199_254_741_072n);
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  it('guarantees deterministic atomic token accumulation across concurrent inferences without race conditions', async () => {
    const testFile = `/tmp/test-concurrent-tokens-${Date.now()}.json`;

    try {
      const concurrency = 20;
      const tasks = Array.from({ length: concurrency }, (_, i) =>
        recordOllamaInferenceMetrics({
          prompt_eval_count: 10,
          prompt_eval_duration: 100_000_000,
          eval_count: 5,
          eval_duration: 50_000_000,
          total_duration: 150_000_000,
        }, 'gemma4:26b', testFile)
      );

      await Promise.all(tasks);

      const raw = fs.readFileSync(testFile, 'utf8');
      const data = JSON.parse(raw);

      expect(BigInt(data.totalPromptTokens)).toBe(BigInt(concurrency * 10));
      expect(BigInt(data.totalCompletionTokens)).toBe(BigInt(concurrency * 5));
      expect(BigInt(data.totalTokens)).toBe(BigInt(concurrency * 15));
      expect(BigInt(data.totalInferences)).toBe(BigInt(concurrency));
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
      if (fs.existsSync(`${testFile}.lock`)) {
        fs.unlinkSync(`${testFile}.lock`);
      }
    }
  });

  it('probes live workstation hardware on darwin without crashing', async () => {
    if (os.platform() !== 'darwin') {
      const snapshot = await probeWorkstationHardware();
      expect(snapshot.detected).toBe(false);
      return;
    }

    const snapshot = await probeWorkstationHardware();
    expect(snapshot.detected).toBe(true);
    expect(snapshot.cpuCores).toBeGreaterThan(0);
    expect(snapshot.memoryTotalBytes).toBeGreaterThan(0n);
    expect(snapshot.loadAvg.length).toBe(3);
    expect(typeof snapshot.gpuUtilizationPct).toBe('number');
    expect(typeof snapshot.tokensPerSecond).toBe('number');
  });
});
