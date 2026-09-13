/**
 * prometheus.ts
 * Prometheus metrics exporter formatting telemetry metrics into RFC-compliant exposition format.
 *
 * Invariant:
 * - All counter metric values must be exact integers (BigInt).
 * - Monotonicity is guaranteed.
 */

import { PacketMetric } from '../core/telemetry.js';

export class PrometheusExporter {
  /**
   * Formats a PacketMetric snapshot into standard Prometheus exposition format.
   */
  public static formatSnapshot(metric: PacketMetric, throughputBytesPerSec: bigint = 0n): string {
    const lines: string[] = [
      '# HELP network_packets_ingress_total Total ingress packets received on interface.',
      '# TYPE network_packets_ingress_total counter',
      `network_packets_ingress_total{interface="${metric.interfaceName}"} ${metric.packetsIngress.toString()}`,
      '',
      '# HELP network_packets_egress_total Total egress packets transmitted on interface.',
      '# TYPE network_packets_egress_total counter',
      `network_packets_egress_total{interface="${metric.interfaceName}"} ${metric.packetsEgress.toString()}`,
      '',
      '# HELP network_bytes_ingress_total Total ingress byte volume on interface.',
      '# TYPE network_bytes_ingress_total counter',
      `network_bytes_ingress_total{interface="${metric.interfaceName}"} ${metric.bytesIngress.toString()}`,
      '',
      '# HELP network_bytes_egress_total Total egress byte volume on interface.',
      '# TYPE network_bytes_egress_total counter',
      `network_bytes_egress_total{interface="${metric.interfaceName}"} ${metric.bytesEgress.toString()}`,
      '',
      '# HELP network_packets_dropped_total Total dropped or quarantined packets (fail-closed security).',
      '# TYPE network_packets_dropped_total counter',
      `network_packets_dropped_total{interface="${metric.interfaceName}"} ${metric.droppedPackets.toString()}`,
      '',
      '# HELP network_throughput_bytes_per_second Current estimated throughput in bytes/second.',
      '# TYPE network_throughput_bytes_per_second gauge',
      `network_throughput_bytes_per_second{interface="${metric.interfaceName}"} ${throughputBytesPerSec.toString()}`,
      '',
    ];

    return lines.join('\n');
  }
}
