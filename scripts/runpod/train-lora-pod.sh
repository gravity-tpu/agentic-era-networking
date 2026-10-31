#!/usr/bin/env bash
# scripts/runpod/train-lora-pod.sh
# Runs ON the Runpod Secure Cloud pod to train Zodiac Proposer and/or Reviewer LoRAs.
# Inputs (uploaded by scripts/runpod/launch-train-lora.sh into /workspace/in):
#   - repo.bundle
#   - proposer-bundle/ (optional)
#   - reviewer-bundle/ (optional)
# Outputs: /workspace/out containing adapter safetensors, GGUF weights, Modelfiles,
#          training summaries, and the terminal marker /workspace/out/DONE (or /workspace/out/FAILED).
# Fails closed (Invariant 3 & 4): any failing step halts immediately via trap.
set -Eeuo pipefail
trap 'echo "step failed at line $LINENO" >> /workspace/out/pod.log; touch /workspace/out/FAILED' ERR

TASK="${TASK:-both}"
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3.8-27B}"
MAX_STEPS="${MAX_STEPS:-15}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LEARNING_RATE="${LEARNING_RATE:-5e-5}"
BATCH_SIZE="${BATCH_SIZE:-1}"
TIME_BUDGET_SECONDS="${TIME_BUDGET_SECONDS:-0}"   # graceful wall-clock budget for both training stages (0 = none); see train-proposer-lora.py

IN=/workspace/in
OUT=/workspace/out
W=/workspace/work
mkdir -p "$OUT" "$W"
exec > >(tee -a "$OUT/pod.log") 2>&1
echo "=== Zodiac LoRA Cloud Trainer Starting $(date -u +%FT%TZ) ==="
echo "task=$TASK base_model=$BASE_MODEL max_steps=$MAX_STEPS grad_accum=$GRAD_ACCUM lr=$LEARNING_RATE time_budget_s=$TIME_BUDGET_SECONDS"

# 0. System packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq zstd cmake build-essential git curl ca-certificates pciutils

# 1. Python environment and dependencies
# -U: pip leaves an already-installed (older) transformers alone otherwise, and an old one does not recognise this model's architecture.
pip install -q -U transformers peft trl accelerate huggingface_hub sentencepiece datasets bitsandbytes gguf

# 2. Build / clone llama.cpp for GGUF conversion
git clone -q https://github.com/ggml-org/llama.cpp "$W/llama.cpp"
(cd "$W/llama.cpp" && git rev-parse HEAD > "$OUT/llama-cpp-commit.txt")

# 3. Unpack repository at pinned commit
git clone -q "$IN/repo.bundle" "$W/repo"
(cd "$W/repo" && git rev-parse HEAD > "$OUT/repo-commit.txt")

# Helper to train and convert an adapter
train_and_convert() {
  local role="$1" # "proposer" or "reviewer"
  local bundle_dir="$IN/${role}-bundle"
  local work_dir="$W/${role}-out"
  local target_out="$OUT/${role}-lora-out"

  echo "--- Starting training for: $role ---"
  [ -d "$bundle_dir" ] || { echo "bundle not found at $bundle_dir" >&2; return 1; }

  # Pre-flight dataset invariant validation
  python3 "$W/repo/scripts/train-proposer-lora.py" \
    --task "$role" \
    --dataset-dir "$bundle_dir" \
    --out-dir "$work_dir" \
    --validate-only

  # Run LoRA training (SFT + DPO)
  python3 "$W/repo/scripts/train-proposer-lora.py" \
    --task "$role" \
    --dataset-dir "$bundle_dir" \
    --out-dir "$work_dir" \
    --mode both \
    --base-model "$BASE_MODEL" \
    --batch-size "$BATCH_SIZE" \
    --grad-accum "$GRAD_ACCUM" \
    --max-steps "$MAX_STEPS" \
    --time-budget-seconds "$TIME_BUDGET_SECONDS"

  # Stage the trained adapter BEFORE the optional GGUF conversion: a conversion failure must not lose a finished run.
  mkdir -p "$target_out"
  cp -r "$work_dir/dpo-adapter" "$target_out/"
  if [ -d "$work_dir/sft-adapter" ]; then
    cp -r "$work_dir/sft-adapter" "$target_out/"
  fi
  cp "$work_dir/training-run-summary.json" "$target_out/"
  if [ -f "$work_dir/Modelfile.${role}-lora" ]; then
    cp "$work_dir/Modelfile.${role}-lora" "$target_out/"
  fi

  # Convert the DPO adapter to GGUF. Not fatal: on failure the PEFT adapter above is already staged, an explicit marker is written and
  # the conversion can be redone elsewhere (the evaluation pods have llama.cpp and the base model).
  echo "--- Converting $role DPO adapter to GGUF ---"
  if python3 "$W/llama.cpp/convert_lora_to_gguf.py" \
    --base "$BASE_MODEL" \
    "$work_dir/dpo-adapter" \
    -o "$OUT/zodiac-${role}-dpo-lora.gguf" \
    --outtype f16; then
    sha256sum "$OUT/zodiac-${role}-dpo-lora.gguf" > "$OUT/zodiac-${role}-dpo-lora.sha256"
  else
    echo "WARN: GGUF conversion failed for $role; the PEFT adapter is staged in $target_out" | tee -a "$OUT/pod.log"
    touch "$OUT/GGUF-CONVERSION-FAILED-${role}"
  fi
  echo "--- $role training & GGUF conversion complete ---"
}

if [ "$TASK" = "proposer" ] || [ "$TASK" = "both" ]; then
  train_and_convert "proposer"
fi

if [ "$TASK" = "reviewer" ] || [ "$TASK" = "both" ]; then
  train_and_convert "reviewer"
fi

echo "=== All requested training completed successfully $(date -u +%FT%TZ) ==="
touch "$OUT/DONE"

