#!/usr/bin/env bash
# scripts/runpod/hailo-compile-pod.sh
# Runs ON the Runpod CPU Pod. Extracts the Hailo AI Software Suite Docker image (staged once on the attached
# network volume by scripts/runpod/launch-hailo-compile.sh, not re-uploaded per run) by hand into a plain
# directory and chroots into it, then compiles one model to a .hef via `hailomz parse/optimize/compile`.
#
# Why not just `docker run` the Suite image (the obvious approach, and what this script originally did): live
# runs on 2026-11-02 proved this pod's container has neither CAP_NET_ADMIN nor CAP_SYS_ADMIN -- confirmed via
# /proc/self/status's Cap lines, and independently via dockerd itself failing at three different layers in turn
# (bridge/iptables setup, then mount()-based overlay2 layer application, then unshare() during `docker load`
# even with vfs). Runpod's REST API has no privileged/capability field (checked the OpenAPI spec directly) --
# there is no flag that would have fixed this. Real Docker-in-Docker is not possible on this pod via the API we
# have. CAP_SYS_CHROOT, by contrast, IS present (also confirmed live) -- a much lower privilege bar -- so this
# extracts the image's layers with plain tar (handling AUFS-style whiteout files by hand) and chroots into the
# result instead of running an actual Docker daemon.
#
# Bonus discovery while inspecting the image's config for this rewrite: it already bundles a fully built
# virtualenv (HAILO_VENV_PATH) AND its own paired copy of the Hailo Model Zoo (MZ_DIR) -- this pipeline no
# longer needs to `pip install` or `git clone` anything at all inside the chroot, which also sidesteps needing
# outbound network access to work from inside it (untested whether it would have; moot now).
#
# Scope (deliberately narrow -- Option C of the agent-feedback plan, "validate the pipeline with a known-good
# model before betting it on our own untested detector architecture"): compiles a Hailo Model Zoo reference
# model (default mobilenet_v1), NOT this project's own sentinel detector. Whether that detector's own
# convolutions are even DFC-compatible is a separate, harder, not-yet-attempted question (docs/ROADMAP.md's
# Hailo-8 entry criterion (b)).
#
# Calibration data: Hailo's own docs recommend >=1024 real images for production-quality INT8 quantization and
# do not document any auto-downloaded default set -- sourcing a real dataset is out of scope for a pipeline-
# validation run. This generates a small SYNTHETIC calibration set instead (random RGB noise, correctly sized
# for the model's input). The resulting .hef will compile and load correctly -- which is everything this run is
# actually trying to prove -- but its quantization is NOT accuracy-tuned and must never be used for real
# inference numbers. CALIB_IMAGE_COUNT controls how many (default 64, far below Hailo's 1024 recommendation,
# deliberately: this run validates the pipeline, not classifier accuracy).
#
# Inputs (uploaded/staged by launch-hailo-compile.sh):
#   /workspace/suite.tar.gz       -- the Hailo AI Software Suite Docker image (9GB, staged on the network
#                                    volume once; present from a prior run's upload, or freshly uploaded).
#                                    launch-hailo-compile.sh verifies this by rehashing the file itself on
#                                    every run, not a sidecar hash file, so none exists here to read.
# Outputs: /workspace/out/<model>.hef, pod.log, versions.txt, and the terminal marker
#          /workspace/out/DONE (or /workspace/out/FAILED).
# Fails closed: any step failing stops the script (set -e) and leaves /workspace/out/FAILED.
set -Eeuo pipefail
mkdir -p /workspace/out /workspace/work   # before the traps below: both write into /workspace/out on failure,
                                           # and must not themselves fail because that directory doesn't exist yet
# /workspace is the attached network volume, which outlives any single pod -- without this, a stale DONE/FAILED
# left by a previous run on the same volume is still there when this run starts, and the launcher's poll loop
# (which only checks for the file's presence, not its age) reports FAILED/DONE within its first poll before this
# run has done anything. Confirmed live 2026-11-02: a leftover FAILED from a prior failed attempt caused the
# next attempt to be reported (and the pod terminated) ~60s in, mid-apt-get, nowhere near its actual failure point.
rm -f /workspace/out/DONE /workspace/out/FAILED
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ ! -e /workspace/out/DONE ] && [ ! -e /workspace/out/FAILED ]; then echo "exit $rc" >> /workspace/out/pod.log; touch /workspace/out/FAILED; fi' EXIT

