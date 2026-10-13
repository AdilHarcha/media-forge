-- sorties multiples (DAG), webhooks de fin de job, rétention
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS webhook_url    text,
  ADD COLUMN IF NOT EXISTS webhook_status text,
  ADD COLUMN IF NOT EXISTS purged_at      timestamptz;

CREATE TABLE IF NOT EXISTS job_outputs (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name    text NOT NULL,
  key     text NOT NULL,
  mime    text,
  size    bigint,
  UNIQUE (job_id, name)
);

CREATE INDEX IF NOT EXISTS jobs_retention_idx ON jobs (finished_at) WHERE purged_at IS NULL AND finished_at IS NOT NULL;
