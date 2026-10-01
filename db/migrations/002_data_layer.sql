-- Full statement snapshot (source of truth for rendering/YTD/CSV of a generated statement).
ALTER TABLE owner_statements ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}';

-- One current statement per property+period (superseding statements chain via supersedes_statement_id).
CREATE UNIQUE INDEX one_current_statement ON owner_statements (property_id, accounting_period_id)
  WHERE supersedes_statement_id IS NULL;

-- Import rows that were NOT imported (unmatched listing, locked period) so they stay visible as exceptions.
CREATE TABLE import_rejected_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  source_row int, status text NOT NULL CHECK (status IN ('UNMATCHED_PROPERTY','PERIOD_LOCKED')),
  idempotency_key text NOT NULL, earnings_date date NOT NULL, listing_name text,
  net_payout_cents bigint NOT NULL, record jsonb NOT NULL
);
CREATE INDEX ON import_rejected_rows (organization_id, earnings_date);
CREATE INDEX ON import_rejected_rows (idempotency_key);

-- Delivery lookups by provider id (webhooks).
CREATE INDEX ON statement_deliveries (provider_message_id);

-- Audit chain is per organization; verify() walks it in id order.
CREATE INDEX audit_logs_org_id ON audit_logs (organization_id, id);
