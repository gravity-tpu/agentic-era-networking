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
#     [--task proposer|reviewer|both] [--max-steps 15] [--grad-accum 4] [--time-budget-seconds N] \
#     [--out DIR] [--yes]
# --gpu takes one GPU id or a comma-separated preference list (see scripts/runpod/launch-eval-lora.sh's comment):
#   Secure Cloud On-Demand capacity for a given GPU can be thin, so pod creation is retried across the list, and a
#   pod whose ssh port never answers within SSH_READY_SECONDS is terminated and the next candidate is tried.
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
TIME_BUDGET_SECONDS="0"
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
    --time-budget-seconds) TIME_BUDGET_SECONDS="$2"; shift 2 ;;
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
POD=""; GPU_USED=""

cleanup() {
  if [ -n "$POD" ]; then
    echo "=== Cleaning up Runpod pod $POD (guaranteed termination) ==="
    "${RP[@]}" terminate "$POD" || echo "!! WARNING: runpod terminate failed for $POD. Run 'npm run runpod -- terminate $POD' immediately!" >&2
  fi
}
trap cleanup EXIT

# Invariant 4: --kind train enforces Secure Cloud on-demand placement (src/infra/runpod-budget.ts)
# Same GPU-retry + SSH-health-check pattern as launch-eval-lora.sh (ported 2026-11-01): previously this script did
# a single-shot create and a 200s SSH loop with no proactive terminate-and-retry, so a pod whose ssh port never
# answered just sat there billing until the EXIT trap fired at script exit -- unlike launch-eval-lora.sh, which
# already terminates and tries the next GPU candidate within SSH_READY_SECONDS.
CREATE_ROUNDS="${CREATE_ROUNDS:-20}"; CREATE_WAIT="${CREATE_WAIT:-60}"
IFS=',' read -r -a GPU_LIST <<<"$GPU"
do_create() { "${RP[@]}" create --gpu "$1" --minutes "$MINUTES" --kind train --label "lora-train" --ssh-pubkey "$PUBKEY" --disk-gb "$DISK_GB" "${@:2}"; }   # no mapfile: macOS bash is 3.2

if [ -z "$YES" ]; then
  echo "=== Planned Runpod Launch (dry-run, pass --yes to execute) ==="
  any_ok=0
  for g in "${GPU_LIST[@]}"; do if do_create "$g"; then any_ok=1; fi; done
  [ "$any_ok" = 1 ] || { echo "ERR: dry run: every GPU candidate was refused (see output above)" >&2; exit 1; }
  exit 0
fi

SSH_READY_SECONDS="${SSH_READY_SECONDS:-420}"
ssh_ready() { # ip port
  local start=$SECONDS   # SECONDS is a monotonic (shell-relative) bash counter, unlike `date +%s` under an NTP step
  while [ $(( SECONDS - start )) -lt "$SSH_READY_SECONDS" ]; do
    ssh -p "$2" -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@$1" true 2>/dev/null && return 0
    sleep 6
  done
  return 1
}
IP=""; PORT=""
for round in $(seq 1 "$CREATE_ROUNDS"); do
  for g in "${GPU_LIST[@]}"; do
    if out=$(do_create "$g" --yes 2>&1); then
      POD=$(sed -n 's/^created \([^ ]*\) .*/\1/p' <<<"$out"); GPU_USED="$g"
      if [ -z "$POD" ]; then
        echo "create on $g reported success but no pod ID could be parsed from its output; skipping ssh-target to avoid querying an empty ID" >&2
        echo "create output was: $(tail -1 <<<"$out" | cut -c1-140)" >&2
        GPU_USED=""
        continue
      fi
      echo "=== Created Runpod Secure Cloud Pod: $POD ($g) ==="
      if read -r IP PORT < <("${RP[@]}" ssh-target "$POD") && [ -n "$IP" ] && [ -n "$PORT" ] && ssh_ready "$IP" "$PORT"; then break 2; fi
      echo "pod $POD on $g did not accept ssh within ${SSH_READY_SECONDS}s (or ssh-target returned no IP/port); terminating it and trying the next candidate"
      "${RP[@]}" terminate "$POD" || echo "!! TERMINATE FAILED for $POD: run 'npm run runpod -- terminate $POD' now" >&2
      POD=""; GPU_USED=""; IP=""; PORT=""
      continue
    fi
    echo "create failed on $g (round $round/$CREATE_ROUNDS): $(tail -1 <<<"$out" | cut -c1-140)"
  done
  [ "$round" -eq "$CREATE_ROUNDS" ] || sleep "$CREATE_WAIT"
