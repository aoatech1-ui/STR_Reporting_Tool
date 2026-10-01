import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { confirmCsvImport, previewCsvImport } from '../../src/services/import.ts';
import { finalizePeriod, generateStatements } from '../../src/services/close.ts';
import { createExpense, deleteExpense, listExpenses, reverseExpense, updateExpense } from '../../src/repo/expenses.ts';
import { listAudit, verifyAuditChain } from '../../src/repo/audit.ts';
import { loadStatements } from '../../src/repo/statements.ts';
import { getDashboard } from '../../src/repo/dashboard.ts';
import { createProperty, listRules, setCommissionRule } from '../../src/repo/properties.ts';
import { getPeriod } from '../../src/repo/periods.ts';
import { monthlyStatementCsv } from '../../src/export/csv.ts';
import { computeYtd } from '../../src/accounting/statement.ts';
import { CSV, freshDb, seed, skip } from './helper.ts';

describe('Postgres data layer: import → expenses → close', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, s: Awaited<ReturnType<typeof seed>>;
  before(async () => { ({ pool, close } = await freshDb()); s = await seed(pool); });
  after(async () => { await close(); });

  const exp = (e: object) => withTx(pool, (tx) => createExpense(tx, s.orgId, s.userId, e as any));

  test('import: preview is read-only; confirm needed; unmatched is stored; re-import is a no-op', async () => {
    const prev = await previewCsvImport(pool, s.orgId, 'sep.csv', CSV);
    assert.deepEqual([prev.summary.READY, prev.summary.UNMATCHED_PROPERTY], [2, 1]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM earnings_transactions')).rows[0].n, 0);
    await assert.rejects(() => confirmCsvImport(pool, s.orgId, s.userId, 'sep.csv', CSV, false), /confirmation/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_batches')).rows[0].n, 0, 'rolled back');

    const res = await confirmCsvImport(pool, s.orgId, s.userId, 'sep.csv', CSV, true);
    assert.deepEqual([res.imported, res.skipped], [2, 1]);
    const again = await confirmCsvImport(pool, s.orgId, s.userId, 'sep.csv', CSV, true);
    assert.equal(again.imported, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM earnings_transactions')).rows[0].n, 2);
    const dash = await getDashboard(pool, s.orgId, 2026, 9);
    assert.equal(dash.unmatchedTransactions, 1);
    assert.equal(dash.month.revenueCents, 600000);
  });

  test('expenses: validation, audit, edit/delete while open', async () => {
    await assert.rejects(() => exp({ propertyId: s.propertyId, date: '2026-09-10', vendor: 'X', category: 'Repairs', amountCents: 10.5 }), /whole cents/);
    await assert.rejects(() => exp({ propertyId: s.propertyId, date: '2026-09-10', vendor: '', category: 'Repairs', amountCents: 100 }), /Vendor/);
    const e1 = await exp({ propertyId: s.propertyId, date: '2026-09-10', vendor: 'Fix-It', description: 'Roof', category: 'Repairs', amountCents: 50000 });
    await exp({ propertyId: s.propertyId, date: '2026-09-11', vendor: 'Costco', category: 'Supplies', amountCents: 10000 });
    await exp({ propertyId: s.propertyId, date: '2026-09-12', vendor: 'HVAC Co', category: 'Custom Category', amountCents: 20000 });
    await withTx(pool, (tx) => updateExpense(tx, s.orgId, s.userId, e1, { amountCents: 55000 }));
    await withTx(pool, (tx) => updateExpense(tx, s.orgId, s.userId, e1, { amountCents: 50000 }));
    const tmp = await exp({ propertyId: s.propertyId, date: '2026-09-13', vendor: 'Oops', category: 'Other', amountCents: 999 });
    await withTx(pool, (tx) => deleteExpense(tx, s.orgId, s.userId, tmp));
    assert.equal((await listExpenses(pool, s.orgId)).length, 3);
    const actions = (await listAudit(pool, s.orgId, { entityType: 'expense' })).map((a) => a.action);
    assert.ok(['EXPENSE_CREATED', 'EXPENSE_UPDATED', 'EXPENSE_DELETED'].every((a) => actions.includes(a)));
  });

  test('close: finalize is blocked by unmatched revenue until acknowledged; transaction rolls back', async () => {
    const draft = await generateStatements(pool, s.orgId, s.userId, 2026, 9);
    assert.equal(draft.period.status, 'REVIEW');
    assert.ok(draft.exceptions.some((e) => e.code === 'UNMATCHED_REVENUE'));
    await assert.rejects(() => finalizePeriod(pool, s.orgId, s.userId, 2026, 9), /critical exception/);
    assert.equal((await getPeriod(pool, s.orgId, 2026, 9))!.status, 'REVIEW');
    assert.equal((await loadStatements(pool, s.orgId, { statuses: ['FINALIZED'] })).length, 0);
  });

  test('ACCEPTANCE (Postgres): $6,000 − $800 − 20% = $4,000, finalized and frozen', async () => {
    const fin = await finalizePeriod(pool, s.orgId, s.userId, 2026, 9, { acknowledgeCritical: true });
    assert.equal(fin.period.status, 'FINALIZED');
    const [st] = await loadStatements(pool, s.orgId, { statuses: ['FINALIZED'] });
    assert.equal(st.statement.ownerProceedsCents, 400000);
    assert.equal(st.statement.commission.commissionCents, 120000);
    assert.equal(st.statement.commission.explanation, '20% × $6,000.00 = $1,200.00');
    assert.match(st.statementNumber, /^STM-202609-/);
    const lines = await pool.query('SELECT sum(amount_cents)::int AS t, count(*)::int AS n FROM statement_line_items WHERE statement_id=$1', [st.id]);
    assert.equal(lines.rows[0].t, 400000, 'DB line items sum to owner proceeds');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM commission_calculations WHERE statement_id=$1', [st.id])).rows[0].n, 1);
    assert.match(monthlyStatementCsv([{ ownerName: st.ownerName, propertyName: st.propertyName, statement: st.statement }]), /2026-09,John Smith,123 Main Street,6200\.00,200\.00,0\.00,6000\.00,800\.00,1200\.00,4000\.00/);
    assert.equal(computeYtd((await loadStatements(pool, s.orgId, { year: 2026, throughMonth: 9, statuses: ['FINALIZED'] })).map((x) => x.statement), 2026, 9).ownerProceedsCents, 400000);
  });

  test('locked period: writes rejected in app layer AND by database triggers', async () => {
    await assert.rejects(() => exp({ propertyId: s.propertyId, date: '2026-09-20', vendor: 'Late', category: 'Repairs', amountCents: 100 }), /FINALIZED/);
    const [e] = await listExpenses(pool, s.orgId);
    await assert.rejects(() => withTx(pool, (tx) => updateExpense(tx, s.orgId, s.userId, e.id, { amountCents: 1 })), /FINALIZED/);
    await assert.rejects(() => withTx(pool, (tx) => deleteExpense(tx, s.orgId, s.userId, e.id)), /FINALIZED/);
    await assert.rejects(() => pool.query('UPDATE expenses SET amount_cents = 1'), /Period is FINALIZED/);
    await assert.rejects(() => pool.query('UPDATE earnings_transactions SET net_payout_cents = 1'), /Period is FINALIZED/);
    await assert.rejects(() => pool.query('UPDATE owner_statements SET owner_proceeds_cents = 1'), /immutable/);
    await assert.rejects(() => pool.query('DELETE FROM owner_statements'), /cannot be deleted/);
    await assert.rejects(() => generateStatements(pool, s.orgId, s.userId, 2026, 9), /FINALIZED/);
    // import into the closed month is rejected into the exceptions table, never written
    const late = CSV.replace('HM2', 'HM3').replace('09/12/2026,Reservation', '09/13/2026,Reservation');
    const r = await confirmCsvImport(pool, s.orgId, s.userId, 'late.csv', late, true);
    assert.equal(r.imported, 0);
    assert.ok((await pool.query(`SELECT 1 FROM import_rejected_rows WHERE status='PERIOD_LOCKED'`)).rowCount);
  });

  test('correction via reversal in an open month; original untouched', async () => {
    const [orig] = await listExpenses(pool, s.orgId);
    const rev = await withTx(pool, (tx) => reverseExpense(tx, s.orgId, s.userId, orig.id, '2026-10', 'Duplicate invoice'));
    const row = (await listExpenses(pool, s.orgId)).find((e) => e.id === rev)!;
    assert.equal(row.amountCents, -orig.amountCents);
    assert.equal(row.reverses, orig.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM expenses WHERE id=$1 AND amount_cents=$2', [orig.id, orig.amountCents])).rows[0].n, 1);
  });

  test('commission change is forward-only; history keeps its snapshot; overlap impossible', async () => {
    await withTx(pool, (tx) => setCommissionRule(tx, s.orgId, s.userId, s.propertyId, { type: 'PERCENT_NET', rateBps: 2500, fixedCents: 0, includeCleaningFees: true, excludeTaxes: false, hybridBasis: 'NET', effectiveFrom: '2026-10-01' }));
    const rules = await listRules(pool, s.propertyId);
    assert.deepEqual(rules.map((r) => [r.rateBps, r.effectiveFrom, r.effectiveTo]), [[2000, '2026-01-01', '2026-09-30'], [2500, '2026-10-01', null]]);
    const [sep] = await loadStatements(pool, s.orgId, { statuses: ['FINALIZED'] });
    assert.equal(sep.statement.commission.rateBps, 2000);
    assert.equal(sep.statement.ownerProceedsCents, 400000);
    await assert.rejects(() => withTx(pool, (tx) => setCommissionRule(tx, s.orgId, s.userId, s.propertyId, { type: 'FIXED', rateBps: 0, fixedCents: 1, includeCleaningFees: true, excludeTaxes: false, hybridBasis: 'NET', effectiveFrom: '2026-10-01' })), /start after/);
  });

  test('property without commission rule is a critical exception, not a guess', async () => {
    const o = await seed(pool);
    await withTx(pool, (tx) => createProperty(tx, o.orgId, o.userId, { name: 'No Rule Villa', ownerId: o.ownerId }));
    const g = await generateStatements(pool, o.orgId, o.userId, 2026, 7);
    assert.ok(g.exceptions.some((e) => e.code === 'NO_COMMISSION_RULE' && e.severity === 'CRITICAL'));
    assert.equal(g.statements.length, 1);
  });

  test('tenant isolation: another org cannot see or touch these records', async () => {
    const other = await seed(pool);
    assert.equal((await loadStatements(pool, other.orgId, { statuses: ['FINALIZED'] })).length, 0);
    assert.equal((await listExpenses(pool, other.orgId)).length, 0);
    await assert.rejects(() => withTx(pool, (tx) => createExpense(tx, other.orgId, other.userId, { propertyId: s.propertyId, date: '2026-09-01', vendor: 'x', category: 'Other', amountCents: 1 })), /Property not found/);
  });

  test('audit chain verifies, and detects tampering; audit rows are append-only', async () => {
    assert.equal(await verifyAuditChain(pool, s.orgId), null);
    await assert.rejects(() => pool.query('UPDATE audit_logs SET action = $1', ['X']), /append-only/);
    await assert.rejects(() => pool.query('DELETE FROM audit_logs'), /append-only/);
    // simulate a privileged tamper (trigger disabled) → chain verification must flag it
    await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_no_update');
    const id = (await pool.query('SELECT id FROM audit_logs WHERE organization_id=$1 ORDER BY id LIMIT 1 OFFSET 3', [s.orgId])).rows[0].id;
    await pool.query(`UPDATE audit_logs SET new_value = '{"forged":true}' WHERE id=$1`, [id]);
    assert.equal(await verifyAuditChain(pool, s.orgId), id);
    await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_no_update');
  });
});
