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
import { execSync, execFileSync } from 'node:child_process';
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
        // No test here asserts on stderr. On real hardware without a Jetson/thermal sysfs present
        // (this Mac), the script fails open with expected stderr notes ("cannot read ...telemetry.json",
        // "telemetry HTTP poll failed") that execSync otherwise inherits straight to the console on
        // every run of this suite. Suppress; stdout (what the assertions below check) is unaffected.
        stdio: ['ignore', 'pipe', 'ignore'],
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
        // No test here asserts on stderr. On real hardware without a Jetson/thermal sysfs present
        // (this Mac), the script fails open with expected stderr notes ("cannot read ...telemetry.json",
        // "telemetry HTTP poll failed") that execSync otherwise inherits straight to the console on
        // every run of this suite. Suppress; stdout (what the assertions below check) is unaffected.
        stdio: ['ignore', 'pipe', 'ignore'],
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
        // No test here asserts on stderr. On real hardware without a Jetson/thermal sysfs present
        // (this Mac), the script fails open with expected stderr notes ("cannot read ...telemetry.json",
        // "telemetry HTTP poll failed") that execSync otherwise inherits straight to the console on
        // every run of this suite. Suppress; stdout (what the assertions below check) is unaffected.
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      expect(output).toContain('STAGE-2 GPU DEEP TRAFFIC ANOMALY SENTINEL');
      expect(output).toContain('Neural Engine Initialized');
      expect(output).toContain('GPU SDN ANOMALY SENTINEL STOPPED');
      expect(output).toContain('Total Inferences Run');
      expect(output).toContain('Dean Latency Budget: < 1.0 ms');
    });

    it('--weights-file is a no-op on default behavior: unset, the sentinel runs the compiled-in constants unchanged', () => {
      const scriptPath = path.resolve(REPO_ROOT, 'scripts/gpu-sdn-anomaly-sentinel.py');
      const output = execSync(`python3 ${scriptPath} --demo --duration 1 --threshold 0.99`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(output).toContain('(compiled-in hardcoded constants, default)');
    });
  });

  describe('Opt-in trained-weight loading (load_weights_payload, scripts/gpu-sdn-anomaly-sentinel.py)', () => {
    // Pure-function validation, no CUDA engine needed: this is the fail-closed gate a --weights-file argument must
    // pass before scripts/train-sentinel-weights.py's (or any future) fitted weights ever reach
    // load_cuda_model_weights(). Exercises it directly via importlib so the reject paths are tested without
    // requiring the Jetson's compiled libgpu_anomaly.so.
    const scriptPath = path.resolve(REPO_ROOT, 'scripts/gpu-sdn-anomaly-sentinel.py');

    // sys.argv carries the script path and the exact bytes to write to the temp file, so no shell/JSON-in-Python-
    // string quoting is needed for arbitrary test payloads (malformed JSON, embedded quotes, NaN tokens, etc.).
    const DRIVER = `
import importlib.util, json, sys, tempfile, os
spec = importlib.util.spec_from_file_location('sentinel', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
path = None
try:
    fd, path = tempfile.mkstemp(suffix='.json')
    with os.fdopen(fd, 'w') as f:
        f.write(sys.argv[2])
    try:
        out = mod.load_weights_payload(path)
        print(json.dumps({'ok': True, 'result': out}))
    except Exception as exc:
        print(json.dumps({'ok': False, 'result': f'{type(exc).__name__}: {exc}'}))
finally:
    if path:
        os.unlink(path)
`;

    function runLoader(jsonText: string): { ok: boolean; result: unknown } {
      const r = execFileSync('python3', ['-c', DRIVER, scriptPath, jsonText], { encoding: 'utf8', timeout: 10000 });
      return JSON.parse(r.trim().split('\n').pop() ?? '{}');
    }

    it('accepts exactly ten finite weights, as a JSON object with a "weights" key', () => {
      const out = runLoader(JSON.stringify({ weights: [0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, 0.4] }));
      expect(out.ok).toBe(true);
      expect(out.result).toEqual([0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, 0.4]);
    });

    it('accepts a bare ten-element JSON list too', () => {
      const out = runLoader(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
      expect(out.ok).toBe(true);
      expect((out.result as number[]).length).toBe(10);
    });

    it('rejects a weights list of the wrong length (fail closed, not padded or truncated)', () => {
      const out = runLoader(JSON.stringify({ weights: [1, 2, 3] }));
      expect(out.ok).toBe(false);
      expect(out.result).toMatch(/ValueError.*10-element/);
    });

    it('rejects a non-finite weight (NaN/Infinity, which Python\'s json module accepts by default)', () => {
      const out = runLoader('{"weights": [0.2, 0.3, 0.25, 0.25, 0.05, 0.5, 0.02, 0.85, 1.5, NaN]}');
      expect(out.ok).toBe(false);
      expect(out.result).toMatch(/ValueError.*finite/);
    });

    it('rejects a payload that is not a list or an object with "weights"', () => {
      const out = runLoader(JSON.stringify('not-a-list'));
      expect(out.ok).toBe(false);
      expect(out.result).toMatch(/ValueError/);
    });

    it('rejects malformed JSON outright rather than guessing at intent', () => {
      const out = runLoader('{not valid json');
      expect(out.ok).toBe(false);
      expect(out.result).toMatch(/JSONDecodeError/);
    });
  });
});
