import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../src/db/pool.ts';
import { verifyAuditChain } from '../../src/repo/audit.ts';
import { buildApp } from '../../src/server/app.ts';
import { generateStatements } from '../../src/services/close.ts';
import { postDueRecurringExpenses } from '../../src/services/recurring.ts';
import { freshDb, seed, skip, tmpStore } from './helper.ts';
import { addUser, Client, testConfig } from './httpkit.ts';

describe('recurring expenses', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, app: FastifyInstance;
  const clock = { t: Date.parse('2026-10-05T15:00:00Z') };
  const now = () => new Date(clock.t);
  before(async () => {
    ({ pool, close } = await freshDb());
    app = await buildApp({ pool, config: testConfig(), email: null, files: tmpStore(), now });
  });
  after(async () => { await app.close(); await close(); });

  async function org(prefix: string) {
    const s = await seed(pool);
    await addUser(pool, s.orgId, 'MANAGER', `${prefix}-mgr@rx.test`);
    await addUser(pool, s.orgId, 'VIEWER', `${prefix}-viewer@rx.test`);
    const c = await new Client(app).login(`${prefix}-mgr@rx.test`);
    const mgrId = (await pool.query(`SELECT id FROM users WHERE email=$1`, [`${prefix}-mgr@rx.test`])).rows[0].id;
    return { ...s, c, mgrId };
  }
  const body = (propertyId: string, o: object = {}) => ({ propertyId, vendor: 'Comcast', category: 'Utilities', amountCents: 8999, taxCents: 0, intervalMonths: 1, dayOfMonth: 15, startMonth: '2026-10', ...o });
  const expensesOf = async (id: string) => (await pool.query(`SELECT e.*, p.year, p.month FROM expenses e JOIN accounting_periods p ON p.id=e.accounting_period_id WHERE e.recurring_expense_id=$1 ORDER BY e.expense_date`, [id])).rows;
  const postings = async (id: string) => (await pool.query(`SELECT * FROM recurring_expense_postings WHERE recurring_expense_id=$1 ORDER BY year, month`, [id])).rows;

  test('create: validation and permissions; nothing posted before its day; posted once on its day, as an ordinary expense in that month', async () => {
    const o = await org('a');
    for (const bad of [{ amountCents: 0 }, { intervalMonths: 4 }, { dayOfMonth: 32 }, { startMonth: '2026-13' }, { startMonth: '2025-01' }, { endMonth: '2026-09' }])
      assert.ok([400, 422].includes((await o.c.post('/api/recurring-expenses', body(o.propertyId, bad))).statusCode), JSON.stringify(bad));
    const v = await new Client(app).login('a-viewer@rx.test');
    assert.equal((await v.post('/api/recurring-expenses', body(o.propertyId))).statusCode, 403);
    const r = await o.c.post('/api/recurring-expenses', body(o.propertyId));
    assert.equal(r.statusCode, 201, r.body); assert.equal(r.json().posted, 0, 'Oct 15 has not come yet (today is Oct 5)');
    const id = r.json().id;
    const list = (await v.get('/api/recurring-expenses')).json();
    assert.equal(list.recurring[0].schedule, 'Monthly, on the 15th'); assert.equal(list.recurring[0].next, '2026-10-15'); assert.equal(list.monthlyEquivalentCents, 8999);
    assert.equal(await postDueRecurringExpenses(pool, new Date('2026-10-14T23:00:00Z')), 0);
    const counts = await Promise.all([1, 2, 3].map(() => postDueRecurringExpenses(pool, new Date('2026-10-15T00:30:00Z'))));
    assert.equal(counts.reduce((a, b) => a + b, 0), 1, 'concurrent workers post once');
    assert.equal(await postDueRecurringExpenses(pool, new Date('2026-10-20T00:00:00Z')), 0);
    const ex = await expensesOf(id);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].expense_date, '2026-10-15'); assert.equal(ex[0].month, 10); assert.equal(Number(ex[0].amount_cents), 8999); assert.equal(ex[0].recurring, true); assert.equal(ex[0].vendor, 'Comcast');
    const audit = (await pool.query(`SELECT user_id, new_value FROM audit_logs WHERE action='EXPENSE_CREATED' AND entity_id=$1`, [ex[0].id])).rows[0];
    assert.equal(audit.user_id, null, 'automatic posting is audited as the system'); assert.equal(audit.new_value.recurringExpenseId, id);
    const exp = (await o.c.get(`/api/expenses?ym=2026-10`)).json().expenses;
    assert.equal(exp.find((e: any) => e.id === ex[0].id).recurringExpenseId, id);
  });

  test('time zone: the org date decides (New York 9pm Oct 14 is still the 14th)', async () => {
    const o = await org('tz');
    await pool.query(`INSERT INTO reminder_settings(organization_id, timezone) VALUES ($1,'America/New_York')`, [o.orgId]);
    const id = (await o.c.post('/api/recurring-expenses', body(o.propertyId))).json().id;
    await postDueRecurringExpenses(pool, new Date('2026-10-15T01:00:00Z'));
    assert.equal((await expensesOf(id)).length, 0);
    await postDueRecurringExpenses(pool, new Date('2026-10-15T04:30:00Z'));
    assert.equal((await expensesOf(id)).length, 1);
  });

  test('starting in the past posts the open months at once; quarterly and last-day schedules', async () => {
    const o = await org('b');
    const r = await o.c.post('/api/recurring-expenses', body(o.propertyId, { vendor: 'Insurer', category: 'Insurance', amountCents: 30000, startMonth: '2026-07', intervalMonths: 3, dayOfMonth: 31 }));
    assert.equal(r.json().posted, 1, 'July 31 (Oct 31 is not due yet)');
    const ex = await expensesOf(r.json().id);
    assert.deepEqual(ex.map((e) => e.expense_date), ['2026-07-31']);
    const d = (await o.c.get(`/api/recurring-expenses/${r.json().id}`)).json();
    assert.deepEqual(d.upcoming.slice(0, 3).map((u: any) => u.date), ['2026-10-31', '2027-01-31', '2027-04-30']);
    assert.equal(d.recurring.schedule, 'Quarterly, on the last day');
  });

  test('a finalized month is never changed: the occurrence is recorded as skipped with the reason', async () => {
    const o = await org('c');
    // August has no revenue in this org, so the close would refuse to finalize it; mark it finalized directly
    await pool.query(`INSERT INTO accounting_periods(organization_id, year, month, start_date, end_date, status) VALUES ($1,2026,8,'2026-08-01','2026-08-31','FINALIZED')
      ON CONFLICT (organization_id, year, month) DO UPDATE SET status='FINALIZED'`, [o.orgId]);
    const r = await o.c.post('/api/recurring-expenses', body(o.propertyId, { startMonth: '2026-08', dayOfMonth: 1 }));
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual([r.json().posted, r.json().skipped], [2, 1], 'Sep + Oct posted, Aug skipped');
    const p = await postings(r.json().id);
    assert.deepEqual(p.map((x) => [x.month, x.status]), [[8, 'SKIPPED'], [9, 'POSTED'], [10, 'POSTED']]);
    assert.match(p[0].reason, /August 2026 was already finalized/);
  });

  test('closing a month posts its recurring expenses even if their day has not come; they flow into the statement', async () => {
    const o = await org('d');
    const id = (await o.c.post('/api/recurring-expenses', body(o.propertyId, { vendor: 'HOA', category: 'HOA', amountCents: 25000, dayOfMonth: 28 }))).json().id;
    assert.equal((await expensesOf(id)).length, 0);
    const res = await generateStatements(pool, o.orgId, o.userId, 2026, 10);
    assert.equal((await expensesOf(id)).length, 1);
    assert.equal(res.statements[0].statement.expensesCents, 25000);
    await generateStatements(pool, o.orgId, o.userId, 2026, 10);
    assert.equal((await expensesOf(id)).length, 1, 're-running the review does not post again');
    await postDueRecurringExpenses(pool, new Date('2026-10-29T12:00:00Z'));
    assert.equal((await expensesOf(id)).length, 1, 'the worker does not post it again on its day');
  });

  test('skip / unskip a month; deleting a posted expense drops that month without re-posting', async () => {
    const o = await org('e');
    const id = (await o.c.post('/api/recurring-expenses', body(o.propertyId, { dayOfMonth: 1 }))).json().id; // Oct 1 is due: posted
    const [oct] = await expensesOf(id);
    assert.equal((await o.c.call('DELETE', `/api/expenses/${oct.id}`)).statusCode, 200);
    await postDueRecurringExpenses(pool, new Date('2026-10-06T12:00:00Z'));
    assert.equal((await expensesOf(id)).length, 0, 'not re-posted after being deleted');
    const d = (await o.c.get(`/api/recurring-expenses/${id}`)).json();
    assert.equal(d.postings[0].status, 'POSTED'); assert.equal(d.postings[0].expenseId, null);
    assert.equal((await o.c.post(`/api/recurring-expenses/${id}/skip`, { month: '2026-11', reason: 'Owner pays directly in November' })).statusCode, 200);
    assert.equal((await o.c.post(`/api/recurring-expenses/${id}/skip`, { month: '2026-11' })).statusCode, 409);
    assert.equal((await o.c.post(`/api/recurring-expenses/${id}/skip`, { month: '2026-10' })).statusCode, 409, 'already posted');
    await postDueRecurringExpenses(pool, new Date('2026-11-02T12:00:00Z'));
    assert.equal((await expensesOf(id)).length, 0, 'skipped month not posted');
    clock.t = Date.parse('2026-11-02T12:00:00Z');
    await o.c.login('e-mgr@rx.test'); // the clock jump ended the idle session
    const u = await o.c.post(`/api/recurring-expenses/${id}/unskip`, { month: '2026-11' });
    clock.t = Date.parse('2026-10-05T15:00:00Z');
    assert.equal(u.statusCode, 200, u.body); assert.equal(u.json().posted, 1, 'unskipping a due month posts it');
  });

  test('edit changes future occurrences only; stop; delete only when never posted; tenant isolation', async () => {
    const o = await org('f');
    const id = (await o.c.post('/api/recurring-expenses', body(o.propertyId, { dayOfMonth: 1 }))).json().id; // Oct posted at 89.99
    assert.equal((await o.c.call('PATCH', `/api/recurring-expenses/${id}`, { amountCents: 9999 })).statusCode, 200);
    await postDueRecurringExpenses(pool, new Date('2026-11-01T12:00:00Z'));
    assert.deepEqual((await expensesOf(id)).map((e) => Number(e.amount_cents)), [8999, 9999]);
    assert.equal((await o.c.call('PATCH', `/api/recurring-expenses/${id}`, { active: false })).statusCode, 200);
    await postDueRecurringExpenses(pool, new Date('2026-12-01T12:00:00Z'));
    assert.equal((await expensesOf(id)).length, 2, 'stopped: nothing more');
    assert.equal((await o.c.call('DELETE', `/api/recurring-expenses/${id}`)).statusCode, 409);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE action='RECURRING_EXPENSE_STOPPED' AND entity_id=$1`, [id])).rowCount);
    const fresh = (await o.c.post('/api/recurring-expenses', body(o.propertyId, { startMonth: '2027-01' }))).json().id;
    const other = await org('g');
    assert.equal((await other.c.get(`/api/recurring-expenses/${fresh}`)).statusCode, 404);
    assert.equal((await other.c.call('DELETE', `/api/recurring-expenses/${fresh}`)).statusCode, 404);
    assert.equal((await other.c.call('PATCH', `/api/recurring-expenses/${fresh}`, { active: false })).statusCode, 404);
    assert.equal((await other.c.post('/api/recurring-expenses', body(o.propertyId))).statusCode, 404, 'cannot attach to another org’s property');
    assert.equal((await o.c.call('DELETE', `/api/recurring-expenses/${fresh}`)).statusCode, 200);
  });

  test('audit chains stay intact', async () => {
    for (const r of (await pool.query('SELECT id FROM organizations')).rows) assert.equal(await verifyAuditChain(pool, r.id), null);
  });
});
