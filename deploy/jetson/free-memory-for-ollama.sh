#!/usr/bin/env bash
# Free Jetson memory so Ollama can load qwen2.5:3b, then prove it loads. Run on the Jetson with sudo:
#   sudo bash free-memory-for-ollama.sh
# Why: the Jetson's CPU and GPU share 8 GB. cudaMalloc cannot reclaim the page cache, so with ~2 GB cached and ~2.4 GB
# free, the 1.83 GiB model buffer fails ("cudaMalloc failed: out of memory", HTTP 500). Dropping the cache and compacting
# memory is non-destructive (clean pages are re-read from disk). Nothing here changes what the bridge reports.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
echo "before: $(grep -E 'MemFree|^Cached' /proc/meminfo | tr -s ' ' | tr '\n' ' ')"
sync
echo 3 > /proc/sys/vm/drop_caches
echo 1 > /proc/sys/vm/compact_memory
systemctl restart ollama
for _ in $(seq 1 20); do curl -fs -m2 localhost:11434/api/tags >/dev/null && break; sleep 1; done
echo "after:  $(grep -E 'MemFree|^Cached' /proc/meminfo | tr -s ' ' | tr '\n' ' ')"
# keep_alive -1 keeps the model resident once loaded, so it is not reloaded (and cannot fail to reload) per request.
out=$(curl -s -m120 localhost:11434/api/generate -d "{\"model\":\"$MODEL\",\"prompt\":\"Reply with OK\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":5}}")
if printf '%s' "$out" | grep -q '"done":true'; then echo "OK: $MODEL loaded and answered"; else echo "FAILED: $out" >&2; exit 2; fi
