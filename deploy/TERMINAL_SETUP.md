# Secure ttyd SSH terminal deployment

This repo now includes:

- Static landing page at `/terminal` (`public/terminal/index.html`)
- Static fallback page at `/terminal/session/` for non-proxied environments (`public/terminal/session/index.html`)
- `ttyd` SSH launcher script (`scripts/ttyd-ssh-root.sh`)
- Hardened systemd unit (`deploy/systemd/ttyd-root-ssh.service`)
- NGINX server block template (`deploy/nginx/terminal.conf`)

## 1) Install runtime dependencies on your server

```bash
sudo apt-get update
sudo apt-get install -y nginx apache2-utils openssh-client ttyd
```

## 2) Create locked-down ttyd service account

```bash
sudo useradd --system --create-home --home-dir /var/lib/ttyd --shell /usr/sbin/nologin ttyd || true
sudo install -d -o ttyd -g ttyd -m 700 /var/lib/ttyd/.ssh
```

## 3) Deploy scripts and service

```bash
sudo install -m 755 /workspace/shc33/scripts/ttyd-ssh-root.sh /usr/local/bin/ttyd-ssh-root.sh
sudo cp /workspace/shc33/deploy/systemd/ttyd-root-ssh.service /etc/systemd/system/ttyd-root-ssh.service
sudo sed -i 's#/workspace/shc33/scripts/ttyd-ssh-root.sh#/usr/local/bin/ttyd-ssh-root.sh#g' /etc/systemd/system/ttyd-root-ssh.service
sudo systemctl daemon-reload
sudo systemctl enable --now ttyd-root-ssh.service
sudo systemctl status ttyd-root-ssh.service --no-pager
```

## 4) Configure NGINX access controls

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-terminal youradminuser
sudo cp /workspace/shc33/deploy/nginx/terminal.conf /etc/nginx/sites-available/terminal.conf
```

Edit `/etc/nginx/sites-available/terminal.conf`:

- set `server_name`
- set SSL certificate paths
- optionally add an `allow` / `deny all` IP allowlist

Then:

```bash
sudo ln -sf /etc/nginx/sites-available/terminal.conf /etc/nginx/sites-enabled/terminal.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 5) Use it

- Visit `https://<your-domain>/terminal`
- Click **Open terminal session**
- Enter SSH password for `root@67.227.250.215` when prompted in terminal

## Security notes

- `ttyd` is bound to `127.0.0.1` only; only NGINX can reach it.
- Access is protected by HTTPS + HTTP Basic auth (and optional IP allowlist).
- `--once` ensures one client per ttyd process, reducing session-sharing risk.
- You should strongly prefer SSH keys over password auth whenever possible.
