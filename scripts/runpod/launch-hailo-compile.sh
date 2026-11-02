#!/usr/bin/env bash
# scripts/runpod/launch-hailo-compile.sh
# Mac-side driver for the Hailo-8 .hef compile pipeline (Option C of the agent-feedback plan: validate the
# Runpod -> Dataflow Compiler -> .hef path against a known-good Hailo Model Zoo reference model before
# attempting this project's own, untested sentinel-detector architecture -- see docs/ROADMAP.md's Hailo-8
# entry criterion (b)). Creates one capped CPU Pod attached to a pre-created network volume (scripts/runpod.ts
# volume-create), stages the Hailo AI Software Suite Docker image on that volume (uploaded once, reused on
# every future run against the same volume), runs scripts/runpod/hailo-compile-pod.sh, downloads the .hef, and
# ALWAYS terminates the pod on exit (trap). Without --yes it only prints the plan (no pod is created).
#
# Why a CPU Pod, not GPU: Hailo's own Dataflow Compiler system-requirements check treats a GPU as optional, not
# required (see src/infra/runpod-budget.ts's 'compile' JobKind comment). Originally chosen for Docker-in-Docker
# (documented as Runpod-CPU-Pod-only), which the compile pod no longer actually uses -- see
# hailo-compile-pod.sh's header: this pod's container turned out to have neither CAP_NET_ADMIN nor
# CAP_SYS_ADMIN, ruling out a real Docker daemon regardless of pod type, so the pod script now extracts the
# Suite image's layers by hand and chroots into them (CAP_SYS_CHROOT is present). Staying on CPU Pods anyway:
# cheaper than GPU, and there is still no GPU requirement either way.
#
# Prerequisites (one-time, manual, NOT performed by this script):
#   1. A Hailo Developer Zone account and the downloaded Hailo AI Software Suite Docker bundle (a .zip
#      containing a .tar.gz of the image) for Hailo-8/8L specifically -- not the Hailo-10H/15H/15L-tagged
#      default download; check the Developer Zone's release history for a Hailo-8-tagged release.
#   2. A Runpod network volume: `npm run runpod -- volume-create --name hailo-compile --size-gb 50
#      --datacenter <id> --yes` (50GB covers the ~9GB image plus output headroom -- the much larger uncompressed
#      extraction and chroot work happen on the pod's own ephemeral container disk, not this volume; size and
#      datacenter are a one-time, deliberate choice -- see scripts/runpod.ts's volume-create docs).
#
# Usage: scripts/runpod/launch-hailo-compile.sh --minutes 90 --network-volume-id <id> \
#          --suite-tar ~/Downloads/hailo8_ai_sw_suite_2026-07.tar.gz [--model mobilenet_v1] \
#          [--cpu-flavor "cpu5c,cpu3c"] [--vcpu-count 16] [--out DIR] [--yes]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CPU_FLAVOR="cpu5c"; MINUTES=""; NETWORK_VOLUME_ID=""; SUITE_TAR=""; MODEL="mobilenet_v1"
VCPU_COUNT="16"; YES=""; DISK_GB=60    # ephemeral container disk, not the network volume. Measured locally
                                        # 2026-11-02: this image's layer.tar contents sum to ~17GB uncompressed
                                        # total, and hailo-compile-pod.sh deletes each raw layer tar immediately
                                        # after extracting it, so peak usage never approaches that doubled --
                                        # 60GB is a generous (~3.5x) margin, not the 100-160GB first guessed
                                        # before actually measuring it. That earlier guess likely cost real
                                        # Secure Cloud host matches: every CPU flavor failed on capacity across
                                        # 10 full retry rounds right after the bump to 160GB (confirmed this pod
                                        # type's hard ceiling is 160, separately), where capacity had been
                                        # findable at 60GB before.
OUT="/tmp/zodiac-hailo-compile-$(date -u +%Y%m%dT%H%M%SZ)"
PUBKEY="${PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
IMAGE="${IMAGE:-ubuntu:22.04}"   # just the pod's own base OS now (no Docker installed into it anymore -- see
                                 # hailo-compile-pod.sh's header); the Hailo Suite's own docker-run script
                                 # documents Ubuntu 20.04/22.04 as a supported host OS for its tooling too.
POLL_SECONDS="${POLL_SECONDS:-60}"   # overridable, matching SSH_READY_SECONDS/CREATE_ROUNDS/CREATE_WAIT below

