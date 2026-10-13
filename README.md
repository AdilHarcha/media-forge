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
curl -H "x-api-key: $API_KEY" -F file=@photo.jpg "http://127.0.0.1:3100/jobs?workflow=smart-web"
# -> {"id":"...","status":"queued"}

# suivre / récupérer le résultat (download_url présigné)
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3100/jobs/<id>

# créer son propre workflow
curl -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"name":"video-av1","definition":[{"type":"video.transcode","params":{"codec":"av1","crf":32}}]}' \
  http://127.0.0.1:3100/workflows
```

## Workflows par règles (v2)

Le format d'entrée est détecté par signature (pas par extension). La première règle qui correspond s'applique.
Chaque règle enchaîne : **redimensionner → convertir → compresser**, avec des objectifs.

```json
{"rules": [
  {"match": {"formats": ["png"]},  "resize": {"width": 1600},
   "convert": {"format": "webp"},
   "compress": {"quality": 82, "minQuality": 60, "maxBytes": 250000}},
  {"match": {"formats": ["svg"]},  "compress": {"svgo": true}},
  {"match": {"kind": "video"},     "resize": {"maxHeight": 1080},
   "convert": {"codec": "h264"},   "compress": {"crf": 26}}
]}
```

| Clé | Rôle |
|---|---|
| `match.formats` / `match.kind` | png, jpeg, webp, avif, gif, svg, mp4, mov, webm · `image` / `video` (absent = règle par défaut) |
| `convert.format` / `convert.codec` | format image de sortie (webp, avif, jpeg, png) / codec vidéo (h264, av1, vp9). Absent = on garde le format |
| `compress.quality` | **qualité visée** (1-100) |
| `compress.minQuality` | **plancher de qualité** : jamais en dessous |
| `compress.maxBytes` | **objectif de poids** : la qualité baisse par paliers de 5 jusqu'à l'atteindre (vidéo : débit calculé depuis la durée) |

Convert + compress = **un seul encodage** (pas de double perte). Si l'objectif de poids est inatteignable au plancher
de qualité, le job réussit quand même avec le meilleur résultat et un avertissement dans `logs`.
Une définition v1 (simple liste `[{type, params}]`) reste acceptée.

## Architecture

- La file est la table `jobs` ; les workers réservent avec `FOR UPDATE SKIP LOCKED` et sont réveillés par `LISTEN/NOTIFY`.
- Un job abandonné (worker crashé) est repris après 15 min ; 3 tentatives max.
- Scalabilité : lancer d'autres workers (même image, `node src/worker.js`) sur d'autres machines, pointant sur le même Postgres + MinIO.

## Roadmap

1. Objectif de qualité perceptuelle (SSIM/VMAF) en plus du plancher `minQuality`
2. Workflows en DAG (branches parallèles, ex. vidéo + vignette) au lieu de la liste linéaire
3. Éditeur visuel (React Flow) qui produit la même définition JSON
4. Accélération matérielle (NVENC/QSV), presets par qualité cible
5. Webhooks de fin de job, purge automatique des fichiers (rétention)
