-- When an owner replies STOP to a WhatsApp message we must stop immediately and be able to show when and why.
-- opt_in is cleared; this records the moment. A manager re-enabling opt-in (after the owner asks) clears it.
ALTER TABLE owners ADD COLUMN whatsapp_opt_out_at timestamptz;
CREATE INDEX owners_whatsapp_digits ON owners ((regexp_replace(whatsapp_phone, '\D', '', 'g'))) WHERE whatsapp_phone IS NOT NULL;