while [ $# -gt 0 ]; do case "$1" in
  --cpu-flavor) CPU_FLAVOR="$2"; shift 2;; --vcpu-count) VCPU_COUNT="$2"; shift 2;; --minutes) MINUTES="$2"; shift 2;;
  --network-volume-id) NETWORK_VOLUME_ID="$2"; shift 2;; --suite-tar) SUITE_TAR="$2"; shift 2;;
  --model) MODEL="$2"; shift 2;;
  --disk-gb) DISK_GB="$2"; shift 2;; --out) OUT="$2"; shift 2;; --yes) YES=--yes; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -n "$MINUTES" ] || { echo "--minutes is required" >&2; exit 2; }
[[ "$MINUTES" =~ ^[0-9]+$ ]] && [ "$MINUTES" -gt 0 ] || { echo "--minutes must be a positive integer" >&2; exit 2; }
[ -n "$NETWORK_VOLUME_ID" ] || { echo "--network-volume-id is required (see the module header for how to create one)" >&2; exit 2; }
[ -n "$SUITE_TAR" ] || { echo "--suite-tar is required: path to the downloaded Hailo AI Software Suite .tar.gz" >&2; exit 2; }
[ -f "$SUITE_TAR" ] || { echo "--suite-tar not found: $SUITE_TAR" >&2; exit 2; }
# --model is later interpolated, single-quoted, into a double-quoted remote SSH command string
# (`MODEL='$MODEL' ... nohup ...`). A value containing a single quote would break out of that quoting on the
# remote root shell. There is no actual privilege boundary crossed here (the operator already has unrestricted
# root SSH access to the very pod this targets, which they created and will terminate themselves), but
# validating the charset is cheap and removes the question entirely rather than relying on that reasoning
# holding up forever.
[[ "$MODEL" =~ ^[A-Za-z0-9._/:-]+$ ]] || { echo "--model contains characters outside [A-Za-z0-9._/:-]: $MODEL" >&2; exit 2; }

echo "computing sha256 of $SUITE_TAR (this is a local hash of a multi-GB file; the operation itself does not touch the network)..."
SUITE_TAR_SHA256="$(shasum -a 256 "$SUITE_TAR" | awk '{print $1}')"
echo "suite tar sha256: $SUITE_TAR_SHA256"

RP=(npm run -s runpod --)
POD=""; FLAVOR_USED=""
cleanup() {
  if [ -n "$POD" ]; then "${RP[@]}" terminate "$POD" || echo "!! TERMINATE FAILED for $POD: run 'npm run runpod -- terminate $POD' now" >&2; fi
}
trap cleanup EXIT

# Same GPU/CPU-retry + SSH-health-check pattern as launch-eval-lora.sh / launch-train-lora.sh (ported
# 2026-11-01): Secure Cloud capacity for a given CPU flavor can still be thin, so pod creation is retried
# across a comma-separated --cpu-flavor preference list, and a pod whose ssh port never answers within
# SSH_READY_SECONDS is terminated and the next candidate tried.
CREATE_ROUNDS="${CREATE_ROUNDS:-10}"; CREATE_WAIT="${CREATE_WAIT:-60}"
IFS=',' read -r -a FLAVOR_LIST <<<"$CPU_FLAVOR"
do_create() { "${RP[@]}" create --kind compile --cpu-flavor "$1" --vcpu-count "$VCPU_COUNT" --minutes "$MINUTES" --label "hailo-compile" --ssh-pubkey "$PUBKEY" --disk-gb "$DISK_GB" --network-volume-id "$NETWORK_VOLUME_ID" --image "$IMAGE" "${@:2}"; }

if [ -z "$YES" ]; then
  for f in "${FLAVOR_LIST[@]}"; do do_create "$f" || true; done
  exit 0
fi

