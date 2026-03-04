#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/dist"
cd "$ROOT/client"
GOOS=linux GOARCH=amd64 go build -o ../dist/chat-linux-amd64 ./cmd/chat
GOOS=windows GOARCH=amd64 go build -o ../dist/chat-windows-amd64.exe ./cmd/chat
GOOS=darwin GOARCH=amd64 go build -o ../dist/chat-darwin-amd64 ./cmd/chat
GOOS=darwin GOARCH=arm64 go build -o ../dist/chat-darwin-arm64 ./cmd/chat
