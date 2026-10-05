#!/usr/bin/env bash
# ==============================================================================
# scripts/run-review.sh — Council Review Runner with Bounded Variance Retry
# ==============================================================================
# Executes an AI council review command with bounded retries strictly for exit code 2
# (warning-only blocks due to LLM generation variance). Fails closed immediately on exit 1
# (definitive rejection / critical issues / model exhaustion).
# ==============================================================================

set -euo pipefail

REVIEW_SCRIPT="${1:-council:review:last}"
LABEL="${2:-Council Review}"

MAX_ATTEMPTS=3
attempt=1

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "::group::${LABEL} attempt ${attempt} / ${MAX_ATTEMPTS}"
  review_exit=0
  npm run "$REVIEW_SCRIPT" -- --strict || review_exit=$?
  echo "::endgroup::"

  if [ "$review_exit" -eq 0 ]; then
    exit 0
  fi

  if [ "$review_exit" -ne 2 ]; then
    echo "::error::${LABEL}: definitive rejection (exit ${review_exit}) — no retry."
    exit "$review_exit"
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -le "$MAX_ATTEMPTS" ]; then
    echo "::notice::${LABEL}: warning-only block — re-evaluating (attempt ${attempt} / ${MAX_ATTEMPTS})..."
  fi
done

echo "::error::${LABEL}: warning-only block persisted after ${MAX_ATTEMPTS} attempts."
exit 2
