import type { Db, Tx } from '../db/pool.ts';
import { assertEditable, periodOf } from '../accounting/period.ts';
import type { ExpenseInput } from '../accounting/statement.ts';
import { appendAudit } from './audit.ts';
import { getOrCreateCategory } from './orgs.ts';
import { getOrCreatePeriod } from './periods.ts';
import { UserError } from '../errors.ts';

export interface NewExpense {
  propertyId: string; date: string; vendor: string; description?: string; category: string;
  amountCents: number; taxCents?: number; paymentMethod?: string; receiptAttachmentId?: string | null;
  reimbursable?: boolean; ownerPaid?: boolean; recurring?: boolean; notes?: string;
  /** Accounting month override (YYYY-MM); defaults to the expense date's month. */
  accountingMonth?: string;
}
export interface ExpenseRow extends ExpenseInput { recurringExpenseId: string | null; receiptCount: number; propertyId: string; ownerId: string; periodId: string; paymentMethod: string | null; notes: string | null; reverses: string | null }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validate(e: NewExpense) {
  if (!Number.isInteger(e.amountCents) || (e.taxCents !== undefined && !Number.isInteger(e.taxCents))) throw new UserError('Amounts must be whole cents');
  if (e.amountCents === 0) throw new UserError('Expense amount cannot be zero');
  if (!DATE.test(e.date) || isNaN(Date.parse(e.date))) throw new UserError('Invalid expense date');
  if (!e.vendor?.trim()) throw new UserError('Vendor is required');
}

const map = (x: any): ExpenseRow => ({ id: x.id, date: x.expense_date, vendor: x.vendor, description: x.description ?? '', category: x.category,
  amountCents: x.amount_cents, taxCents: x.tax_cents, ownerPaid: x.owner_paid, reimbursable: x.reimbursable, propertyId: x.property_id, ownerId: x.owner_id,
  receiptCount: x.receipt_count ?? 0, periodId: x.accounting_period_id, paymentMethod: x.payment_method, notes: x.notes, reverses: x.reverses_expense_id, recurringExpenseId: x.recurring_expense_id ?? null });

const SELECT = `SELECT e.*, c.name AS category, (SELECT count(*)::int FROM expense_receipts r WHERE r.expense_id = e.id) AS receipt_count FROM expenses e JOIN expense_categories c ON c.id = e.category_id`;

export interface CreateOpts {
  /** Who the audit entry names; null for automatic postings (the worker). Defaults to userId. */
  auditUserId?: string | null;
  recurringExpenseId?: string;
}

