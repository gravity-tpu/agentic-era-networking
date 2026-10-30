#!/usr/bin/env bash
# scripts/runpod/launch-train-lora.sh
# Mac-side orchestrator for Zodiac LoRA cloud training.
# Allocates a Secure Cloud On-Demand Runpod pod (per placement policy in src/infra/runpod-budget.ts),
# uploads the repo bundle and training dataset bundles, executes train-lora-pod.sh,
# streams logs, downloads the trained compact LoRA adapters and GGUFs, and guarantees
# pod termination via EXIT trap.
#
# Usage:
#   scripts/runpod/launch-train-lora.sh --minutes 180 [--gpu "NVIDIA A100-SXM4-80GB"] \
#     [--task proposer|reviewer|both] [--max-steps 15] [--grad-accum 4] \
#     [--out DIR] [--yes]
#
# Invariants:
#   - Invariant 1: No errors suppressed (set -euo pipefail).
#   - Invariant 3: Fails closed on dirty git working tree or missing datasets.
#   - Invariant 4: Training runs strictly on Secure Cloud On-Demand (enforced by runpod.ts --kind train).
#   - Invariant 5: Guarded by runpod-budget cap ceiling and hard termination trap.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GPU="NVIDIA A100-SXM4-80GB"
MINUTES=""
TASK="both"
MAX_STEPS="15"
GRAD_ACCUM="4"
LEARNING_RATE="5e-5"
YES=""
OUT="docs/benchmarks/results/lora-adapters-$(date -u +%Y%m%d)"
PUBKEY="${PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
DISK_GB=250
POLL_SECONDS=60

while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) GPU="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --max-steps) MAX_STEPS="$2"; shift 2 ;;
    --grad-accum) GRAD_ACCUM="$2"; shift 2 ;;
    --learning-rate) LEARNING_RATE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --disk-gb) DISK_GB="$2"; shift 2 ;;
    --yes) YES=--yes; shift ;;
    *) echo "ERR_USAGE: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$MINUTES" ] || { echo "ERR_USAGE: --minutes is required" >&2; exit 2; }
[[ "$MINUTES" =~ ^[0-9]+$ ]] && [ "$MINUTES" -gt 0 ] || { echo "ERR_USAGE: --minutes must be a positive integer" >&2; exit 2; }
[ "$TASK" = "proposer" ] || [ "$TASK" = "reviewer" ] || [ "$TASK" = "both" ] || {
  echo "ERR_USAGE: --task must be proposer, reviewer, or both" >&2; exit 2;
}

[ -z "$(git status --porcelain)" ] || {
  echo "refusing: working tree is dirty; commit first (plan section 8)" >&2
  exit 1
}

PROPOSER_SRC="/tmp/zodiac-proposer-lora"
REVIEWER_SRC="/tmp/zodiac-reviewer-lora"

RP=(npm run -s runpod --)
POD=""

cleanup() {
  if [ -n "$POD" ]; then
    echo "=== Cleaning up Runpod pod $POD (guaranteed termination) ==="
    "${RP[@]}" terminate "$POD" || echo "!! WARNING: runpod terminate failed for $POD. Run 'npm run runpod -- terminate $POD' immediately!" >&2
  fi
}
trap cleanup EXIT

# Invariant 4: --kind train enforces Secure Cloud on-demand placement (src/infra/runpod-budget.ts)
CREATE=("${RP[@]}" create --gpu "$GPU" --minutes "$MINUTES" --kind train --label "lora-train" --ssh-pubkey "$PUBKEY" --disk-gb "$DISK_GB")

if [ -z "$YES" ]; then
  echo "=== Planned Runpod Launch (dry-run, pass --yes to execute) ==="
  "${CREATE[@]}"
  exit $?
fi

POD=$("${CREATE[@]}" --yes | sed -n 's/^created \([^ ]*\) .*/\1/p')
[ -n "$POD" ] || { echo "ERR: could not parse created pod ID" >&2; exit 1; }
echo "=== Created Runpod Secure Cloud Pod: $POD ==="

read -r IP PORT < <("${RP[@]}" ssh-target "$POD")
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "root@$IP")

echo "=== Waiting for SSH readiness on root@$IP:$PORT ==="
for _ in $(seq 1 40); do
  if "${SSH[@]}" true 2>/dev/null; then break; fi
  sleep 5
done

