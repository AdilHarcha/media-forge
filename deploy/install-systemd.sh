#!/usr/bin/env bash
# Installe (en root) l'export quotidien de la base (03:00 UTC) et le contrôle de santé (toutes les 5 min).
set -euo pipefail
cd "$(dirname "$0")"
SRC="$(pwd)"

install_unit() {   # nom, description, calendrier systemd
  local name="$1" desc="$2" when="$3"
  cat > "/etc/systemd/system/media-forge-$name.service" <<UNIT
[Unit]
Description=$desc
After=docker.service
[Service]
Type=oneshot
ExecStart=$SRC/$name.sh
Nice=10
UNIT
  cat > "/etc/systemd/system/media-forge-$name.timer" <<UNIT
[Unit]
Description=$desc
[Timer]
OnCalendar=$when
Persistent=true
[Install]
WantedBy=timers.target
UNIT
}

install_unit backup-db   "MediaForge - export quotidien de la base" "*-*-* 03:00:00"
install_unit healthcheck "MediaForge - contrôle de santé"           "*:0/5"
systemctl daemon-reload
systemctl enable --now media-forge-backup-db.timer media-forge-healthcheck.timer
systemctl list-timers --no-pager | grep media-forge
