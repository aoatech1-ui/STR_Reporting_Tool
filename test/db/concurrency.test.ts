import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { confirmCsvImport } from '../../src/services/import.ts';
import { createExpense } from '../../src/repo/expenses.ts';
import { verifyAuditChain } from '../../src/repo/audit.ts';
import { migrate } from '../../src/db/migrate.ts';
import { CSV, freshDb, seed, skip } from './helper.ts';

describe('concurrency', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, s: Awaited<ReturnType<typeof seed>>;
  before(async () => { ({ pool, close } = await freshDb()); s = await seed(pool); });
  after(async () => { await close(); });

  test('simultaneous imports of the same file store each transaction exactly once', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => confirmCsvImport(pool, s.orgId, s.userId, 'same.csv', CSV, true)));
    assert.equal(results.reduce((a, r) => a + r.imported, 0), 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM earnings_transactions')).rows[0].n, 2);
  });

  test('parallel writers keep the audit hash chain intact', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      withTx(pool, (tx) => createExpense(tx, s.orgId, s.userId, { propertyId: s.propertyId, date: '2026-09-02', vendor: `V${i}`, category: 'Other', amountCents: 100 + i }))));
    assert.equal(await verifyAuditChain(pool, s.orgId), null);
  });

  test('migrations are idempotent', async () => {
    assert.deepEqual(await migrate(pool), []);
  });
});