SSH_READY_SECONDS="${SSH_READY_SECONDS:-300}"
ssh_ready() { # ip port
  local start=$SECONDS
  while [ $(( SECONDS - start )) -lt "$SSH_READY_SECONDS" ]; do
    ssh -p "$2" -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@$1" true 2>/dev/null && return 0
    sleep 6
  done
  return 1
}
IP=""; PORT=""
for round in $(seq 1 "$CREATE_ROUNDS"); do
  for f in "${FLAVOR_LIST[@]}"; do
    if out=$(do_create "$f" --yes 2>&1); then
      POD=$(sed -n 's/^created \([^ ]*\) .*/\1/p' <<<"$out"); FLAVOR_USED="$f"
      if [ -z "$POD" ]; then
        echo "create on $f reported success but no pod ID could be parsed from its output; skipping ssh-target to avoid querying an empty ID" >&2
        echo "create output was: $(tail -1 <<<"$out" | cut -c1-140)" >&2
        FLAVOR_USED=""
        continue
      fi
      echo "pod $POD ($f)"
      if read -r IP PORT < <("${RP[@]}" ssh-target "$POD") && [ -n "$IP" ] && [ -n "$PORT" ] && ssh_ready "$IP" "$PORT"; then break 2; fi
      echo "pod $POD on $f did not accept ssh within ${SSH_READY_SECONDS}s (or ssh-target returned no IP/port); terminating it and trying the next candidate"
      "${RP[@]}" terminate "$POD" || echo "!! TERMINATE FAILED for $POD: run 'npm run runpod -- terminate $POD' now" >&2
      POD=""; FLAVOR_USED=""; IP=""; PORT=""
      continue
    fi
    echo "create failed on $f (round $round/$CREATE_ROUNDS): $(tail -1 <<<"$out" | cut -c1-140)"
  done
  [ "$round" -eq "$CREATE_ROUNDS" ] || sleep "$CREATE_WAIT"
done
[ -n "$POD" ] || { echo "could not start a reachable pod on any of: $CPU_FLAVOR" >&2; exit 1; }
echo "cpu flavor $FLAVOR_USED"
echo "pod $POD"

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "root@$IP")
"${SSH[@]}" 'mkdir -p /workspace/in /workspace/out'

# Stage the Suite image on the attached network volume: upload+verify only if a sha256-matching copy isn't
# already there from a prior run against this same volume. The volume is mounted at /workspace (the pod's own
# default), so anything written there (not /workspace/in, /workspace/out, which this script treats as this
# run's scratch areas by convention) persists across future pods attached to the same --network-volume-id.
remote_sha256="$("${SSH[@]}" 'sha256sum /workspace/suite.tar.gz 2>/dev/null | awk "{print \$1}"' || true)"
if [ "$remote_sha256" = "$SUITE_TAR_SHA256" ]; then
  echo "suite image already staged on the network volume (sha256 matches); skipping the 9GB upload"
else
  echo "staging suite image on the network volume (one-time per volume; this is a multi-GB upload and may take a while)..."
  scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$SUITE_TAR" "root@$IP:/workspace/suite.tar.gz"
  verify_sha256="$("${SSH[@]}" 'sha256sum /workspace/suite.tar.gz' | awk '{print $1}')"
  [ "$verify_sha256" = "$SUITE_TAR_SHA256" ] || { echo "uploaded suite.tar.gz sha256 mismatch (local $SUITE_TAR_SHA256, remote $verify_sha256); refusing to proceed" >&2; exit 1; }
  echo "upload verified (sha256 match)"
fi
# hailo-compile-pod.sh reads from /workspace/in; symlink rather than re-copy the multi-GB file.
"${SSH[@]}" 'ln -sf /workspace/suite.tar.gz /workspace/in/suite.tar.gz'

git show HEAD:scripts/runpod/hailo-compile-pod.sh | "${SSH[@]}" 'cat > /workspace/in/hailo-compile-pod.sh && chmod +x /workspace/in/hailo-compile-pod.sh'
"${SSH[@]}" "MODEL='$MODEL' nohup /workspace/in/hailo-compile-pod.sh > /workspace/out-boot.log 2>&1 &"

mkdir -p "$OUT"
# Bounded poll loop (Invariant 5), same pattern as launch-eval-lora.sh / launch-train-lora.sh: incremental pull
# every poll so a pod that goes UNREACHABLE doesn't lose progress that was only ever downloaded once at the end.
MAX_POLLS=$(( (MINUTES * 60 / POLL_SECONDS) + 15 ))
POLL_COUNT=0
pull_results() {
  local err
  if ! err=$(scp -P "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -r "root@$IP:/workspace/out/." "$OUT/" 2>&1); then
    echo "  (pull failed: $(tail -1 <<<"$err" | cut -c1-200); will retry next poll)" >&2
  fi
}
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
ls -la "$OUT" 2>/dev/null || true
[ "$state" = DONE ]
