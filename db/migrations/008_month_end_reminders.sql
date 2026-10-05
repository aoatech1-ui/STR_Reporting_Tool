-- Scheduled month-end reminders to the management team (never to owners). They only report; nothing is finalized or sent automatically.
CREATE TABLE reminder_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled    boolean NOT NULL DEFAULT false,
  timezone   text NOT NULL DEFAULT 'UTC',
  send_hour  int NOT NULL DEFAULT 9 CHECK (send_hour BETWEEN 0 AND 23),
  -- 1..28 = day of the following month; -1..-10 = days before the month ends (-1 = last day)
  days       int[] NOT NULL DEFAULT '{-2,1,5}' CHECK (cardinality(days) <= 6 AND 0 <> ALL(days) AND -10 <= ALL(days) AND 28 >= ALL(days)),
  due_day    int CHECK (due_day BETWEEN 1 AND 28) DEFAULT 10,
  roles      text[] NOT NULL DEFAULT '{ADMIN,MANAGER}' CHECK (roles <@ ARRAY['ADMIN','MANAGER','ACCOUNTANT','VIEWER']),
  -- reminders scheduled before this moment are never sent (no back-filling after enabling or changing the schedule)
  effective_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

-- Per-person opt-out.
ALTER TABLE users ADD COLUMN month_end_reminders boolean NOT NULL DEFAULT true;

CREATE TABLE reminder_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  year int NOT NULL, month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  offset_days int NOT NULL,
  scheduled_for timestamptz NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  requested_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','SKIPPED','FAILED','MISSED')),
  reason text,
  sent_to text[] NOT NULL DEFAULT '{}',   -- grows as each recipient succeeds, so a retry never emails anyone twice
  subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- One scheduled reminder per org/month/offset, however many workers are running.
CREATE UNIQUE INDEX reminder_runs_once ON reminder_runs (organization_id, year, month, offset_days) WHERE NOT is_test;
CREATE INDEX ON reminder_runs (organization_id, created_at DESC);