MODEL="${MODEL:-mobilenet_v1}"
CALIB_IMAGE_COUNT="${CALIB_IMAGE_COUNT:-64}"
CALIB_IMAGE_SIZE="${CALIB_IMAGE_SIZE:-224}"   # mobilenet_v1's standard input resolution; override per model

IN=/workspace/in; OUT=/workspace/out   # already created above, before the traps
# Heavy extraction work happens on the pod's own ephemeral container disk, NOT under /workspace: /workspace is
# the attached network volume (currently 50GB, already holding the 9GB suite.tar.gz) and the image's uncompressed
# footprint plus a temporary full copy of its raw layer tars (see the extraction script below -- manifest.json
# arrives at the END of the tar stream, after every layer, so layer order isn't known until the whole 9GB has
# already streamed past once) can run well past that. Mirrors this script's own prior reasoning about Docker's
# image storage living on ephemeral disk, not the volume.
BUILD=/root/hailo-build
RAWLAYERS="$BUILD/raw-layers"
ROOTFS="$BUILD/rootfs"
ENVFILE="$BUILD/suite-env.sh"
mkdir -p "$RAWLAYERS" "$ROOTFS"
exec > >(tee -a "$OUT/pod.log") 2>&1
echo "start $(date -u +%FT%TZ) model=$MODEL calib_images=$CALIB_IMAGE_COUNT"

# 0. OS packages. No GPU is required by the Dataflow Compiler itself (confirmed from Hailo's own
# system-requirements check bundled in the Suite's docker-run script); no Docker needed at all anymore (see
# header). python3/pip are for the synthetic calibration image generator and the layer-extraction script below.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq python3 python3-pip
pip install -q --break-system-packages pillow numpy || pip install -q pillow numpy
python3 --version > "$OUT/versions.txt"

# 1. Extract the Suite image's layers by hand into $ROOTFS (see header for why: no CAP_SYS_ADMIN, so no real
# Docker daemon is possible here). This is the classic `docker save` tar format: a flat set of
# "<layer-id>/layer.tar" entries (order within the stream is unrelated to application order) plus a
# manifest.json (confirmed live 2026-11-02 to be the SECOND-TO-LAST entry in the stream, after every layer) that
# gives the real per-image layer order and the config blob. AUFS-style whiteout markers (.wh.<name> for a
# deleted file, .wh..wh..opq for "clear this directory before applying the rest of this layer") are handled by
# hand to match what a real union filesystem would have done.
[ -f "$IN/suite.tar.gz" ] || { echo "suite.tar.gz not found in $IN" >&2; exit 1; }
python3 - "$IN/suite.tar.gz" "$RAWLAYERS" "$ROOTFS" "$ENVFILE" <<'PY'
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile

suite_tar, raw_layers_dir, rootfs, env_out = sys.argv[1:5]
os.makedirs(raw_layers_dir, exist_ok=True)
os.makedirs(rootfs, exist_ok=True)

# Single streaming pass (the file is ~9GB compressed; gzip is not seekable, so re-opening per-layer would mean
# re-scanning from the start every time -- O(n^2) I/O over a 9GB stream). manifest.json and every small
# "<id>/json" / "<id>/VERSION" config entry are buffered in memory; each "<id>/layer.tar" is streamed straight
# to its own file under raw_layers_dir, since we don't yet know which order to apply them in. One wrinkle
# confirmed live 2026-11-02: `docker save` represents at least one layer as a SYMLINK to another layer's
# layer.tar (presumably a deduplicated empty/identical layer) rather than its own regular-file entry --
# extractfile() cannot read a symlink's "content" at all in streaming mode ("cannot extract (sym)link as file
# object"), and the real target can appear either earlier or later in the stream than the symlink itself. Such
# layers are recorded in `aliases` (id -> target id) instead of staged directly; raw files are kept until the
# whole extraction finishes (not deleted layer-by-layer) so an alias can always resolve to its target's file
# regardless of which one was encountered first.
small_files = {}
aliases = {}  # layer_id -> target layer_id, for layer.tar entries that are symlinks to another layer's tar
layer_count = 0
with tarfile.open(suite_tar, 'r|*') as t:
    for member in t:
        if member.name.endswith('/layer.tar'):
            layer_id = member.name.split('/', 1)[0]
            if member.issym() or member.islnk():
                target_id = member.linkname.strip('/').split('/')[-2]
                aliases[layer_id] = target_id
                print(f'layer {layer_id} is a link to {target_id}, not staging separately', flush=True)
                continue
            dest = os.path.join(raw_layers_dir, layer_id + '.tar')
            src = t.extractfile(member)
            with open(dest, 'wb') as out:
                shutil.copyfileobj(src, out, length=4 * 1024 * 1024)
            layer_count += 1
            print(f'staged layer {layer_count}: {layer_id}', flush=True)
        elif member.isfile() and member.size < 1_000_000:
            small_files[member.name] = t.extractfile(member).read()

