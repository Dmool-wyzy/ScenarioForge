#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin="$repo_dir/deploy/private/runtime/node/bin"
test -x "$node_bin/node"
test -x "$repo_dir/mcp-server/.venv/bin/python"
test -f "$repo_dir/deploy/private/.env.local"
test -f "$repo_dir/.next/BUILD_ID"

if [ -e "$repo_dir/.env.local" ] || [ -L "$repo_dir/.env.local" ]; then
  if [ "$(readlink -f "$repo_dir/.env.local")" != "$repo_dir/deploy/private/.env.local" ]; then
    printf 'Root .env.local already exists and is not the private configuration symlink.\n' >&2
    exit 1
  fi
else
  ln -s deploy/private/.env.local "$repo_dir/.env.local"
fi

cat > /etc/systemd/system/scenarioforge-mcp.service <<UNIT
[Unit]
Description=ScenarioForge Python MCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$repo_dir/mcp-server
EnvironmentFile=$repo_dir/deploy/private/.env.local
Environment=NODE_ENV=production
Environment=PYTHONUNBUFFERED=1
Environment="PATH=$node_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart="$repo_dir/mcp-server/.venv/bin/python" "$repo_dir/mcp-server/main.py"
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/scenarioforge-web.service <<UNIT
[Unit]
Description=ScenarioForge Next.js production service
After=network-online.target mysql-isolated.service scenarioforge-mcp.service
Wants=network-online.target scenarioforge-mcp.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/deploy/private/.env.local
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment="PATH=$node_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart="$node_bin/node" "$repo_dir/node_modules/next/dist/bin/next" start --hostname 127.0.0.1
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemd-analyze verify /etc/systemd/system/scenarioforge-mcp.service /etc/systemd/system/scenarioforge-web.service
systemctl daemon-reload
systemctl enable --now scenarioforge-mcp.service scenarioforge-web.service
systemctl --no-pager --full status scenarioforge-mcp.service scenarioforge-web.service
