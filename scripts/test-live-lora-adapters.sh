#!/usr/bin/env bash
# scripts/test-live-lora-adapters.sh
# Permanent harness for testing live LoRA inference with llama-server on local Apple Silicon or CUDA.
# Invariant 1: No errors suppressed (set -euo pipefail).
# Invariant 4: Checks admissibility with deterministic triage before declaring pass.
# Invariant 5: Guarded by bounded health polling and cleanup trap.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PORT=11436
BASE_GGUF="${BASE_GGUF:-}"
REVIEWER_LORA="${REVIEWER_LORA:-docs/benchmarks/results/lora-adapters-2026-10-29/reviewer-lora-out/zodiac-reviewer-dpo-lora.gguf}"
PROPOSER_LORA="${PROPOSER_LORA:-docs/benchmarks/results/lora-adapters-2026-10-29/proposer-lora-out/zodiac-proposer-dpo-lora.gguf}"
LLAMA_SERVER="${LLAMA_SERVER:-/opt/homebrew/bin/llama-server}"

# Auto-detect base model if not specified
if [ -z "$BASE_GGUF" ]; then
  CANDIDATE="$HOME/.ollama/models/blobs/sha256-f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d"
  if [ -f "$CANDIDATE" ]; then
    BASE_GGUF="$CANDIDATE"
  fi
fi

if [ ! -f "$BASE_GGUF" ]; then
  echo "ERR: Base GGUF model not found. Set BASE_GGUF=/path/to/qwen3.8-27b.gguf" >&2
  exit 1
fi

if [ ! -x "$LLAMA_SERVER" ]; then
  if command -v llama-server >/dev/null; then
    LLAMA_SERVER="$(command -v llama-server)"
  else
    echo "ERR: llama-server binary not found at $LLAMA_SERVER or in PATH" >&2
    exit 1
  fi
fi

SERVER_PID=""
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping llama-server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.5
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -9 "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
cleanup() {
  stop_server
}
trap cleanup EXIT

wait_for_server() {
  local label="$1"
  for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
      echo "llama-server ($label) ready after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "ERR: llama-server ($label) failed to become healthy within 60s" >&2
  return 1
}

if [ -f "$REVIEWER_LORA" ]; then
  echo "=== [1/2] Live Inference Test: Reviewer LoRA ==="
  "$LLAMA_SERVER" \
    --host 127.0.0.1 \
    -m "$BASE_GGUF" \
    --lora "$REVIEWER_LORA" \
    --port "$PORT" \
    -c 4096 \
    -ngl 99 \
    --reasoning-budget 0 \
    >/tmp/llama-server-reviewer.log 2>&1 &
  SERVER_PID=$!

  wait_for_server "Reviewer"
  node --experimental-strip-types scripts/eval-lora-llama-server.ts --mode reviewer --host "http://127.0.0.1:$PORT"

  stop_server
  sleep 2
else
  echo "SKIP: Reviewer LoRA GGUF not found at $REVIEWER_LORA"
fi

if [ -f "$PROPOSER_LORA" ]; then
  echo ""
  echo "=== [2/2] Live Inference Test: Proposer LoRA on HELD-OUT INTENT-3 ==="
  "$LLAMA_SERVER" \
    --host 127.0.0.1 \
    -m "$BASE_GGUF" \
    --lora "$PROPOSER_LORA" \
    --port "$PORT" \
    -c 8192 \
    -ngl 99 \
    --reasoning-budget 0 \
    >/tmp/llama-server-proposer.log 2>&1 &
  SERVER_PID=$!

  wait_for_server "Proposer"
  node --experimental-strip-types scripts/eval-lora-llama-server.ts --mode proposer --host "http://127.0.0.1:$PORT"
  stop_server
else
  echo "SKIP: Proposer LoRA GGUF not found at $PROPOSER_LORA"
fi

echo ""
echo "=== Live Adapter Inference Evaluations Completed Successfully ==="
