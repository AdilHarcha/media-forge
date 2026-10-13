#!/usr/bin/env bash
# Export quotidien de la base MediaForge (workflows, historique des jobs) → STACK_DIR/backups/forge-<jour>.dump
# 7 fichiers tournants. Les fichiers médias NE sont PAS sauvegardés : ils sont régénérables et purgés après RETENTION_DAYS.
# Le dossier backups/ est dans l'arbre /opt/stacks, donc repris par la sauvegarde restic existante.
set -euo pipefail
STACK_DIR="${STACK_DIR:-/opt/stacks/media-forge}"
mkdir -p "$STACK_DIR/backups"; chmod 700 "$STACK_DIR/backups"
OUT="$STACK_DIR/backups/forge-$(date +%u).dump"
docker compose -p media-forge -f "$STACK_DIR/docker-compose.yml" exec -T postgres pg_dump -U forge -d forge -Fc -Z 6 > "$OUT.tmp"
[ -s "$OUT.tmp" ] || { echo "export vide, abandon" >&2; rm -f "$OUT.tmp"; exit 1; }
mv "$OUT.tmp" "$OUT"
echo "export OK $(date -u +%FT%TZ) $(stat -c %s "$OUT") octets"
