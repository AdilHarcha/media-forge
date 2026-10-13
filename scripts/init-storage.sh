#!/usr/bin/env bash
# Initialise Garage (layout, clé d'accès, bucket). Idempotent : peut être relancé sans risque.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
DC="${DOCKER:-docker} compose -p media-forge"
G="$DC exec -T garage /garage"

until $G status >/dev/null 2>&1; do sleep 1; done

NODE=$($G node id -q | cut -d@ -f1)
if ! $G layout show 2>/dev/null | grep -q "$(echo "$NODE" | cut -c1-8)"; then
  $G layout assign -z dc1 -c "${GARAGE_CAPACITY:-50G}" "$NODE"
  $G layout apply --version 1
fi
$G key import --yes -n forge "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1 || true
$G bucket create "${S3_BUCKET:-media}" >/dev/null 2>&1 || true
$G bucket allow --read --write --owner "${S3_BUCKET:-media}" --key forge
echo "stockage prêt (bucket ${S3_BUCKET:-media})"
