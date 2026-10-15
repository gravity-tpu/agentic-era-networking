#!/usr/bin/env bash
# ==============================================================================
# scripts/run-review.sh — CI AI review runner (advisory on warnings)
# ==============================================================================
# Runs an AI review command in CI WITHOUT --strict. Behaviour, from scripts/ai-reviewer.mjs:
#   exit 0  no critical issues (warnings, if any, are printed in the log and are advisory here)
#   exit 1  critical issues, OR no model produced a verdict, OR the reviewer crashed
#   exit 2  warnings only; the reviewer emits it only under --strict, but it is treated as advisory if it ever appears
# Exit 1 is classified from the log so the job says which of the three happened: "the reviewer never ran" is
# materially different from "the reviewer rejected the change".
# Deploy is gated by the deterministic `verify` job, not by this one; an LLM's non-deterministic warning count
# should not turn a branch red. The local pre-push hook stays strict and calls the reviewer directly, not through
# this script.
# ==============================================================================

set -uo pipefail

REVIEW_SCRIPT="${1:-council:review:last}"
LABEL="${2:-AI Review}"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

echo "::group::${LABEL}"
npm run "$REVIEW_SCRIPT" 2>&1 | tee "$LOG"
review_exit="${PIPESTATUS[0]}"
echo "::endgroup::"

case "$review_exit" in
  0)
    echo "${LABEL}: no critical issues (warnings, if any, are in the log above and are advisory in CI)."
    exit 0
    ;;
  2)
    echo "::warning::${LABEL}: warnings only (advisory in CI); see the log above."
    exit 0
    ;;
  1)
    if grep -q "Fail-closed verification enforced" "$LOG"; then
      echo "::error::${LABEL}: no model produced a verdict, so this change was NOT reviewed."
    elif grep -q "Critical Issues must be resolved" "$LOG"; then
      echo "::error::${LABEL}: the reviewer reported critical issues."
    else
      echo "::error::${LABEL}: the reviewer exited 1 without a recognised verdict (crash or unexpected output); the change was NOT reliably reviewed."
    fi
    exit 1
    ;;
  *)
    echo "::error::${LABEL}: the reviewer exited with unexpected status ${review_exit}."
    exit "$review_exit"
    ;;
esac
