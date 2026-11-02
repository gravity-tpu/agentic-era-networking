/**
 * test/invariants/runpod-hailo-compile-lifecycle.test.ts
 *
 * Invariant tests for the Hailo-8 .hef compile pipeline (scripts/runpod/launch-hailo-compile.sh,
 * scripts/runpod/hailo-compile-pod.sh): argument validation fails closed before any network call or
 * pod creation, and the incremental-pull / bounded-poll-loop / sha256-verified-upload patterns proven
 * in the Tier 1 runpod reliability work (launch-eval-lora.sh, launch-train-lora.sh) are present here
 * too, not reinvented differently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { runCliScript, type CliResult } from '../helpers/run-cli-script.ts';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LAUNCH_SCRIPT = path.join(REPO_ROOT, 'scripts/runpod/launch-hailo-compile.sh');
const POD_SCRIPT = path.join(REPO_ROOT, 'scripts/runpod/hailo-compile-pod.sh');

function runLaunchScript(args: string[]): CliResult {
  return runCliScript('bash', [LAUNCH_SCRIPT, ...args], { cwd: REPO_ROOT, timeout: 15_000 });
}

describe('launch-hailo-compile.sh: argument validation fails closed before any network call', () => {
  it('requires --minutes', () => {
    const res = runLaunchScript([]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--minutes is required');
  });

  it('requires --network-volume-id', () => {
    const res = runLaunchScript(['--minutes', '30']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--network-volume-id is required');
  });

  it('requires --suite-tar', () => {
    const res = runLaunchScript(['--minutes', '30', '--network-volume-id', 'vol123']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--suite-tar is required');
  });

  it('fails closed when --suite-tar does not exist', () => {
    const res = runLaunchScript(['--minutes', '30', '--network-volume-id', 'vol123', '--suite-tar', '/nonexistent-suite.tar.gz']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--suite-tar not found');
  });

  it('computes the suite tar sha256 and derives the image tag from its filename before any network call', () => {
    const tmpTar = path.join(REPO_ROOT, '.tmp-hailo-suite-test.tar.gz');
    writeFileSync(tmpTar, 'fake suite content for sha256 testing');
    try {
      const res = runLaunchScript(['--minutes', '30', '--network-volume-id', 'vol123', '--suite-tar', tmpTar]);
      // Not asserting res.status here: the dry-run path (no --yes) swallows do_create's failure with `|| true`
      // and always exits 0 (same pattern as launch-eval-lora.sh/launch-train-lora.sh), so a status check can
      // never meaningfully fail in this path and would only be noise. The stdout assertion below is the real
      // signal: it proves the script reached and completed the sha256 step without crashing beforehand.
      expect(res.stdout).toContain('suite tar sha256:');
    } finally {
      unlinkSync(tmpTar);
    }
  });
});

describe('launch-hailo-compile.sh: reuses the Tier 1 reliability patterns, not reinvented differently', () => {
  const content = readFileSync(LAUNCH_SCRIPT, 'utf8');

  it('bounds the poll loop (Invariant 5), same MAX_POLLS formula as launch-eval-lora.sh/launch-train-lora.sh', () => {
    expect(content).not.toMatch(/while true; do/);
    expect(content).toMatch(/MAX_POLLS=\$\(\( \(MINUTES \* 60 \/ POLL_SECONDS\) \+ 15 \)\)/);
  });

  it('pulls results incrementally (not only once at the end) and surfaces real scp errors, not 2>/dev/null', () => {
    const fnStart = content.indexOf('pull_results() {');
    const fnEnd = content.indexOf('\n}', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = content.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('2>/dev/null');
    expect(fnBody).toContain('2>&1');
    const callSites = content.match(/^\s*pull_results\s*$/gm) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2); // in-loop and final
  });

  it('uses a monotonic $SECONDS deadline for ssh_ready, not wall-clock date +%s', () => {
    expect(content).not.toMatch(/ssh_ready\(\)[\s\S]{0,400}\$\(date \+%s\)/);
    expect(content).toMatch(/ssh_ready\(\)[\s\S]{0,200}\$SECONDS/);
  });

  it('guards against an empty parsed pod ID and an empty IP/port before calling ssh_ready', () => {
    expect(content).toContain('no pod ID could be parsed from its output');
    expect(content).toMatch(/&& \[ -n "\$IP" \] && \[ -n "\$PORT" \] && ssh_ready/);
  });

  it('verifies the uploaded suite image by sha256 before proceeding, and skips re-upload if already staged', () => {
    expect(content).toMatch(/remote_sha256.*=.*SUITE_TAR_SHA256/);
    expect(content).toContain('skipping the 9GB upload');
    expect(content).toContain('sha256 mismatch');
  });

  it('validates --model before interpolating it into a remote SSH command', () => {
    // --model is later single-quoted inside a double-quoted SSH command string executed as root on the pod; a
    // value containing a single quote would break that quoting. Validated here rather than relying on the
    // (true, but not permanent) observation that the operator already has unrestricted root access to that
    // same pod via the SSH connection itself.
    const res = runLaunchScript(['--minutes', '30', '--network-volume-id', 'vol123', '--suite-tar', __filename, '--model', "x'; echo pwned; echo '"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--model contains characters outside');
  });

  it('accepts a realistic --model value (mobilenet_v1)', () => {
    const tmpTar = path.join(REPO_ROOT, '.tmp-hailo-suite-test2.tar.gz');
    writeFileSync(tmpTar, 'fake suite content');
    try {
      const res = runLaunchScript(['--minutes', '30', '--network-volume-id', 'vol123', '--suite-tar', tmpTar, '--model', 'mobilenet_v1']);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain('contains characters outside');
    } finally {
      unlinkSync(tmpTar);
    }
  });
});

describe('hailo-compile-pod.sh: fail-closed trap and the disclosed calibration-data limitation', () => {
  const content = readFileSync(POD_SCRIPT, 'utf8');

  it('defines the fail-closed ERR/EXIT trap pattern used by every other *-pod.sh script', () => {
    expect(content).toMatch(/set -E?euo pipefail/);
    expect(content).toContain("trap 'echo \"step failed at line $LINENO\"");
    expect(content).toContain('/workspace/out/FAILED');
    expect(content).toContain('/workspace/out/DONE');
  });

  it('extracts the suite image by hand and chroots into it rather than running a Docker daemon', () => {
    // This pod's container has neither CAP_NET_ADMIN nor CAP_SYS_ADMIN (confirmed live 2026-11-02), ruling out
    // a real dockerd regardless of flags -- see the module header for the full story. Checking for an actual
    // invocation, not just the word (it's discussed in prose comments explaining why there isn't one).
    expect(content).not.toMatch(/^\s*(nohup\s+)?dockerd\b/m);
    expect(content).not.toMatch(/^\s*docker (run|load)\b/m);
    expect(content).toContain('chroot "$ROOTFS"');
  });

  it('handles AUFS-style whiteout files when applying extracted layers', () => {
    expect(content).toContain('.wh..wh..opq');
    expect(content).toContain(".wh.'):");
  });

  it('discloses that the synthetic calibration set is for pipeline validation only, not accuracy', () => {
    expect(content.toLowerCase()).toContain('not accuracy-tuned');
    expect(content).toContain('CALIB_IMAGE_COUNT');
  });

  it('relies on the Hailo Model Zoo bundled in the Suite image rather than cloning a separate copy', () => {
    // The bundled copy is already version-paired with this exact Suite build (MZ_DIR in the image's own config);
    // a separately `git clone`d copy pinned to some branch could drift out of sync with it. Checking for an
    // actual invocation, not just the word (it's discussed in prose comments explaining why there isn't one).
    expect(content).not.toMatch(/^\s*git clone\b/m);
    expect(content).toContain('MZ_DIR');
  });

  it('finds the freshly-compiled .hef by modification time, not by name alone', () => {
    // The Suite image ships its own pre-existing example .hef files elsewhere under $WORKSPACE_DIR. Confirmed
    // live 2026-11-02: a since-fixed version of this script searched `find ... -name '*.hef'` with no time
    // filter and reported DONE with 7 bundled .hef files on a run that never even got past `import
    // hailo_sdk_client` -- none of them had just been compiled.
    expect(content).toMatch(/touch "\$COMPILE_START_MARKER"/);
    expect(content).toMatch(/find "\$ROOTFS\$WORKSPACE_DIR" -name '\*\.hef' -newer "\$COMPILE_START_MARKER"/);
  });

  it('actually invokes the hailomz parse/optimize/compile pipeline, not just a diagnostic', () => {
    expect(content).toContain('run_pipeline_step parse');
    expect(content).toContain('hailomz parse $MODEL');
    expect(content).toContain('run_pipeline_step optimize');
    expect(content).toContain('hailomz optimize $MODEL --calib-path');
    expect(content).toContain('run_pipeline_step compile');
    expect(content).toContain('hailomz compile $MODEL');
  });

  it('diagnoses a hung pipeline step instead of waiting silently for hours', () => {
    // Confirmed live 2026-11-02: with every known abort fixed, the pipeline got past every import and then hung
    // with zero further output for 4+ hours until the launcher's own poll budget ran out and killed the pod --
    // no crash, no progress, no visibility into what it was doing. chroot doesn't create a new PID namespace, so
    // a chrooted process's PID and its real /proc entry are both visible from the outer, unchrooted shell.
    expect(content).toContain('diagnose_hang');
    expect(content).toContain('/proc/$pid/wchan');
    expect(content).toMatch(/kill -9 "\$pid"/);
  });

  it('stubs /proc/self/exe so TensorFlow\'s readlink-based executable-path check does not abort', () => {
    // Confirmed live 2026-11-02 via strace: TensorFlow's tsl/platform/env.cc calls
    // readlink("/proc/self/exe"), gets ENOENT (no live procfs in this hand-built rootfs), and hits a hard CHECK
    // failure that aborts the whole process -- crashing `import hailo_sdk_client` before any pipeline code runs.
    expect(content).toContain('mkdir -p "$ROOTFS/proc/self"');
    expect(content).toMatch(/ln -sfn "\$VENV_PYTHON_REL" "\$ROOTFS\/proc\/self\/exe"/);
  });
});
