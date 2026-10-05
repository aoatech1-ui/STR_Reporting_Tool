-- Recurring expenses: a template posts an ordinary expense once per occurrence. Postings are recorded one row per
-- template and month (unique), so an occurrence is posted at most once however often or wherever posting runs.
CREATE TABLE recurring_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  category_id uuid NOT NULL REFERENCES expense_categories(id),
  vendor text NOT NULL CHECK (btrim(vendor) <> ''), description text,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0), tax_cents bigint NOT NULL DEFAULT 0,
  owner_paid boolean NOT NULL DEFAULT false, reimbursable boolean NOT NULL DEFAULT false,
  payment_method text, notes text,
  interval_months int NOT NULL CHECK (interval_months IN (1,2,3,6,12)),
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_month date NOT NULL CHECK (extract(day FROM start_month) = 1),
  end_month date CHECK (end_month IS NULL OR (extract(day FROM end_month) = 1 AND end_month >= start_month)),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recurring_expenses (organization_id, active);

CREATE TABLE recurring_expense_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  recurring_expense_id uuid NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  year int NOT NULL, month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL CHECK (status IN ('POSTED','SKIPPED')),
  -- NULL after the posted expense was deleted: deleting it is how a single month is dropped, and it is not re-posted
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  reason text,
  posted_by uuid REFERENCES users(id),          -- NULL = posted automatically by the worker
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recurring_expense_id, year, month)
);

ALTER TABLE expenses ADD COLUMN recurring_expense_id uuid REFERENCES recurring_expenses(id);
