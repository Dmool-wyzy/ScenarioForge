#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test -f "$repo_dir/deploy/private/letsencrypt/live/scenarioforge/fullchain.pem"

cat > /etc/systemd/system/scenarioforge-cert-renew.service <<UNIT
[Unit]
Description=Renew ScenarioForge HTTPS certificate and reload nginx
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$repo_dir
ExecStart=/bin/sh "$repo_dir/deploy/renew-certificate.sh"
UNIT

cat > /etc/systemd/system/scenarioforge-cert-renew.timer <<'UNIT'
[Unit]
Description=Check ScenarioForge short-lived certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemd-analyze verify /etc/systemd/system/scenarioforge-cert-renew.service /etc/systemd/system/scenarioforge-cert-renew.timer
systemctl daemon-reload
systemctl enable --now scenarioforge-cert-renew.timer
systemctl list-timers scenarioforge-cert-renew.timer --no-pager
