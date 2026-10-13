# MediaForge

Workflows souverains de conversion et compression d'images et de vidéos.
100 % auto-hébergé : **PostgreSQL** (état + file d'attente), **MinIO** (stockage S3), **FFmpeg** + **sharp/libvips** (traitement).

## Démarrer

```bash
cp .env.example .env   # puis changer les secrets
docker compose up -d --build
```

## Utilisation

```bash
# lancer un workflow sur un fichier
curl -H "x-api-key: $API_KEY" -F file=@photo.jpg "http://127.0.0.1:3100/jobs?workflow=image-web"
# -> {"id":"...","status":"queued"}

# suivre / récupérer le résultat (download_url présigné)
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3100/jobs/<id>

# créer son propre workflow
curl -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"name":"video-av1","definition":[{"type":"video.transcode","params":{"codec":"av1","crf":32}}]}' \
  http://127.0.0.1:3100/workflows
```

## Étapes disponibles

`image.resize` · `image.convert` (webp, avif, jpeg, png) · `video.transcode` (h264, av1, vp9) · `video.thumbnail`

## Architecture

- La file est la table `jobs` ; les workers réservent avec `FOR UPDATE SKIP LOCKED` et sont réveillés par `LISTEN/NOTIFY`.
- Un job abandonné (worker crashé) est repris après 15 min ; 3 tentatives max.
- Scalabilité : lancer d'autres workers (même image, `node src/worker.js`) sur d'autres machines, pointant sur le même Postgres + MinIO.

## Roadmap

1. Workflows en DAG (branches parallèles, ex. vidéo + vignette) au lieu de la liste linéaire
2. Éditeur visuel (React Flow) qui produit la même définition JSON
3. Accélération matérielle (NVENC/QSV), presets par qualité cible
4. Webhooks de fin de job, purge automatique des fichiers (rétention)
