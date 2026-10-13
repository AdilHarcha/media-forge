-- traitement par lot : plusieurs fichiers, un seul ZIP de résultats ; nom d'origine conservé pour nommer les sorties
CREATE TABLE IF NOT EXISTS batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS batch_id   uuid REFERENCES batches(id),
  ADD COLUMN IF NOT EXISTS input_name text;
CREATE INDEX IF NOT EXISTS jobs_batch_idx ON jobs (batch_id) WHERE batch_id IS NOT NULL;
