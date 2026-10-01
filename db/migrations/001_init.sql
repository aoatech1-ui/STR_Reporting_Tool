-- STR Owner Accounting – PostgreSQL schema (MVP core + hooks for Phase 2).
-- Money is stored as integer cents. UUID primary keys. All FKs enforced.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role        AS ENUM ('ADMIN','MANAGER','ACCOUNTANT','VIEWER');
CREATE TYPE period_status    AS ENUM ('DRAFT','REVIEW','FINALIZED','LOCKED');
CREATE TYPE commission_type  AS ENUM ('PERCENT_GROSS','PERCENT_NET','FIXED','HYBRID');
CREATE TYPE revenue_source   AS ENUM ('AIRBNB_CSV_IMPORT','AIRBNB_API','PMS_API','OTHER_CHANNEL');
CREATE TYPE earnings_kind    AS ENUM ('RESERVATION','ADJUSTMENT','REFUND','CO_HOST_PAYOUT','TAX_PASS_THROUGH');
CREATE TYPE import_status    AS ENUM ('PREVIEW','COMMITTED','FAILED');
CREATE TYPE statement_status AS ENUM ('DRAFT','REVIEW','FINALIZED','LOCKED');
CREATE TYPE delivery_channel AS ENUM ('EMAIL','WHATSAPP');
CREATE TYPE delivery_status  AS ENUM ('QUEUED','SENT','DELIVERED','BOUNCED','FAILED');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL, display_name text NOT NULL,
  address text, email text, phone text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, email text NOT NULL UNIQUE,
  auth_provider_id text,                    -- managed auth; no raw passwords stored here
  role user_role NOT NULL DEFAULT 'VIEWER', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_name text NOT NULL, display_name text NOT NULL,
  email text, secondary_email text, email_enabled boolean NOT NULL DEFAULT true,
  phone text, whatsapp_phone text, whatsapp_enabled boolean NOT NULL DEFAULT false,
  whatsapp_opt_in boolean NOT NULL DEFAULT false, whatsapp_opt_in_at timestamptz,
  mailing_address text, tax_reporting_name text,
  tax_id_status text CHECK (tax_id_status IN ('NOT_COLLECTED','ON_FILE_EXTERNALLY','REQUESTED')) DEFAULT 'NOT_COLLECTED', -- never the raw TIN
  active boolean NOT NULL DEFAULT true, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, address text, city text, state text, zip text,
  airbnb_listing_id text, airbnb_listing_name text,
  management_start_date date, management_end_date date,
  active boolean NOT NULL DEFAULT true, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, airbnb_listing_id)
);
-- Junction from day one: MVP enforces one primary owner (100%); Phase 2 lifts that.
CREATE TABLE property_owners (
  property_id uuid NOT NULL REFERENCES properties(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  ownership_bps int NOT NULL DEFAULT 10000 CHECK (ownership_bps BETWEEN 1 AND 10000),
  is_primary boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT '1970-01-01',
  PRIMARY KEY (property_id, owner_id, effective_from)
);
CREATE UNIQUE INDEX one_primary_owner_per_property ON property_owners(property_id) WHERE is_primary;

CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  commission_type commission_type NOT NULL,
  rate_bps int NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 10000),
  fixed_cents bigint NOT NULL DEFAULT 0 CHECK (fixed_cents >= 0),
  hybrid_basis text NOT NULL DEFAULT 'NET' CHECK (hybrid_basis IN ('GROSS','NET')),
  include_cleaning_fees boolean NOT NULL DEFAULT true, exclude_taxes boolean NOT NULL DEFAULT false,
  repair_approval_threshold_cents bigint,
  effective_from date NOT NULL, effective_to date, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- rules for one property may not overlap in time (needs btree_gist)
  EXCLUDE USING gist (property_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (active)
);

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  year int NOT NULL, month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  start_date date NOT NULL, end_date date NOT NULL,
  status period_status NOT NULL DEFAULT 'DRAFT',
  finalized_at timestamptz, finalized_by uuid REFERENCES users(id),
  UNIQUE (organization_id, year, month)
);

