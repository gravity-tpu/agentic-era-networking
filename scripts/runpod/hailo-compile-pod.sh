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
# to its own file under raw_layers_dir, since we don't yet know which order to apply them in.
small_files = {}
layer_count = 0
with tarfile.open(suite_tar, 'r|*') as t:
    for member in t:
        if member.name.endswith('/layer.tar'):
            layer_id = member.name.split('/', 1)[0]
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
    raw_path = os.path.join(raw_layers_dir, layer_id + '.tar')
    print(f'applying layer {i}/{len(layers)}: {layer_id}', flush=True)
    apply_whiteouts(raw_path, rootfs)
    # Native tar for the actual extraction: faster and more faithful (preserves modes/owners/symlinks/devices)
    # than re-implementing extraction in Python. --exclude matches the whiteout marker files themselves so they
    # never land in the final rootfs (their effect was already applied above).
    subprocess.run(
        ['tar', '--same-owner', '-xf', raw_path, '-C', rootfs, '--exclude=.wh.*'],
        check=True,
    )
    os.remove(raw_path)  # reclaim disk as we go; never need more than ~one extra layer's worth of headroom

cfg = config.get('config', {}) or {}
with open(env_out, 'w') as f:
    for line in cfg.get('Env') or []:
        key, _, val = line.partition('=')
        f.write(f'export {key}={shlex.quote(val)}\n')
    f.write(f"export HAILO_CHROOT_WORKDIR={shlex.quote(cfg.get('WorkingDir') or '/')}\n")

print('rootfs extraction complete:', rootfs, flush=True)
PY

# Minimal /dev nodes: a fresh rootfs directory has no device files at all, and without CAP_SYS_ADMIN this script
# can't bind-mount the pod's real /dev into it. CAP_MKNOD *is* present (confirmed live 2026-11-02 via
# /proc/self/status), so create the handful of character devices most tools actually touch directly.
mkdir -p "$ROOTFS/dev"
[ -e "$ROOTFS/dev/null" ]    || mknod -m 666 "$ROOTFS/dev/null" c 1 3
[ -e "$ROOTFS/dev/zero" ]    || mknod -m 666 "$ROOTFS/dev/zero" c 1 5
[ -e "$ROOTFS/dev/random" ]  || mknod -m 666 "$ROOTFS/dev/random" c 1 8
[ -e "$ROOTFS/dev/urandom" ] || mknod -m 666 "$ROOTFS/dev/urandom" c 1 9
# /etc/resolv.conf is a plain file, not a live mount -- copy the pod's own in case anything inside the chroot
# does a DNS lookup (nothing should need to: the Suite's venv and Model Zoo are already baked into the image).
mkdir -p "$ROOTFS/etc"
cp -f /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || true

# 2. Synthetic calibration set (see module header: pipeline validation only, not accuracy-tuned), written
# directly into the rootfs at a path matching WORKSPACE/calib -- there is no bind-mount to populate it through,
# so it has to be created at its final chroot-relative location from the start.
set -a; source "$ENVFILE"; set +a
WORKSPACE_DIR="${WORKSPACE:-/local/workspace}"
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
chroot "$ROOTFS" /bin/bash -c "
  set -e
  cd '$MZ_REL'
  hailomz parse $MODEL
  hailomz optimize $MODEL --calib-path '$CALIB_REL'
  hailomz compile $MODEL
"

# hailomz's own output path convention is not pinned by Hailo's docs (verified: GETTING_STARTED.rst does not
# state where the .hef lands); search the whole workspace inside the rootfs rather than guess a single exact
# path, and fail if none appear.
found=0
while IFS= read -r -d '' f; do cp "$f" "$OUT/"; found=1; done < <(find "$ROOTFS$WORKSPACE_DIR" -name '*.hef' -print0)
[ "$found" = 1 ] || { echo "no .hef produced under $WORKSPACE_DIR" >&2; exit 1; }

ls -la "$OUT"/*.hef
for f in "$OUT"/*.hef; do sha256sum "$f" >> "$OUT/hef.sha256"; done
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
