#!/usr/bin/env bash
set -euo pipefail

CHAT_DIR="${CHAT_DIR:-$HOME/.local/share/moviechat}"
BIN_DIR="${HOME}/.local/bin"
STORE_DIR="${HOME}/.matrix-store"

mkdir -p "$CHAT_DIR" "$BIN_DIR" "$STORE_DIR"

copy_repo_assets() {
  if [[ -d "$(pwd)/chat/bin" ]]; then
    cp "$(pwd)/chat/bin/chat" "$CHAT_DIR/chat"
    cp "$(pwd)/chat/bin/moviecrypt" "$CHAT_DIR/moviecrypt"
    cp "$(pwd)/chat/contacts.json" "$CHAT_DIR/contacts.json"
  else
    echo "Run from repo root containing ./chat or set CHAT_DIR manually."
    exit 1
  fi
}

ensure_pipx_path() {
  if command -v pipx >/dev/null 2>&1; then
    pipx ensurepath || true
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

install_iamb_compatible() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found; skipping iamb install"
    return
  fi

  local rust_ver major minor
  rust_ver="$(rustc --version 2>/dev/null | awk '{print $2}' || true)"
  major="${rust_ver%%.*}"
  minor="$(echo "$rust_ver" | cut -d. -f2)"

  # iamb >=0.0.11 needs rustc >=1.88; fallback to 0.0.10 if older toolchain.
  if [[ -n "$rust_ver" && "$major" -eq 1 && "$minor" -lt 88 ]]; then
    echo "Detected rustc $rust_ver (<1.88). Installing iamb 0.0.10 compatibility version."
    cargo install iamb --version 0.0.10 || true
  else
    cargo install iamb || true
  fi
}

install_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y jq curl python3-pip pipx cargo
  fi
  ensure_pipx_path
  pipx install matrix-commander || pipx upgrade matrix-commander || true
  install_iamb_compatible
}

install_macos() {
  command -v brew >/dev/null 2>&1 || {
    echo "Homebrew required: https://brew.sh"
    exit 1
  }
  brew install jq pipx rust
  ensure_pipx_path
  pipx install matrix-commander || pipx upgrade matrix-commander || true
  install_iamb_compatible
}

install_termux() {
  pkg update -y
  pkg install -y jq curl python rust
  python -m pip install --user matrix-commander
  export PATH="$HOME/.local/bin:$PATH"
  install_iamb_compatible
}

OS="$(uname -s)"
case "$OS" in
  Linux)
    if [[ -n "${TERMUX_VERSION:-}" ]]; then install_termux; else install_linux; fi
    ;;
  Darwin)
    install_macos
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

copy_repo_assets
chmod +x "$CHAT_DIR/chat" "$CHAT_DIR/moviecrypt"
ln -sf "$CHAT_DIR/chat" "$BIN_DIR/chat"

export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"

echo "Homeserver URL (example: https://example.com/chat):"
read -r HS
matrix-commander --store "$STORE_DIR/matrix-commander" --homeserver "$HS" --login

echo "Installed. Ensure $BIN_DIR and $HOME/.local/bin are on PATH, then run: chat contacts"
echo "Safer alternative to curl|bash: download install.sh, inspect it, then run bash install.sh"
