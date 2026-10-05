import type { Db, Pool, Tx } from '../db/pool.ts';
import { withTx } from '../db/pool.ts';
import { isClosed, periodKey } from '../accounting/period.ts';
import { describeSchedule, dueOccurrences, occurrenceDate, occursIn, upcomingOccurrences, validateSchedule, type RecurringSchedule } from '../accounting/recurring.ts';
import { UserError } from '../errors.ts';
import { appendAudit } from './audit.ts';
import { createExpense } from './expenses.ts';
import { getOrCreateCategory } from './orgs.ts';
import { getOrCreatePeriod } from './periods.ts';

export interface RecurringInput extends RecurringSchedule {
  propertyId: string; vendor: string; description?: string | null; category: string; amountCents: number; taxCents?: number;
  ownerPaid?: boolean; reimbursable?: boolean; paymentMethod?: string | null; notes?: string | null;
}
export interface RecurringRow extends Required<Omit<RecurringInput, 'description' | 'paymentMethod' | 'notes'>> {
  id: string; propertyName: string; description: string | null; paymentMethod: string | null; notes: string | null; active: boolean;
  schedule: string; createdAt: string; updatedAt: string;
}
export interface PostingRow { id: string; year: number; month: number; status: 'POSTED' | 'SKIPPED'; expenseId: string | null; amountCents: number | null; reason: string | null; postedBy: string | null; createdAt: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;
const ym = (d: string | Date | null) => (d === null ? null : (typeof d === 'string' ? d : d.toISOString()).slice(0, 7));

const SELECT = `SELECT r.*, p.name AS property_name, c.name AS category FROM recurring_expenses r JOIN properties p ON p.id=r.property_id JOIN expense_categories c ON c.id=r.category_id`;
const map = (x: any): RecurringRow => {
  const s = { startMonth: ym(x.start_month)!, endMonth: ym(x.end_month), intervalMonths: x.interval_months, dayOfMonth: x.day_of_month };
  return { id: x.id, propertyId: x.property_id, propertyName: x.property_name, vendor: x.vendor, description: x.description, category: x.category,
    amountCents: Number(x.amount_cents), taxCents: Number(x.tax_cents), ownerPaid: x.owner_paid, reimbursable: x.reimbursable, paymentMethod: x.payment_method, notes: x.notes,
    ...s, active: x.active, schedule: describeSchedule(s), createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString() };
};

function check(t: RecurringInput, today: string) {
  if (!Number.isInteger(t.amountCents) || t.amountCents === 0) throw new UserError('Amount must be a non-zero number of cents');
  if (t.taxCents !== undefined && !Number.isInteger(t.taxCents)) throw new UserError('Tax must be whole cents');
  if (!t.vendor?.trim()) throw new UserError('Vendor is required');
  if (!t.category?.trim()) throw new UserError('Category is required');
  const p = validateSchedule(t, today);
  if (p) throw new UserError(p);
}

export async function listRecurring(db: Db, orgId: string, f: { propertyId?: string } = {}): Promise<RecurringRow[]> {
  const r = await db.query(`${SELECT} WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR r.property_id=$2) ORDER BY r.active DESC, p.name, r.vendor`, [orgId, f.propertyId ?? null]);
  return r.rows.map(map);
}
export async function getRecurring(db: Db, orgId: string, id: string): Promise<RecurringRow | null> {
  const r = await db.query(`${SELECT} WHERE r.id=$1 AND r.organization_id=$2`, [id, orgId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function listPostings(db: Db, orgId: string, id: string): Promise<PostingRow[]> {
  const r = await db.query(
    `SELECT x.*, e.amount_cents + e.tax_cents AS total, u.name AS posted_by_name FROM recurring_expense_postings x
     LEFT JOIN expenses e ON e.id=x.expense_id LEFT JOIN users u ON u.id=x.posted_by
     WHERE x.recurring_expense_id=$1 AND x.organization_id=$2 ORDER BY x.year DESC, x.month DESC`, [id, orgId]);
  return r.rows.map((x) => ({ id: x.id, year: x.year, month: x.month, status: x.status, expenseId: x.expense_id, amountCents: x.total === null ? null : Number(x.total),
    reason: x.reason, postedBy: x.posted_by_name ?? null, createdAt: new Date(x.created_at).toISOString() }));
}

async function propertyOk(tx: Tx, orgId: string, propertyId: string) {
  const r = await tx.query('SELECT active FROM properties WHERE id=$1 AND organization_id=$2', [propertyId, orgId]);
  if (!r.rowCount) throw new UserError('Property not found');
  return r.rows[0].active as boolean;
}

export async function createRecurring(tx: Tx, orgId: string, userId: string, t: RecurringInput, today: string): Promise<string> {
  check(t, today);
  await propertyOk(tx, orgId, t.propertyId);
  const category = await getOrCreateCategory(tx, orgId, t.category);
  const r = await tx.query(
    `INSERT INTO recurring_expenses(organization_id, property_id, category_id, vendor, description, amount_cents, tax_cents, owner_paid, reimbursable, payment_method, notes,
       interval_months, day_of_month, start_month, end_month, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [orgId, t.propertyId, category, t.vendor.trim(), t.description ?? null, t.amountCents, t.taxCents ?? 0, t.ownerPaid ?? false, t.reimbursable ?? false, t.paymentMethod ?? null, t.notes ?? null,
      t.intervalMonths, t.dayOfMonth, `${t.startMonth}-01`, t.endMonth ? `${t.endMonth}-01` : null, userId]);
  await appendAudit(tx, orgId, { userId, action: 'RECURRING_EXPENSE_CREATED', entityType: 'recurring_expense', entityId: r.rows[0].id, oldValue: null, newValue: t });
  return r.rows[0].id;
}

/** Changes apply to occurrences not yet posted. Expenses already posted are ordinary expenses and are edited individually. */
export async function updateRecurring(tx: Tx, orgId: string, userId: string, id: string, patch: Partial<RecurringInput> & { active?: boolean }, today: string): Promise<void> {
  const cur = (await tx.query(`${SELECT} WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r`, [id, orgId])).rows[0];
  if (!cur) throw new UserError('Recurring expense not found');
  const before = map(cur);
  const { id: _i, propertyName: _p, schedule: _s, createdAt: _c, updatedAt: _u, ...base } = before;
  const next = { ...base, ...patch };
  if (patch.propertyId && patch.propertyId !== before.propertyId) throw new UserError('The property cannot be changed. Stop this one and create a new one instead.');
  // a start month already in the past is fine if it was not changed
  check(next, patch.startMonth && patch.startMonth !== before.startMonth ? today : `${before.startMonth}-01`);
  const category = await getOrCreateCategory(tx, orgId, next.category);
  await tx.query(
    `UPDATE recurring_expenses SET category_id=$2, vendor=$3, description=$4, amount_cents=$5, tax_cents=$6, owner_paid=$7, reimbursable=$8, payment_method=$9, notes=$10,
       interval_months=$11, day_of_month=$12, start_month=$13, end_month=$14, active=$15, updated_at=now() WHERE id=$1`,
    [id, category, next.vendor.trim(), next.description ?? null, next.amountCents, next.taxCents ?? 0, next.ownerPaid, next.reimbursable, next.paymentMethod ?? null, next.notes ?? null,
      next.intervalMonths, next.dayOfMonth, `${next.startMonth}-01`, next.endMonth ? `${next.endMonth}-01` : null, next.active]);
  const action = patch.active === false && before.active ? 'RECURRING_EXPENSE_STOPPED' : patch.active === true && !before.active ? 'RECURRING_EXPENSE_RESUMED' : 'RECURRING_EXPENSE_UPDATED';
  await appendAudit(tx, orgId, { userId, action, entityType: 'recurring_expense', entityId: id, oldValue: base, newValue: next });
}

/** Only while nothing was ever posted from it; afterwards it is stopped instead, so the link from its expenses stays meaningful. */
export async function deleteRecurring(tx: Tx, orgId: string, userId: string, id: string): Promise<void> {
  const cur = await getRecurring(tx, orgId, id);
  if (!cur) throw new UserError('Recurring expense not found');
  const used = await tx.query('SELECT 1 FROM recurring_expense_postings WHERE recurring_expense_id=$1 LIMIT 1', [id]);
  if (used.rowCount) throw new UserError('Expenses were already posted from this. Stop it instead of deleting it.', 409);
  await tx.query('DELETE FROM recurring_expenses WHERE id=$1', [id]);
  await appendAudit(tx, orgId, { userId, action: 'RECURRING_EXPENSE_DELETED', entityType: 'recurring_expense', entityId: id, oldValue: cur, newValue: null });
}

export type PostResult = { status: 'POSTED'; expenseId: string } | { status: 'SKIPPED'; reason: string } | { status: 'EXISTS' };

/**
 * Posts one occurrence as an ordinary expense in its own month. Exactly once: the posting row is claimed first (unique per
 * template and month); a second caller waits for the first to commit, then finds the row and does nothing.
 * `actor` null = automatic (worker).
 */
export async function postOccurrence(tx: Tx, orgId: string, t: RecurringRow, year: number, month: number, actor: string | null, createdBy: string): Promise<PostResult> {
  if (!occursIn(t, year, month)) throw new UserError(`${t.vendor} does not occur in ${label(year, month)}`);
  const claim = await tx.query(
    `INSERT INTO recurring_expense_postings(organization_id, recurring_expense_id, year, month, status, posted_by) VALUES ($1,$2,$3,$4,'POSTED',$5)
     ON CONFLICT (recurring_expense_id, year, month) DO NOTHING RETURNING id`, [orgId, t.id, year, month, actor]);
  if (!claim.rowCount) return { status: 'EXISTS' };
  const postingId = claim.rows[0].id;
  const skip = async (reason: string): Promise<PostResult> => {
    await tx.query(`UPDATE recurring_expense_postings SET status='SKIPPED', reason=$2 WHERE id=$1`, [postingId, reason]);
    await appendAudit(tx, orgId, { userId: actor, action: 'RECURRING_EXPENSE_SKIPPED', entityType: 'recurring_expense', entityId: t.id, oldValue: null, newValue: { month: periodKey(year, month), reason } });
    return { status: 'SKIPPED', reason };
  };
  const period = await getOrCreatePeriod(tx, orgId, year, month, true);
  if (isClosed(period)) return skip(`${label(year, month)} was already finalized. If it belongs in that month, add it in an open month as an adjustment.`);
  if (!(await propertyOk(tx, orgId, t.propertyId))) return skip(`${t.propertyName} is inactive`);
  const date = occurrenceDate(t, year, month);
  const expenseId = await createExpense(tx, orgId, createdBy, {
    propertyId: t.propertyId, date, vendor: t.vendor, description: t.description ?? undefined, category: t.category, amountCents: t.amountCents, taxCents: t.taxCents,
    ownerPaid: t.ownerPaid, reimbursable: t.reimbursable, paymentMethod: t.paymentMethod ?? undefined, notes: t.notes ?? undefined, accountingMonth: periodKey(year, month),
  }, { auditUserId: actor, recurringExpenseId: t.id });
  await tx.query('UPDATE recurring_expense_postings SET expense_id=$2 WHERE id=$1', [postingId, expenseId]);
  await appendAudit(tx, orgId, { userId: actor, action: 'RECURRING_EXPENSE_POSTED', entityType: 'recurring_expense', entityId: t.id, oldValue: null,
    newValue: { month: periodKey(year, month), expenseId, amountCents: t.amountCents, taxCents: t.taxCents, automatic: actor === null } });
  return { status: 'POSTED', expenseId };
}

const creatorOf = async (db: Db, id: string) => (await db.query('SELECT created_by FROM recurring_expenses WHERE id=$1', [id])).rows[0].created_by as string;

/** Marks one upcoming (or due, not yet posted) occurrence as skipped. */
export async function skipOccurrence(tx: Tx, orgId: string, userId: string, id: string, year: number, month: number, reason?: string): Promise<void> {
  const t = await getRecurring(tx, orgId, id);
  if (!t) throw new UserError('Recurring expense not found');
  if (!occursIn(t, year, month)) throw new UserError(`${t.vendor} does not occur in ${label(year, month)}`);
  const r = await tx.query(
    `INSERT INTO recurring_expense_postings(organization_id, recurring_expense_id, year, month, status, reason, posted_by) VALUES ($1,$2,$3,$4,'SKIPPED',$5,$6)
     ON CONFLICT (recurring_expense_id, year, month) DO NOTHING RETURNING id`, [orgId, id, year, month, reason?.trim() || 'Skipped by a manager', userId]);
  if (!r.rowCount) throw new UserError(`${label(year, month)} was already posted or skipped. To remove a posted one, delete that expense.`, 409);
  await appendAudit(tx, orgId, { userId, action: 'RECURRING_EXPENSE_SKIPPED', entityType: 'recurring_expense', entityId: id, oldValue: null, newValue: { month: periodKey(year, month), reason: reason ?? null } });
}

/** Undoes a skip: the occurrence is posted the next time posting runs (immediately if it is already due). */
export async function unskipOccurrence(tx: Tx, orgId: string, userId: string, id: string, year: number, month: number): Promise<void> {
  const r = await tx.query(`DELETE FROM recurring_expense_postings WHERE recurring_expense_id=$1 AND organization_id=$2 AND year=$3 AND month=$4 AND status='SKIPPED' RETURNING id`, [id, orgId, year, month]);
  if (!r.rowCount) throw new UserError(`${label(year, month)} is not skipped`);
  await appendAudit(tx, orgId, { userId, action: 'RECURRING_EXPENSE_UNSKIPPED', entityType: 'recurring_expense', entityId: id, oldValue: null, newValue: { month: periodKey(year, month) } });
}

/**
 * Posts every active template's occurrences for one accounting month, whatever their day. Runs inside the monthly close
 * (generate review / finalize) so a closed month always contains its recurring expenses, even if the worker was down.
 */
export async function postMonth(tx: Tx, orgId: string, year: number, month: number, actor: string | null): Promise<number> {
  let n = 0;
  for (const t of (await listRecurring(tx, orgId)).filter((x) => x.active && occursIn(x, year, month))) {
    const r = await postOccurrence(tx, orgId, t, year, month, actor, await creatorOf(tx, t.id));
    if (r.status === 'POSTED') n++;
  }
  return n;
}

/** Posts all occurrences dated on or before `today` that have no posting yet. Each template in its own transaction. */
export async function postDue(pool: Pool, orgId: string, today: string, actor: string | null): Promise<{ posted: number; skipped: number }> {
  const out = { posted: 0, skipped: 0 };
  const active = (await listRecurring(pool, orgId)).filter((t) => t.active);
  if (!active.length) return out;
  const done = new Set((await pool.query(`SELECT recurring_expense_id, year, month FROM recurring_expense_postings WHERE organization_id=$1`, [orgId])).rows.map((x) => `${x.recurring_expense_id}:${x.year}:${x.month}`));
  for (const t of active) {
    const todo = dueOccurrences(t, today).filter((o) => !done.has(`${t.id}:${o.year}:${o.month}`));
    if (!todo.length) continue;
    await withTx(pool, async (tx) => {
      const createdBy = await creatorOf(tx, t.id);
      for (const o of todo) {
        const r = await postOccurrence(tx, orgId, t, o.year, o.month, actor, createdBy);
        if (r.status === 'POSTED') out.posted++; else if (r.status === 'SKIPPED') out.skipped++;
      }
    });
  }
  return out;
}

export const upcomingFor = (t: RecurringRow, today: string, n = 6) => (t.active ? upcomingOccurrences(t, today, n) : []);
export const monthLabel = label;
