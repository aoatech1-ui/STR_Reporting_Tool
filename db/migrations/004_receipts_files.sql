-- Receipts: many per expense. Kept in a link table (not a column on expenses) so that documenting an expense in a closed
-- month does not modify the frozen expense row. Deleting an open-period expense removes its links.
CREATE TABLE expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  expense_id uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachments(id),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON expense_receipts (expense_id);
CREATE INDEX ON expense_receipts (organization_id);
CREATE INDEX ON attachments (organization_id);

-- Generated statement files (PDF/CSV) are attached to a finalized statement exactly once.
-- Everything else on a finalized statement stays immutable; the two file links may go NULL -> value, never change afterwards.
CREATE OR REPLACE FUNCTION freeze_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('FINALIZED','LOCKED') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Finalized statements cannot be deleted'; END IF;
    IF (to_jsonb(NEW) - 'status' - 'pdf_attachment_id' - 'csv_attachment_id') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'pdf_attachment_id' - 'csv_attachment_id')
       OR NOT (OLD.status = 'FINALIZED' AND NEW.status IN ('FINALIZED','LOCKED') OR OLD.status = NEW.status)
       OR (OLD.pdf_attachment_id IS NOT NULL AND NEW.pdf_attachment_id IS DISTINCT FROM OLD.pdf_attachment_id)
       OR (OLD.csv_attachment_id IS NOT NULL AND NEW.csv_attachment_id IS DISTINCT FROM OLD.csv_attachment_id) THEN
      RAISE EXCEPTION 'Finalized statement % is immutable; issue a superseding statement', OLD.id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