manifest = json.loads(small_files['manifest.json'])
entry = manifest[0]
config = json.loads(small_files[entry['Config']])
layers = entry['Layers']  # ordered list of "<id>/layer.tar"
print(f'manifest: {len(layers)} layers in application order', flush=True)

def apply_whiteouts(layer_tar_path, rootfs):
    with tarfile.open(layer_tar_path, 'r') as lt:
        for member in lt.getmembers():
            name = member.name.lstrip('./')
            if not name:
                continue
            parts = name.split('/')
            base = parts[-1]
            dirname = '/'.join(parts[:-1])
            if base == '.wh..wh..opq':
                target_dir = os.path.join(rootfs, dirname)
                if os.path.isdir(target_dir):
                    for e in os.listdir(target_dir):
                        full = os.path.join(target_dir, e)
                        if os.path.islink(full) or os.path.isfile(full):
                            os.remove(full)
                        else:
                            shutil.rmtree(full, ignore_errors=True)
            elif base.startswith('.wh.'):
                real = base[len('.wh.'):]
                target = os.path.join(rootfs, dirname, real)
                if os.path.islink(target) or os.path.isfile(target):
                    os.remove(target)
                elif os.path.isdir(target):
                    shutil.rmtree(target, ignore_errors=True)

for i, layer_path in enumerate(layers, 1):
    layer_id = layer_path.split('/', 1)[0]
    real_id = aliases.get(layer_id, layer_id)
    raw_path = os.path.join(raw_layers_dir, real_id + '.tar')
    print(f'applying layer {i}/{len(layers)}: {layer_id}' + (f' (-> {real_id})' if real_id != layer_id else ''), flush=True)
    apply_whiteouts(raw_path, rootfs)
    # Native tar for the actual extraction: faster and more faithful (preserves modes/owners/symlinks/devices)
    # than re-implementing extraction in Python. --exclude matches the whiteout marker files themselves so they
    # never land in the final rootfs (their effect was already applied above).
    subprocess.run(
        ['tar', '--same-owner', '-xf', raw_path, '-C', rootfs, '--exclude=.wh.*'],
        check=True,
    )
# Raw layers are kept until every layer has been applied (an aliased layer's target may be needed more than
# once, or needed again later than its first use), then dropped all at once rather than one at a time.
shutil.rmtree(raw_layers_dir, ignore_errors=True)

# bash treats a handful of names as builtin/readonly (UID and EUID in particular -- confirmed live 2026-11-02:
# the image's own Env list includes UID=10642, metadata about the user the Suite container originally ran as,
# and `export UID=...` in a sourced script fails with "readonly variable" under `set -e`). Not needed here
# anyway: everything in the chroot runs as root regardless of what this Env list says.
BASH_READONLY_NAMES = {'UID', 'EUID', 'PPID', 'BASHPID', 'GROUPS', 'FUNCNAME', 'DIRSTACK', 'SHELLOPTS'}
cfg = config.get('config', {}) or {}
with open(env_out, 'w') as f:
    for line in cfg.get('Env') or []:
        key, _, val = line.partition('=')
        if key in BASH_READONLY_NAMES:
            continue
        f.write(f'export {key}={shlex.quote(val)}\n')
    f.write(f"export HAILO_CHROOT_WORKDIR={shlex.quote(cfg.get('WorkingDir') or '/')}\n")

print('rootfs extraction complete:', rootfs, flush=True)
PY

