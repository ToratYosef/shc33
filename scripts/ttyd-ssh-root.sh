#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="root@67.227.250.215"

exec /usr/bin/ssh \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/var/lib/ttyd/.ssh/known_hosts \
  "$SSH_TARGET"
