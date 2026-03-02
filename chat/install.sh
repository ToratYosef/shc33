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

ensure_modern_rust() {
  # Cargo edition2024 support is stabilized in modern toolchains.
  # Older distro cargo (e.g. 1.75) will fail on some iamb deps.
  export PATH="$HOME/.cargo/bin:$PATH"

  if ! command -v rustup >/dev/null 2>&1; then
    echo "Installing rustup (for up-to-date cargo/rustc)..."
    curl https://sh.rustup.rs -sSf | sh -s -- -y || {
      echo "Warning: rustup install failed; iamb install may be skipped."
      return 0
    }
  fi

  echo "Updating Rust stable toolchain..."
  rustup toolchain install stable >/dev/null 2>&1 || true
  rustup default stable >/dev/null 2>&1 || true
  rustup update stable >/dev/null 2>&1 || true

  # re-export PATH for current shell
  export PATH="$HOME/.cargo/bin:$PATH"
}

install_iamb_compatible() {
  ensure_modern_rust

  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not available; skipping iamb install (chat send/listen still works via matrix-commander)."
    return
  fi

  echo "Attempting iamb install with cargo $(cargo --version 2>/dev/null || echo unknown)..."
  if cargo install iamb; then
    echo "iamb installed successfully."
    return
  fi

  echo "Latest iamb build failed; trying pinned fallback iamb 0.0.10..."
  if cargo install iamb --version 0.0.10; then
    echo "iamb 0.0.10 installed successfully."
    return
  fi

  echo "Warning: iamb install failed even after rustup update."
  echo "You can still use non-interactive messaging/listening via matrix-commander."
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
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
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

export PATH="$BIN_DIR:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

echo "Homeserver URL (example: https://example.com/chat):"
read -r HS
matrix-commander --store "$STORE_DIR/matrix-commander" --homeserver "$HS" --login

echo "Installed. Ensure $BIN_DIR, $HOME/.local/bin and $HOME/.cargo/bin are on PATH, then run: chat contacts"
echo "Safer alternative to curl|bash: download install.sh, inspect it, then run bash install.sh"