# Minimal /dev nodes: a fresh rootfs directory has no device files at all, and without CAP_SYS_ADMIN this script
# can't bind-mount the pod's real /dev into it. CAP_MKNOD was present on the pod this was first confirmed live
# against (2026-11-02, US-IL-1, via /proc/self/status), but NOT on a different pod/host in a different
# datacenter the same day (US-CA-2): `mknod: Operation not permitted`, under `set -e`, aborting the whole run.
# Runpod's capability set isn't uniform across hosts -- best-effort each one rather than treating it as
# load-bearing; if something downstream genuinely needs a working /dev/null and it's missing, that will surface
# as its own concrete, diagnosable failure rather than this script refusing to even try.
mkdir -p "$ROOTFS/dev"
[ -e "$ROOTFS/dev/null" ] || mknod -m 666 "$ROOTFS/dev/null" c 1 3 2>/dev/null || echo "mknod /dev/null failed (no CAP_MKNOD on this host?); continuing" >&2
[ -e "$ROOTFS/dev/zero" ] || mknod -m 666 "$ROOTFS/dev/zero" c 1 5 2>/dev/null || echo "mknod /dev/zero failed (no CAP_MKNOD on this host?); continuing" >&2
# /dev/random and /dev/urandom specifically: confirmed live 2026-11-02 that even when mknod is refused here
# (same host, same run), the getrandom() syscall itself works fine -- it's specifically libstdc++'s
# random_device opening "/dev/urandom" *by path* that fails (RuntimeError: random_device::random_device(const
# std::string&), from TensorFlow's eager context init, imported by hailo_sdk_client). A FIFO doesn't need
# CAP_MKNOD at all (only char/block device nodes do), so where mknod is refused, bridge one to the pod's real
# /dev/urandom instead: a background reader of the real device continuously feeds whatever this chroot reads
# from the FIFO. Real device nodes are still tried first since they're simpler and don't need a live process.
for dev in random urandom; do
  if [ -e "$ROOTFS/dev/$dev" ]; then continue; fi
  if mknod -m 666 "$ROOTFS/dev/$dev" c 1 9 2>/dev/null; then continue; fi
  if mkfifo -m 666 "$ROOTFS/dev/$dev" 2>/dev/null; then
    ( while :; do cat /dev/urandom > "$ROOTFS/dev/$dev" 2>/dev/null || break; done ) &
  else
    echo "neither mknod nor mkfifo worked for /dev/$dev; continuing without it" >&2
  fi
done
# /etc/resolv.conf is a plain file, not a live mount -- copy the pod's own in case anything inside the chroot
# does a DNS lookup (nothing should need to: the Suite's venv and Model Zoo are already baked into the image).
mkdir -p "$ROOTFS/etc"
cp -f /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || true

# A fresh rootfs also has no /proc at all: without CAP_SYS_ADMIN this script can't mount procfs into it, and
# procfs can't be copied like a normal filesystem (it's generated by the kernel, not backed by files on disk).
# hailo_model_zoo's own platform-discovery code reads /proc/modules directly and crashes outright if it's
# missing (confirmed live 2026-11-02: unhandled FileNotFoundError, not a graceful fallback). Copying a static
# snapshot of the pod's own real /proc files at this moment is accurate, not a fake -- this is a short-lived
# compile job, and the kernel these files describe (shared with the host; containers don't get their own) isn't
# going to change under it.
mkdir -p "$ROOTFS/proc"
for f in modules cpuinfo meminfo stat version loadavg uptime; do
  [ -r "/proc/$f" ] && cp "/proc/$f" "$ROOTFS/proc/$f" 2>/dev/null || true
done

# 2. Synthetic calibration set (see module header: pipeline validation only, not accuracy-tuned), written
# directly into the rootfs at a path matching WORKSPACE/calib -- there is no bind-mount to populate it through,
# so it has to be created at its final chroot-relative location from the start.
set -a; source "$ENVFILE"; set +a
WORKSPACE_DIR="${WORKSPACE:-/local/workspace}"

# TensorFlow's tsl/platform/env.cc calls readlink("/proc/self/exe") to find its own executable path. Confirmed
# live 2026-11-02 via strace: that call fails with ENOENT (our /proc has no live /proc/self -- it can't, without
# a real procfs mount) and TF hits a hard `CHECK failed: -1 != path_length` that aborts the whole process,
# crashing `import hailo_sdk_client` (which imports TensorFlow) before any of our own code even runs. Every
# process in this pipeline is python3 from the bundled venv, so a static symlink pointing there is accurate for
# "self" here, not a generic fake -- there is no other binary that would ever actually be /proc/self/exe in this
# chroot.
VENV_PYTHON_REL="${HAILO_VENV_PATH:-$WORKSPACE_DIR/hailo_virtualenv}/bin/python3"
mkdir -p "$ROOTFS/proc/self"
[ -e "$ROOTFS$VENV_PYTHON_REL" ] && ln -sfn "$VENV_PYTHON_REL" "$ROOTFS/proc/self/exe"
# The readlink("/proc/self/exe") fix above wasn't the whole story: strace on a live run 2026-11-02 showed it
# succeeding, immediately followed by openat(AT_FDCWD, "/proc/self/cmdline", O_RDONLY) = -1 ENOENT -- a second,
# unrelated call (/proc/self/cmdline is a real file, not a symlink, containing the process's own NUL-separated
# argv) that TF's env.cc also needs and that doesn't exist in this hand-built /proc either. Unlike /proc/self/exe
# there's no one true answer for "the" cmdline across every process in this pipeline (parse/optimize/compile are
# different invocations) -- a plausible placeholder is enough here, since TF only needs the read to succeed, not
# any particular content.
printf 'python3\0' > "$ROOTFS/proc/self/cmdline"

