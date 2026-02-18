#!/usr/bin/env bash
set -euo pipefail

# Sets up NGINX reverse-cache "CDN" for this project.
#
# Example:
#   sudo bash deploy/scripts/setup-cdn.sh \
#     --domain secondhandcell.com \
#     --www-domain www.secondhandcell.com \
#     --upstream 127.0.0.1:3000

DOMAIN="secondhandcell.com"
WWW_DOMAIN="www.secondhandcell.com"
UPSTREAM="127.0.0.1:3000"
SITE_NAME="secondhandcell-cdn"
LETSENCRYPT_DIR="/etc/letsencrypt/live"
REPO_ROOT="/workspace/shc33"
ENABLE_DEFAULT_SITE=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --domain <domain>              Primary domain (default: ${DOMAIN})
  --www-domain <domain>          WWW domain (default: ${WWW_DOMAIN})
  --upstream <host:port>         App upstream (default: ${UPSTREAM})
  --site-name <name>             NGINX site file base name (default: ${SITE_NAME})
  --letsencrypt-dir <path>       Cert base dir (default: ${LETSENCRYPT_DIR})
  --repo-root <path>             Repo root for template path (default: ${REPO_ROOT})
  --enable-default-site          Keep default nginx site enabled (disabled by default)
  -h, --help                     Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="$2"; shift 2 ;;
    --www-domain)
      WWW_DOMAIN="$2"; shift 2 ;;
    --upstream)
      UPSTREAM="$2"; shift 2 ;;
    --site-name)
      SITE_NAME="$2"; shift 2 ;;
    --letsencrypt-dir)
      LETSENCRYPT_DIR="$2"; shift 2 ;;
    --repo-root)
      REPO_ROOT="$2"; shift 2 ;;
    --enable-default-site)
      ENABLE_DEFAULT_SITE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (e.g., sudo bash $0 ...)" >&2
  exit 1
fi

command -v nginx >/dev/null 2>&1 || {
  echo "Installing nginx..."
  apt-get update
  apt-get install -y nginx
}

mkdir -p /var/cache/nginx/shc_static /var/cache/nginx/shc_feed
chown -R www-data:www-data /var/cache/nginx

PRIMARY_CERT_DIR="${LETSENCRYPT_DIR}/${DOMAIN}"
FULLCHAIN="${PRIMARY_CERT_DIR}/fullchain.pem"
PRIVKEY="${PRIMARY_CERT_DIR}/privkey.pem"

if [[ ! -f "${FULLCHAIN}" || ! -f "${PRIVKEY}" ]]; then
  cat >&2 <<ERR
TLS cert files not found:
  ${FULLCHAIN}
  ${PRIVKEY}
Generate certs first (e.g. certbot) or pass --letsencrypt-dir to the correct path.
ERR
  exit 1
fi

TEMPLATE_PATH="${REPO_ROOT}/deploy/nginx/cdn.conf"
if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Template not found: ${TEMPLATE_PATH}" >&2
  exit 1
fi

SITE_PATH="/etc/nginx/sites-available/${SITE_NAME}.conf"
ENABLED_PATH="/etc/nginx/sites-enabled/${SITE_NAME}.conf"

# Render from template by replacing upstream + server names + cert paths.
sed \
  -e "s/server_name secondhandcell.com www.secondhandcell.com;/server_name ${DOMAIN} ${WWW_DOMAIN};/" \
  -e "s#ssl_certificate     /etc/letsencrypt/live/secondhandcell.com/fullchain.pem;#ssl_certificate     ${FULLCHAIN};#" \
  -e "s#ssl_certificate_key /etc/letsencrypt/live/secondhandcell.com/privkey.pem;#ssl_certificate_key ${PRIVKEY};#" \
  -e "s/server 127.0.0.1:3000;/server ${UPSTREAM};/" \
  -e "s/server_name secondhandcell.com www.secondhandcell.com;/server_name ${DOMAIN} ${WWW_DOMAIN};/" \
  "${TEMPLATE_PATH}" > "${SITE_PATH}"

ln -sf "${SITE_PATH}" "${ENABLED_PATH}"

if [[ "${ENABLE_DEFAULT_SITE}" -eq 0 ]]; then
  rm -f /etc/nginx/sites-enabled/default || true
fi

nginx -t
systemctl reload nginx

cat <<DONE
CDN reverse-cache setup complete.

Site file:
  ${SITE_PATH}
Enabled link:
  ${ENABLED_PATH}

Quick checks:
  curl -I https://${DOMAIN}/sellcell/feed.xml | grep -i x-cache-status
  curl -I https://${DOMAIN}/assets/logo.webp | grep -iE 'x-cache-status|cache-control'
DONE
