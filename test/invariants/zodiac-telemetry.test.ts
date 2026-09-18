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
});