"${SSH[@]}" 'mkdir -p /workspace/in /workspace/out /workspace/work'

echo "=== Bundling local repository at HEAD ==="
BUNDLE_TMP="/tmp/zodiac-train-repo-$(date -u +%s).bundle"
git bundle create "$BUNDLE_TMP" HEAD
scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$BUNDLE_TMP" "root@$IP:/workspace/in/repo.bundle"
rm -f "$BUNDLE_TMP"

if [ "$TASK" = "proposer" ] || [ "$TASK" = "both" ]; then
  if [ ! -f "$PROPOSER_SRC/summary.json" ]; then
    echo "=== Generating Proposer LoRA dataset bundle ==="
    npm run lora:dataset:proposer
  fi
  echo "=== Uploading Proposer dataset bundle ==="
  scp -P "$PORT" -o StrictHostKeyChecking=accept-new -r "$PROPOSER_SRC" "root@$IP:/workspace/in/proposer-bundle"
fi

if [ "$TASK" = "reviewer" ] || [ "$TASK" = "both" ]; then
  if [ ! -f "$REVIEWER_SRC/summary.json" ]; then
    echo "=== Generating Reviewer LoRA dataset bundle ==="
    npm run lora:dataset:reviewer
  fi
  echo "=== Uploading Reviewer dataset bundle ==="
  scp -P "$PORT" -o StrictHostKeyChecking=accept-new -r "$REVIEWER_SRC" "root@$IP:/workspace/in/reviewer-bundle"
fi

echo "=== Uploading train-lora-pod.sh script ==="
scp -P "$PORT" -o StrictHostKeyChecking=accept-new scripts/runpod/train-lora-pod.sh "root@$IP:/workspace/in/train-lora-pod.sh"
"${SSH[@]}" 'chmod +x /workspace/in/train-lora-pod.sh'

echo "=== Launching in-pod training supervisor ==="
"${SSH[@]}" "TASK='$TASK' MAX_STEPS='$MAX_STEPS' GRAD_ACCUM='$GRAD_ACCUM' LEARNING_RATE='$LEARNING_RATE' nohup /workspace/in/train-lora-pod.sh > /workspace/out-boot.log 2>&1 &"

# Bounded polling loop: maximum iterations = (MINUTES * 60 / POLL_SECONDS) + 15
MAX_POLLS=$(( (MINUTES * 60 / POLL_SECONDS) + 15 ))
POLL_COUNT=0

echo "=== Monitoring training progress (polling every ${POLL_SECONDS}s, max ${MAX_POLLS} attempts) ==="
while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]; do
  POLL_COUNT=$((POLL_COUNT + 1))
  sleep "$POLL_SECONDS"
  STATUS=$("${RP[@]}" status "$POD" 2>/dev/null || echo "UNREACHABLE")
  echo "[$(date -u +%FT%TZ)] Pod status: $STATUS (poll $POLL_COUNT/$MAX_POLLS)"

  if [[ "$STATUS" =~ TERMINATED|EXITED|CANCELLED ]]; then
    echo "ERR: Pod $POD transitioned to terminal status ($STATUS) unexpectedly" >&2
    exit 1
  fi

  # Check terminal markers
  if "${SSH[@]}" '[ -f /workspace/out/DONE ]' 2>/dev/null; then
    echo "=== Training run SUCCEEDED: /workspace/out/DONE detected ==="
    break
  fi
  if "${SSH[@]}" '[ -f /workspace/out/FAILED ]' 2>/dev/null; then
    echo "=== Training run FAILED: /workspace/out/FAILED detected ==="
    "${SSH[@]}" 'cat /workspace/out/pod.log | tail -n 50' || true
    exit 1
  fi

  # Stream recent log lines
  "${SSH[@]}" 'tail -n 10 /workspace/out/pod.log 2>/dev/null' || true
done

if [ "$POLL_COUNT" -ge "$MAX_POLLS" ]; then
  echo "ERR: reached maximum poll iterations ($MAX_POLLS) without pod completing" >&2
  exit 1
fi

echo "=== Downloading training artifacts to $OUT ==="
mkdir -p "$OUT"
scp -P "$PORT" -o StrictHostKeyChecking=accept-new -r "root@$IP:/workspace/out/*" "$OUT/"

echo "=== Artifacts downloaded successfully to $OUT ==="
ls -lh "$OUT"

# Pod is automatically destroyed by cleanup trap on EXIT
