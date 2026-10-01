import type { Db, Tx } from '../db/pool.ts';
import { transition, type AccountingPeriod, type PeriodStatus, type TransitionOpts } from '../accounting/period.ts';
import { appendAudit } from './audit.ts';

export interface PeriodRow extends AccountingPeriod { startDate: string; endDate: string; finalizedAt: string | null }

const pad = (n: number) => String(n).padStart(2, '0');
export const monthRange = (year: number, month: number) => ({
  start: `${year}-${pad(month)}-01`,
  end: `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`,
});

const map = (x: any): PeriodRow => ({ id: x.id, year: x.year, month: x.month, status: x.status, startDate: x.start_date, endDate: x.end_date,
  finalizedAt: x.finalized_at ? new Date(x.finalized_at).toISOString() : null });

export async function getOrCreatePeriod(tx: Tx, orgId: string, year: number, month: number, lock = false): Promise<PeriodRow> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('Invalid accounting month');
  const { start, end } = monthRange(year, month);
  await tx.query(
    `INSERT INTO accounting_periods(organization_id, year, month, start_date, end_date) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, year, month) DO NOTHING`, [orgId, year, month, start, end]);
  const r = await tx.query(`SELECT * FROM accounting_periods WHERE organization_id=$1 AND year=$2 AND month=$3 ${lock ? 'FOR UPDATE' : ''}`, [orgId, year, month]);
  return map(r.rows[0]);
}

export async function getPeriod(db: Db, orgId: string, year: number, month: number): Promise<PeriodRow | null> {
  const r = await db.query('SELECT * FROM accounting_periods WHERE organization_id=$1 AND year=$2 AND month=$3', [orgId, year, month]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function listPeriods(db: Db, orgId: string): Promise<PeriodRow[]> {
  return (await db.query('SELECT * FROM accounting_periods WHERE organization_id=$1 ORDER BY year DESC, month DESC', [orgId])).rows.map(map);
}

/** FINALIZED/LOCKED month ranges, loaded once so import preview can check locks synchronously. */
export async function closedRanges(db: Db, orgId: string): Promise<{ start: string; end: string }[]> {
  const r = await db.query(`SELECT start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND status IN ('FINALIZED','LOCKED')`, [orgId]);
  return r.rows.map((x) => ({ start: x.start_date, end: x.end_date }));
}

/** Validated status change (row must be locked by caller via getOrCreatePeriod(..., true)). */
export async function setPeriodStatus(tx: Tx, orgId: string, userId: string, p: PeriodRow, to: PeriodStatus, opts: TransitionOpts = {}): Promise<PeriodRow> {
  const next = transition(p, to, opts);
  await tx.query(
    `UPDATE accounting_periods SET status=$2::period_status, finalized_at = CASE WHEN $2::text = 'FINALIZED' THEN now() ELSE finalized_at END,
       finalized_by = CASE WHEN $2::text = 'FINALIZED' THEN $3::uuid ELSE finalized_by END WHERE id=$1`, [p.id, to, userId]);
  await appendAudit(tx, orgId, { userId, action: `PERIOD_${to}`, entityType: 'accounting_period', entityId: p.id, oldValue: { status: p.status },
    newValue: { status: to, acknowledgedCritical: opts.managerAcknowledged ?? false } });
  return { ...p, status: next.status };
}
