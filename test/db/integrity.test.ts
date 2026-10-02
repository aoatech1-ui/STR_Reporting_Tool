import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '../../src/db/pool.ts';
import { withTx } from '../../src/db/pool.ts';
import { createExpense } from '../../src/repo/expenses.ts';
import { uploadReceipt } from '../../src/services/receipts.ts';
import { verifyDataIntegrity } from '../../src/ops/integrity.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import { finalizedOrg, freshDb, skip, tmpStore } from './helper.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('data integrity verifier', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, o: Awaited<ReturnType<typeof finalizedOrg>>;
  const files = tmpStore();
  const codes = async (opts: { deep?: boolean; files?: boolean } = {}) => (await verifyDataIntegrity(pool, { files: opts.files === false ? undefined : files, deep: opts.deep })).violations.map((v) => v.code).sort();
  /** Privileged tampering: what a compromised DB account could do. Triggers are disabled for the statement, then restored. */
  const tamper = async (sql: string, triggers: [string, string][] = []) => {
    for (const [t, n] of triggers) await pool.query(`ALTER TABLE ${t} DISABLE TRIGGER ${n}`);
    try { await pool.query(sql); } finally { for (const [t, n] of triggers) await pool.query(`ALTER TABLE ${t} ENABLE TRIGGER ${n}`); }
  };

  before(async () => {
    ({ pool, close } = await freshDb());
    o = await finalizedOrg(pool);
    const h = buildHandlers({ pool, files, email: null, whatsapp: null, linkSecret: 'x'.repeat(40), baseUrl: 'https://x.test' });
    while (await runOnce(pool, h)) { /* archive statement files */ }
    const eid = await withTx(pool, (tx) => createExpense(tx, o.orgId, o.userId, { propertyId: o.propertyId, date: '2026-10-05', vendor: 'Open month', category: 'Repairs', amountCents: 5000 }));
    await uploadReceipt(pool, files, o.orgId, o.userId, eid, 'r.png', PNG);
  });
  after(async () => { await close(); });

  test('a healthy database passes, and reports what it checked', async () => {
    const r = await verifyDataIntegrity(pool, { files, deep: true });
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.checked, { organizations: 1, statements: 1, files: 3 }, '2 statement files + 1 receipt');
    assert.equal((await verifyDataIntegrity(pool, { files })).checked.files, 2, 'receipts only with deep');
  });

  test('drafts are not held to finalized-statement rules', async () => {
    await pool.query(`INSERT INTO accounting_periods(organization_id, year, month, start_date, end_date) VALUES ($1,2026,11,'2026-11-01','2026-11-30')`, [o.orgId]);
    assert.deepEqual(await codes(), []);
  });

  test('detects: an owner-borne expense slipped into (or altered in) a finalized month', async () => {
    const insert = `INSERT INTO expenses(organization_id, property_id, owner_id, accounting_period_id, category_id, expense_date, vendor, amount_cents, created_by)
      SELECT $1, $2, $3, (SELECT id FROM accounting_periods WHERE organization_id=$1 AND month=9), (SELECT id FROM expense_categories WHERE organization_id=$1 LIMIT 1), '2026-09-15', 'Backdated', 12345, $4`;
    await pool.query('ALTER TABLE expenses DISABLE TRIGGER expenses_period_guard');
    try { await pool.query(insert, [o.orgId, o.propertyId, o.ownerId, o.userId]); } finally { await pool.query('ALTER TABLE expenses ENABLE TRIGGER expenses_period_guard'); }
    const found = (await verifyDataIntegrity(pool, { files })).violations.filter((v) => v.code === 'EXPENSES_CHANGED');
    assert.equal(found.length, 1); assert.match(found[0].message, /now total 12345, the statement says 0/);
    await tamper(`UPDATE expenses SET amount_cents = 1 WHERE vendor='Backdated'`, [['expenses', 'expenses_period_guard']]);
    assert.match((await verifyDataIntegrity(pool, { files })).violations.find((v) => v.code === 'EXPENSES_CHANGED')!.message, /now total 1,/);
    await tamper(`DELETE FROM expenses WHERE vendor='Backdated'`, [['expenses', 'expenses_period_guard']]);
    assert.deepEqual(await codes(), [], 'removing the tamper restores a clean report');
  });

  test('detects: imported revenue altered after finalization', async () => {
    await tamper(`UPDATE earnings_transactions SET net_payout_cents = net_payout_cents + 1`, [['earnings_transactions', 'earnings_period_guard']]);
    assert.ok((await codes()).includes('REVENUE_CHANGED'));
    await tamper(`UPDATE earnings_transactions SET net_payout_cents = net_payout_cents - 1`, [['earnings_transactions', 'earnings_period_guard']]);
  });

  test('detects: statement lines no longer add up; snapshot disagrees with the row', async () => {
    await pool.query(`UPDATE statement_line_items SET amount_cents = amount_cents + 5 WHERE id=(SELECT id FROM statement_line_items ORDER BY id LIMIT 1)`);
    assert.ok((await codes()).includes('LINES_DO_NOT_SUM'));
    await pool.query(`UPDATE statement_line_items SET amount_cents = amount_cents - 5 WHERE id=(SELECT id FROM statement_line_items ORDER BY id LIMIT 1)`);
    await tamper(`UPDATE owner_statements SET snapshot = jsonb_set(snapshot, '{ownerProceedsCents}', '1')`, [['owner_statements', 'statements_freeze']]);
    assert.ok((await codes()).includes('SNAPSHOT_MISMATCH'));
    await tamper(`UPDATE owner_statements SET snapshot = jsonb_set(snapshot, '{ownerProceedsCents}', to_jsonb(owner_proceeds_cents))`, [['owner_statements', 'statements_freeze']]);
    assert.deepEqual(await codes(), []);
  });

  test('detects: archived statement files corrupted or missing; receipts too in deep mode', async () => {
    const rows = (await pool.query(`SELECT storage_key, content_type FROM attachments WHERE organization_id=$1`, [o.orgId])).rows;
    const pdf = rows.find((r) => r.content_type === 'application/pdf').storage_key, receipt = rows.find((r) => r.content_type === 'image/png').storage_key;
    const good = (await files.get(pdf))!;
    await files.put(pdf, Buffer.concat([good, Buffer.from(' ')]), 'application/pdf');
    assert.deepEqual(await codes(), ['FILE_CORRUPT']);
    await files.delete(pdf);
    assert.deepEqual(await codes(), ['FILE_MISSING']);
    await files.put(pdf, good, 'application/pdf');
    assert.deepEqual(await codes(), []);
    await files.put(receipt, Buffer.from('not the receipt'), 'image/png');
    assert.deepEqual(await codes(), [], 'receipts are only re-hashed in deep mode');
    assert.deepEqual(await codes({ deep: true }), ['FILE_CORRUPT']);
    await files.put(receipt, PNG, 'image/png');
    assert.deepEqual(await codes({ deep: true }), []);
    assert.deepEqual(await codes({ files: false }), [], 'skipping files skips file checks');
  });

  test('detects: audit log tampering, and a finalized statement sitting in an open period', async () => {
    await tamper(`UPDATE audit_logs SET new_value='{"forged":1}' WHERE id=(SELECT min(id) FROM audit_logs)`, [['audit_logs', 'audit_no_update']]);
    assert.ok((await codes()).includes('AUDIT_CHAIN_BROKEN'));
  });

  test('detects a finalized statement whose period was reopened', async () => {
    await tamper(`UPDATE accounting_periods SET status='REVIEW' WHERE month=9`);
    assert.ok((await codes()).includes('PERIOD_NOT_CLOSED'));
  });
});
