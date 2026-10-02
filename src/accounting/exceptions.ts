import type { Statement } from './statement.ts';

/** Expenses at or above this amount should have a receipt on file. */
export const RECEIPT_THRESHOLD_CENTS = 7500;

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';
export interface ExceptionItem { code: string; severity: Severity; message: string; propertyId?: string }

export interface OwnerContact { email: string | null; emailEnabled: boolean; whatsappPhone: string | null; whatsappEnabled: boolean; whatsappOptIn: boolean }

export function evaluateStatement(
  s: Statement, owner: OwnerContact, ctx: { unmatchedTransactions: number; uncategorizedExpenses: number; negativeExpenses: number; missingReceipts?: number },
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  const add = (code: string, severity: Severity, message: string) => out.push({ code, severity, message, propertyId: s.propertyId });
  if (ctx.unmatchedTransactions > 0) add('UNMATCHED_REVENUE', 'CRITICAL', `${ctx.unmatchedTransactions} Airbnb transaction(s) not matched to a property`);
  if (s.ownerProceedsCents < 0) add('NEGATIVE_OWNER_PROCEEDS', 'CRITICAL', 'Owner proceeds are negative');
  if (ctx.uncategorizedExpenses > 0) add('MISSING_EXPENSE_CATEGORY', 'WARNING', `${ctx.uncategorizedExpenses} expense(s) without category`);
  if (ctx.negativeExpenses > 0) add('INVALID_EXPENSE', 'WARNING', `${ctx.negativeExpenses} expense(s) with negative amount`);
  if ((ctx.missingReceipts ?? 0) > 0) add('MISSING_RECEIPT', 'WARNING', `${ctx.missingReceipts} expense(s) of $${RECEIPT_THRESHOLD_CENTS / 100}.00 or more have no receipt attached`);
  if (s.revenue.netPayoutCents === 0 && s.lines.every((l) => l.type !== 'EARNINGS')) add('NO_REVENUE', 'INFO', 'No Airbnb activity this month');
  if (owner.emailEnabled && !owner.email) add('MISSING_OWNER_EMAIL', 'WARNING', 'Email delivery enabled but no owner email');
  if (owner.whatsappEnabled && !owner.whatsappOptIn) add('MISSING_WHATSAPP_OPT_IN', 'WARNING', 'WhatsApp enabled without opt-in; will not send');
  return out;
}