CREATE TABLE revenue_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind revenue_source NOT NULL, label text NOT NULL, config jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source revenue_source NOT NULL, filename text, file_sha256 text,
  imported_by uuid NOT NULL REFERENCES users(id), imported_at timestamptz NOT NULL DEFAULT now(),
  record_count int NOT NULL DEFAULT 0, successful_count int NOT NULL DEFAULT 0, failed_count int NOT NULL DEFAULT 0,
  status import_status NOT NULL DEFAULT 'COMMITTED'
);

CREATE TABLE earnings_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  source revenue_source NOT NULL, source_transaction_id text NOT NULL,
  idempotency_key text NOT NULL,
  kind earnings_kind NOT NULL, reservation_id text, source_row int,
  check_in date, check_out date, earnings_date date NOT NULL, payout_date date,
  gross_booking_cents bigint NOT NULL DEFAULT 0, cleaning_fee_cents bigint NOT NULL DEFAULT 0,
  other_revenue_cents bigint NOT NULL DEFAULT 0, platform_fee_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0, adjustment_cents bigint NOT NULL DEFAULT 0, refund_cents bigint NOT NULL DEFAULT 0,
  co_host_payout_cents bigint NOT NULL DEFAULT 0,
  net_payout_cents bigint NOT NULL,           -- authoritative; NOT derived from booking total
  currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)   -- prevents duplicate financial imports
);
CREATE INDEX ON earnings_transactions (property_id, earnings_date);
CREATE INDEX ON earnings_transactions (source_transaction_id);
CREATE INDEX ON earnings_transactions (import_batch_id);

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE (organization_id, name)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NOT NULL, filename text NOT NULL, content_type text, size_bytes bigint, sha256 text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL REFERENCES properties(id), owner_id uuid NOT NULL REFERENCES owners(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  category_id uuid NOT NULL REFERENCES expense_categories(id),
  expense_date date NOT NULL, vendor text NOT NULL, description text,
  amount_cents bigint NOT NULL, tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint GENERATED ALWAYS AS (amount_cents + tax_cents) STORED,
  payment_method text, receipt_attachment_id uuid REFERENCES attachments(id),
  reimbursable boolean NOT NULL DEFAULT false, manager_paid boolean NOT NULL DEFAULT true, owner_paid boolean NOT NULL DEFAULT false,
  recurring boolean NOT NULL DEFAULT false, notes text,
  reverses_expense_id uuid REFERENCES expenses(id),   -- corrections in closed periods are reversal rows
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (manager_paid AND owner_paid))
);
CREATE INDEX ON expenses (property_id, expense_date);
CREATE INDEX ON expenses (owner_id);
CREATE INDEX ON expenses (accounting_period_id);

CREATE TABLE owner_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  owner_id uuid NOT NULL REFERENCES owners(id), property_id uuid NOT NULL REFERENCES properties(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  statement_number text NOT NULL UNIQUE,
  gross_cents bigint NOT NULL, platform_fees_cents bigint NOT NULL, net_revenue_cents bigint NOT NULL,
  expenses_cents bigint NOT NULL, commission_cents bigint NOT NULL, adjustments_cents bigint NOT NULL DEFAULT 0,
  owner_proceeds_cents bigint NOT NULL,
  derivation jsonb NOT NULL,                  -- step-by-step explanation shown to the manager
  status statement_status NOT NULL DEFAULT 'DRAFT',
  pdf_attachment_id uuid REFERENCES attachments(id), csv_attachment_id uuid REFERENCES attachments(id),
  generated_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz,
  supersedes_statement_id uuid REFERENCES owner_statements(id),
  UNIQUE (property_id, accounting_period_id, supersedes_statement_id)
);
CREATE INDEX ON owner_statements (owner_id);
CREATE INDEX ON owner_statements (accounting_period_id);

