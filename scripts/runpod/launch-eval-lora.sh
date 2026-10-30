#!/usr/bin/env bash
# scripts/runpod/launch-eval-lora.sh
# Mac-side driver for docs/research/evaluation-plan.md section 11. Creates one capped pod, uploads the pinned repo
# bundle and the proposer adapter, runs eval-lora-pod.sh on the pod, downloads the results, and ALWAYS terminates
# the pod on exit (trap), verifying that it is gone. Without --yes it only prints the plan (no pod is created).
#
# Placement: --kind score (default) runs on Community Cloud spot; add --on-demand to leave spot (still Community).
#   A preempted spot pod loses its results, so the poll loop reports UNREACHABLE and downloads what it can.
# Usage: scripts/runpod/launch-eval-lora.sh --minutes 150 [--gpu "NVIDIA A100-SXM4-80GB"] [--intents "a/v1 b/v1"] \
#          [--n 50] [--arms "B3 L3 C3"] [--out DIR] [--yes]
# Needs: a clean git tree (the commit is the evidence), .env.local with RUNPOD_API_KEY, ~/.ssh/id_ed25519.pub.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GPU="NVIDIA A100-SXM4-80GB"; MINUTES=""; INTENTS="quarantine-precedence/v1"; N=50; ARMS="B3 L3 C3"; YES=""; STOP_AFTER=""; KIND="score"; ONDEMAND=""
OUT="/tmp/zodiac-lora-eval-$(date -u +%Y%m%dT%H%M%SZ)"
ADAPTER_SRC="${ADAPTER_SRC:-$(git rev-parse --git-common-dir)/../docs/benchmarks/results/lora-adapters-2026-10-29/proposer-lora-out}"
PUBKEY="${PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
POLL_SECONDS=120
while [ $# -gt 0 ]; do case "$1" in
  --gpu) GPU="$2"; shift 2;; --minutes) MINUTES="$2"; shift 2;; --intents) INTENTS="$2"; shift 2;;
  --n) N="$2"; shift 2;; --arms) ARMS="$2"; shift 2;; --stop-after) STOP_AFTER="$2"; shift 2;; --kind) KIND="$2"; shift 2;; --on-demand) ONDEMAND=--on-demand; shift;; --out) OUT="$2"; shift 2;; --yes) YES=--yes; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -n "$MINUTES" ] || { echo "--minutes is required" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "refusing: working tree is dirty" >&2; exit 1; }
[ -f "$ADAPTER_SRC/dpo-adapter/adapter_model.safetensors" ] || { echo "adapter not found at $ADAPTER_SRC" >&2; exit 1; }

RP=(npm run -s runpod --)
POD=""
cleanup() {
  if [ -n "$POD" ]; then "${RP[@]}" terminate "$POD" || echo "!! TERMINATE FAILED for $POD: run 'npm run runpod -- terminate $POD' now" >&2; fi
}
trap cleanup EXIT

CREATE=("${RP[@]}" create --gpu "$GPU" --minutes "$MINUTES" --kind "$KIND" ${ONDEMAND:+"$ONDEMAND"} --label "lora-eval" --ssh-pubkey "$PUBKEY" --disk-gb 250)
if [ -z "$YES" ]; then "${CREATE[@]}"; exit 0; fi
POD=$("${CREATE[@]}" --yes | sed -n 's/^created \([^ ]*\) .*/\1/p')
[ -n "$POD" ] || { echo "could not parse pod id" >&2; exit 1; }
echo "pod $POD"

read -r IP PORT < <("${RP[@]}" ssh-target "$POD")
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "root@$IP")
for _ in $(seq 1 30); do "${SSH[@]}" true 2>/dev/null && break; sleep 5; done
"${SSH[@]}" 'mkdir -p /workspace/in /workspace/out'

git bundle create /tmp/zodiac-eval-repo.bundle HEAD
scp -P "$PORT" /tmp/zodiac-eval-repo.bundle "root@$IP:/workspace/in/repo.bundle"
scp -P "$PORT" -r "$ADAPTER_SRC" "root@$IP:/workspace/in/proposer-adapter"
git show HEAD:scripts/runpod/eval-lora-pod.sh | "${SSH[@]}" 'cat > /workspace/in/eval-lora-pod.sh && chmod +x /workspace/in/eval-lora-pod.sh'
"${SSH[@]}" "INTENTS='$INTENTS' N='$N' ARMS='$ARMS' STOP_AFTER='$STOP_AFTER' nohup /workspace/in/eval-lora-pod.sh > /workspace/out-boot.log 2>&1 &"

while true; do
  state=$("${SSH[@]}" 'if [ -e /workspace/out/DONE ]; then echo DONE; elif [ -e /workspace/out/FAILED ]; then echo FAILED; else echo RUNNING; fi' 2>/dev/null || echo UNREACHABLE)
  echo "$(date -u +%FT%TZ) $state"
  [ "$state" = RUNNING ] || [ "$state" = UNREACHABLE ] || break
  [ "$state" != UNREACHABLE ] || { echo "pod unreachable (it may have hit its time limit)" >&2; break; }
  sleep "$POLL_SECONDS"
done

mkdir -p "$OUT"
scp -P "$PORT" -r "root@$IP:/workspace/out/." "$OUT/" || echo "!! result download failed; results are lost once the pod is terminated" >&2
echo "results in $OUT (state: $state)"
[ "$state" = DONE ]
