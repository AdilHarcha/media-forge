# MediaForge

Workflows souverains de conversion et compression d'images et de vidéos.
100 % auto-hébergé : **PostgreSQL** (état + file d'attente), **Garage** (stockage S3, Deuxfleurs), **FFmpeg** + **sharp/libvips** (traitement).

## Démarrer

```bash
./scripts/gen-env.sh   # génère .env avec des secrets aléatoires
docker compose up -d --build && ./scripts/init-storage.sh   # init-storage : layout + clé + bucket (idempotent)
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
| `compress.minSsim` | **qualité mesurée** (image, 0-1) : cherche la qualité encodeur la plus basse dont le SSIM ≥ cible (ex. 0.97) |
| `compress.minVmaf` / `minSsim` | **qualité mesurée** (vidéo) : cherche le CRF le plus élevé qui respecte la cible, sur un échantillon de 12 s, puis encode tout |
| `compress.strict` | `true` = le job échoue si un objectif n'est pas atteint (défaut : succès + avertissement dans `logs`) |
| `compress.maxBytes` | **objectif de poids** : la qualité baisse par paliers de 5 jusqu'à l'atteindre (vidéo : débit calculé depuis la durée) |

Convert + compress = **un seul encodage** (pas de double perte). Si `minSsim`/`minVmaf` et `maxBytes` entrent en conflit, **la qualité l'emporte**. Un objectif inatteignable
garde le meilleur résultat avec un avertissement dans `logs` (ou échoue avec `strict: true`).
Une interface web est servie sur `/` (upload multiple, suivi des jobs, éditeur de workflows).
Une définition v1 (simple liste `[{type, params}]`) reste acceptée.

## Architecture

- La file est la table `jobs` ; les workers réservent avec `FOR UPDATE SKIP LOCKED` et sont réveillés par `LISTEN/NOTIFY`.
- Un job abandonné (worker crashé) est repris après 15 min ; 3 tentatives max.
- Scalabilité : lancer d'autres workers (même image, `node src/worker.js`) sur d'autres machines, pointant sur le même Postgres + Garage.

## Roadmap

1. Workflows en DAG (branches parallèles, ex. vidéo + vignette) au lieu de la liste linéaire
2. Éditeur visuel (React Flow) qui produit la même définition JSON
3. Accélération matérielle (NVENC/QSV), presets par qualité cible
4. Webhooks de fin de job, purge automatique des fichiers (rétention)
