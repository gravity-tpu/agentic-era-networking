#!/usr/bin/env bash
# scripts/runpod/eval-lora-pod.sh
# Runs ON the Runpod pod. Builds arms B3, L3 and C3 of docs/research/evaluation-plan.md section 11 and runs
# Protocol A (scripts/agent-eval.ts) on the intents in $INTENTS, N=$N trials, prompt v3, think true.
# Inputs (uploaded by scripts/runpod/launch-eval-lora.sh into /workspace/in): repo.bundle, proposer-adapter/.
# Output: /workspace/out (agent-eval result dirs, pod.log, versions.txt) and the marker /workspace/out/DONE.
# Fails closed: any step failing stops the script (set -e) and leaves /workspace/out/FAILED.
set -Eeuo pipefail   # -E: the ERR trap also fires inside functions (it did not on the 2026-10-30 run 3: the pod died silently)
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR
# Backstop: any non-zero exit that left neither marker (signal, set -e in a context ERR misses) still reports FAILED.
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ ! -e /workspace/out/DONE ] && [ ! -e /workspace/out/FAILED ]; then echo "exit $rc" >> /workspace/out/pod.log; touch /workspace/out/FAILED; fi' EXIT

WAIT_FOR_GO="${WAIT_FOR_GO:-}"   # non-empty: finish setup, then hold before any trial until /workspace/in/GO exists (plan section 11.3 stage gate)
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
nvidia-smi -L > "$OUT/gpu.txt" 2>&1 || true

# 0. OS packages the installers and the llama.cpp build need (the pod image lacks zstd, found on the first launch).
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq zstd cmake build-essential git curl ca-certificates pciutils python3-venv

# 1. Toolchain (Node 22, Ollama pinned to the version of the registered runs, llama.cpp CPU build for convert/quantize).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$OLLAMA_VERSION" sh
OLLAMA_NUM_PARALLEL="$PARALLEL" OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_KEEP_ALIVE=24h nohup ollama serve > "$W/ollama.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
# Merge environment: the image's CUDA torch plus a transformers new enough to know qwen3_5. -U matters: pip leaves an
# already-installed (older) transformers alone otherwise.
pip install -q -U transformers peft accelerate huggingface_hub sentencepiece
git clone -q https://github.com/ggml-org/llama.cpp "$W/llama.cpp"
(cd "$W/llama.cpp" && git rev-parse HEAD > "$OUT/llama-cpp-commit.txt" && cmake -B build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null && cmake --build build --target llama-quantize llama-export-lora -j"$(nproc)")
# Converter environment, isolated: llama.cpp's requirements pin transformers<5 and replace torch with a CPU build, which
# broke the merge environment on the first full launch.
python3 -m venv "$W/convenv"
"$W/convenv/bin/pip" install -q -r "$W/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt"
# Fail fast, before any 55 GB download: both environments must be able to do their job.
python3 - <<'PY'
import torch, transformers
from transformers import AutoConfig
assert torch.cuda.is_available(), "torch in the merge environment has no CUDA"
c = AutoConfig.from_pretrained("Qwen/Qwen3.8-27B", trust_remote_code=True)
print("merge env ok: transformers", transformers.__version__, "torch", torch.__version__, "model_type", c.model_type)
PY
"$W/convenv/bin/python" "$W/llama.cpp/convert_hf_to_gguf.py" --help > /dev/null
{ python3 -m pip list 2>/dev/null | grep -iE '^(transformers|peft|torch|accelerate) '; echo --- convenv; "$W/convenv/bin/pip" list 2>/dev/null | grep -iE '^(transformers|torch|gguf) '; } > "$OUT/pip-versions.txt"

# 2. Repo at the pinned commit (bundle keeps the commit hash; agent-eval refuses a dirty tree).
git clone -q "$IN/repo.bundle" "$W/repo"
(cd "$W/repo" && git rev-parse HEAD > "$OUT/repo-commit.txt" && npm ci --ignore-scripts --no-audit --no-fund && npx prisma generate && npx tsc)

if [ "$STOP_AFTER" = toolchain ]; then echo "toolchain ok $(date -u +%FT%TZ)"; touch "$OUT/DONE"; exit 0; fi

