# MovieCrypt Matrix Chat (self-hosted E2EE terminal messaging)

This folder provides a complete self-host deployment for Matrix Synapse + Postgres + Nginx + Element, plus CLI/TUI wrappers for Linux/macOS/Windows/Termux.

> The flashy `moviecrypt` console is presentation-only. Real encryption is Matrix E2EE (Olm/Megolm) handled by real Matrix clients.

## Deployment modes

- **Recommended: subdomain** (`https://chat.example.com`) using `nginx/chat-subdomain.conf`
- **Requested: /chat subpath** (`https://example.com/chat/...`) using `nginx/chat-subpath.conf`

Path-based Matrix can be brittle with some clients and `.well-known` discovery; subdomain is generally cleaner.

---

## File map

- `docker-compose.yml` — Synapse + Postgres + Element + Nginx
- `synapse/homeserver.yaml` — Synapse template (registration disabled by default)
- `nginx/chat-subpath.conf` — **requested** path-based config
- `nginx/chat-subdomain.conf` — **recommended** subdomain config
- `bin/chat`, `bin/chat.ps1` — terminal command wrappers
- `bin/moviecrypt`, `bin/moviecrypt.ps1` — fake-cool overlay
- `contacts.json` — name -> Matrix room mapping
- `install.sh`, `install.ps1` — one-liner installer targets

---

## DNS setup

### Requested: /chat subpath
Point `example.com` A/AAAA to VPS.

### Recommended: subdomain
Point `chat.example.com` A/AAAA to VPS.

---

## Fresh Ubuntu VPS deployment (paste-ready)

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx ufw fail2ban jq
sudo systemctl enable --now docker

cd /path/to/repo/chat
cp .env.example .env
# edit .env and set strong secrets/passwords
nano .env

# First-time synapse config generation:
docker run --rm -it -v "$(pwd)/synapse/data:/data" \
  -e SYNAPSE_SERVER_NAME=example.com \
  -e SYNAPSE_REPORT_STATS=no \
  matrixdotorg/synapse:latest generate

# Replace generated homeserver with template-driven hardened one if desired:
cp synapse/homeserver.yaml synapse/data/homeserver.yaml

docker compose --env-file .env up -d
```

### Switch Nginx mode

By default compose mounts `nginx/chat-subpath.conf`.
For subdomain mode, change compose bind to `nginx/chat-subdomain.conf` then:

```bash
docker compose up -d nginx
```

---

## HTTPS (Let's Encrypt)

Issue certs after DNS resolves:

```bash
mkdir -p nginx/www nginx/certs
sudo certbot certonly --webroot -w /path/to/repo/chat/nginx/www -d example.com
# or recommended subdomain:
sudo certbot certonly --webroot -w /path/to/repo/chat/nginx/www -d chat.example.com
```

Copy cert material into `chat/nginx/certs` or bind-mount `/etc/letsencrypt` into compose.
Then restart Nginx container:

```bash
docker compose restart nginx
```

---

## One-liner installers

### Linux/macOS/Termux

```bash
curl -fsSL https://example.com/chat/install.sh | bash
```

### Windows PowerShell

```powershell
iwr https://example.com/chat/install.ps1 -UseBasicParsing | iex
```

Safer alternative: download installer, inspect locally, then run.

---

## Terminal usage

After install/login, `chat` command supports:

```bash
chat contacts
chat ez "message"
chat ez
chat listen
```

- `chat contacts`: list aliases from `contacts.json`
- `chat <name> "msg"`: sends via `matrix-commander`
- `chat <name>`: opens interactive `iamb`
- `chat listen`: stream incoming via `matrix-commander --listen forever`

If room ID missing, wrapper prompts guidance to create DM and update `contacts.json`.

---

## Fingerprints / device verification (honest)

- **Real trust**: verify Matrix device keys in Element/iamb/device verification UX.
- `moviecrypt` prints synthetic SHA-256-like strings to create a cinematic intro.
- Treat overlay as cosmetic only; E2EE guarantees come from Matrix clients + verified devices.

---

## Security hardening checklist

1. Keep `enable_registration: false` (already in template).
2. Use strong secrets in `homeserver.yaml` + `.env`.
3. Firewall (`ufw`):
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
4. Optional fail2ban for SSH + nginx auth abuse.
5. Enable unattended upgrades:
   ```bash
   sudo apt-get install -y unattended-upgrades
   sudo dpkg-reconfigure --priority=low unattended-upgrades
   ```
6. Backup strategy:
   - Postgres dump: `docker exec chat-postgres pg_dump -U synapse synapse > backup.sql`
   - Synapse data dir: archive `chat/synapse/data`
7. Metadata reality:
   - With E2EE, server cannot read message plaintext.
   - Server still sees metadata (who talks to whom, room IDs, timing, IP, device/user IDs).

---

## Troubleshooting

### Nginx path rewrite gotchas (/chat mode)
- Ensure requests hit:
  - `/chat/_matrix/*` -> rewritten to `/_matrix/*`
  - `/chat/_synapse/client/*` -> rewritten to `/_synapse/client/*`
- Check `public_baseurl` alignment with reverse proxy path.
- Some clients expect `/.well-known/matrix/client`; consider publishing discovery JSON.

### Cert errors
- Verify DNS points to VPS before certbot.
- Ensure `/.well-known/acme-challenge/` is reachable from internet.
- Confirm cert paths in Nginx config match mounted files.

### Login/store issues
- Keep persistent store at `~/.matrix-store`.
- If login breaks after changing homeserver, re-run matrix-commander login with same store path.
- Ensure system clock is correct (TLS / token validity).

