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

GPU="NVIDIA A100-SXM4-80GB"; MINUTES=""; INTENTS="quarantine-precedence/v1"; N=50; ARMS="B3 L3 C3"; YES=""; STOP_AFTER=""; KIND="score"; ONDEMAND=""; WAIT_FOR_GO=""; PROTOCOL="A"
OUT="/tmp/zodiac-lora-eval-$(date -u +%Y%m%dT%H%M%SZ)"
ADAPTER_SRC="${ADAPTER_SRC:-$(git rev-parse --git-common-dir)/../docs/benchmarks/results/lora-adapters-2026-10-29/proposer-lora-out}"
PUBKEY="${PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
POLL_SECONDS=120
while [ $# -gt 0 ]; do case "$1" in
  --gpu) GPU="$2"; shift 2;; --minutes) MINUTES="$2"; shift 2;; --intents) INTENTS="$2"; shift 2;;
  --n) N="$2"; shift 2;; --arms) ARMS="$2"; shift 2;; --stop-after) STOP_AFTER="$2"; shift 2;; --kind) KIND="$2"; shift 2;; --wait-for-go) WAIT_FOR_GO=1; shift;; --protocol) PROTOCOL="$2"; shift 2;; --on-demand) ONDEMAND=--on-demand; shift;; --out) OUT="$2"; shift 2;; --yes) YES=--yes; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -n "$MINUTES" ] || { echo "--minutes is required" >&2; exit 2; }
[[ "$MINUTES" =~ ^[0-9]+$ ]] && [ "$MINUTES" -gt 0 ] || { echo "--minutes must be a positive integer" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "refusing: working tree is dirty" >&2; exit 1; }
[ -f "$ADAPTER_SRC/dpo-adapter/adapter_model.safetensors" ] || { echo "adapter not found at $ADAPTER_SRC" >&2; exit 1; }

RP=(npm run -s runpod --)
POD=""; GPU_USED=""
cleanup() {
  if [ -n "$POD" ]; then "${RP[@]}" terminate "$POD" || echo "!! TERMINATE FAILED for $POD: run 'npm run runpod -- terminate $POD' now" >&2; fi
}
trap cleanup EXIT

# --gpu takes one GPU id or a comma-separated preference list. Community capacity is thin, so create is retried across the
# list (CREATE_ROUNDS rounds, CREATE_WAIT s apart). The per-run cap is enforced by `runpod.ts create` for every candidate:
# a GPU too expensive for --minutes under the cap is refused and the next one is tried.
CREATE_ROUNDS="${CREATE_ROUNDS:-20}"; CREATE_WAIT="${CREATE_WAIT:-60}"
IFS=',' read -r -a GPU_LIST <<<"$GPU"
do_create() { "${RP[@]}" create --gpu "$1" --minutes "$MINUTES" --kind "$KIND" ${ONDEMAND:+"$ONDEMAND"} --label "lora-eval" --ssh-pubkey "$PUBKEY" --disk-gb 250 "${@:2}"; }   # no mapfile: macOS bash is 3.2
if [ -z "$YES" ]; then
  any_ok=0
  for g in "${GPU_LIST[@]}"; do if do_create "$g"; then any_ok=1; fi; done
  [ "$any_ok" = 1 ] || { echo "dry run: every GPU candidate was refused (see output above)" >&2; exit 1; }
  exit 0
fi
# A community host can hand out a pod whose ssh port never answers (seen 2026-10-30: TCP timeout for 20 minutes). A pod must accept
# ssh within SSH_READY_SECONDS or it is terminated and the next candidate is tried.
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
      echo "pod $POD ($g)"
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
[ -n "$POD" ] || { echo "could not start a reachable pod on any of: $GPU" >&2; exit 1; }
echo "gpu $GPU_USED"
echo "pod $POD"

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "root@$IP")
"${SSH[@]}" 'mkdir -p /workspace/in /workspace/out'

