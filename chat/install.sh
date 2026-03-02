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

install_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y jq curl python3-pip pipx cargo
  fi
  pipx install matrix-commander || true
  cargo install iamb || true
}

install_macos() {
  command -v brew >/dev/null 2>&1 || {
    echo "Homebrew required: https://brew.sh"
    exit 1
  }
  brew install jq pipx rust
  pipx install matrix-commander || true
  cargo install iamb || true
}

install_termux() {
  pkg update -y
  pkg install -y jq curl python rust
  python -m pip install --user matrix-commander
  cargo install iamb || true
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

export PATH="$BIN_DIR:$PATH"

echo "Homeserver URL (example: https://example.com/chat):"
read -r HS
matrix-commander --store "$STORE_DIR/matrix-commander" --homeserver "$HS" --login

echo "Installed. Ensure $BIN_DIR is on PATH, then run: chat contacts"
echo "Safer alternative to curl|bash: download install.sh, inspect it, then run bash install.sh"
