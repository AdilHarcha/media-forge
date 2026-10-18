# MediaForge

Workflows souverains de conversion et compression d'images et de vidéos.
100 % auto-hébergé : **PostgreSQL** (état + file d'attente), **Garage** (stockage S3, Deuxfleurs), **FFmpeg** + **sharp/libvips** (traitement).
Aucune API cloud, aucune dépendance payante.

## Démarrer

```bash
./scripts/gen-env.sh   # génère .env avec des secrets aléatoires
docker compose up -d --build && ./scripts/init-storage.sh   # init-storage : layout + clé + bucket (idempotent)
```

L'API écoute sur `127.0.0.1:3100` ; l'interface web est servie sur `/`. Pour l'exposer, placer un reverse proxy TLS devant
(exemple nginx : upload en flux `proxy_request_buffering off`, `client_max_body_size`, limites de débit).

Variables utiles (`.env`) : `API_KEY` (+ `API_KEYS` : une clé par application, révocable seule ; `DL_SECRET` fixe la signature des liens) · `PUBLIC_URL` (URL publique, utilisée dans les webhooks) · `RETENTION_DAYS` (défaut 7, `0` = jamais)
· `MAX_UPLOAD_BYTES` (défaut 2 Go) · `GRAPH_PARALLEL` (branches d'un job en parallèle, défaut 2) · `WORKER_CONCURRENCY` (jobs simultanés par worker, défaut 1) · `FFMPEG_THREADS` (défaut 2) · `WORKER_CPUS` / `WORKER_MEM` (plafonds du conteneur worker, défaut 2 / 2g) · `ALLOW_PRIVATE_WEBHOOKS=1` (tests uniquement).

## Utilisation

```bash
# lancer un workflow sur un fichier (+ webhook optionnel)
curl -H "x-api-key: $API_KEY" -F file=@photo.jpg "http://127.0.0.1:3100/jobs?workflow=smart-web&webhook=https://mon-site.fr/hook"
# -> {"id":"...","status":"queued"}

# suivre / récupérer les résultats (une URL signée par sortie)
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3100/jobs/<id>

# créer / modifier un workflow
curl -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"name":"video-av1","definition":[{"type":"video.transcode","params":{"codec":"av1","crf":32}}]}' \
  http://127.0.0.1:3100/workflows
```

### Client en ligne de commande

```bash
FORGE_URL=https://forge.exemple.fr FORGE_KEY=… node cli/forge.mjs smart-web photos/*.jpg video.mp4 --out sortie --parallel 4
```

Envoie les fichiers, attend les jobs et télécharge toutes les sorties (sans dépendance, Node ≥ 20). Pratique en CI / à la publication d'un site.

### Lots (ZIP)

`POST /batches` → `{id}` ; envoyer chaque fichier avec `POST /jobs?workflow=…&batch=<id>` ; `GET /batches/:id` donne l'avancement et, une fois tout fini, `zip_url`
(ZIP en flux, noms d'origine conservés). L'interface web crée un lot automatiquement quand plusieurs fichiers sont choisis.

Routes : `GET /` (UI) · `GET|POST /workflows` · `DELETE /workflows/:name` · `POST /jobs` · `GET /jobs` · `GET /jobs/:id` · `POST /batches` · `GET /batches/:id` · `GET /steps` · `GET /dl/:id` et `GET /dlz/:id` (liens signés).

## Workflows par règles (v2)

Le format d'entrée est détecté par signature (pas par extension). La première règle qui correspond s'applique.
Chaque règle enchaîne : **redimensionner → convertir → compresser**, avec des objectifs. L'éditeur web génère ce JSON par formulaire.

```json
{"rules": [
  {"match": {"formats": ["png"]},  "resize": {"width": 1600},
   "convert": {"format": "webp"},
   "compress": {"quality": 85, "minQuality": 50, "minSsim": 0.97, "maxBytes": 250000}},
  {"match": {"formats": ["svg"]},  "compress": {"svgo": true}},
  {"match": {"kind": "video"},     "resize": {"maxHeight": 1080},
   "convert": {"codec": "h264"},   "compress": {"minSsim": 0.97},
   "extras": [{"name": "thumb", "type": "video.thumbnail", "params": {"at": 2}}]}
]}
```

| Clé | Rôle |
|---|---|
| `match.formats` / `match.kind` | png, jpeg, webp, avif, gif, svg, mp4, mov, webm · `image` / `video` (absent = règle par défaut) |
| `convert.format` / `convert.codec` | format image de sortie (webp, avif, jpeg, png) / codec vidéo (h264, av1, vp9). Absent = on garde le format |
| `compress.quality` | **qualité visée** (1-100) |
| `compress.minQuality` | **plancher de qualité** : jamais en dessous |
| `compress.minSsim` | **qualité mesurée** (image, 0-1) : cherche la qualité encodeur la plus basse dont le SSIM ≥ cible (ex. 0.97) |
| `compress.minSsim` (vidéo) | **qualité mesurée** : cherche le CRF le plus élevé qui respecte la cible, sur un échantillon de 12 s au milieu, puis encode tout |
| `compress.minVmaf` (vidéo) | idem en VMAF (0-100). Demande un FFmpeg compilé avec `libvmaf` : absent des paquets Debian, refusé avec un message clair par l'image par défaut |
| `compress.strict` | `true` = le job échoue si un objectif n'est pas atteint (défaut : succès + avertissement dans `logs`) |
| `compress.maxBytes` | **objectif de poids** : la qualité baisse par paliers de 5 jusqu'à l'atteindre (vidéo sans cible qualité : débit calculé depuis la durée) |
| `extras` | sorties **parallèles** tirées de la source (vignette vidéo, miniature image…) : `{name, type, params}` |

Convert + compress = **un seul encodage** (pas de double perte). Si `minSsim`/`minVmaf` et `maxBytes` entrent en conflit, **la qualité l'emporte**.

## Graphes (DAG)

Pour des chaînes ou des branches libres, une définition peut être un graphe (au niveau racine, ou dans une règle via `"graph"`) :

```json
{"graph": {"nodes": [
  {"id": "main",  "type": "image.convert", "params": {"format": "webp", "width": 1200, "quality": 80}, "output": true},
  {"id": "thumb", "from": "main", "type": "image.convert", "params": {"format": "webp", "width": 200}, "output": true}
]}}
```

`from` = `"input"` (défaut) ou l'`id` d'un autre nœud. Les nœuds sans dépendance entre eux s'exécutent en parallèle (`GRAPH_PARALLEL`).
Seuls les nœuds `"output": true` sont livrés ; **si aucun nœud n'est marqué, toutes les feuilles du graphe le sont**.
Le nom d'une sortie est l'`id` du nœud (`main` = sortie principale). Cycles, ids dupliqués et sources inconnues sont refusés à l'enregistrement.

Étapes disponibles : `image.convert` · `image.resize` · `svg.optimize` · `video.transcode` · `video.thumbnail`.

## Webhooks

`POST /jobs?webhook=https://…` : à la fin **définitive** du job (`done` ou `failed` après 3 tentatives), l'API envoie un POST JSON
`{id, status, error, outputs:[{name, mime, size, url}]}` avec l'en-tête `x-forge-signature: sha256=<HMAC>` (HMAC-SHA256 du corps, clé = `DL_SECRET` ou `API_KEY`).
3 essais (0 s, 2 s, 10 s). Les URLs de sortie sont valables 24 h. Les adresses privées/loopback/lien-local sont refusées (anti-SSRF), redirections non suivies.

## Rétention

Les fichiers (source + sorties) des jobs terminés depuis plus de `RETENTION_DAYS` jours sont supprimés du stockage (toutes les 10 min, par lots de 100).
La ligne du job reste (historique, logs). Un job `running` abandonné (worker disparu, tentatives épuisées) est clos en échec.

## Générer une image (source d'entrée)

Dans le bloc **Entrée**, à côté de « Mes fichiers », l'onglet **Générer une image** remplace le dépôt de fichiers : prompt, **pièces jointes de référence**
(jusqu'à 4 images PNG/JPEG/WebP de 10 Mo, pour guider le résultat : produit, croquis, personnage, style…), format, 1 à 4 images.
Les images produites passent ensuite dans la chaîne (redimensionner, convertir, compresser) comme n'importe quel fichier.

Deux modes de connexion :

**1. Abonnement ChatGPT (sans clé API) : pont local.** Un petit agent, `bridge/forge-bridge.mjs`, tourne sur *votre* ordinateur, connecté à votre abonnement par le CLI officiel.
Aucun jeton d'abonnement ne quitte votre machine ; le serveur ne tient que la file des demandes.

```bash
npm i -g @openai/codex && codex login          # « Sign in with ChatGPT »
curl -O https://<votre-instance>/bridge/forge-bridge.mjs
FORGE_KEY=<clé API MediaForge> node forge-bridge.mjs --url https://<votre-instance>
```

- Le pont interroge le serveur (connexion sortante, rien à ouvrir), télécharge les pièces jointes, exécute `codex exec` (outil de génération d'image, références passées avec `-i`) et renvoie les images.
- Il refuse de démarrer si Codex est connecté par clé API (la génération serait facturée) : seule la connexion ChatGPT est acceptée.
- Chaque image prend de 1 à 6 minutes et consomme le quota du forfait. Usage personnel : n'exposez pas votre pont à d'autres, voir les [conditions « Sign in with ChatGPT »](https://openai.com/policies/sign-in-with-chatgpt-terms/).
- `--mock` : fournisseur de test (dégradé PNG) pour vérifier l'installation sans abonnement.

**2. Clé API OpenAI : appel direct.** L'utilisateur saisit sa clé OpenAI dans l'interface (optionnellement mémorisée dans son navigateur) ; le serveur appelle l'API Images
(`/images/generations`, ou `/images/edits` quand des pièces jointes sont fournies). La clé est utilisée pour cet appel puis oubliée : ni stockée, ni journalisée, masquée dans les messages d'erreur.
Modèle par défaut `gpt-image-1` (champ « Modèle » pour en choisir un autre). Facturation à l'usage sur le compte OpenAI.
Un administrateur peut fournir une clé partagée à toute l'instance avec `OPENAI_API_KEY` (voir `.env.example`) : les utilisateurs n'ont alors plus rien à saisir, mais chaque détenteur d'une clé MediaForge dépense ce crédit.

- **Gemini** : non pris en charge, l'extension Nano Banana exige une clé API Google (pas de connexion par abonnement).
- API : `POST /generations` (JSON ou multipart avec fichiers `ref`), `GET /generations/:id`, `GET /bridge/status` ; côté pont `/bridge/claim`, `/bridge/:id/results`, `/bridge/:id/fail`.
- Les images (résultats et références) sont purgées après `RETENTION_DAYS` jours.

## Architecture

- La file est la table `jobs` ; les workers réservent avec `FOR UPDATE SKIP LOCKED` et sont réveillés par `LISTEN/NOTIFY`.
- Un job abandonné (worker crashé) est repris après 15 min ; 3 tentatives max.
- Le schéma évolue par migrations (`db/migrations/*.sql`), appliquées automatiquement au démarrage sous verrou.
- Scalabilité : lancer d'autres workers (même image, `node src/worker.js`) sur d'autres machines, pointant sur le même Postgres + Garage.

## Exploitation

`deploy/` contient de quoi exploiter un serveur : `install-systemd.sh` (root) installe un export quotidien de la base `deploy/backup-db.sh`
(7 fichiers tournants dans `backups/`, à inclure dans votre sauvegarde ; les médias ne sont pas sauvegardés : régénérables et purgés)
et un contrôle de santé `deploy/healthcheck.sh` toutes les 5 min (conteneurs, API, file bloquée > 15 min, rafale d'échecs ; écrit dans `ALERT_LOG`, uniquement quand le diagnostic change).

## Performances mesurées

Serveur partagé 8 cœurs (AMD EPYC), worker plafonné à 2 CPU / 2 Go, un seul job à la fois :

| Cas | Durée | Mémoire (pic) |
|---|---|---|
| JPEG 48 Mpx → WebP (SSIM ≥ 0,97) | 3 s | 250 Mo |
| PNG 24 Mpx → WebP | 6 s | 325 Mo |
| 30 images 1600×1200 | 58 s (≈ 1,9 s/image) | 320 Mo |
| Vidéo 4K 30 s → H.264 1080p (SSIM ≥ 0,97) | 174 s | ≈ 1 Go |

La vidéo est limitée par le CPU : la recherche de qualité encode 5 échantillons de 12 s (preset rapide, résultat conservateur) avant l'encodage final.
`FFMPEG_THREADS` borne les threads de FFmpeg, qui voit sinon tous les cœurs de l'hôte et non le quota du conteneur (mémoire ≈ 1,6 Go → 1 Go sur le test 4K).
Pour aller plus vite : plus de CPU (`WORKER_CPUS`), plusieurs workers, ou un worker sur une machine dédiée.

## Limites connues

- **Accélération matérielle (NVENC / QSV / VAAPI)** : non implémentée. Elle n'a pas pu être testée (serveur de référence sans GPU).
  Piste : un worker dédié sur une machine GPU, avec un FFmpeg adapté, branché sur le même Postgres + Garage.
- **VMAF** : nécessite un FFmpeg avec `libvmaf` (SSIM utilisé par défaut).
- **Éditeur visuel** : formulaire de règles (pas de canevas à nœuds) ; les graphes s'éditent en JSON.

## Licence

AGPL-3.0-or-later.