CALIB_REL="$WORKSPACE_DIR/calib"
mkdir -p "$ROOTFS$CALIB_REL"
python3 - "$ROOTFS$CALIB_REL" "$CALIB_IMAGE_COUNT" "$CALIB_IMAGE_SIZE" <<'PY'
import sys
from pathlib import Path
import numpy as np
from PIL import Image

out_dir, count, size = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
out_dir.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(42)
for i in range(count):
    arr = rng.integers(0, 256, size=(size, size, 3), dtype=np.uint8)
    Image.fromarray(arr, mode="RGB").save(out_dir / f"calib-{i:04d}.jpg", quality=90)
print(f"wrote {count} synthetic {size}x{size} calibration images to {out_dir}")
PY

# 3. Parse, optimize (quantize), compile -- inside the extracted rootfs via chroot. The image already bundles a
# fully built virtualenv (on $PATH, from $ENVFILE) and its own paired copy of the Hailo Model Zoo ($MZ_DIR) --
# no `pip install` or `git clone` needed. Environment variables exported above (via `source "$ENVFILE"`) are
# inherited across chroot() same as any other process attribute, so they don't need to be re-passed.
MZ_REL="${MZ_DIR:-$WORKSPACE_DIR/hailo_model_zoo}"
[ -d "$ROOTFS$MZ_REL" ] || { echo "bundled Hailo Model Zoo not found at $MZ_REL inside the extracted image" >&2; exit 1; }
# PYTHONFAULTHANDLER: an earlier live run's `hailomz parse` aborted with no Python traceback at all -- this at
# least gives faulthandler a chance to print a Python-level stack before the process dies, for the subset of
# native aborts that still route back through the interpreter's signal handling.
export PYTHONFAULTHANDLER=1
# Checkpointed imports, strace, and a getrandom()/dev-urandom probe (all since removed -- their diagnosis is
# preserved in git history and in the /proc/self/exe and FIFO-bridge fixes above) found and fixed two real
# aborts in turn. With both fixed, live run 2026-11-02 got past every import and all the way into the actual
# pipeline -- and then hung silently for 4+ hours with zero further output, until the launcher's own poll budget
# ran out and terminated the pod. No crash, no progress: no visibility into what it was actually doing.
#
# chroot doesn't create a new PID namespace (no CAP_SYS_ADMIN for that either -- see the module header), so a
# chrooted process's PID is visible from the OUTER, unchrooted shell too, with a real, live /proc for it (unlike
# the chroot's own hand-stubbed /proc). That means each pipeline step can be run in the background with a bounded
# wait, and if it's still running past that, inspected from outside: /proc/<pid>/status (running vs. blocked in
# a syscall), /proc/<pid>/wchan (which kernel function it's blocked in), and open file descriptors -- all of
# which need no special capability, unlike py-spy's stack dump (attempted too, but needs CAP_SYS_PTRACE, which
# is NOT present on at least one host this was confirmed against).
pip install -q py-spy >/dev/null 2>&1 || echo "py-spy install failed; its stack dump (if CAP_SYS_PTRACE allows it) will be unavailable" >&2

diagnose_hang() {
  local pid="$1" label="$2"
  {
    echo "=== hang diagnosis for $label (pid $pid) after ${3}s with no completion ==="
    echo "--- /proc/$pid/status ---"; cat "/proc/$pid/status" 2>/dev/null
    echo "--- /proc/$pid/wchan ---"; cat "/proc/$pid/wchan" 2>/dev/null; echo
    echo "--- open file descriptors ---"; ls -la "/proc/$pid/fd" 2>/dev/null
    for child in $(pgrep -P "$pid" 2>/dev/null); do
      echo "--- child $child status ---"; cat "/proc/$child/status" 2>/dev/null
      echo "--- child $child wchan ---"; cat "/proc/$child/wchan" 2>/dev/null; echo
    done
    echo "--- py-spy dump (best effort, needs CAP_SYS_PTRACE) ---"
    py-spy dump --pid "$pid" 2>&1 || echo "py-spy failed (likely no CAP_SYS_PTRACE on this host)"
  } > "$OUT/$label-hang-diagnosis.log" 2>&1
  cat "$OUT/$label-hang-diagnosis.log"
}

