# MovieCrypt Matrix Chat (self-hosted E2EE terminal messaging)

This setup is fully self-hosted on your VPS.

- **Default storage mode:** Synapse + SQLite file on VPS disk (`./synapse/data/homeserver.db`)
- **Optional mode:** Synapse + Postgres container on the same VPS (no external DB service)

> `moviecrypt` is visual theater only. Real encryption is Matrix E2EE (Olm/Megolm) in real clients.

## Deployment modes

- **Recommended: subdomain** (`https://chat.example.com`) with `nginx/chat-subdomain.conf`
- **Requested: /chat subpath** (`https://example.com/chat/...`) with `nginx/chat-subpath.conf`

## DNS

- Requested mode: point `example.com` to VPS
- Recommended mode: point `chat.example.com` to VPS

## Fresh Ubuntu VPS deploy (SQLite default, no DB service needed)

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin certbot ufw fail2ban jq
sudo systemctl enable --now docker

cd /path/to/repo/chat
cp .env.example .env
nano .env

# Generate initial Synapse state in ./synapse/data
docker run --rm -it -v "$(pwd)/synapse/data:/data" \
  -e SYNAPSE_SERVER_NAME=example.com \
  -e SYNAPSE_REPORT_STATS=no \
  matrixdotorg/synapse:latest generate

# Use SQLite template (default compose mount)
./synapse/use-config.sh sqlite

docker compose --env-file .env up -d
```

## Optional: local Postgres on same VPS (still no external DB)

```bash
cd /path/to/repo/chat
./synapse/use-config.sh postgres
# set password in synapse/data/homeserver.yaml to match .env POSTGRES_PASSWORD
nano synapse/data/homeserver.yaml

# mount generated config instead of template if needed (compose already maps /data/homeserver.yaml)
docker compose --profile postgres --env-file .env up -d
```

## HTTPS with certbot

```bash
mkdir -p nginx/www nginx/certs
sudo certbot certonly --webroot -w /path/to/repo/chat/nginx/www -d example.com
# or recommended:
sudo certbot certonly --webroot -w /path/to/repo/chat/nginx/www -d chat.example.com

docker compose restart nginx
```

## Terminal usage

```bash
chat contacts
chat ez "message"
chat ez
chat listen
```

- `chat contacts` list aliases from `contacts.json`
- `chat <name> "msg"` send with `matrix-commander`
- `chat <name>` open `iamb`
- `chat listen` stream incoming

Persistent crypto/state store: `~/.matrix-store`

## One-liner installers

Linux/macOS/Termux:

```bash
curl -fsSL https://example.com/chat/install.sh | bash
```

Windows PowerShell:

```powershell
iwr https://example.com/chat/install.ps1 -UseBasicParsing | iex
```

Safer alternative: download installer, inspect locally, then execute.

## Device verification + fingerprints (honest)

- Real trust comes from Matrix device verification in Element/iamb.
- `moviecrypt` fingerprints are synthetic for presentation UX.

## Security hardening

1. Keep `enable_registration: false`
2. Firewall:
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
3. Optional fail2ban
4. Auto updates:
   ```bash
   sudo apt-get install -y unattended-upgrades
   sudo dpkg-reconfigure --priority=low unattended-upgrades
   ```
5. Backups:
   - SQLite mode: backup `chat/synapse/data/`
   - Postgres mode: `docker exec chat-postgres pg_dump -U synapse synapse > backup.sql`

## Metadata reality

With E2EE, server cannot read plaintext messages, but can still see metadata (timing, room IDs, sender/receiver IDs, IP/device metadata).

## Troubleshooting

- `/chat` rewrites must map:
  - `/chat/_matrix/* -> /_matrix/*`
  - `/chat/_synapse/client/* -> /_synapse/client/*`
- If clients fail discovery, add `.well-known/matrix/client`
- Certbot requires correct DNS before issuing certs
- Keep same store path (`~/.matrix-store`) when relogging
