import type { Db, Tx } from '../db/pool.ts';
import { appendAudit } from './audit.ts';

export const DEFAULT_CATEGORIES = ['Repairs', 'Maintenance', 'Cleaning', 'Supplies', 'Utilities', 'Landscaping', 'Pest Control', 'Insurance',
  'Property Taxes', 'HOA', 'Furniture', 'Appliances', 'Linens', 'Software', 'Airbnb/Platform Fees', 'Other'];

export type Role = 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER';

export async function createOrganization(tx: Tx, o: { legalName: string; displayName: string; email?: string }): Promise<string> {
  const r = await tx.query('INSERT INTO organizations(legal_name, display_name, email) VALUES ($1,$2,$3) RETURNING id', [o.legalName, o.displayName, o.email ?? null]);
  const id = r.rows[0].id as string;
  for (const name of DEFAULT_CATEGORIES) await tx.query('INSERT INTO expense_categories(organization_id, name) VALUES ($1,$2)', [id, name]);
  return id;
}

export async function createUser(tx: Tx, orgId: string, u: { name: string; email: string; role: Role; authProviderId?: string }): Promise<string> {
  const r = await tx.query('INSERT INTO users(organization_id, name, email, role, auth_provider_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orgId, u.name, u.email.toLowerCase(), u.role, u.authProviderId ?? null]);
  await appendAudit(tx, orgId, { userId: r.rows[0].id, action: 'USER_CREATED', entityType: 'user', entityId: r.rows[0].id, oldValue: null, newValue: { email: u.email, role: u.role } });
  return r.rows[0].id;
}

export async function getUser(db: Db, orgId: string, id: string) {
  const r = await db.query('SELECT id, name, email, role, active FROM users WHERE id = $1 AND organization_id = $2', [id, orgId]);
  return (r.rows[0] as { id: string; name: string; email: string; role: Role; active: boolean } | undefined) ?? null;
}

/** Custom categories are allowed; returns the existing id for a case-insensitive match. */
export async function getOrCreateCategory(tx: Tx, orgId: string, name: string): Promise<string> {
  const n = name.trim();
  if (!n) throw new Error('Expense category is required');
  const ex = await tx.query('SELECT id FROM expense_categories WHERE organization_id = $1 AND lower(name) = lower($2)', [orgId, n]);
  if (ex.rowCount) return ex.rows[0].id;
  return (await tx.query('INSERT INTO expense_categories(organization_id, name) VALUES ($1,$2) RETURNING id', [orgId, n])).rows[0].id;
}
