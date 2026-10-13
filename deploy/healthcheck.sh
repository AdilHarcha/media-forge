#!/usr/bin/env bash
# Contrôle de santé : API, conteneurs, file bloquée, échecs en rafale. Écrit une ligne dans ALERT_LOG seulement si le diagnostic change.
set -uo pipefail
STACK_DIR="${STACK_DIR:-/opt/stacks/media-forge}"
ALERT_LOG="${ALERT_LOG:-/var/log/position-alerts.log}"
STATE="${STATE_FILE:-/var/lib/media-forge-health.state}"
DC="docker compose -p media-forge -f $STACK_DIR/docker-compose.yml"
Q() { $DC exec -T postgres psql -U forge -d forge -tAc "$1" 2>/dev/null; }
problems=""

for s in api worker postgres garage; do
  $DC ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx "$s" || problems+="conteneur $s arrêté; "
done
curl -sf -m 5 http://127.0.0.1:${API_PORT:-3100}/health >/dev/null || problems+="API ne répond pas; "
stuck=$(Q "select count(*) from jobs where status='queued' and created_at < now() - interval '15 minutes'")
[ "${stuck:-0}" -gt 0 ] && problems+="$stuck job(s) en file depuis plus de 15 min; "
failed=$(Q "select count(*) from jobs where status='failed' and finished_at > now() - interval '1 hour'")
[ "${failed:-0}" -ge 5 ] && problems+="$failed échecs de jobs sur la dernière heure; "

if [ -n "$problems" ]; then
  [ "$(cat "$STATE" 2>/dev/null)" = "$problems" ] || echo "$(date -u +%FT%TZ) MEDIAFORGE : $problems" >> "$ALERT_LOG"
  echo "$problems" > "$STATE"; echo "ALERTE : $problems"; exit 1
fi
rm -f "$STATE"; echo "ok"