export async function createExpense(tx: Tx, orgId: string, userId: string, e: NewExpense, opts: CreateOpts = {}): Promise<string> {
  validate(e);
  const prop = await tx.query(`SELECT po.owner_id FROM properties p JOIN property_owners po ON po.property_id=p.id AND po.is_primary
    WHERE p.id=$1 AND p.organization_id=$2`, [e.propertyId, orgId]);
  if (!prop.rowCount) throw new UserError('Property not found');
  const ym = e.accountingMonth ?? e.date.slice(0, 7);
  const { year, month } = periodOf(`${ym}-01`);
  const period = await getOrCreatePeriod(tx, orgId, year, month, true);
  assertEditable(period);
  const category = await getOrCreateCategory(tx, orgId, e.category);
  const r = await tx.query(
    `INSERT INTO expenses(organization_id, property_id, owner_id, accounting_period_id, category_id, expense_date, vendor, description, amount_cents, tax_cents,
       payment_method, receipt_attachment_id, reimbursable, manager_paid, owner_paid, recurring, notes, created_by, recurring_expense_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [orgId, e.propertyId, prop.rows[0].owner_id, period.id, category, e.date, e.vendor.trim(), e.description ?? null, e.amountCents, e.taxCents ?? 0,
      e.paymentMethod ?? null, e.receiptAttachmentId ?? null, e.reimbursable ?? false, !(e.ownerPaid ?? false), e.ownerPaid ?? false, (e.recurring ?? false) || !!opts.recurringExpenseId, e.notes ?? null, userId, opts.recurringExpenseId ?? null]);
  await appendAudit(tx, orgId, { userId: opts.auditUserId === undefined ? userId : opts.auditUserId, action: 'EXPENSE_CREATED', entityType: 'expense', entityId: r.rows[0].id, oldValue: null,
    newValue: opts.recurringExpenseId ? { ...e, recurringExpenseId: opts.recurringExpenseId } : e });
  return r.rows[0].id;
}

export async function getExpense(db: Db, orgId: string, id: string): Promise<ExpenseRow | null> {
  const r = await db.query(`${SELECT} WHERE e.id=$1 AND e.organization_id=$2`, [id, orgId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function listExpenses(db: Db, orgId: string, f: { periodId?: string; propertyId?: string; ownerId?: string } = {}): Promise<ExpenseRow[]> {
  const r = await db.query(
    `${SELECT} WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR e.accounting_period_id=$2) AND ($3::uuid IS NULL OR e.property_id=$3)
       AND ($4::uuid IS NULL OR e.owner_id=$4) ORDER BY e.expense_date, e.created_at, e.id`, [orgId, f.periodId ?? null, f.propertyId ?? null, f.ownerId ?? null]);
  return r.rows.map(map);
}

/** Editable only while the period is open. Closed periods need reverseExpense() in an open period. */
export async function updateExpense(tx: Tx, orgId: string, userId: string, id: string, patch: Partial<Pick<NewExpense, 'vendor' | 'description' | 'category' | 'amountCents' | 'taxCents' | 'ownerPaid' | 'notes' | 'reimbursable'>>): Promise<void> {
  const cur = (await tx.query(`${SELECT} WHERE e.id=$1 AND e.organization_id=$2 FOR UPDATE OF e`, [id, orgId])).rows[0];
  if (!cur) throw new UserError('Expense not found');
  const period = (await tx.query('SELECT id, year, month, status FROM accounting_periods WHERE id=$1 FOR UPDATE', [cur.accounting_period_id])).rows[0];
  assertEditable(period);
  const before = map(cur);
  const next = { ...before, ...patch };
  validate({ propertyId: before.propertyId, date: before.date, vendor: next.vendor, category: next.category, amountCents: next.amountCents, taxCents: next.taxCents });
  const category = await getOrCreateCategory(tx, orgId, next.category);
  await tx.query(
    `UPDATE expenses SET vendor=$2, description=$3, category_id=$4, amount_cents=$5, tax_cents=$6, owner_paid=$7, manager_paid=NOT $7, notes=$8, reimbursable=$9, updated_at=now() WHERE id=$1`,
    [id, next.vendor, next.description, category, next.amountCents, next.taxCents, next.ownerPaid, next.notes, next.reimbursable]);
  await appendAudit(tx, orgId, { userId, action: 'EXPENSE_UPDATED', entityType: 'expense', entityId: id, oldValue: before, newValue: next });
}

/** Returns the storage keys of the expense's receipts; the caller deletes those blobs after the transaction commits. */
export async function deleteExpense(tx: Tx, orgId: string, userId: string, id: string): Promise<string[]> {
  const cur = (await tx.query(`${SELECT} WHERE e.id=$1 AND e.organization_id=$2 FOR UPDATE OF e`, [id, orgId])).rows[0];
  if (!cur) throw new UserError('Expense not found');
  const period = (await tx.query('SELECT id, year, month, status FROM accounting_periods WHERE id=$1 FOR UPDATE', [cur.accounting_period_id])).rows[0];
  assertEditable(period);
  const blobs = (await tx.query('SELECT a.id, a.storage_key FROM expense_receipts r JOIN attachments a ON a.id=r.attachment_id WHERE r.expense_id=$1', [id])).rows;
  await tx.query('DELETE FROM expenses WHERE id=$1', [id]); // cascades the receipt links
  if (blobs.length) await tx.query('DELETE FROM attachments WHERE id = ANY($1::uuid[])', [blobs.map((b) => b.id)]);
  await appendAudit(tx, orgId, { userId, action: 'EXPENSE_DELETED', entityType: 'expense', entityId: id, oldValue: map(cur), newValue: null });
  return blobs.map((b) => b.storage_key as string);
}

/** Correction path for a closed period: posts the negated expense into an OPEN accounting month. */
export async function reverseExpense(tx: Tx, orgId: string, userId: string, id: string, intoMonth: string, reason: string): Promise<string> {
  const orig = await getExpense(tx, orgId, id);
  if (!orig) throw new UserError('Expense not found');
  if (!reason?.trim()) throw new UserError('A reason is required for a reversal');
  const newId = await createExpense(tx, orgId, userId, { propertyId: orig.propertyId, date: `${intoMonth}-01`, vendor: orig.vendor,
    description: `Reversal of ${id}: ${reason}`, category: orig.category, amountCents: -orig.amountCents, taxCents: -orig.taxCents,
    ownerPaid: orig.ownerPaid, accountingMonth: intoMonth });
  await tx.query('UPDATE expenses SET reverses_expense_id=$2 WHERE id=$1', [newId, id]);
  await appendAudit(tx, orgId, { userId, action: 'EXPENSE_REVERSED', entityType: 'expense', entityId: id, oldValue: null, newValue: { reversalId: newId, reason } });
  return newId;
}
