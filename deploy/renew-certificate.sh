#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
sh "$repo_dir/deploy/certbot.sh" renew --quiet --cert-name scenarioforge
docker compose exec -T proxy nginx -t </dev/null
docker compose exec -T proxy nginx -s reload </dev/null
