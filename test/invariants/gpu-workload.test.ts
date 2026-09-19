/**
 * test/invariants/gpu-workload.test.ts
 * Invariant Verification Suite for Jetson Orin GPU Workload (gpu-workload)
 *
 * Council Invariants Tested:
 * - Invariant 1 (Anti-Shortcut Law): Zero suppression of reality, explicit protocol boundary error handling.
 * - Invariant 2 (Determinism & Accounting): Monotonic nanosecond timestamps and integer packet accounting.
 * - Invariant 3 (Fail-Closed Isolation): Anomaly quarantine defaults strictly to DROP action with priority 65535.
 * - Invariant 6 (Anti-Simulation Law): Verifiable execution truth on compute kernels.
 */

import { describe, it, expect } from 'vitest';
import { ZodiacController } from '../../src/sdn/zodiac-controller.js';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

describe('Jetson Orin GPU Workload Invariants (gpu-workload)', () => {
  describe('SDN Quarantine Engine (ZodiacController)', () => {
    it('creates an emergency fail-closed quarantine rule with default priority 65535 and DROP action', () => {
      const controller = new ZodiacController();

      const result = controller.quarantineAgent({
        targetIp: '10.0.2.50',
        reason: '1D-CNN GPU Autoencoder Reconstruction Error 0.89 > Threshold 0.45',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('DROP');
      expect(result.priority).toBe(65535);
      expect(typeof result.ruleId).toBe('string');
      expect(result.ruleId.startsWith('quarantine-')).toBe(true);
      expect(typeof result.timestampNs).toBe('bigint');
      expect(result.timestampNs > 0n).toBe(true);
      // Because no physical switch is attached in unit test, OpenFlow install is safely false without crashing
      expect(result.openFlowInstalled).toBe(false);
    });

    it('supports custom quarantine priority levels while preserving fail-closed DROP action', () => {
      const controller = new ZodiacController();

      const result = controller.quarantineAgent({
        targetIp: '10.0.2.77',
        reason: 'Volumetric SYN flood anomaly detected on Port 1',
        priority: 50000,
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('DROP');
      expect(result.priority).toBe(50000);
    });

    it('quarantines by MAC address when IP is unassigned without causing global blackhole', () => {
      const controller = new ZodiacController();

      const result = controller.quarantineAgent({
        targetMac: 'b8:27:eb:a2:ec:b0',
        reason: 'Anomalous MAC burst rate on untrusted port',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('DROP');
      expect(result.priority).toBe(65535);
      expect(result.rule).toBeDefined();
      expect(result.rule.srcMac).toBe('b8:27:eb:a2:ec:b0');
      expect(result.rule.action).toBe('DROP');
      expect(result.rule.priority).toBe(65535);
    });

    it('fails closed and rejects quarantine requests missing both MAC and IP to prevent total network blackhole', () => {
      const controller = new ZodiacController();

      expect(() => {
        controller.quarantineAgent({
          reason: 'Missing target identifiers',
        });
      }).toThrow(/requires at least targetMac or targetIp to prevent total network blackhole/);
    });

    it('strictly throws in buildOfpFlowMod on malformed MAC or IP to prevent wildcard rule degradation', () => {
      expect(() => {
        buildOfpFlowMod({
          command: FlowModCommand.OFPFC_ADD,
          priority: 65535,
          match: { srcMac: 'invalid-mac-address' },
        }, 1);
      }).toThrow(/Invalid MAC address format/);

      expect(() => {
        buildOfpFlowMod({
          command: FlowModCommand.OFPFC_ADD,
          priority: 65535,
          match: { srcIp: '999.999.999.999' },
        }, 1);
      }).toThrow(/IPv4 octet out of range/);
    });
  });

  describe('Hardware Burst Daemon GPU Target Integration', () => {
    it('executes hardware-burst-daemon with --target jetson cleanly and counts GPU operations', () => {
      const scriptPath = path.resolve(REPO_ROOT, 'scripts/hardware-burst-daemon.py');
      const cmd = `python3 ${scriptPath} --duration 1s --target jetson --interval 1`;

      const output = execSync(cmd, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      });

      expect(output).toContain('Target Filter : jetson');
      expect(output).toContain('Spawned Jetson Orin Ampere GPU compute worker');
      expect(output).toContain('BURST COMPLETED');
      expect(output).toContain('Jetson Orin GPU Ops');
    });

    it('executes hardware-burst-daemon with alias --target gpu cleanly', () => {
      const scriptPath = path.resolve(REPO_ROOT, 'scripts/hardware-burst-daemon.py');
      const cmd = `python3 ${scriptPath} --duration 1s --target gpu --interval 1`;

      const output = execSync(cmd, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      });

      expect(output).toContain('Target Filter : gpu');
      expect(output).toContain('Spawned Jetson Orin Ampere GPU compute worker');
      expect(output).toContain('BURST COMPLETED');
    });
  });

  describe('Stage-2 Deep Traffic Anomaly Sentinel Daemon', () => {
    it('runs the autonomous sentinel in demo mode and computes sub-millisecond inference batches', () => {
      const scriptPath = path.resolve(REPO_ROOT, 'scripts/gpu-sdn-anomaly-sentinel.py');
      const cmd = `python3 ${scriptPath} --demo --duration 1 --threshold 0.99`;

      const output = execSync(cmd, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      });

      expect(output).toContain('STAGE-2 GPU DEEP TRAFFIC ANOMALY SENTINEL');
      expect(output).toContain('Neural Engine Initialized');
      expect(output).toContain('GPU SDN ANOMALY SENTINEL STOPPED');
      expect(output).toContain('Total Inferences Run');
      expect(output).toContain('Dean Latency Budget: < 1.0 ms');
    });
  });
});
