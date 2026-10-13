-- MediaForge : PostgreSQL = état des workflows + file d'attente (SKIP LOCKED)

CREATE TABLE IF NOT EXISTS workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  -- v1 : liste d'étapes [{type,params}]   |   v2 : {"rules":[{match,resize,convert,compress}]} (voir src/pipeline.js)
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES workflows(id),
  status        job_status NOT NULL DEFAULT 'queued',
  input_key     text NOT NULL,            -- clé S3 du fichier source
  output_key    text,                     -- clé S3 du résultat final
  step_index    int  NOT NULL DEFAULT 0,  -- reprise après crash
  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL DEFAULT 3,
  locked_at     timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS job_logs (
  id        bigserial PRIMARY KEY,
  job_id    uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step      int,
  message   text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);

-- réveille les workers instantanément à chaque nouveau job
CREATE OR REPLACE FUNCTION notify_new_job() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('new_job', NEW.id::text); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_notify ON jobs;
CREATE TRIGGER jobs_notify AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_new_job();
