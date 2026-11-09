#!/usr/bin/env bash
# scripts/runpod/cic-score-pod.sh
# Runs ON the Runpod pod. Scores the deployed GPU sentinel's alert rule on whole days of the public CIC-IDS2017 captures
# (docs/research/detector-evaluation-plan.md section 8): downloads the pcaps and the labelled flows from the Hugging Face mirror
# `bencorn/CICIDS2017`, verifies every file's size and sha256 against the mirror's own metadata, streams each day through
# scripts/cic-ids2017-adapter.py (unmodified), and scores the windows with scripts/cic-score-windows.py.
# Inputs (uploaded by scripts/runpod/launch-cic-score.sh into /workspace/in): repo.bundle.
# Output: /workspace/out (per-day adapter logs and summaries, combined.summary.json, dataset-manifest.json, pod.log, versions.txt)
#   and the marker /workspace/out/DONE. Fails closed: any step failing stops the script and leaves /workspace/out/FAILED.
set -Eeuo pipefail
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ ! -e /workspace/out/DONE ] && [ ! -e /workspace/out/FAILED ]; then echo "exit $rc" >> /workspace/out/pod.log; touch /workspace/out/FAILED; fi' EXIT

DAYS="${DAYS:-Monday Tuesday Wednesday Thursday Friday}"
PARALLEL="${PARALLEL:-4}"            # adapter processes at once; each is single-threaded Python
DOWNLOAD_PARALLEL="${DOWNLOAD_PARALLEL:-3}"
HF_BASE="https://huggingface.co/datasets/bencorn/CICIDS2017"
IN=/workspace/in; OUT=/workspace/out; W=/workspace/work
mkdir -p "$OUT" "$W"
exec > >(tee -a "$OUT/pod.log") 2>&1
echo "start $(date -u +%FT%TZ) days=$DAYS parallel=$PARALLEL"
nproc > "$OUT/nproc.txt"; free -g > "$OUT/memory.txt"; df -h /workspace > "$OUT/disk.txt"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq unzip git curl ca-certificates
python3 -m pip install -q numpy scapy
python3 -m pip list 2>/dev/null | grep -iE '^(numpy|scapy) ' > "$OUT/versions.txt"

git clone -q "$IN/repo.bundle" "$W/repo"
(cd "$W/repo" && git rev-parse HEAD > "$OUT/repo-commit.txt")

# 1. Manifest from the mirror's own metadata (file names, sizes, LFS sha256). Nothing is trusted that does not match it.
python3 - "$OUT/dataset-manifest.json" <<'PY'
import json, sys, urllib.request
base = "https://huggingface.co/api/datasets/bencorn/CICIDS2017/tree/main/"
manifest = {}
for d in ("pcaps", "csvs"):
    with urllib.request.urlopen(base + d, timeout=60) as r:
        for e in json.load(r):
            if e.get("type") == "file":
                manifest[e["path"]] = {"size": e["size"], "sha256": (e.get("lfs") or {}).get("oid")}
missing = [k for k, v in manifest.items() if not v["sha256"]]
assert not missing, f"no sha256 in the mirror metadata for {missing}"
json.dump(manifest, open(sys.argv[1], "w"), indent=2, sort_keys=True)
print(len(manifest), "files in the manifest")
PY

# 2. Resolve each requested day to its pcap path in the manifest (case-insensitive prefix, e.g. Wednesday-workingHours.pcap).
for day in $DAYS; do
  python3 - "$OUT/dataset-manifest.json" "$day" > "$W/pcap-$day.txt" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); day = sys.argv[2].lower()
hits = [k for k in m if k.startswith("pcaps/") and k.split("/")[-1].lower().startswith(day + "-")]
assert len(hits) == 1, f"expected exactly one pcap for {day}, found {hits}"
print(hits[0])
PY
  echo "day $day -> $(cat "$W/pcap-$day.txt")"
done

# 3. Download and verify (size, then sha256 against the mirror's value).
fetch() { # manifest-path
  local path="$1" dest="$W/data/$1"
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 5 --retry-delay 10 -C - -sS -o "$dest" "$HF_BASE/resolve/main/$path"
  python3 - "$OUT/dataset-manifest.json" "$path" "$dest" <<'PY'
import hashlib, json, os, sys
m = json.load(open(sys.argv[1]))[sys.argv[2]]; dest = sys.argv[3]
assert os.path.getsize(dest) == m["size"], f"{sys.argv[2]}: size {os.path.getsize(dest)} != {m['size']}"
h = hashlib.sha256()
with open(dest, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 24), b""): h.update(chunk)
assert h.hexdigest() == m["sha256"], f"{sys.argv[2]}: sha256 mismatch"
print("verified", sys.argv[2], m["size"], "bytes", m["sha256"][:16])
PY
}
export -f fetch; export W OUT HF_BASE
{ echo "csvs/GeneratedLabelledFlows.zip"; for day in $DAYS; do cat "$W/pcap-$day.txt"; done; } | xargs -P "$DOWNLOAD_PARALLEL" -I{} bash -c 'fetch {}'
mkdir -p "$W/labels" && unzip -q -o "$W/data/csvs/GeneratedLabelledFlows.zip" -d "$W/labels"
find "$W/labels" -iname '*.csv' | sort > "$OUT/label-csvs.txt"

# 4. One adapter process per day (the adapter is unmodified; TZ offset and label join are its own), then score the windows.
score_day() { # day
  set -Eeuo pipefail   # the function runs in a child shell (xargs), which does not inherit -e
  local day="$1" pcap csvs=()
  pcap="$W/data/$(cat "$W/pcap-$day.txt")"
  while IFS= read -r c; do csvs+=("$c"); done < <(find "$W/labels" -iname "*${day}*" -name '*.csv' | sort)
  [ "${#csvs[@]}" -ge 1 ] || { echo "no labelled-flow CSV found for $day" >&2; return 1; }
  printf '%s\n' "${csvs[@]}" > "$OUT/$day.csvs.txt"
  (cd "$W/repo" && python3 scripts/cic-ids2017-adapter.py "$pcap" "${csvs[@]}" --out "$W/$day.windows.jsonl") > "$OUT/$day.adapter.log" 2>&1
  (cd "$W/repo" && python3 scripts/cic-score-windows.py --day "$day" --out "$OUT/$day.summary.json" "$W/$day.windows.jsonl")
  wc -l < "$W/$day.windows.jsonl" > "$OUT/$day.windows-count.txt"
  rm -f "$W/$day.windows.jsonl" "$pcap"    # windows files are large; the summary and the logs are the evidence
  echo "scored $day $(date -u +%FT%TZ)"
}
export -f score_day; export W OUT
printf '%s\n' $DAYS | xargs -P "$PARALLEL" -I{} bash -c 'score_day {}' || { echo "a day failed; not combining"; exit 1; }

(cd "$W/repo" && python3 scripts/cic-score-windows.py --combine --out "$OUT/combined.summary.json" $(for d in $DAYS; do echo "$OUT/$d.summary.json"; done))
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
