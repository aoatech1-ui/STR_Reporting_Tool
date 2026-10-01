import type { Db, Tx } from '../db/pool.ts';
import type { CommissionRule, CommissionType } from '../accounting/commission.ts';
import { appendAudit } from './audit.ts';

export interface PropertyInput {
  name: string; ownerId: string; address?: string; city?: string; state?: string; zip?: string;
  airbnbListingId?: string | null; airbnbListingName?: string | null;
  managementStartDate?: string | null; managementEndDate?: string | null; notes?: string | null;
}
export interface Property extends Required<Omit<PropertyInput, 'ownerId'>> { id: string; ownerId: string; active: boolean }

const map = (x: any): Property => ({ id: x.id, name: x.name, ownerId: x.owner_id, address: x.address, city: x.city, state: x.state, zip: x.zip,
  airbnbListingId: x.airbnb_listing_id, airbnbListingName: x.airbnb_listing_name, managementStartDate: x.management_start_date,
  managementEndDate: x.management_end_date, notes: x.notes, active: x.active });

const SELECT = `SELECT p.*, po.owner_id FROM properties p JOIN property_owners po ON po.property_id = p.id AND po.is_primary`;

export async function createProperty(tx: Tx, orgId: string, userId: string, p: PropertyInput): Promise<string> {
  if (!p.name?.trim()) throw new Error('Property name is required');
  const owner = await tx.query('SELECT 1 FROM owners WHERE id=$1 AND organization_id=$2', [p.ownerId, orgId]);
  if (!owner.rowCount) throw new Error('Owner not found');
  const r = await tx.query(
    `INSERT INTO properties(organization_id, name, address, city, state, zip, airbnb_listing_id, airbnb_listing_name, management_start_date, management_end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [orgId, p.name, p.address ?? null, p.city ?? null, p.state ?? null, p.zip ?? null, p.airbnbListingId ?? null, p.airbnbListingName ?? null,
      p.managementStartDate ?? null, p.managementEndDate ?? null, p.notes ?? null]);
  await tx.query('INSERT INTO property_owners(property_id, owner_id, ownership_bps, is_primary) VALUES ($1,$2,10000,true)', [r.rows[0].id, p.ownerId]);
  await appendAudit(tx, orgId, { userId, action: 'PROPERTY_CREATED', entityType: 'property', entityId: r.rows[0].id, oldValue: null, newValue: p });
  return r.rows[0].id;
}

export async function getProperty(db: Db, orgId: string, id: string): Promise<Property | null> {
  const r = await db.query(`${SELECT} WHERE p.id=$1 AND p.organization_id=$2`, [id, orgId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function listProperties(db: Db, orgId: string): Promise<Property[]> {
  return (await db.query(`${SELECT} WHERE p.organization_id=$1 ORDER BY p.name`, [orgId])).rows.map(map);
}

/** Active properties whose management window overlaps the period. */
export async function listManagedProperties(db: Db, orgId: string, start: string, end: string): Promise<Property[]> {
  const r = await db.query(
    `${SELECT} WHERE p.organization_id=$1 AND p.active AND (p.management_start_date IS NULL OR p.management_start_date <= $3)
       AND (p.management_end_date IS NULL OR p.management_end_date >= $2) ORDER BY p.name`, [orgId, start, end]);
  return r.rows.map(map);
}

const mapRule = (x: any): CommissionRule => ({ id: x.id, type: x.commission_type as CommissionType, rateBps: x.rate_bps, fixedCents: x.fixed_cents,
  includeCleaningFees: x.include_cleaning_fees, excludeTaxes: x.exclude_taxes, hybridBasis: x.hybrid_basis, effectiveFrom: x.effective_from, effectiveTo: x.effective_to });

export async function listRules(db: Db, propertyId: string): Promise<CommissionRule[]> {
  return (await db.query('SELECT * FROM commission_rules WHERE property_id=$1 AND active ORDER BY effective_from', [propertyId])).rows.map(mapRule);
}

export type NewRule = Omit<CommissionRule, 'id' | 'effectiveTo'>;

/**
 * Changes the commission going forward: closes the open rule the day before the new one starts and inserts the new rule.
 * Past rules (and the calculations that snapshot them) are untouched.
 */
export async function setCommissionRule(tx: Tx, orgId: string, userId: string, propertyId: string, rule: NewRule): Promise<string> {
  if (rule.rateBps < 0 || rule.rateBps > 10000 || rule.fixedCents < 0) throw new Error('Invalid commission rate or amount');
  if (rule.type === 'FIXED' && rule.fixedCents === 0) throw new Error('Fixed commission needs an amount');
  if ((rule.type === 'PERCENT_GROSS' || rule.type === 'PERCENT_NET') && rule.rateBps === 0) throw new Error('Percent commission needs a rate');
  const prop = await tx.query('SELECT 1 FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE', [propertyId, orgId]);
  if (!prop.rowCount) throw new Error('Property not found');
  const open = (await tx.query('SELECT * FROM commission_rules WHERE property_id=$1 AND active AND effective_to IS NULL', [propertyId])).rows[0];
  if (open) {
    if (open.effective_from >= rule.effectiveFrom) throw new Error('New rule must start after the current rule starts');
    await tx.query(`UPDATE commission_rules SET effective_to = ($2::date - 1) WHERE id=$1`, [open.id, rule.effectiveFrom]);
  }
  const r = await tx.query(
    `INSERT INTO commission_rules(property_id, commission_type, rate_bps, fixed_cents, hybrid_basis, include_cleaning_fees, exclude_taxes, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [propertyId, rule.type, rule.rateBps, rule.fixedCents, rule.hybridBasis, rule.includeCleaningFees, rule.excludeTaxes, rule.effectiveFrom]);
  await appendAudit(tx, orgId, { userId, action: 'COMMISSION_CHANGED', entityType: 'property', entityId: propertyId,
    oldValue: open ? mapRule(open) : null, newValue: { ...rule, id: r.rows[0].id } });
  return r.rows[0].id;
}
