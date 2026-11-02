#!/usr/bin/env bash
# scripts/runpod/hailo-compile-pod.sh
# Runs ON the Runpod CPU Pod. Loads the Hailo AI Software Suite Docker image (staged once on the attached
# network volume by scripts/runpod/launch-hailo-compile.sh, not re-uploaded per run), clones the Hailo Model
# Zoo at a Hailo-8-compatible version, and compiles one model to a .hef via `hailomz parse/optimize/compile`.
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
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ ! -e /workspace/out/DONE ] && [ ! -e /workspace/out/FAILED ]; then echo "exit $rc" >> /workspace/out/pod.log; touch /workspace/out/FAILED; fi' EXIT

MODEL="${MODEL:-mobilenet_v1}"
MODEL_ZOO_REF="${MODEL_ZOO_REF:-v2.14}"   # Hailo-8/8L-compatible branch (paired with DFC 3.x); the zoo's master
                                          # branch now targets Hailo-10/15 only -- confirmed 2026-11-01.
SUITE_IMAGE_TAG="${SUITE_IMAGE_TAG:-hailo8_ai_sw_suite_2026-07:latest}"   # must match the tag baked into the
                                                                          # specific suite.tar.gz staged on the volume
CALIB_IMAGE_COUNT="${CALIB_IMAGE_COUNT:-64}"
CALIB_IMAGE_SIZE="${CALIB_IMAGE_SIZE:-224}"   # mobilenet_v1's standard input resolution; override per model

IN=/workspace/in; OUT=/workspace/out; W=/workspace/work   # already created above, before the traps
exec > >(tee -a "$OUT/pod.log") 2>&1
echo "start $(date -u +%FT%TZ) model=$MODEL model_zoo_ref=$MODEL_ZOO_REF calib_images=$CALIB_IMAGE_COUNT"

# 0. OS packages + Docker-in-Docker (documented as CPU-Pod-only on Runpod; this pod is always a CPU Pod --
# see src/infra/runpod-budget.ts's 'compile' JobKind comment). No GPU is required by the Dataflow Compiler
# itself (confirmed from Hailo's own system-requirements check bundled in the Suite's docker-run script).
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq docker.io python3 python3-pip
# Both attempts' output already lands in pod.log via the exec/tee redirect above; no reason to discard the
# first attempt's stderr if it fails and the fallback is needed -- it's the first thing an operator would want
# to see when debugging why the fallback path was taken.
pip install -q --break-system-packages pillow numpy || pip install -q pillow numpy
nohup dockerd > "$W/dockerd.log" 2>&1 &
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "dockerd did not become ready" >&2; exit 1; }
docker --version > "$OUT/versions.txt"

# 1. Load the Hailo AI Software Suite image. The 9GB tar.gz is staged on the attached network volume (NOT
# re-uploaded by the launcher if a sha256-verified copy is already there) -- but Docker's own image storage is
# NOT part of that volume (it lives on this pod's ephemeral container disk), so `docker load` always runs fresh
# per pod. This is a local decompress + layer-registration, not a network transfer.
[ -f "$IN/suite.tar.gz" ] || { echo "suite.tar.gz not found in $IN" >&2; exit 1; }
docker load -i "$IN/suite.tar.gz" | tee "$OUT/docker-load.log"
docker image inspect "$SUITE_IMAGE_TAG" >/dev/null || {
  echo "loaded image does not match expected tag $SUITE_IMAGE_TAG; check SUITE_IMAGE_TAG against the actual tar.gz" >&2
  docker images >&2
  exit 1
}

# 2. Hailo Model Zoo, pinned to a Hailo-8-compatible branch (public repo, no auth).
git clone -q -b "$MODEL_ZOO_REF" https://github.com/hailo-ai/hailo_model_zoo "$W/hailo_model_zoo"
(cd "$W/hailo_model_zoo" && git rev-parse HEAD > "$OUT/model-zoo-commit.txt")

# 3. Synthetic calibration set (see module header: pipeline validation only, not accuracy-tuned).
python3 - "$W/calib" "$CALIB_IMAGE_COUNT" "$CALIB_IMAGE_SIZE" <<'PY'
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

# 4. Parse, optimize (quantize), compile -- inside the Suite container, which bundles the Dataflow Compiler's
# Python environment. hailo_model_zoo is pip-installed into the container at run time (not baked into the
# image), matching the zoo's own documented workflow (`pip install -e .` after cloning).
docker run --rm \
  -v "$W/hailo_model_zoo:/local/model_zoo" \
  -v "$W/calib:/local/calib" \
  -v "$OUT:/local/out" \
  "$SUITE_IMAGE_TAG" \
  bash -c "
    set -e
    cd /local/model_zoo
    pip install -q -e .
    hailomz parse $MODEL
    hailomz optimize $MODEL --calib-path /local/calib
    hailomz compile $MODEL
    # hailomz's own output path convention is not pinned by Hailo's docs (verified: GETTING_STARTED.rst does
    # not state where the .hef lands); copy whatever .hef files exist in the working tree rather than guess a
    # single exact path, and fail if none appear.
    found=0
    while IFS= read -r -d '' f; do cp \"\$f\" /local/out/; found=1; done < <(find . -maxdepth 3 -name '*.hef' -print0)
    [ \"\$found\" = 1 ] || { echo 'no .hef produced' >&2; exit 1; }
  "

ls -la "$OUT"/*.hef
for f in "$OUT"/*.hef; do sha256sum "$f" >> "$OUT/hef.sha256"; done
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
