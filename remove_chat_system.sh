#!/usr/bin/env bash
set -euo pipefail

# remove_chat_system.sh
# Removes legacy chat-system files from this repository when you choose to run it.
# This script does NOT run automatically; it only acts when invoked.
#
# Usage:
#   ./remove_chat_system.sh --dry-run
#   ./remove_chat_system.sh --yes

DRY_RUN=false
ASSUME_YES=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes) ASSUME_YES=true ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./remove_chat_system.sh [--dry-run] [--yes]

Options:
  --dry-run   Show what would be removed without changing files.
  --yes       Skip confirmation prompt.
  -h, --help  Show this help text.
USAGE
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "[cleanup] repo root: $ROOT_DIR"

if [[ ! -d .git ]]; then
  echo "[error] must run in a git repository root" >&2
  exit 1
fi

TARGETS=(
  "chat"
  "chat-ma"
  "client"
  "server"
  "Makefile"
  "README.md"
  "dist"
)

if ! $DRY_RUN && ! $ASSUME_YES; then
  echo "This will remove legacy chat-system paths if present:"
  printf '  - %s\n' "${TARGETS[@]}"
  read -r -p "Proceed? [y/N] " response
  case "${response:-}" in
    y|Y|yes|YES) ;;
    *)
      echo "[abort] no changes made"
      exit 0
      ;;
  esac
fi

remove_path() {
  local path="$1"

  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    if $DRY_RUN; then
      echo "[dry-run] would git rm -r --force -- $path"
    else
      git rm -r --force -- "$path" >/dev/null
      echo "[removed:tracked] $path"
    fi
  elif [[ -e "$path" ]]; then
    if $DRY_RUN; then
      echo "[dry-run] would rm -rf -- $path"
    else
      rm -rf -- "$path"
      echo "[removed:untracked] $path"
    fi
  else
    echo "[skip] not found: $path"
  fi
}

for target in "${TARGETS[@]}"; do
  remove_path "$target"
done

echo
if $DRY_RUN; then
  echo "[done] dry run complete"
else
  echo "[done] cleanup complete"
  echo "[next] review staged changes: git status --short"
fi
