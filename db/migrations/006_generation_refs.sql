-- images de référence jointes à une génération (guident le résultat) + modèle demandé (mode clé API)
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS refs  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS model text;