# 3. Arms. B3 = library model. L3/C3 = merge (or plain re-save), convert, quantize, then ollama create with the
#    library Modelfile's TEMPLATE/RENDERER/PARSER/PARAMETER lines and only FROM replaced.
ollama pull "$BASE_OLLAMA"
ollama show "$BASE_OLLAMA" --modelfile > "$W/library.Modelfile"
# Arms L3/C3 are built in GGUF space from the ORIGINAL checkpoint. A transformers merge-and-save drops the model's trailing
# next-token-prediction layer (blk.64), and the resulting GGUF cannot be loaded by Ollama ("tensor blk.64.attn_norm.weight not
# found", run 3 salvage, 2026-10-30). L3 = base f16 + llama-export-lora of the adapter GGUF, then Q4_K_M; C3 = base f16, then Q4_K_M.
base_f16() {
  [ -f "$W/base-f16.gguf" ] && return 0
  local base; base=$(python3 -c "from huggingface_hub import snapshot_download as s; print(s('$BASE_HF'))")
  "$W/convenv/bin/python" "$W/llama.cpp/convert_hf_to_gguf.py" "$base" --outtype f16 --outfile "$W/base-f16.gguf"
}
build_arm() { # name adapter-gguf|none
  local name="$1" adapter="$2" src
  base_f16
  if [ "$adapter" = none ]; then
    src="$W/base-f16.gguf"
  else
    "$W/llama.cpp/build/bin/llama-export-lora" -m "$W/base-f16.gguf" --lora "$adapter" -o "$W/$name-f16.gguf"
    src="$W/$name-f16.gguf"
  fi
  "$W/llama.cpp/build/bin/llama-quantize" "$src" "$W/$name-q4_k_m.gguf" Q4_K_M
  [ "$adapter" = none ] || rm -f "$W/$name-f16.gguf"
  sed "s|^FROM .*|FROM $W/$name-q4_k_m.gguf|" "$W/library.Modelfile" > "$W/$name.Modelfile"
  ollama create "zodiac-$name:q4_k_m" -f "$W/$name.Modelfile"   # explicit tag: /api/tags lists "name:tag" and agent-eval matches the name exactly
  sha256sum "$W/$name-q4_k_m.gguf" > "$OUT/$name-q4_k_m.sha256"
  # Fail closed before 50 trials: the model must actually load and answer.
  curl -sf -m 600 http://127.0.0.1:11434/api/chat -d "{\"model\":\"zodiac-$name:q4_k_m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}],\"stream\":false,\"options\":{\"num_predict\":16}}" | grep -q '"message"'
}

ollama list > "$OUT/versions.txt"; ollama --version >> "$OUT/versions.txt"

run_arm() { # arm model
  local arm="$1" model="$2" pids=() rc=0
  if [ -n "$WAIT_FOR_GO" ]; then   # setup is done and the model answers; hold until the stage gate is opened
    echo "ready, waiting for /workspace/in/GO $(date -u +%FT%TZ)"
    until [ -e /workspace/in/GO ]; do sleep 10; done
    echo "GO received $(date -u +%FT%TZ)"
  fi
  for intent in $INTENTS; do
    # agent-eval records the git commit and refuses a dirty tree, so it must run with the repo as cwd.
    (cd "$W/repo" && exec node --experimental-strip-types --no-warnings scripts/agent-eval.ts \
      --host http://127.0.0.1:11434 --model "$model" --intent "$intent" --n "$N" \
      --prompt-version v3 --protocol A --think true --num-predict 32768 \
      --out "$OUT/protocol-a-${intent//\//_}-$arm-pv3-n$N") &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || rc=1; done
  return $rc
}

for arm in $ARMS; do
  case "$arm" in
    B3) run_arm B3 "$BASE_OLLAMA" ;;
    L3) build_arm L3 /workspace/in/proposer-adapter/zodiac-proposer-dpo-lora.gguf; run_arm L3 zodiac-L3:q4_k_m ;;
    C3) build_arm C3 none; run_arm C3 zodiac-C3:q4_k_m ;;
    *) echo "unknown arm $arm"; exit 2 ;;
  esac
  ollama stop "$BASE_OLLAMA" 2>/dev/null || true
done
echo "done $(date -u +%FT%TZ)"; touch "$OUT/DONE"
