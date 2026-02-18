# Server-side CDN setup (NGINX reverse cache)

Yes — you can run a CDN-like cache directly on the server using NGINX.

This repo now includes a template:

- `deploy/nginx/cdn.conf`

## What this does

- Caches static assets (`css/js/images/fonts`) for 30 days.
- Caches `/sellcell/feed.xml` for 15 minutes.
- Bypasses cache for dynamic traffic by default.
- Adds `X-Cache-Status` response header so you can verify `MISS/HIT/BYPASS`.

## One-command setup script

You can run the included script to configure everything automatically:

```bash
sudo bash /workspace/shc33/deploy/scripts/setup-cdn.sh \
  --domain secondhandcell.com \
  --www-domain www.secondhandcell.com \
  --upstream 127.0.0.1:3000
```

The script will:
- install NGINX if missing,
- create cache directories,
- render and enable site config from `deploy/nginx/cdn.conf`,
- validate config (`nginx -t`) and reload NGINX.

## Install

```bash
sudo apt-get update
sudo apt-get install -y nginx

sudo mkdir -p /var/cache/nginx/shc_static /var/cache/nginx/shc_feed
sudo chown -R www-data:www-data /var/cache/nginx

sudo cp /workspace/shc33/deploy/nginx/cdn.conf /etc/nginx/sites-available/secondhandcell-cdn.conf
sudo ln -sf /etc/nginx/sites-available/secondhandcell-cdn.conf /etc/nginx/sites-enabled/secondhandcell-cdn.conf

# Disable old/default site if needed
# sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl reload nginx
```

## Verify cache behavior

```bash
# First request should usually MISS
curl -I https://secondhandcell.com/sellcell/feed.xml | grep -i x-cache-status

# Second request should usually HIT
curl -I https://secondhandcell.com/sellcell/feed.xml | grep -i x-cache-status

# Static asset test (replace with real asset path)
curl -I https://secondhandcell.com/assets/logo.webp | grep -iE 'x-cache-status|cache-control'
```

## Optional: pair with Cloudflare

You can place Cloudflare in front as the global edge CDN and keep this NGINX cache as an origin shield.

Recommended pattern:

1. Keep NGINX caching enabled (this file).
2. Enable Cloudflare proxy for DNS records.
3. Create Cloudflare cache rules for:
   - `/assets/*` (long TTL)
   - `/sellcell/feed.xml` (short TTL, e.g., 5–15m)
4. Purge Cloudflare + NGINX cache together when force-refresh is needed.

## Purge local NGINX cache

```bash
sudo rm -rf /var/cache/nginx/shc_static/* /var/cache/nginx/shc_feed/*
sudo systemctl reload nginx
```
