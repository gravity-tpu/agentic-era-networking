import { describe, it, expect } from 'vitest';
import { PrometheusExporter } from '../../src/telemetry/prometheus.js';
import { PacketMetric } from '../../src/core/telemetry.js';

describe('Invariant: Prometheus Exposition Format & Determinism', () => {
  it('formats telemetry metrics into valid Prometheus text exposition with integer values', () => {
    const metric: PacketMetric = {
      interfaceName: 'eth0',
      packetsIngress: 12_345_678n,
      packetsEgress: 9_876_543n,
      bytesIngress: 18_691_356_492n,
      bytesEgress: 14_953_086_102n,
      droppedPackets: 42n,
      timestampNs: 1_700_000_000_000_000_000n,
    };

    const output = PrometheusExporter.formatSnapshot(metric, 100_000_000n);

    // Verify presence of headers
    expect(output).toContain('# TYPE network_packets_ingress_total counter');
    expect(output).toContain('# TYPE network_bytes_ingress_total counter');
    expect(output).toContain('# TYPE network_packets_dropped_total counter');
    expect(output).toContain('# TYPE network_throughput_bytes_per_second gauge');

    // Verify exact integer serializations (no scientific notation or floats)
    expect(output).toContain('network_packets_ingress_total{interface="eth0"} 12345678');
    expect(output).toContain('network_bytes_ingress_total{interface="eth0"} 18691356492');
    expect(output).toContain('network_packets_dropped_total{interface="eth0"} 42');
    expect(output).toContain('network_throughput_bytes_per_second{interface="eth0"} 100000000');
  });
});
