import type { Db, Tx } from '../db/pool.ts';
import { appendAudit } from './audit.ts';
import { UserError } from '../errors.ts';

export interface OwnerInput {
  legalName: string; displayName: string; email?: string | null; secondaryEmail?: string | null; emailEnabled?: boolean;
  phone?: string | null; whatsappPhone?: string | null; whatsappEnabled?: boolean; whatsappOptIn?: boolean;
  mailingAddress?: string | null; taxReportingName?: string | null; taxIdStatus?: TaxIdStatus;
  notes?: string | null; active?: boolean;
}
export type TaxIdStatus = 'NOT_COLLECTED' | 'ON_FILE_EXTERNALLY' | 'REQUESTED';
export interface Owner extends Required<Omit<OwnerInput, 'taxIdStatus'>> { id: string; taxIdStatus: TaxIdStatus; whatsappOptOutAt: string | null }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9]\d{6,14}$/; // E.164

function validate(o: OwnerInput) {
  if (!o.legalName?.trim() || !o.displayName?.trim()) throw new UserError('Owner legal and display names are required');
  for (const e of [o.email, o.secondaryEmail]) if (e && !EMAIL.test(e)) throw new UserError(`Invalid email: ${e}`);
  if (o.whatsappPhone && !PHONE.test(o.whatsappPhone)) throw new UserError('WhatsApp phone must be E.164 (+15551234567)');
}

const map = (x: any): Owner => ({
  id: x.id, legalName: x.legal_name, displayName: x.display_name, email: x.email, secondaryEmail: x.secondary_email, emailEnabled: x.email_enabled,
  phone: x.phone, whatsappPhone: x.whatsapp_phone, whatsappEnabled: x.whatsapp_enabled, whatsappOptIn: x.whatsapp_opt_in,
  mailingAddress: x.mailing_address, taxReportingName: x.tax_reporting_name, taxIdStatus: x.tax_id_status, notes: x.notes, active: x.active,
  whatsappOptOutAt: x.whatsapp_opt_out_at ? new Date(x.whatsapp_opt_out_at).toISOString() : null,
});

export async function getOwner(db: Db, orgId: string, id: string): Promise<Owner | null> {
  const r = await db.query('SELECT * FROM owners WHERE id = $1 AND organization_id = $2', [id, orgId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function listOwners(db: Db, orgId: string): Promise<Owner[]> {
  return (await db.query('SELECT * FROM owners WHERE organization_id = $1 ORDER BY display_name', [orgId])).rows.map(map);
}

export async function createOwner(tx: Tx, orgId: string, userId: string, o: OwnerInput): Promise<string> {
  validate(o);
  const r = await tx.query(
    `INSERT INTO owners (organization_id, legal_name, display_name, email, secondary_email, email_enabled, phone, whatsapp_phone, whatsapp_enabled,
       whatsapp_opt_in, whatsapp_opt_in_at, mailing_address, tax_reporting_name, tax_id_status, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $10 THEN now() END,$11,$12,$13,$14,$15) RETURNING id`,
    [orgId, o.legalName, o.displayName, o.email ?? null, o.secondaryEmail ?? null, o.emailEnabled ?? true, o.phone ?? null, o.whatsappPhone ?? null,
      o.whatsappEnabled ?? false, o.whatsappOptIn ?? false, o.mailingAddress ?? null, o.taxReportingName ?? null, o.taxIdStatus ?? 'NOT_COLLECTED',
      o.notes ?? null, o.active ?? true]);
  await appendAudit(tx, orgId, { userId, action: 'OWNER_CREATED', entityType: 'owner', entityId: r.rows[0].id, oldValue: null, newValue: o });
  return r.rows[0].id;
}

export async function updateOwner(tx: Tx, orgId: string, userId: string, id: string, patch: Partial<OwnerInput>): Promise<Owner> {
  const cur = (await tx.query('SELECT * FROM owners WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, orgId])).rows[0];
  if (!cur) throw new UserError('Owner not found');
  const before = map(cur);
  const next = { ...before, ...patch };
  validate(next);
  const optInChanged = !!patch.whatsappOptIn && !before.whatsappOptIn;
  await tx.query(
    `UPDATE owners SET legal_name=$3, display_name=$4, email=$5, secondary_email=$6, email_enabled=$7, phone=$8, whatsapp_phone=$9, whatsapp_enabled=$10,
       whatsapp_opt_in=$11, whatsapp_opt_in_at = CASE WHEN $16 THEN now() WHEN NOT $11 THEN NULL ELSE whatsapp_opt_in_at END,
       whatsapp_opt_out_at = CASE WHEN $16 THEN NULL ELSE whatsapp_opt_out_at END,
       mailing_address=$12, tax_reporting_name=$13, tax_id_status=$14, notes=$15, active=$17, updated_at=now()
     WHERE id=$1 AND organization_id=$2`,
    [id, orgId, next.legalName, next.displayName, next.email, next.secondaryEmail, next.emailEnabled, next.phone, next.whatsappPhone, next.whatsappEnabled,
      next.whatsappOptIn, next.mailingAddress, next.taxReportingName, next.taxIdStatus, next.notes, optInChanged, next.active]);
  await appendAudit(tx, orgId, { userId, action: 'OWNER_UPDATED', entityType: 'owner', entityId: id, oldValue: before, newValue: next });
  return next;
}

/**
 * An owner replied STOP. Clears opt-in for every owner (in any organization) whose WhatsApp number matches, records when,
 * and audits it. Idempotent: owners already opted out are untouched. `digits` is the sender's number without "+".
 */
export async function optOutWhatsAppByPhone(tx: Tx, digits: string): Promise<{ orgId: string; ownerId: string }[]> {
  if (!/^\d{7,15}$/.test(digits)) return [];
  const r = await tx.query(
    `UPDATE owners SET whatsapp_opt_in=false, whatsapp_opt_in_at=NULL, whatsapp_opt_out_at=now(), updated_at=now()
     WHERE regexp_replace(whatsapp_phone, '\\D', '', 'g') = $1 AND whatsapp_opt_in RETURNING id, organization_id`, [digits]);
  for (const x of r.rows) {
    await appendAudit(tx, x.organization_id, { userId: null, action: 'WHATSAPP_OPT_OUT', entityType: 'owner', entityId: x.id,
      oldValue: { whatsappOptIn: true }, newValue: { whatsappOptIn: false, via: 'owner replied STOP' } });
  }
  return r.rows.map((x) => ({ orgId: x.organization_id, ownerId: x.id }));
}
