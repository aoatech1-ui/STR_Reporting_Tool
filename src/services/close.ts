import { withTx, type Pool, type Tx } from '../db/pool.ts';
import { selectRule } from '../accounting/commission.ts';
import { evaluateStatement, RECEIPT_THRESHOLD_CENTS, type ExceptionItem } from '../accounting/exceptions.ts';
import { enqueue } from '../worker/queue.ts';
import { assertEditable } from '../accounting/period.ts';
import { buildStatement, type Statement } from '../accounting/statement.ts';
import { appendAudit } from '../repo/audit.ts';
import { countUnmatched, listEarnings } from '../repo/earnings.ts';
import { listExpenses } from '../repo/expenses.ts';
import { getOwner } from '../repo/owners.ts';
import { getOrCreatePeriod, setPeriodStatus, type PeriodRow } from '../repo/periods.ts';
import { listManagedProperties, listRules } from '../repo/properties.ts';
import { deleteDraftStatements, finalizeStatements, insertDraftStatement } from '../repo/statements.ts';
import { UserError } from '../errors.ts';

export const STATEMENT_FILES_JOB = 'generate_statement_files';

export interface DraftResult { statements: { id: string; statement: Statement }[]; exceptions: ExceptionItem[] }

/** Rebuilds all draft statements for an open period from source records. Pure function of DB state; deterministic. */
async function generateInTx(tx: Tx, orgId: string, userId: string, period: PeriodRow): Promise<DraftResult> {
  assertEditable(period);
  await deleteDraftStatements(tx, orgId, period.id);
  const exceptions: ExceptionItem[] = [];
  const out: DraftResult['statements'] = [];
  for (const prop of await listManagedProperties(tx, orgId, period.startDate, period.endDate)) {
    let rule;
    try { rule = selectRule(await listRules(tx, prop.id), period.endDate); }
    catch (e) { exceptions.push({ code: 'NO_COMMISSION_RULE', severity: 'CRITICAL', message: `${prop.name}: ${(e as Error).message}`, propertyId: prop.id }); continue; }
    const owner = (await getOwner(tx, orgId, prop.ownerId))!;
    const expenses = await listExpenses(tx, orgId, { periodId: period.id, propertyId: prop.id });
    const statement = buildStatement({
      ownerId: prop.ownerId, propertyId: prop.id, periodId: period.id, year: period.year, month: period.month, rule,
      earnings: await listEarnings(tx, orgId, prop.id, period.startDate, period.endDate), expenses,
    });
    const id = await insertDraftStatement(tx, orgId, statement);
    out.push({ id, statement });
    exceptions.push(...evaluateStatement(statement,
      { email: owner.email, emailEnabled: owner.emailEnabled, whatsappPhone: owner.whatsappPhone, whatsappEnabled: owner.whatsappEnabled, whatsappOptIn: owner.whatsappOptIn },
      { unmatchedTransactions: 0, uncategorizedExpenses: 0, negativeExpenses: expenses.filter((e) => e.amountCents < 0).length,
        missingReceipts: expenses.filter((e) => !e.reverses && e.amountCents + e.taxCents >= RECEIPT_THRESHOLD_CENTS && e.receiptCount === 0).length }));
  }
  const unmatched = await countUnmatched(tx, orgId, period.startDate, period.endDate);
  if (unmatched > 0) exceptions.push({ code: 'UNMATCHED_REVENUE', severity: 'CRITICAL', message: `${unmatched} Airbnb transaction(s) not matched to a property` });
  await appendAudit(tx, orgId, { userId, action: 'STATEMENTS_GENERATED', entityType: 'accounting_period', entityId: period.id, oldValue: null,
    newValue: { count: out.length, exceptions: exceptions.length } });
  return { statements: out, exceptions };
}

/** Manager's "review" step: (re)generates drafts and moves DRAFT → REVIEW. Safe to re-run until finalized. */
export async function generateStatements(pool: Pool, orgId: string, userId: string, year: number, month: number): Promise<DraftResult & { period: PeriodRow }> {
  return withTx(pool, async (tx) => {
    let period = await getOrCreatePeriod(tx, orgId, year, month, true);
    const res = await generateInTx(tx, orgId, userId, period);
    if (period.status === 'DRAFT') period = await setPeriodStatus(tx, orgId, userId, period, 'REVIEW');
    return { ...res, period };
  });
}

/**
 * Finalize: regenerates inside the same transaction (so what is locked equals what is current), refuses on critical
 * exceptions unless acknowledged, then freezes statements and the period. All-or-nothing.
 */
export async function finalizePeriod(pool: Pool, orgId: string, userId: string, year: number, month: number, opts: { acknowledgeCritical?: boolean } = {}) {
  return withTx(pool, async (tx) => {
    let period = await getOrCreatePeriod(tx, orgId, year, month, true);
    const res = await generateInTx(tx, orgId, userId, period);
    if (res.statements.length === 0) throw new UserError('Nothing to finalize: no statements were generated');
    if (period.status === 'DRAFT') period = await setPeriodStatus(tx, orgId, userId, period, 'REVIEW');
    const critical = res.exceptions.filter((e) => e.severity === 'CRITICAL').length;
    period = await setPeriodStatus(tx, orgId, userId, period, 'FINALIZED', { criticalExceptions: critical, managerAcknowledged: opts.acknowledgeCritical });
    const finalized = await finalizeStatements(tx, orgId, period.id);
    for (const s of finalized) {
      // PDF + CSV are rendered by the worker (never in the request) and archived against the statement.
      await enqueue(tx, { orgId, type: STATEMENT_FILES_JOB, payload: { statementId: s.id }, dedupeKey: `files:${s.id}` });
      await appendAudit(tx, orgId, { userId, action: 'STATEMENT_FINALIZED', entityType: 'owner_statement', entityId: s.id, oldValue: null, newValue: { statementNumber: s.statementNumber } });
    }
    return { period, statementIds: finalized.map((s) => s.id), exceptions: res.exceptions };
  });
}
