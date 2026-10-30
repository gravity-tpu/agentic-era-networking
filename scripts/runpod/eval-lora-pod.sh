#!/usr/bin/env bash
# scripts/runpod/eval-lora-pod.sh
# Runs ON the Runpod pod. Builds arms B3, L3 and C3 of docs/research/evaluation-plan.md section 11 and runs
# Protocol A (scripts/agent-eval.ts) on the intents in $INTENTS, N=$N trials, prompt v3, think true.
# Inputs (uploaded by scripts/runpod/launch-eval-lora.sh into /workspace/in): repo.bundle, proposer-adapter/.
# Output: /workspace/out (agent-eval result dirs, pod.log, versions.txt) and the marker /workspace/out/DONE.
# Fails closed: any step failing stops the script (set -e) and leaves /workspace/out/FAILED.
set -euo pipefail
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR

STOP_AFTER="${STOP_AFTER:-}"   # "toolchain": exit 0 after steps 0-2 (cheap-GPU shakedown, no model download)
INTENTS="${INTENTS:-quarantine-precedence/v1}"
N="${N:-50}"
ARMS="${ARMS:-B3 L3 C3}"
PARALLEL="${PARALLEL:-4}"
OLLAMA_VERSION="${OLLAMA_VERSION:-0.34.4}"
BASE_HF="Qwen/Qwen3.8-27B"
BASE_OLLAMA="qwen3.8:27b"
IN=/workspace/in; OUT=/workspace/out; W=/workspace/work
mkdir -p "$OUT" "$W"
exec > >(tee -a "$OUT/pod.log") 2>&1
echo "start $(date -u +%FT%TZ) intents=$INTENTS n=$N arms=$ARMS"

# 0. OS packages the installers and the llama.cpp build need (the pod image lacks zstd, found on the first launch).
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq zstd cmake build-essential git curl ca-certificates pciutils

# 1. Toolchain (Node 22, Ollama pinned to the version of the registered runs, llama.cpp CPU build for convert/quantize).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$OLLAMA_VERSION" sh
OLLAMA_NUM_PARALLEL="$PARALLEL" OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_KEEP_ALIVE=24h nohup ollama serve > "$W/ollama.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
pip install -q "transformers" peft accelerate huggingface_hub sentencepiece
git clone -q https://github.com/ggml-org/llama.cpp "$W/llama.cpp"
(cd "$W/llama.cpp" && git rev-parse HEAD > "$OUT/llama-cpp-commit.txt" && cmake -B build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null && cmake --build build --target llama-quantize -j"$(nproc)")
pip install -q -r "$W/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt"

# 2. Repo at the pinned commit (bundle keeps the commit hash; agent-eval refuses a dirty tree).
git clone -q "$IN/repo.bundle" "$W/repo"
(cd "$W/repo" && git rev-parse HEAD > "$OUT/repo-commit.txt" && npm ci --ignore-scripts --no-audit --no-fund && npx prisma generate && npx tsc)

if [ "$STOP_AFTER" = toolchain ]; then echo "toolchain ok $(date -u +%FT%TZ)"; touch "$OUT/DONE"; exit 0; fi

# 3. Arms. B3 = library model. L3/C3 = merge (or plain re-save), convert, quantize, then ollama create with the
#    library Modelfile's TEMPLATE/RENDERER/PARSER/PARAMETER lines and only FROM replaced.
ollama pull "$BASE_OLLAMA"
ollama show "$BASE_OLLAMA" --modelfile > "$W/library.Modelfile"
build_arm() { # name adapter
  local name="$1" adapter="$2" dir="$W/$1-merged"
  python3 "$W/repo/scripts/runpod/merge-lora.py" --base "$BASE_HF" --adapter "$adapter" --out "$dir"
  python3 "$W/llama.cpp/convert_hf_to_gguf.py" "$dir" --outtype f16 --outfile "$W/$name-f16.gguf"
  "$W/llama.cpp/build/bin/llama-quantize" "$W/$name-f16.gguf" "$W/$name-q4_k_m.gguf" Q4_K_M
  sed "s|^FROM .*|FROM $W/$name-q4_k_m.gguf|" "$W/library.Modelfile" > "$W/$name.Modelfile"
  ollama create "zodiac-$name" -f "$W/$name.Modelfile"
  cp "$dir/merge-record.json" "$OUT/$name-merge-record.json"
  sha256sum "$W/$name-q4_k_m.gguf" > "$OUT/$name-q4_k_m.sha256"
  rm -rf "$dir" "$W/$name-f16.gguf"   # disk: keep only the quantized file
}
ollama list > "$OUT/versions.txt"; ollama --version >> "$OUT/versions.txt"

run_arm() { # arm model
  # Seeds of one intent are split into SHARDS strided shards (agent-eval --shard i/k) that run concurrently against
  # the one Ollama server (OLLAMA_NUM_PARALLEL=$PARALLEL), then merged into the canonical result directory. Each
  # trial is identical to a sequential one (same seed, prompt, sampling). Shards of a failed process are not merged.
  local arm="$1" model="$2" pids=() rc=0 n_intents shards
  n_intents=$(wc -w <<<"$INTENTS")
  shards=$(( PARALLEL / n_intents )); [ "$shards" -ge 1 ] || shards=1; [ "$shards" -le "$N" ] || shards=$N
  mkdir -p "$OUT/shards"
  for intent in $INTENTS; do
    local base="protocol-a-${intent//\//_}-$arm-pv3-n$N"
    for i in $(seq 1 "$shards"); do
      # agent-eval records the git commit and refuses a dirty tree, so it must run with the repo as cwd.
      (cd "$W/repo" && exec node --experimental-strip-types --no-warnings scripts/agent-eval.ts \
        --host http://127.0.0.1:11434 --model "$model" --intent "$intent" --n "$N" --shard "$i/$shards" \
        --prompt-version v3 --protocol A --think true --num-predict 32768 \
        --out "$OUT/shards/$base-shard$i") &
      pids+=($!)
    done
  done
  for p in "${pids[@]}"; do wait "$p" || rc=1; done
  [ "$rc" = 0 ] || { echo "a shard failed for arm $arm; not merging"; return 1; }
  for intent in $INTENTS; do
    local base="protocol-a-${intent//\//_}-$arm-pv3-n$N"
    (cd "$W/repo" && node --experimental-strip-types --no-warnings scripts/merge-eval-shards.ts --out "$OUT/$base" "$OUT/shards/$base"-shard*)
  done
}

for arm in $ARMS; do
  case "$arm" in
    B3) run_arm B3 "$BASE_OLLAMA" ;;
    L3) build_arm L3 /workspace/in/proposer-adapter/dpo-adapter; run_arm L3 zodiac-L3 ;;
    C3) build_arm C3 none; run_arm C3 zodiac-C3 ;;
    *) echo "unknown arm $arm"; exit 2 ;;
  esac
  ollama stop "$BASE_OLLAMA" 2>/dev/null || true
done
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