# label, diagnosis timeout (seconds), command. Timeouts are generous and asymmetric: parse is just ONNX
# import/graph construction (should be fast); optimize (INT8 calibration) and compile (graph allocation) are
# the parts expected to actually be CPU-heavy and slow, not hung.
run_pipeline_step() {
  local label="$1" timeout_s="$2" cmd="$3"
  echo "--- starting $label ---"
  chroot "$ROOTFS" /bin/bash -c "cd '$MZ_REL'; $cmd" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$timeout_s" ]; then
      diagnose_hang "$pid" "$label" "$waited"
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      echo "$label killed after ${waited}s with no completion" >&2
      return 1
    fi
    sleep 15
    waited=$((waited + 15))
  done
  wait "$pid"
}

# strace (run from the OUTER pod OS -- chroot doesn't create a new PID namespace, so a chrooted process's PID
# and its real /proc entry are both visible from outside, and the Suite's own extracted rootfs has no working
# apt [no gpgv/gpgv2/gpgv1], so installing strace has to happen out here regardless) already found two real
# causes this way: the /proc/self/exe and /proc/self/cmdline fixes above. The hang diagnosis from a full live run
# (2026-11-02, after both of those fixes) showed `hailomz parse` blocked with wchan "wait_for_partner" -- the
# kernel's FIFO-open wait state, used only for named pipes, never anonymous pipes from pipe()/pipe2(). No FIFO
# under our own control was involved (mknod succeeded for /dev/random and /dev/urandom on that host, so our FIFO
# fallback for those wasn't even in play), and no mkfifo call appears anywhere in hailo_sdk_client/hailo_platform/
# hailo_sdk_server's Python source -- so whatever opens a FIFO here does it from native code or creates one at
# runtime, invisible to a static source grep. Tracing the real `hailomz parse` invocation itself (not just the
# isolated import, which is a different process and apparently doesn't reach this far) for mkfifo/open/connect
# calls, bounded to 2 minutes: the hang itself happens shortly after the same TF plugin-registration messages
# seen in every prior run, not gradually, so there is no need to wait anywhere near the full 600s step timeout
# to catch it in the act.
apt-get install -y -qq strace || echo 'strace install failed on the outer OS (non-fatal; continuing without a trace)' >&2
timeout 120 strace -f -e trace=open,openat,mkfifo,mknodat,connect,bind -s 500 -o "$OUT/hailomz-parse-strace.log" \
  chroot "$ROOTFS" /bin/bash -c "cd '$MZ_REL'; hailomz parse $MODEL" || true

COMPILE_START_MARKER="$BUILD/compile-start-marker"
touch "$COMPILE_START_MARKER"
run_pipeline_step parse 600 "hailomz parse $MODEL"
run_pipeline_step optimize 3600 "hailomz optimize $MODEL --calib-path '$CALIB_REL'"
run_pipeline_step compile 3600 "hailomz compile $MODEL"

# hailomz's own output path convention is not pinned by Hailo's docs (verified: GETTING_STARTED.rst does not
# state where the .hef lands); search the whole workspace inside the rootfs rather than guess a single exact
# path. -newer the marker touched just before compiling, rather than matching on name alone: the Suite image
# ships its own pre-existing example .hef files elsewhere under $WORKSPACE_DIR (confirmed live 2026-11-02 --
# a run that never got past `import hailo_sdk_client` still reported DONE with 7 bundled .hef files, because an
# earlier, since-fixed version of this script searched by name only and happily "found" demo artifacts nobody
# had just compiled).
found=0
while IFS= read -r -d '' f; do cp "$f" "$OUT/"; found=1; done < <(find "$ROOTFS$WORKSPACE_DIR" -name '*.hef' -newer "$COMPILE_START_MARKER" -print0)
[ "$found" = 1 ] || { echo "no .hef produced under $WORKSPACE_DIR since compiling started" >&2; exit 1; }

ls -la "$OUT"/*.hef
for f in "$OUT"/*.hef; do sha256sum "$f" >> "$OUT/hef.sha256"; done
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