-- Commission calc stores a full rule snapshot so later rule edits never alter history.
CREATE TABLE commission_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES owner_statements(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  commission_rule_id uuid NOT NULL REFERENCES commission_rules(id), rule_snapshot jsonb NOT NULL,
  calculation_basis text NOT NULL, base_cents bigint NOT NULL, rate_bps int NOT NULL, fixed_cents bigint NOT NULL,
  commission_cents bigint NOT NULL, explanation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE statement_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES owner_statements(id),
  type text NOT NULL CHECK (type IN ('EARNINGS','EXPENSE','COMMISSION','ADJUSTMENT')),
  description text NOT NULL, category text, line_date date, amount_cents bigint NOT NULL,
  source_id text NOT NULL                     -- earnings source id / expense id: every dollar is traceable
);
CREATE INDEX ON statement_line_items (statement_id);

CREATE TABLE statement_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES owner_statements(id),
  channel delivery_channel NOT NULL, recipient text NOT NULL,
  status delivery_status NOT NULL DEFAULT 'QUEUED', provider_message_id text, template_id text,
  resend boolean NOT NULL DEFAULT false,
  sent_at timestamptz, delivered_at timestamptz, failure_reason text
);
CREATE INDEX ON statement_deliveries (statement_id);

CREATE TABLE annual_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id), owner_id uuid NOT NULL REFERENCES owners(id),
  year int NOT NULL, total_revenue_cents bigint NOT NULL, total_platform_fees_cents bigint NOT NULL,
  total_expenses_cents bigint NOT NULL, total_commissions_cents bigint NOT NULL, total_owner_proceeds_cents bigint NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE communication_preferences (
  owner_id uuid PRIMARY KEY REFERENCES owners(id),
  email_enabled boolean NOT NULL DEFAULT true, whatsapp_enabled boolean NOT NULL DEFAULT false,
  include_whatsapp_summary boolean NOT NULL DEFAULT false
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid REFERENCES users(id),
  action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  old_value jsonb, new_value jsonb, ip inet, user_agent text,
  prev_hash text NOT NULL, hash text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (entity_type, entity_id);

-- ---------- Immutability ----------
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Expenses and earnings cannot be inserted/changed/deleted in a FINALIZED/LOCKED period.
CREATE FUNCTION guard_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; st period_status;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    pid := COALESCE(NEW.accounting_period_id, OLD.accounting_period_id);
    SELECT status INTO st FROM accounting_periods WHERE id = pid;
  ELSE -- earnings_transactions: resolve by earnings_date
    SELECT status INTO st FROM accounting_periods
      WHERE organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
        AND COALESCE(NEW.earnings_date, OLD.earnings_date) BETWEEN start_date AND end_date;
  END IF;
  IF st IN ('FINALIZED','LOCKED') THEN
    RAISE EXCEPTION 'Period is %; post an adjustment/reversal in an open period', st;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER expenses_period_guard BEFORE INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION guard_closed_period();
CREATE TRIGGER earnings_period_guard BEFORE INSERT OR UPDATE OR DELETE ON earnings_transactions FOR EACH ROW EXECUTE FUNCTION guard_closed_period();

-- Finalized statements are frozen (status may only advance FINALIZED -> LOCKED).
CREATE FUNCTION freeze_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('FINALIZED','LOCKED') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Finalized statements cannot be deleted'; END IF;
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
       OR NOT (OLD.status = 'FINALIZED' AND NEW.status IN ('FINALIZED','LOCKED') OR OLD.status = NEW.status) THEN
      RAISE EXCEPTION 'Finalized statement % is immutable; issue a superseding statement', OLD.id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER statements_freeze BEFORE UPDATE OR DELETE ON owner_statements FOR EACH ROW EXECUTE FUNCTION freeze_statement();
