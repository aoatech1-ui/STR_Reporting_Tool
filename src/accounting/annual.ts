import type { Cents } from '../money.ts';
import type { Statement } from './statement.ts';

export interface AnnualMonth { month: number; grossCents: Cents; platformFeesCents: Cents; netPayoutCents: Cents; expensesCents: Cents; commissionCents: Cents; adjustmentsCents: Cents; ownerProceedsCents: Cents }
export interface AnnualReport {
  year: number; months: AnnualMonth[]; totals: Omit<AnnualMonth, 'month'>;
  expenseCategories: { category: string; cents: Cents }[]; statementCount: number;
  explanation: string; disclaimer: string;
}

export const ANNUAL_EXPLANATION =
  'Your annual statement summarizes property-related income, expenses, management fees, and owner proceeds recorded by the manager. ' +
  'Gross revenue is booking revenue before Airbnb fees; the net payout is what Airbnb paid after its fees, adjustments and refunds. ' +
  'Owner proceeds are net payout less property expenses and management fees. Use these figures as supporting information when preparing your ' +
  'tax records and provide the report to your tax professional.';
export const ANNUAL_DISCLAIMER =
  'This report is a management accounting summary. It is not a tax return and does not determine any tax treatment. Tax treatment can vary ' +
  'based on ownership structure, deductions, depreciation, rental classification, and other circumstances. Please consult your tax professional.';

/** Pure aggregation of finalized statements for one year (one owner, one or many properties). */
export function buildAnnualReport(year: number, statements: Statement[]): AnnualReport {
  const zero = () => ({ grossCents: 0, platformFeesCents: 0, netPayoutCents: 0, expensesCents: 0, commissionCents: 0, adjustmentsCents: 0, ownerProceedsCents: 0 });
  const months: AnnualMonth[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...zero() }));
  const totals = zero();
  const cats = new Map<string, number>();
  const rows = statements.filter((s) => s.year === year);
  for (const s of rows) {
    const m = months[s.month - 1];
    const add = { grossCents: s.revenue.grossBookingCents, platformFeesCents: s.revenue.platformFeeCents, netPayoutCents: s.revenue.netPayoutCents,
      expensesCents: s.expensesCents, commissionCents: s.commission.commissionCents, adjustmentsCents: s.adjustmentsCents, ownerProceedsCents: s.ownerProceedsCents };
    for (const k of Object.keys(add) as (keyof typeof add)[]) { m[k] += add[k]; totals[k] += add[k]; }
    for (const [c, v] of Object.entries(s.expensesByCategory)) cats.set(c, (cats.get(c) ?? 0) + v);
  }
  return { year, months, totals, statementCount: rows.length,
    expenseCategories: [...cats].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    explanation: ANNUAL_EXPLANATION, disclaimer: ANNUAL_DISCLAIMER };
}
