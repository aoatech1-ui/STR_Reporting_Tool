import type { Db, Tx } from '../db/pool.ts';
import type { Statement } from '../accounting/statement.ts';

export type StatementStatus = 'DRAFT' | 'REVIEW' | 'FINALIZED' | 'LOCKED';
export interface StoredStatement { id: string; statementNumber: string; status: StatementStatus; ownerId: string; ownerName: string; propertyId: string; propertyName: string; statement: Statement; generatedAt: string; finalizedAt: string | null }

export const statementNumber = (year: number, month: number, id: string) => `STM-${year}${String(month).padStart(2, '0')}-${id.slice(0, 8).toUpperCase()}`;

export async function deleteDraftStatements(tx: Tx, orgId: string, periodId: string): Promise<void> {
  const ids = `(SELECT id FROM owner_statements WHERE organization_id=$1 AND accounting_period_id=$2 AND status IN ('DRAFT','REVIEW'))`;
  await tx.query(`DELETE FROM statement_line_items WHERE statement_id IN ${ids}`, [orgId, periodId]);
  await tx.query(`DELETE FROM commission_calculations WHERE statement_id IN ${ids}`, [orgId, periodId]);
  await tx.query(`DELETE FROM owner_statements WHERE id IN ${ids}`, [orgId, periodId]);
}

export async function insertDraftStatement(tx: Tx, orgId: string, s: Statement): Promise<string> {
  const r = await tx.query(
    `INSERT INTO owner_statements(organization_id, owner_id, property_id, accounting_period_id, statement_number, gross_cents, platform_fees_cents, net_revenue_cents,
       expenses_cents, commission_cents, adjustments_cents, owner_proceeds_cents, derivation, snapshot, status)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT') RETURNING id`,
    [orgId, s.ownerId, s.propertyId, s.periodId, s.revenue.grossBookingCents, s.revenue.platformFeeCents, s.revenue.netPayoutCents, s.expensesCents,
      s.commission.commissionCents, s.adjustmentsCents, s.ownerProceedsCents, JSON.stringify(s.derivation), JSON.stringify(s)]);
  const id = r.rows[0].id as string;
  await tx.query('UPDATE owner_statements SET statement_number=$2 WHERE id=$1', [id, statementNumber(s.year, s.month, id)]);
  const c = s.commission;
  await tx.query(
    `INSERT INTO commission_calculations(statement_id, property_id, accounting_period_id, commission_rule_id, rule_snapshot, calculation_basis, base_cents, rate_bps, fixed_cents, commission_cents, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, s.propertyId, s.periodId, c.rule.id, JSON.stringify(c.rule), c.calculationBasis, c.baseCents, c.rateBps, c.fixedCents, c.commissionCents, c.explanation]);
  for (const l of s.lines) {
    await tx.query('INSERT INTO statement_line_items(statement_id, type, description, category, line_date, amount_cents, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, l.type, l.description, l.category, l.date, l.amountCents, l.sourceId]);
  }
  return id;
}

export async function finalizeStatements(tx: Tx, orgId: string, periodId: string): Promise<{ id: string; statementNumber: string }[]> {
  const r = await tx.query(
    `UPDATE owner_statements SET status='FINALIZED', finalized_at=now() WHERE organization_id=$1 AND accounting_period_id=$2 AND status IN ('DRAFT','REVIEW')
     RETURNING id, statement_number`, [orgId, periodId]);
  return r.rows.map((x) => ({ id: x.id, statementNumber: x.statement_number }));
}

const map = (x: any): StoredStatement => ({ id: x.id, statementNumber: x.statement_number, status: x.status, ownerId: x.owner_id, ownerName: x.owner_name,
  propertyId: x.property_id, propertyName: x.property_name, statement: x.snapshot as Statement, generatedAt: new Date(x.generated_at).toISOString(),
  finalizedAt: x.finalized_at ? new Date(x.finalized_at).toISOString() : null });

export async function loadStatements(db: Db, orgId: string, f: { id?: string; year?: number; throughMonth?: number; periodId?: string; ownerId?: string; propertyId?: string; statuses?: StatementStatus[] } = {}): Promise<StoredStatement[]> {
  const r = await db.query(
    `SELECT s.*, o.display_name AS owner_name, p.name AS property_name FROM owner_statements s
       JOIN owners o ON o.id=s.owner_id JOIN properties p ON p.id=s.property_id JOIN accounting_periods ap ON ap.id=s.accounting_period_id
     WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND ($3::int IS NULL OR ap.year=$3) AND ($4::int IS NULL OR ap.month<=$4)
       AND ($5::uuid IS NULL OR s.accounting_period_id=$5) AND ($6::uuid IS NULL OR s.owner_id=$6) AND ($7::uuid IS NULL OR s.property_id=$7)
       AND ($8::text[] IS NULL OR s.status::text = ANY($8))
     ORDER BY ap.year, ap.month, o.display_name, p.name`,
    [orgId, f.id ?? null, f.year ?? null, f.throughMonth ?? null, f.periodId ?? null, f.ownerId ?? null, f.propertyId ?? null, f.statuses ?? null]);
  return r.rows.map(map);
}

/** For the public signed-link route, which has no session: resolves the owning organization of a statement id. */
export async function statementOrg(db: Db, id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query('SELECT organization_id FROM owner_statements WHERE id=$1', [id]);
  return r.rows[0]?.organization_id ?? null;
}
