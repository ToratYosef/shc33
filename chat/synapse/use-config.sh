#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-sqlite}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/synapse/data"

mkdir -p "$DATA_DIR"
case "$MODE" in
  sqlite)
    cp "$ROOT/synapse/homeserver-sqlite.yaml" "$DATA_DIR/homeserver.yaml"
    echo "Selected SQLite config -> $DATA_DIR/homeserver.yaml"
    ;;
  postgres)
    cp "$ROOT/synapse/homeserver-postgres.yaml" "$DATA_DIR/homeserver.yaml"
    echo "Selected Postgres config -> $DATA_DIR/homeserver.yaml"
    echo "Remember to edit DB password and start with: docker compose --profile postgres up -d"
    ;;
  *)
    echo "Usage: $0 [sqlite|postgres]"
    exit 1
    ;;
esac