BUNDLE="/tmp/zodiac-eval-repo.$$.bundle"   # per-launcher path: parallel launchers must not share one file
git bundle create "$BUNDLE" HEAD
scp -P "$PORT" "$BUNDLE" "root@$IP:/workspace/in/repo.bundle"
rm -f "$BUNDLE"
scp -P "$PORT" -r "$ADAPTER_SRC" "root@$IP:/workspace/in/proposer-adapter"
git show HEAD:scripts/runpod/eval-lora-pod.sh | "${SSH[@]}" 'cat > /workspace/in/eval-lora-pod.sh && chmod +x /workspace/in/eval-lora-pod.sh'
"${SSH[@]}" "INTENTS='$INTENTS' N='$N' ARMS='$ARMS' STOP_AFTER='$STOP_AFTER' WAIT_FOR_GO='$WAIT_FOR_GO' PROTOCOL='$PROTOCOL' nohup /workspace/in/eval-lora-pod.sh > /workspace/out-boot.log 2>&1 &"

mkdir -p "$OUT"
# Best-effort incremental pull: scripts/agent-eval.ts appends each finished trial to trials.partial.jsonl as it
# runs, so real progress sits on the pod well before DONE/FAILED. Without this, a pod that goes UNREACHABLE
# (preempted, hits the in-container `timeout`, loses network) loses every trial since the last successful pull --
# previously that meant every trial, since the only pull was the one after the loop exits, which fails outright
# once the pod is actually unreachable. Attempted even when state=UNREACHABLE (bounded by ConnectTimeout, not
# skipped): the one SSH health check that reported UNREACHABLE can itself be a transient glitch, and skipping the
# pull entirely in exactly that case defeated the point of this fix. Errors are surfaced (not fully discarded via
# 2>/dev/null) so a real, non-connectivity failure (permissions, disk full) is visible to the operator.
# StrictHostKeyChecking=accept-new matches the SSH array above: a recycled pod IP (common on Community Cloud)
# presenting a new host key must not block this call waiting on an interactive prompt.
# Known, accepted limitation (pre-existing in the single end-of-run download this replaces, not new here): `scp -r`
# has no atomicity guard, so a pull racing a concurrent write on the pod could copy a torn last line of
# trials.partial.jsonl or pod.log. Because both files are append-only (never rewritten), every earlier, already-
# complete line is unaffected -- at worst the newest line is incomplete until the next successful pull overwrites
# it with the by-then-flushed version. Not mitigated with a staging-directory/rsync merge here; worth revisiting
# if a future incident shows this actually losing data rather than just a transiently-stale last line.
pull_results() {
  local err
  if ! err=$(scp -P "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -r "root@$IP:/workspace/out/." "$OUT/" 2>&1); then
    echo "  (pull failed: $(tail -1 <<<"$err" | cut -c1-200); will retry next poll)" >&2
  fi
}
# Bounded poll loop (Invariant 5: configurable, bounded limits, no unbounded wait). In practice the pod's own
# in-container `timeout` (--minutes, enforced pod-side independent of this script) already caps how long a
# never-finishing run can stay reachable, after which state falls to UNREACHABLE and the loop breaks on its own --
# but that is a second system's guarantee, not this script's; MAX_POLLS is this script's own explicit bound.
MAX_POLLS=$(( (MINUTES * 60 / POLL_SECONDS) + 15 ))
POLL_COUNT=0
state=RUNNING
while [ "$POLL_COUNT" -lt "$MAX_POLLS" ]; do
  POLL_COUNT=$((POLL_COUNT + 1))
  state=$("${SSH[@]}" 'if [ -e /workspace/out/DONE ]; then echo DONE; elif [ -e /workspace/out/FAILED ]; then echo FAILED; else echo RUNNING; fi' 2>/dev/null || echo UNREACHABLE)
  echo "$(date -u +%FT%TZ) $state (poll $POLL_COUNT/$MAX_POLLS)"
  pull_results
  [ "$state" = RUNNING ] || [ "$state" = UNREACHABLE ] || break
  [ "$state" != UNREACHABLE ] || { echo "pod unreachable (it may have hit its time limit)" >&2; break; }
  sleep "$POLL_SECONDS"
done
[ "$POLL_COUNT" -lt "$MAX_POLLS" ] || echo "reached maximum poll iterations ($MAX_POLLS) without the pod reporting DONE/FAILED/UNREACHABLE" >&2

pull_results
echo "results in $OUT (state: $state)"
[ "$state" = DONE ]