done
[ -n "$POD" ] || { echo "ERR: could not start a reachable pod on any of: $GPU" >&2; exit 1; }
echo "=== Using GPU $GPU_USED, pod $POD ==="

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "root@$IP")

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
"${SSH[@]}" "TASK='$TASK' MAX_STEPS='$MAX_STEPS' GRAD_ACCUM='$GRAD_ACCUM' LEARNING_RATE='$LEARNING_RATE' TIME_BUDGET_SECONDS='$TIME_BUDGET_SECONDS' nohup /workspace/in/train-lora-pod.sh > /workspace/out-boot.log 2>&1 &"

# Bounded polling loop: maximum iterations = (MINUTES * 60 / POLL_SECONDS) + 15
MAX_POLLS=$(( (MINUTES * 60 / POLL_SECONDS) + 15 ))
POLL_COUNT=0
mkdir -p "$OUT"

# Best-effort incremental pull of whatever has landed in /workspace/out so far (checkpoints, pod.log,
# dataset-build artifacts). Previously the only download was the single scp after the loop, which never ran at
# all on the FAILED, unexpected-terminal-status, or poll-budget-exhausted exit paths below -- every one of those
# exited 1 without downloading anything, losing all training progress even though the pod was still reachable at
# the moment of the check. Failure here is non-fatal (next poll, or the exit path, retries).
# Known, accepted limitation (pre-existing in the single end-of-run download this replaces, not new here): `scp -r`
# has no atomicity guard, so a pull racing a concurrent write on the pod could copy a torn last line of pod.log, or
# (scripts/train-proposer-lora.py currently only calls trainer.save_model() once at the end of each phase, no
# save_steps-interval checkpoints yet -- see the roadmap item for adding those) an incomplete copy of that final
# adapter directory if a pull lands mid-save. pod.log is append-only, so only its newest line is ever at risk; a
# mid-save adapter directory is the bigger exposure once interval checkpoints exist. Not mitigated with a staging-
# directory/rsync merge here; worth revisiting alongside that checkpoint-interval work.
pull_partial() {
  local err
  if ! err=$(scp -P "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -r "root@$IP:/workspace/out/." "$OUT/" 2>&1); then
    echo "  (pull failed: $(tail -1 <<<"$err" | cut -c1-200); will retry next poll)" >&2
  fi
}

echo "=== Monitoring training progress (polling every ${POLL_SECONDS}s, max ${MAX_POLLS} attempts) ==="
while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]; do
  POLL_COUNT=$((POLL_COUNT + 1))
  sleep "$POLL_SECONDS"
  STATUS=$("${RP[@]}" status "$POD" 2>/dev/null || echo "UNREACHABLE")
  echo "[$(date -u +%FT%TZ)] Pod status: $STATUS (poll $POLL_COUNT/$MAX_POLLS)"

  if [[ "$STATUS" =~ TERMINATED|EXITED|CANCELLED ]]; then
    echo "ERR: Pod $POD transitioned to terminal status ($STATUS) unexpectedly" >&2
    pull_partial
    exit 1
  fi

  pull_partial

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
  pull_partial
  exit 1
fi

echo "=== Downloading training artifacts to $OUT ==="
pull_partial

echo "=== Artifacts downloaded to $OUT ==="
ls -lh "$OUT"

# Pod is automatically destroyed by cleanup trap on EXIT
