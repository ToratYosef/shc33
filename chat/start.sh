#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() {
  printf "\n[chat-start] %s\n" "$1"
}

ensure_kv() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$file"
  else
    printf "%s=%s\n" "$key" "$value" >> "$file"
  fi
}

randhex() {
  openssl rand -hex "${1:-32}"
}

log "Step 1/9: Installing required packages (Docker, Compose plugin, Certbot, jq, openssl, firewall tools)."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker.io docker-compose-plugin certbot jq curl openssl ufw fail2ban
else
  log "apt-get not found. Please install Docker + docker compose + openssl + jq manually for this OS."
  exit 1
fi

log "Step 2/9: Enabling and starting Docker service."
sudo systemctl enable --now docker

log "Step 3/9: Preparing local folders and environment file."
mkdir -p synapse/data synapse/postgres nginx/certs nginx/www
if [[ ! -f .env ]]; then
  cp .env.example .env
fi

ensure_kv .env SYNAPSE_UID "$(id -u)"
ensure_kv .env SYNAPSE_GID "$(id -g)"
ensure_kv .env POSTGRES_DB "synapse"
ensure_kv .env POSTGRES_USER "synapse"
if ! grep -qE '^POSTGRES_PASSWORD=' .env || grep -q 'CHANGE_ME' .env; then
  ensure_kv .env POSTGRES_PASSWORD "$(randhex 24)"
fi

log "Step 4/9: Generating self-signed TLS cert (so Nginx can start immediately)."
CERT_BASE="nginx/certs/live/example.com"
mkdir -p "$CERT_BASE"
if [[ ! -f "$CERT_BASE/fullchain.pem" || ! -f "$CERT_BASE/privkey.pem" ]]; then
  openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
    -keyout "$CERT_BASE/privkey.pem" \
    -out "$CERT_BASE/fullchain.pem" \
    -subj "/CN=example.com"
fi

log "Step 5/9: Initializing Synapse data (one-time generate if signing key is missing)."
if [[ ! -f synapse/data/example.com.signing.key ]]; then
  docker run --rm -v "$ROOT_DIR/synapse/data:/data" \
    -e SYNAPSE_SERVER_NAME=example.com \
    -e SYNAPSE_REPORT_STATS=no \
    matrixdotorg/synapse:latest generate
fi

log "Step 6/9: Selecting default SQLite config (VPS-local storage mode)."
./synapse/use-config.sh sqlite

log "Step 7/9: Injecting strong local secrets into homeserver.yaml."
HS="synapse/data/homeserver.yaml"
if [[ -f "$HS" ]]; then
  sed -i "s/CHANGE_ME_REGISTRATION_SECRET/$(randhex 16)/" "$HS"
  sed -i "s/CHANGE_ME_MACAROON_SECRET/$(randhex 16)/" "$HS"
  sed -i "s/CHANGE_ME_FORM_SECRET/$(randhex 16)/" "$HS"
fi

log "Step 8/9: Starting Matrix stack with Docker Compose."
docker compose --env-file .env up -d

log "Step 9/9: Verifying service readiness and printing status."
sleep 4
docker compose ps
if curl -fsS http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
  log "Synapse client API is responding on localhost:8008"
else
  log "Synapse is still starting; check logs with: docker compose logs -f synapse"
fi

cat <<'NEXT'

Done ✅

What was configured automatically:
- Installed dependencies with sudo apt.
- Created/updated chat/.env with usable values.
- Generated Synapse base data + signing keys.
- Switched to SQLite mode (all data local on VPS).
- Generated a self-signed cert so Nginx can boot immediately.
- Started containers.

Recommended next command for production TLS (Let's Encrypt):
  sudo certbot certonly --webroot -w /path/to/repo/chat/nginx/www -d example.com
Then restart:
  docker compose restart nginx

Live logs:
  docker compose logs -f
NEXT
