import { writeCsv } from '../csv.ts';
import { toDecimal } from '../money.ts';
import { periodKey } from '../accounting/period.ts';
import type { Statement } from '../accounting/statement.ts';

export interface StatementRow { ownerName: string; propertyName: string; statement: Statement }

const n = (c: number) => ({ n: toDecimal(c) });

/** Documented, fixed column order. Rows sorted by owner, property for deterministic output. */
export const MONTHLY_STATEMENT_COLUMNS = [
  'Statement Month', 'Owner', 'Property', 'Airbnb Gross Revenue', 'Airbnb Fees', 'Airbnb Adjustments',
  'Airbnb Net Payout', 'Property Expenses', 'Management Commission', 'Owner Net Proceeds',
];

export function monthlyStatementCsv(rows: StatementRow[]): string {
  const sorted = [...rows].sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.propertyName.localeCompare(b.propertyName));
  return writeCsv(MONTHLY_STATEMENT_COLUMNS, sorted.map(({ ownerName, propertyName, statement: s }) => [
    periodKey(s.year, s.month), ownerName, propertyName, n(s.revenue.grossBookingCents), n(s.revenue.platformFeeCents),
    n(s.revenue.adjustmentCents), n(s.revenue.netPayoutCents), n(s.expensesCents), n(s.commission.commissionCents), n(s.ownerProceedsCents),
  ]));
}

export const COMMISSION_COLUMNS = ['Statement Month', 'Property', 'Rule', 'Calculation Basis', 'Base Amount', 'Rate %', 'Fixed Amount', 'Commission', 'Explanation'];

/** Manager commission ledger (the LLC's revenue). */
export function managerCommissionCsv(rows: StatementRow[]): string {
  const sorted = [...rows].sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  return writeCsv(COMMISSION_COLUMNS, sorted.map(({ propertyName, statement: s }) => [
    periodKey(s.year, s.month), propertyName, s.commission.rule.id, s.commission.calculationBasis, n(s.commission.baseCents),
    { n: (s.commission.rateBps / 100).toFixed(2) }, n(s.commission.fixedCents), n(s.commission.commissionCents), s.commission.explanation,
  ]));
}

export const TRANSACTION_COLUMNS = ['Statement Month', 'Property', 'Type', 'Date', 'Source ID', 'Category', 'Description', 'Amount'];

export function monthlyTransactionCsv(rows: StatementRow[]): string {
  const out: (string | { n: string })[][] = [];
  for (const { propertyName, statement: s } of [...rows].sort((a, b) => a.propertyName.localeCompare(b.propertyName))) {
    for (const l of s.lines) out.push([periodKey(s.year, s.month), propertyName, l.type, l.date ?? '', l.sourceId, l.category ?? '', l.description, n(l.amountCents)]);
  }
  return writeCsv(TRANSACTION_COLUMNS, out);
}

export const ANNUAL_COLUMNS = ['Month', 'Gross Revenue', 'Airbnb Fees', 'Property Expenses', 'Management Commission', 'Owner Net Proceeds'];

export function annualOwnerCsv(year: number, statements: Statement[]): string {
  const rows: (string | { n: string })[][] = [];
  const tot = [0, 0, 0, 0, 0];
  for (let m = 1; m <= 12; m++) {
    const ss = statements.filter((s) => s.year === year && s.month === m);
    const v = [
      ss.reduce((a, s) => a + s.revenue.grossBookingCents, 0), ss.reduce((a, s) => a + s.revenue.platformFeeCents, 0),
      ss.reduce((a, s) => a + s.expensesCents, 0), ss.reduce((a, s) => a + s.commission.commissionCents, 0),
      ss.reduce((a, s) => a + s.ownerProceedsCents, 0),
    ];
    v.forEach((x, i) => (tot[i] += x));
    rows.push([periodKey(year, m), ...v.map(n)]);
  }
  rows.push(['Total', ...tot.map(n)]);
  return writeCsv(ANNUAL_COLUMNS, rows);
}
