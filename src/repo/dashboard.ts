import type { Db } from '../db/pool.ts';
import { countUnmatched } from './earnings.ts';
import { countFailedDeliveries } from './deliveries.ts';
import { monthRange } from './periods.ts';

export interface Dashboard {
  month: { revenueCents: number; expensesCents: number; commissionsCents: number; ownerDistributionsCents: number };
  ytd: { revenueCents: number; expensesCents: number; commissionsCents: number };
  properties: number; owners: number;
  awaitingReview: number; readyToSend: number; failedDeliveries: number; missingExpenses: number; unmatchedTransactions: number; importErrors: number;
}

const one = async (db: Db, q: string, v: unknown[]) => (await db.query(q, v)).rows[0] as Record<string, number>;

export async function getDashboard(db: Db, orgId: string, year: number, month: number): Promise<Dashboard> {
  const { start, end } = monthRange(year, month);
  const rev = await one(db, `SELECT coalesce(sum(net_payout_cents),0) AS v FROM earnings_transactions WHERE organization_id=$1 AND earnings_date BETWEEN $2 AND $3`, [orgId, start, end]);
  const exp = await one(db, `SELECT coalesce(sum(e.total_cents) FILTER (WHERE NOT e.owner_paid),0) AS v FROM expenses e JOIN accounting_periods p ON p.id=e.accounting_period_id
    WHERE e.organization_id=$1 AND p.year=$2 AND p.month=$3`, [orgId, year, month]);
  const st = await one(db, `SELECT coalesce(sum(s.commission_cents),0) AS c, coalesce(sum(s.owner_proceeds_cents),0) AS o FROM owner_statements s JOIN accounting_periods p ON p.id=s.accounting_period_id
    WHERE s.organization_id=$1 AND p.year=$2 AND p.month=$3`, [orgId, year, month]);
  const ytd = await one(db, `SELECT coalesce(sum(s.net_revenue_cents),0) AS r, coalesce(sum(s.expenses_cents),0) AS e, coalesce(sum(s.commission_cents),0) AS c
    FROM owner_statements s JOIN accounting_periods p ON p.id=s.accounting_period_id WHERE s.organization_id=$1 AND p.year=$2 AND p.month<=$3`, [orgId, year, month]);
  const counts = await one(db, `SELECT (SELECT count(*) FROM properties WHERE organization_id=$1 AND active) AS props, (SELECT count(*) FROM owners WHERE organization_id=$1 AND active) AS owners,
    (SELECT count(*) FROM owner_statements WHERE organization_id=$1 AND status IN ('DRAFT','REVIEW')) AS review,
    (SELECT count(*) FROM owner_statements s WHERE s.organization_id=$1 AND s.status='FINALIZED' AND NOT EXISTS
       (SELECT 1 FROM statement_deliveries d WHERE d.statement_id=s.id AND d.status IN ('SENT','DELIVERED'))) AS ready,
    (SELECT count(*) FROM properties pr WHERE pr.organization_id=$1 AND pr.active AND NOT EXISTS
       (SELECT 1 FROM expenses e JOIN accounting_periods ap ON ap.id=e.accounting_period_id WHERE e.property_id=pr.id AND ap.year=$2 AND ap.month=$3)) AS noexp,
    (SELECT count(*) FROM import_rejected_rows WHERE organization_id=$1 AND earnings_date BETWEEN $4 AND $5) AS imperr`, [orgId, year, month, start, end]);
  return {
    month: { revenueCents: rev.v, expensesCents: exp.v, commissionsCents: st.c, ownerDistributionsCents: st.o },
    ytd: { revenueCents: ytd.r, expensesCents: ytd.e, commissionsCents: ytd.c },
    properties: counts.props, owners: counts.owners, awaitingReview: counts.review, readyToSend: counts.ready,
    failedDeliveries: await countFailedDeliveries(db, orgId), missingExpenses: counts.noexp,
    unmatchedTransactions: await countUnmatched(db, orgId, start, end), importErrors: counts.imperr,
  };
}
