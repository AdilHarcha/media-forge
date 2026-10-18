-- génération d'images par un « pont » local : l'abonnement de l'utilisateur (ChatGPT via Codex CLI) reste sur SA machine,
-- le serveur ne stocke que la file de demandes et les images produites. Aucune clé API, aucun jeton de session côté serveur.
CREATE TABLE IF NOT EXISTS generations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  prompt      text NOT NULL,
  count       int  NOT NULL DEFAULT 1 CHECK (count BETWEEN 1 AND 4),
  aspect      text NOT NULL DEFAULT '1:1',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  error       text,
  keys        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  finished_at timestamptz,
  purged_at   timestamptz
);
CREATE INDEX IF NOT EXISTS generations_queue_idx ON generations (created_at) WHERE status IN ('queued','running');

-- ponts vus récemment (pour dire à l'interface si une génération a une chance d'aboutir)
CREATE TABLE IF NOT EXISTS bridges (
  name      text PRIMARY KEY,
  providers text[] NOT NULL,
  seen_at   timestamptz NOT NULL DEFAULT now()
);
