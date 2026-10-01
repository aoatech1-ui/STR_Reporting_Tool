import { formatMoney, sum, type Cents } from '../money.ts';
import type { EarningsRecord } from '../providers/types.ts';
import { calculateCommission, type CommissionCalculation, type CommissionRule, type RevenueTotals } from './commission.ts';

export interface ExpenseInput {
  id: string; date: string; vendor: string; description: string; category: string;
  amountCents: Cents; taxCents: Cents;
  ownerPaid: boolean;       // owner paid vendor directly: shown, not deducted
  reimbursable?: boolean;
}
export interface ManualAdjustment { id: string; description: string; amountCents: Cents }

export type LineType = 'EARNINGS' | 'EXPENSE' | 'COMMISSION' | 'ADJUSTMENT';
export interface StatementLine { type: LineType; sourceId: string; date: string | null; description: string; category: string | null; amountCents: Cents }

export interface Statement {
  ownerId: string; propertyId: string; periodId: string; year: number; month: number;
  revenue: RevenueTotals;
  expensesCents: Cents;               // owner-borne expenses deducted
  expensesByCategory: Record<string, Cents>;
  ownerPaidExpensesCents: Cents;      // informational
  adjustmentsCents: Cents;
  commission: CommissionCalculation;
  ownerProceedsCents: Cents;
  lines: StatementLine[];
  /** Human-readable derivation of ownerProceeds, step by step. */
  derivation: string[];
}

export function totalsFrom(records: EarningsRecord[]): RevenueTotals {
  const s = (f: (r: EarningsRecord) => number) => sum(records.map(f));
  return {
    grossBookingCents: s((r) => r.grossBookingCents), cleaningFeeCents: s((r) => r.cleaningFeeCents),
    otherRevenueCents: s((r) => r.otherRevenueCents), platformFeeCents: s((r) => r.platformFeeCents),
    taxCents: s((r) => r.taxCents), adjustmentCents: s((r) => r.adjustmentCents), refundCents: s((r) => r.refundCents),
    coHostPayoutCents: s((r) => r.coHostPayoutCents), netPayoutCents: s((r) => r.netPayoutCents),
  };
}

export interface StatementInput {
  ownerId: string; propertyId: string; periodId: string; year: number; month: number;
  earnings: EarningsRecord[]; expenses: ExpenseInput[]; adjustments?: ManualAdjustment[]; rule: CommissionRule;
}

/**
 * Owner proceeds = Airbnb net payout − owner-borne expenses − management commission ± manual adjustments.
 * Net payout is authoritative (it already reflects fees, refunds and Airbnb adjustments); component
 * fields are informational and never re-added, so nothing is double counted.
 */
export function buildStatement(inp: StatementInput): Statement {
  const revenue = totalsFrom(inp.earnings);
  const charged = inp.expenses.filter((e) => !e.ownerPaid);
  const expensesCents = sum(charged.map((e) => e.amountCents + e.taxCents));
  const ownerPaidExpensesCents = sum(inp.expenses.filter((e) => e.ownerPaid).map((e) => e.amountCents + e.taxCents));
  const expensesByCategory: Record<string, Cents> = {};
  for (const e of charged) expensesByCategory[e.category] = (expensesByCategory[e.category] ?? 0) + e.amountCents + e.taxCents;
  const adjustments = inp.adjustments ?? [];
  const adjustmentsCents = sum(adjustments.map((a) => a.amountCents));
  const commission = calculateCommission(revenue, inp.rule);
  const ownerProceedsCents = revenue.netPayoutCents - expensesCents - commission.commissionCents + adjustmentsCents;

  const lines: StatementLine[] = [
    ...inp.earnings.map((r): StatementLine => ({ type: 'EARNINGS', sourceId: r.sourceTransactionId, date: r.earningsDate,
      description: `${r.kind}${r.reservationId ? ' ' + r.reservationId : ''}`, category: null, amountCents: r.netPayoutCents })),
    ...inp.expenses.map((e): StatementLine => ({ type: 'EXPENSE', sourceId: e.id, date: e.date,
      description: `${e.vendor}: ${e.description}${e.ownerPaid ? ' (owner-paid, not deducted)' : ''}`, category: e.category,
      amountCents: e.ownerPaid ? 0 : -(e.amountCents + e.taxCents) })),
    { type: 'COMMISSION', sourceId: inp.rule.id, date: null, description: `Management fee: ${commission.explanation}`, category: null,
      amountCents: -commission.commissionCents },
    ...adjustments.map((a): StatementLine => ({ type: 'ADJUSTMENT', sourceId: a.id, date: null, description: a.description, category: null, amountCents: a.amountCents })),
  ];
  const derivation = [
    `Airbnb net payout ${formatMoney(revenue.netPayoutCents)}`,
    `− property expenses ${formatMoney(expensesCents)}`,
    `− management fee ${formatMoney(commission.commissionCents)} (${commission.explanation})`,
    ...(adjustmentsCents ? [`± adjustments ${formatMoney(adjustmentsCents)}`] : []),
    `= owner net proceeds ${formatMoney(ownerProceedsCents)}`,
  ];
  return { ownerId: inp.ownerId, propertyId: inp.propertyId, periodId: inp.periodId, year: inp.year, month: inp.month,
    revenue, expensesCents, expensesByCategory, ownerPaidExpensesCents, adjustmentsCents, commission, ownerProceedsCents, lines, derivation };
}

export interface YtdTotals { grossCents: Cents; platformFeesCents: Cents; expensesCents: Cents; commissionsCents: Cents; ownerProceedsCents: Cents }

/** YTD = sum of FINALIZED statements for the year through `throughMonth`, derived from stored statements only. */
export function computeYtd(finalized: Statement[], year: number, throughMonth: number): YtdTotals {
  const s = finalized.filter((x) => x.year === year && x.month <= throughMonth);
  return {
    grossCents: sum(s.map((x) => x.revenue.grossBookingCents)), platformFeesCents: sum(s.map((x) => x.revenue.platformFeeCents)),
    expensesCents: sum(s.map((x) => x.expensesCents)), commissionsCents: sum(s.map((x) => x.commission.commissionCents)),
    ownerProceedsCents: sum(s.map((x) => x.ownerProceedsCents)),
  };
}

export const STATEMENT_DISCLAIMER =
  'This statement is a management accounting summary and is not tax, legal, or investment advice. Please consult your tax professional regarding the appropriate treatment of income and expenses for your circumstances.';
