#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
private_dir="$repo_dir/deploy/private"
umask 077
mkdir -p "$private_dir/letsencrypt" "$private_dir/acme" "$private_dir/certbot-work" "$private_dir/certbot-logs"
chmod 700 "$private_dir" "$private_dir/letsencrypt" "$private_dir/certbot-work" "$private_dir/certbot-logs"
chmod 755 "$private_dir/acme"

exec "$private_dir/certbot-venv/bin/certbot" \
  --config-dir "$private_dir/letsencrypt" \
  --work-dir "$private_dir/certbot-work" \
  --logs-dir "$private_dir/certbot-logs" "$@"
