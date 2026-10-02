-- Liveness of background workers. The most common production failure is "statements queued but no worker running";
-- the Integrations screen and the preflight check read this table to say so plainly.
CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
