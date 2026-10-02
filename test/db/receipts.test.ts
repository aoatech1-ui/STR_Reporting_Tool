import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { buildApp } from '../../src/server/app.ts';
import { createExpense } from '../../src/repo/expenses.ts';
import { listAudit, verifyAuditChain } from '../../src/repo/audit.ts';
import { generateStatements, finalizePeriod } from '../../src/services/close.ts';
import { sha256 } from '../../src/services/documents.ts';
import { addUser, Client, testConfig } from './httpkit.ts';
import { freshDb, seed, skip, tmpStore } from './helper.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = (n = 0) => Buffer.from(`%PDF-1.4\n% receipt ${n}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);

describe('receipts', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, app: FastifyInstance, o: Awaited<ReturnType<typeof seed>>;
  const files = tmpStore();
  let mgr: Client, acct: Client, viewer: Client;
  const expense = (vendor: string, cents: number, date = '2026-09-10') => withTx(pool, (tx) => createExpense(tx, o.orgId, o.userId, { propertyId: o.propertyId, date, vendor, category: 'Repairs', amountCents: cents }));
  const up = (c: Client, id: string, bytes: Buffer, type: string, name = 'receipt.png') => c.put(`/api/expenses/${id}/receipt?filename=${encodeURIComponent(name)}`, bytes, type);
  const blobCount = async () => (await pool.query('SELECT count(*)::int AS n FROM attachments WHERE organization_id=$1', [o.orgId])).rows[0].n;

  before(async () => {
    ({ pool, close } = await freshDb());
    app = await buildApp({ pool, config: testConfig(), email: null, files });
    o = await seed(pool);
    await addUser(pool, o.orgId, 'MANAGER', 'm@r.test'); await addUser(pool, o.orgId, 'ACCOUNTANT', 'a@r.test'); await addUser(pool, o.orgId, 'VIEWER', 'v@r.test');
    mgr = await new Client(app).login('m@r.test'); acct = await new Client(app).login('a@r.test'); viewer = await new Client(app).login('v@r.test');
  });
  after(async () => { await app.close(); await close(); });

  test('upload: stored by content not name, hashed, listed on the expense, audited; download is an attachment with nosniff', async () => {
    const id = await expense('Fix-It', 12000);
    const r = await up(acct, id, PNG, 'image/png', '../../etc/passwd');
    assert.equal(r.statusCode, 201);
    const rec = r.json().receipt;
    assert.deepEqual([rec.filename, rec.contentType, rec.sizeBytes, rec.sha256], ['passwd', 'image/png', PNG.length, sha256(PNG)]);
    const key = (await pool.query('SELECT storage_key FROM attachments WHERE id=$1', [rec.id])).rows[0].storage_key;
    assert.equal(key, `${o.orgId}/receipts/${rec.id}.png`);
    assert.ok(!key.includes('passwd'), 'user-supplied name never reaches the storage key');
    assert.ok((await files.get(key))!.equals(PNG));

    const d = (await viewer.get(`/api/expenses/${id}`)).json();
    assert.deepEqual(d.receipts.map((x: any) => [x.filename, x.sizeBytes]), [['passwd', PNG.length]]);
    assert.ok(!('storageKey' in d.receipts[0]), 'storage keys are not exposed');
    assert.equal(d.expense.receiptCount, 1);

    const dl = await viewer.get(`/api/receipts/${rec.id}`);
    assert.equal(dl.statusCode, 200);
    assert.ok(dl.rawPayload.equals(PNG));
    assert.match(String(dl.headers['content-disposition']), /^attachment;/);
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
    const prev = await viewer.get(`/api/receipts/${rec.id}/preview`);
    assert.equal(prev.statusCode, 200); assert.equal(prev.headers['content-type'], 'image/png');
    const actions = (await listAudit(pool, o.orgId, { entityType: 'expense', entityId: id })).map((a) => a.action);
    assert.ok(actions.includes('RECEIPT_ADDED'));
  });

  test('rejects anything that is not really a PDF/PNG/JPEG/WebP, whatever the client claims', async () => {
    const id = await expense('Hostile', 9000);
    const before = await blobCount();
    for (const [name, bytes, type, status] of [
      ['html as png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 415],
      ['svg as jpeg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/jpeg', 415],
      ['exe as pdf', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'application/pdf', 415],
      ['empty', Buffer.alloc(0), 'application/pdf', 400],
    ] as const) { const r = await up(acct, id, bytes as Buffer, type, 'x.pdf'); assert.equal(r.statusCode, status, name); }
    assert.equal((await acct.put(`/api/expenses/${id}/receipt`, PNG, 'text/html')).statusCode, 415, 'unsupported declared type');
    assert.equal(await blobCount(), before, 'nothing was stored');
  });

  test('size limit, duplicates, and per-expense cap', async () => {
    const id = await expense('Limits', 9000);
    const big = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]);
    assert.equal((await up(acct, id, big, 'application/pdf')).statusCode, 413);
    assert.equal((await up(acct, id, pdf(1), 'application/pdf')).statusCode, 201);
    const dup = await up(acct, id, pdf(1), 'application/pdf');
    assert.equal(dup.statusCode, 409); assert.match(dup.json().error, /already attached/);
    for (let i = 2; i <= 10; i++) assert.equal((await up(acct, id, pdf(i), 'application/pdf')).statusCode, 201);
    const cap = await up(acct, id, pdf(99), 'application/pdf');
    assert.equal(cap.statusCode, 422); assert.match(cap.json().error, /at most 10/);
  });

  test('permissions: viewers cannot upload or delete; unauthenticated and CSRF-less requests are refused before the body is used', async () => {
    const id = await expense('Perm', 9000);
    assert.equal((await up(viewer, id, PNG, 'image/png')).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/expenses/${id}/receipt`, headers: { 'content-type': 'image/png' }, payload: PNG })).statusCode, 401);
    assert.equal((await acct.put(`/api/expenses/${id}/receipt`, PNG, 'image/png', { csrf: null })).statusCode, 403);
    assert.equal((await acct.put(`/api/expenses/${id}/receipt`, PNG, 'image/png', { csrf: 'wrong' })).statusCode, 403);
    const rec = (await up(acct, id, PNG, 'image/png')).json().receipt;
    assert.equal((await viewer.call('DELETE', `/api/receipts/${rec.id}`)).statusCode, 403);
    assert.equal((await app.inject(`/api/receipts/${rec.id}`)).statusCode, 401);
    assert.equal((await viewer.get(`/api/receipts/${rec.id}/preview`)).statusCode, 200);
    assert.equal((await viewer.get('/api/receipts/not-a-uuid')).statusCode, 400);
  });

  test('preview only for images; storage damage is detected, not served', async () => {
    const id = await expense('Integrity', 9000);
    const p = (await up(acct, id, pdf(7), 'application/pdf', 'invoice.pdf')).json().receipt;
    assert.equal((await viewer.get(`/api/receipts/${p.id}/preview`)).statusCode, 415);
    const key = (await pool.query('SELECT storage_key FROM attachments WHERE id=$1', [p.id])).rows[0].storage_key;
    await files.put(key, Buffer.from('%PDF-tampered'), 'application/pdf');
    const bad = await viewer.get(`/api/receipts/${p.id}`);
    assert.equal(bad.statusCode, 500); assert.match(bad.json().error, /integrity check/);
    await files.delete(key);
    const gone = await viewer.get(`/api/receipts/${p.id}`);
    assert.equal(gone.statusCode, 410);
  });

  test('delete while the month is open removes link, record and file; deleting the expense removes its receipts too', async () => {
    const id = await expense('Deletable', 9000);
    const r = (await up(acct, id, PNG, 'image/png')).json().receipt;
    const key = `${o.orgId}/receipts/${r.id}.png`;
    assert.equal((await mgr.call('DELETE', `/api/receipts/${r.id}`)).statusCode, 200);
    assert.equal(await files.get(key), null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE id=$1', [r.id])).rows[0].n, 0);
    assert.equal((await mgr.call('DELETE', `/api/receipts/${r.id}`)).statusCode, 404);
    assert.ok((await listAudit(pool, o.orgId, { entityId: id })).some((a) => a.action === 'RECEIPT_REMOVED'));

    const r2 = (await up(acct, id, pdf(3), 'application/pdf')).json().receipt;
    const key2 = `${o.orgId}/receipts/${r2.id}.pdf`;
    assert.equal((await mgr.call('DELETE', `/api/expenses/${id}`)).statusCode, 200);
    assert.equal(await files.get(key2), null, 'blob removed with the expense');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE id=$1', [r2.id])).rows[0].n, 0);
  });

  test('missing-receipt exception: appears for expenses of $75+ without a receipt and clears once one is attached', async () => {
    const big = await expense('Roofer', 7500, '2026-03-10'), small = await expense('Hardware', 7499, '2026-03-11'), credit = await expense('Refund', -9000, '2026-03-12');
    void small; void credit;
    const gen = async () => (await generateStatements(pool, o.orgId, o.userId, 2026, 3)).exceptions.filter((e) => e.code === 'MISSING_RECEIPT');
    const first = await gen();
    assert.equal(first.length, 1); assert.equal(first[0].severity, 'WARNING'); assert.match(first[0].message, /^1 expense\(s\) of \$75\.00 or more/);
    await up(acct, big, PNG, 'image/png');
    assert.equal((await gen()).length, 0);
  });

  test('closed months: receipts may still be added (documentation), but never removed', async () => {
    const id = await expense('Late paperwork', 20000, '2026-04-10');
    await generateStatements(pool, o.orgId, o.userId, 2026, 4);
    await finalizePeriod(pool, o.orgId, o.userId, 2026, 4, { acknowledgeCritical: true });
    const added = await up(acct, id, PNG, 'image/png', 'late.png');
    assert.equal(added.statusCode, 201, 'documenting a closed-month expense is allowed');
    const rec = added.json().receipt;
    const del = await mgr.call('DELETE', `/api/receipts/${rec.id}`);
    assert.equal(del.statusCode, 422); assert.match(del.json().error, /FINALIZED/);
    assert.ok((await files.get(`${o.orgId}/receipts/${rec.id}.png`))!.equals(PNG), 'file still there');
    assert.equal((await mgr.call('DELETE', `/api/expenses/${id}`)).statusCode, 422, 'closed-month expense cannot be deleted either');
    assert.equal(await verifyAuditChain(pool, o.orgId), null);
  });

  test('tenant isolation: another organization can neither read, add to, nor delete these receipts', async () => {
    const id = await expense('Private', 9000);
    const rec = (await up(acct, id, PNG, 'image/png')).json().receipt;
    const other = await seed(pool);
    await addUser(pool, other.orgId, 'ADMIN', 'admin@other.test');
    const b = await new Client(app).login('admin@other.test');
    const before = await blobCount();
    assert.equal((await b.get(`/api/receipts/${rec.id}`)).statusCode, 404);
    assert.equal((await b.get(`/api/receipts/${rec.id}/preview`)).statusCode, 404);
    assert.equal((await b.call('DELETE', `/api/receipts/${rec.id}`)).statusCode, 404);
    assert.equal((await up(b, id, pdf(55), 'application/pdf')).statusCode, 404);
    assert.equal(await blobCount(), before, 'no blob created for a foreign expense');
    assert.equal((await b.get(`/api/expenses/${id}`)).statusCode, 404);
  });
});
