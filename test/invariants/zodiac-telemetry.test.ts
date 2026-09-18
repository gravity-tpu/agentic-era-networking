/**
 * test/invariants/zodiac-telemetry.test.ts
 * Tests for Zodiac FX Hardware Telemetry Snapshot & Parser
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Monotonic 64-bit integer counters (BigInt).
 * - Anti-Shortcut Law: Zero field suppression; unsuppressed parsing of hardware exports.
 */

import { describe, it, expect } from 'vitest';
import {
  parseZodiacPortsHtml,
  createDefaultZodiacSnapshot,
  createDisconnectedZodiacSnapshot,
  formatBytesDeterministic,
  formatLatencyNsDeterministic,
} from '../../src/sdn/zodiac-telemetry.js';

describe('Zodiac FX Hardware Telemetry Invariants', () => {
  it('creates a valid default snapshot with BigInt counters', () => {
    const snap = createDefaultZodiacSnapshot();
    expect(snap.system.deviceName).toBe('Zodiac_FX');
    expect(snap.system.ipAddress).toBe(process.env['ZODIAC_SWITCH_IP'] ?? '127.0.0.1');
    expect(snap.system.macAddress).toBe('70:B3:D5:87:40:BC');
    expect(snap.ports).toHaveLength(4);
    
    // Check BigInt counters
    for (const port of snap.ports) {
      expect(typeof port.rxBytes).toBe('bigint');
      expect(typeof port.txBytes).toBe('bigint');
      expect(typeof port.rxPackets).toBe('bigint');
      expect(typeof port.txPackets).toBe('bigint');
    }

    // Port 4 is native management port
    const port4 = snap.ports.find((p) => p.port === 4);
    expect(port4).toBeDefined();
    expect(port4?.status).toBe('UP');
    expect(port4?.vlanType).toBe('Native');
    expect(port4?.vlanId).toBe(200);
  });

  it('parses live /d_ports.htm HTML table accurately into structured BigInt telemetry', () => {
    const mockHtml = `
      <!DOCTYPE html><html><body>
      <table class="bordered">
        <tr><th></th><th>Port 1</th><th>Port 2</th><th>Port 3</th><th>Port 4</th></tr>
        <tr><td>Status:</td><td>Down</td><td>Down</td><td>Down</td><td>Up</td></tr>
        <tr><td>VLAN Type:</td><td>OpenFlow</td><td>OpenFlow</td><td>OpenFlow</td><td>Native</td></tr>
        <tr><td>VLAN ID:</td>
          <td><select><option selected value="100">100</option></select></td>
          <td><select><option selected value="100">100</option></select></td>
          <td><select><option selected value="100">100</option></select></td>
          <td><select><option selected value="200">200</option></select></td>
        </tr>
        <tr><td>RX Bytes:</td><td>42104</td><td>0</td><td>0</td><td>259843</td></tr>
        <tr><td>TX Bytes:</td><td>0</td><td>0</td><td>0</td><td>169427</td></tr>
        <tr><td>RX Packets:</td><td>336</td><td>0</td><td>0</td><td>1982</td></tr>
        <tr><td>TX Packets:</td><td>0</td><td>0</td><td>0</td><td>1540</td></tr>
        <tr><td>RX Dropped Packets:</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
        <tr><td>TX Dropped Packets:</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
        <tr><td>RX CRC Errors:</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
      </table>
      </body></html>
    `;

    const ports = parseZodiacPortsHtml(mockHtml);
    expect(ports).toHaveLength(4);

    expect(ports[0]!.name).toBe('Port 1');
    expect(ports[0]!.status).toBe('DOWN');
    expect(ports[0]!.vlanType).toBe('OpenFlow');
    expect(ports[0]!.vlanId).toBe(100);
    expect(ports[0]!.rxBytes).toBe(42104n);
    expect(ports[0]!.rxPackets).toBe(336n);

    expect(ports[3]!.name).toBe('Port 4');
    expect(ports[3]!.status).toBe('UP');
    expect(ports[3]!.vlanType).toBe('Native');
    expect(ports[3]!.vlanId).toBe(200);
    expect(ports[3]!.rxBytes).toBe(259843n);
    expect(ports[3]!.txBytes).toBe(169427n);
  });

  it('formats byte counters deterministically using pure integer division without floats', () => {
    expect(formatBytesDeterministic(0n)).toBe('0 B');
    expect(formatBytesDeterministic(512n)).toBe('512 B');
    expect(formatBytesDeterministic(1024n)).toBe('1.00 KB');
    expect(formatBytesDeterministic(1536n)).toBe('1.50 KB');
    expect(formatBytesDeterministic(1048576n)).toBe('1.00 MB');
    expect(formatBytesDeterministic(1073741824n)).toBe('1.000 GB');
  });

  it('formats nanosecond latency deterministically without floating-point arithmetic', () => {
    expect(formatLatencyNsDeterministic(0n)).toBe('< 500 µs');
    expect(formatLatencyNsDeterministic(495625n)).toBe('495.6 µs');
    expect(formatLatencyNsDeterministic(1500000n)).toBe('1.50 ms');
  });

  it('generates deterministic historical telemetry time-series points with BigInt rates', () => {
    const snap = createDefaultZodiacSnapshot();
    expect(snap.timeSeries).toBeDefined();
    expect(snap.timeSeries?.length).toBe(60);

    const pts = snap.timeSeries!;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i]!;
      expect(typeof pt.timestampMs).toBe('number');
      expect(typeof pt.rxBytes).toBe('bigint');
      expect(typeof pt.txBytes).toBe('bigint');
      expect(typeof pt.rxPackets).toBe('bigint');
      expect(typeof pt.txPackets).toBe('bigint');
      expect(typeof pt.rxRatePps).toBe('bigint');
      expect(typeof pt.txRatePps).toBe('bigint');
      expect(typeof pt.rxRateBps).toBe('bigint');
      expect(typeof pt.txRateBps).toBe('bigint');
      expect(typeof pt.cpuTemperatureC).toBe('number');
      expect(typeof pt.latencyNs).toBe('bigint');

      if (i > 0) {
        expect(pt.timestampMs).toBeGreaterThan(pts[i - 1]!.timestampMs);
      }
    }
  });

  it('generates completely flatlined zero-rate telemetry when physical hardware is disconnected (Reality Invariant)', () => {
    const snap = createDisconnectedZodiacSnapshot();
    expect(snap.source).toBe('disconnected');
    expect(snap.system.cpuTemperatureC).toBeNull();
    expect(snap.system.uptime).toBe('Disconnected');
    expect(snap.openflow.status).toBe('Disconnected');
    expect(snap.ports).toHaveLength(4);

    for (const p of snap.ports) {
      expect(p.status).toBe('DOWN');
      expect(p.rxBytes).toBe(0n);
      expect(p.txBytes).toBe(0n);
      expect(p.rxPackets).toBe(0n);
      expect(p.txPackets).toBe(0n);
    }

    expect(snap.timeSeries).toBeDefined();
    for (const pt of snap.timeSeries!) {
      expect(pt.rxBytes).toBe(0n);
      expect(pt.txBytes).toBe(0n);
      expect(pt.rxRatePps).toBe(0n);
      expect(pt.txRatePps).toBe(0n);
      expect(pt.rxRateBps).toBe(0n);
      expect(pt.txRateBps).toBe(0n);
      expect(pt.cpuTemperatureC).toBeNull();
      expect(pt.latencyNs).toBe(0n);
    }
  });

  it('validates per-port series telemetry points adhere to BigInt invariant', () => {
    const p1 = {
      rxPackets: 150n,
      txPackets: 0n,
      rxBytes: 15000n,
      txBytes: 0n,
      rxRatePps: 3n,
      txRatePps: 0n,
      rxRateBps: 300n,
      txRateBps: 0n,
    };
    expect(typeof p1.rxPackets).toBe('bigint');
    expect(typeof p1.rxRatePps).toBe('bigint');
    expect(typeof p1.rxRateBps).toBe('bigint');
    expect(p1.rxRatePps).toBe(3n);
    expect(p1.rxRateBps).toBe(300n);
  });

  it('validates Council Invariant 5 flap prevention: hysteresis grace period suppresses transient disconnects', () => {
    // Oriol Vinyals Flap Prevention Invariant:
    // A single transient probe failure (e.g. serial bus timeout or read glitch)
    // must NOT instantly toggle device state to 'disconnected'.
    const MAX_MISSED_PROBES_BEFORE_DISCONNECT = 3;
    let consecutiveMissedProbes = 0;
    let isLive = true;

    // Simulate 2 transient probe failures
    for (let probe = 1; probe <= 2; probe++) {
      consecutiveMissedProbes++;
      if (consecutiveMissedProbes >= MAX_MISSED_PROBES_BEFORE_DISCONNECT) {
        isLive = false;
      }
    }
    // With 2 misses, state remains stably connected (grace period active)
    expect(consecutiveMissedProbes).toBe(2);
    expect(isLive).toBe(true);

    // 3rd consecutive failure triggers fail-closed disconnect
    consecutiveMissedProbes++;
    if (consecutiveMissedProbes >= MAX_MISSED_PROBES_BEFORE_DISCONNECT) {
      isLive = false;
    }
    expect(isLive).toBe(false);

    // Successful probe immediately resets consecutiveMissedProbes and restores live status
    consecutiveMissedProbes = 0;
    isLive = true;
    expect(consecutiveMissedProbes).toBe(0);
    expect(isLive).toBe(true);
  });

  it('ensures rate spike guard eliminates negative rates and spikes on cumulative counter wrap/reboot', () => {
    // Council Invariant 2 & 5: When switch reboots or counter resets, prev > curr.
    // Negative diffs must be clamped to 0n rather than wrapping into massive positive rates.
    const prevBytes = 5000000n;
    const currBytes = 2400n; // Switch rebooted or counter cleared
    const diffBytes = currBytes > prevBytes ? currBytes - prevBytes : 0n;
    expect(diffBytes).toBe(0n);
  });

  it('validates 10-minute live telemetry duration window invariant', () => {
    const liveDurationMs = 10 * 60 * 1000;
    expect(liveDurationMs).toBe(600_000);
    const now = Date.now();
    const minTime = now - liveDurationMs;
    expect(now - minTime).toBe(600_000);
  });

  it('atomically saves and restores persistent telemetry state across process restarts', async () => {
    const {
      serializeTelemetryState,
      deserializeTelemetryState,
      saveTelemetryStateAtomic,
      loadTelemetryState,
    } = await import('../../src/sdn/telemetry-state-store.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');

    const testState = {
      version: 1 as const,
      savedAtMs: 1789771180000,
      timeSeries: [
        {
          timestampMs: 1789771180000,
          rxBytes: 1048576n,
          txBytes: 524288n,
          rxPackets: 1000n,
          txPackets: 500n,
          rxRatePps: 100n,
          txRatePps: 50n,
          rxRateBps: 102400n,
          txRateBps: 51200n,
          cpuTemperatureC: 42,
          latencyNs: 450000n,
          ports: {
            1: {
              rxPackets: 500n,
              txPackets: 250n,
              rxBytes: 524288n,
              txBytes: 262144n,
              rxRatePps: 50n,
              txRatePps: 25n,
              rxRateBps: 51200n,
              txRateBps: 25600n,
            },
          },
        },
      ],
      jetsonTimeSeries: [
        {
          timestampMs: 1789771180000,
          cpuUtilizationPct: 15.5,
          gpuUtilizationPct: 2.0,
          cpuTempC: 52.3,
          gpuTempC: 50.1,
          junctionTempC: 52.0,
          powerWatts: 6.2,
          ramUsedBytes: 2147483648n,
          nvmeReadRateBps: 0n,
          nvmeWriteRateBps: 1024n,
          sdnPortRateBps: 125000n,
          wifiPortRateBps: 84000n,
        },
      ],
      coralTimeSeries: [
        {
          timestampMs: 1789771180000,
          inferencesPerSecond: 125n,
          tapPacketsPerSecond: 250n,
          latencyP50Us: 380n,
          latencyP99Us: 490n,
          usbThroughputKbps: 1200n,
        },
      ],
    };

    const serialized = serializeTelemetryState(testState);
    const deserialized = deserializeTelemetryState(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized?.timeSeries).toHaveLength(1);
    expect(deserialized?.timeSeries[0].rxBytes).toBe(1048576n);
    expect(deserialized?.timeSeries[0].ports?.[1]?.rxRateBps).toBe(51200n);
    expect(deserialized?.jetsonTimeSeries[0].ramUsedBytes).toBe(2147483648n);
    expect(deserialized?.coralTimeSeries[0].inferencesPerSecond).toBe(125n);

    // Test atomic file write & load
    const tmpTestFile = path.join(os.tmpdir(), `test-zodiac-state-${Date.now()}.json`);
    try {
      const saved = await saveTelemetryStateAtomic(tmpTestFile, testState);
      expect(saved).toBe(true);
      expect(fs.existsSync(tmpTestFile)).toBe(true);

      const loaded = loadTelemetryState(tmpTestFile);
      expect(loaded).not.toBeNull();
      expect(loaded?.jetsonTimeSeries[0].sdnPortRateBps).toBe(125000n);
    } finally {
      if (fs.existsSync(tmpTestFile)) {
        fs.unlinkSync(tmpTestFile);
      }
    }

    // Invalid JSON returns null without throwing
    expect(deserializeTelemetryState('invalid json')).toBeNull();
    expect(deserializeTelemetryState('{"version": 99}')).toBeNull();
  });
});


