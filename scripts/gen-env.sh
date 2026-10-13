#!/usr/bin/env bash
# Génère un .env avec des secrets aléatoires (n'écrase jamais un .env existant).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env existe déjà, rien fait"; exit 0; }
umask 077
printf 'POSTGRES_PASSWORD=%s\nAPI_KEY=%s\nS3_ACCESS_KEY=GK%s\nS3_SECRET_KEY=%s\nGARAGE_RPC_SECRET=%s\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 12)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
echo ".env généré"
