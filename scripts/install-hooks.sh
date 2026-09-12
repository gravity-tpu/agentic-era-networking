#!/usr/bin/env bash
# ==============================================================================
# Agentic Era Networking — Git Hooks Installer
# ==============================================================================
# Symlinks .agents/hooks/* into .git/hooks/ so they are active for this
# developer machine without requiring manual configuration.
#
# Usage: npm run setup-hooks
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/.agents/hooks"
HOOKS_DEST="$REPO_ROOT/.git/hooks"

GREEN="\033[0;32m"
BOLD="\033[1m"
CYAN="\033[0;36m"
RESET="\033[0m"

echo ""
echo -e "${CYAN}${BOLD}Installing Agentic Networking Senior Staff Overseer Hooks...${RESET}"
echo ""

if [ ! -d "$HOOKS_SRC" ]; then
  echo "Error: .agents/hooks/ directory not found. Run from repo root."
  exit 1
fi

mkdir -p "$HOOKS_DEST"

for hook_file in "$HOOKS_SRC"/*; do
  hook_name="$(basename "$hook_file")"
  dest="$HOOKS_DEST/$hook_name"

  chmod +x "$hook_file"

  if [ -L "$dest" ]; then
    rm "$dest"
  elif [ -f "$dest" ]; then
    echo -e "  Backing up existing $hook_name → $hook_name.bak"
    mv "$dest" "$dest.bak"
  fi

  ln -s "$hook_file" "$dest" 2>/dev/null || cp "$hook_file" "$dest"
  echo -e "  ${GREEN}✓${RESET} Installed ${BOLD}$hook_name${RESET} → .git/hooks/$hook_name"
done

echo ""
echo -e "${GREEN}${BOLD}✓ All hooks installed successfully.${RESET}"
echo -e "  Pre-push gate enforces: TypeScript | Test Suite | Determinism Scan"
echo -e "  Local audit log: ${BOLD}.agents/.local-push.log (gitignored)${RESET}"
echo ""
