-- Credentials + lockout. Hash format: scrypt$N$r$p$salt$hash (parameters travel with the hash).
ALTER TABLE users
  ADD COLUMN password_hash text, ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz, ADD COLUMN password_changed_at timestamptz;

-- Server-side sessions. Only a SHA-256 of the cookie token is stored, so a DB leak does not leak live sessions.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  ip inet, user_agent text
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

-- Postgres-backed job queue (FOR UPDATE SKIP LOCKED). At-least-once; handlers must be idempotent.
CREATE TYPE job_status AS ENUM ('QUEUED','RUNNING','DONE','FAILED');
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  status job_status NOT NULL DEFAULT 'QUEUED',
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 6,
  run_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, locked_by text,
  last_error text, dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_ready ON jobs (run_at) WHERE status = 'QUEUED';
CREATE INDEX jobs_running ON jobs (locked_at) WHERE status = 'RUNNING';

-- Deliveries are the outbox: a QUEUED row is written in the same transaction as the job that will send it.
ALTER TABLE statement_deliveries
  ADD COLUMN organization_id uuid REFERENCES organizations(id), ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN requested_by uuid REFERENCES users(id);
UPDATE statement_deliveries d SET organization_id = s.organization_id FROM owner_statements s WHERE s.id = d.statement_id;
ALTER TABLE statement_deliveries ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX ON statement_deliveries (organization_id, status);
