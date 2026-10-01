export type PeriodStatus = 'DRAFT' | 'REVIEW' | 'FINALIZED' | 'LOCKED';
export interface AccountingPeriod { id: string; year: number; month: number; status: PeriodStatus }

const NEXT: Record<PeriodStatus, PeriodStatus[]> = {
  DRAFT: ['REVIEW'], REVIEW: ['DRAFT', 'FINALIZED'], FINALIZED: ['LOCKED'], LOCKED: [],
};

export const periodKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
export const periodOf = (isoDate: string) => ({ year: Number(isoDate.slice(0, 4)), month: Number(isoDate.slice(5, 7)) });
export const isClosed = (p: Pick<AccountingPeriod, 'status'>) => p.status === 'FINALIZED' || p.status === 'LOCKED';

/** Throws if financial records in this period may not be changed directly. Corrections go through adjustments. */
export function assertEditable(p: AccountingPeriod): void {
  if (isClosed(p)) throw new Error(`Period ${periodKey(p.year, p.month)} is ${p.status}; use an adjustment/reversal in an open period`);
}

export interface TransitionOpts { criticalExceptions?: number; managerAcknowledged?: boolean }

export function transition(p: AccountingPeriod, to: PeriodStatus, opts: TransitionOpts = {}): AccountingPeriod {
  if (!NEXT[p.status].includes(to)) throw new Error(`Illegal period transition ${p.status} → ${to}`);
  if (to === 'FINALIZED' && (opts.criticalExceptions ?? 0) > 0 && !opts.managerAcknowledged) {
    throw new Error(`${opts.criticalExceptions} critical exception(s) require manager review before finalizing`);
  }
  return { ...p, status: to };
}
