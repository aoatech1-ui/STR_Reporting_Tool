import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../src/db/pool.ts';
import { buildApp } from '../../src/server/app.ts';
import { signLink } from '../../src/delivery/links.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { enqueue, runOnce } from '../../src/worker/queue.ts';
import { renderStatementPdf } from '../../src/pdf/render.ts';
import { loadStatementDoc, sha256, statementCsv } from '../../src/services/documents.ts';
import { generateStatements, STATEMENT_FILES_JOB } from '../../src/services/close.ts';
import { loadStatements } from '../../src/repo/statements.ts';
import { listAudit } from '../../src/repo/audit.ts';
import { addUser, Client, testConfig } from './httpkit.ts';
import { finalizedOrg, freshDb, seed, skip, tmpStore } from './helper.ts';

const HAVE_POPPLER = spawnSync('pdftotext', ['-v']).status !== null;
const pdfText = (b: Buffer) => { const f = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'x.pdf'); writeFileSync(f, b); return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); };

describe('statement files: PDF + CSV archive, downloads, public link', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, app: FastifyInstance, o: Awaited<ReturnType<typeof finalizedOrg>>;
  const files = tmpStore();
  const worker = () => buildHandlers({ pool, files, email: null, whatsapp: null, linkSecret: 'x'.repeat(40), baseUrl: 'https://app.test' });
  const drain = async () => { const h = worker(); let n = 0; while (await runOnce(pool, h)) n++; return n; };
  let mgr: Client, viewer: Client;

  before(async () => {
    ({ pool, close } = await freshDb());
    app = await buildApp({ pool, config: testConfig(), email: null, files });
    o = await finalizedOrg(pool);
    await addUser(pool, o.orgId, 'MANAGER', 'm@doc.test'); await addUser(pool, o.orgId, 'VIEWER', 'v@doc.test');
    mgr = await new Client(app).login('m@doc.test'); viewer = await new Client(app).login('v@doc.test');
  });
  after(async () => { await app.close(); await close(); });

  test('finalizing queues exactly one file job per statement; until it runs the PDF is rendered on demand', async () => {
    const jobs = (await pool.query(`SELECT payload, status FROM jobs WHERE type=$1 AND organization_id=$2`, [STATEMENT_FILES_JOB, o.orgId])).rows;
    assert.deepEqual(jobs.map((j) => [j.payload.statementId, j.status]), [[o.statementId, 'QUEUED']]);
    const d = (await viewer.get(`/api/statements/${o.statementId}`)).json();
    assert.equal(d.files.pdfArchived, false);
    const r = await viewer.get(`/api/statements/${o.statementId}/pdf`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.match(String(r.headers['content-disposition']), /attachment; filename="STM-202609-[0-9A-F]{8}\.pdf"/);
    assert.equal(r.rawPayload.subarray(0, 5).toString(), '%PDF-');
  });

  test('worker archives PDF + CSV with size and SHA-256, links them once, audits it, and is idempotent', async () => {
    assert.equal(await drain(), 1);
    const [st] = await pool.query(`SELECT pdf_attachment_id, csv_attachment_id FROM owner_statements WHERE id=$1`, [o.statementId]).then((r) => r.rows);
    assert.ok(st.pdf_attachment_id && st.csv_attachment_id);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = ANY($1::uuid[]) ORDER BY content_type DESC`, [[st.pdf_attachment_id, st.csv_attachment_id]])).rows;
    assert.deepEqual(att.map((a) => a.content_type), ['text/csv', 'application/pdf'].sort().reverse());
    for (const a of att) {
      const bytes = (await files.get(a.storage_key))!;
      assert.equal(bytes.length, a.size_bytes); assert.equal(sha256(bytes), a.sha256);
      assert.match(a.storage_key, new RegExp(`^${o.orgId}/statements/${o.statementId}/STM-`));
    }
    const pdf = att.find((a) => a.content_type === 'application/pdf'), csv = att.find((a) => a.content_type === 'text/csv');
    assert.equal((await files.get(pdf.storage_key))!.subarray(0, 5).toString(), '%PDF-');
    const doc = (await loadStatementDoc(pool, o.orgId, o.statementId))!;
    assert.equal((await files.get(csv.storage_key))!.toString(), statementCsv(doc.stored));
    assert.ok((await files.get(pdf.storage_key))!.equals(await renderStatementPdf(doc.pdf)), 'archived bytes equal a fresh render (deterministic)');
    const audit = (await listAudit(pool, o.orgId, { entityId: o.statementId })).find((a) => a.action === 'STATEMENT_FILES_GENERATED')!;
    assert.deepEqual([audit.userName, (audit.newValue as any).pdfSha256], [null, pdf.sha256]);

    await enqueue(pool, { orgId: o.orgId, type: STATEMENT_FILES_JOB, payload: { statementId: o.statementId } }); // a duplicate job
    await drain();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE organization_id=$1', [o.orgId])).rows[0].n, 2, 'no extra attachments');
  });

  test('archived file is served as-is; a corrupted archive is detected and replaced by a fresh render', async () => {
    const d = (await viewer.get(`/api/statements/${o.statementId}`)).json();
    assert.deepEqual([d.files.pdfArchived, d.files.pdfBytes > 1000], [true, true]);
    const served = await viewer.get(`/api/statements/${o.statementId}/pdf`);
    const key = (await pool.query(`SELECT storage_key FROM attachments WHERE id=(SELECT pdf_attachment_id FROM owner_statements WHERE id=$1)`, [o.statementId])).rows[0].storage_key;
    assert.ok(served.rawPayload.equals((await files.get(key))!));
    await files.put(key, Buffer.from('%PDF-corrupted garbage'), 'application/pdf');
    const after = await viewer.get(`/api/statements/${o.statementId}/pdf`);
    assert.equal(after.statusCode, 200);
    assert.ok(after.rawPayload.equals(served.rawPayload), 'fell back to a deterministic re-render identical to the original');
    await files.put(key, served.rawPayload, 'application/pdf'); // restore
  });

  test('database keeps the archive immutable: links cannot be changed or cleared, nothing else on the statement may change', async () => {
    const other = (await pool.query(`INSERT INTO attachments(organization_id, storage_key, filename, content_type, size_bytes, sha256) VALUES ($1,'x/y/z.pdf','z.pdf','application/pdf',1,'00') RETURNING id`, [o.orgId])).rows[0].id;
    await assert.rejects(() => pool.query('UPDATE owner_statements SET pdf_attachment_id=$2 WHERE id=$1', [o.statementId, other]), /immutable/);
    await assert.rejects(() => pool.query('UPDATE owner_statements SET pdf_attachment_id=NULL WHERE id=$1', [o.statementId]), /immutable/);
    await assert.rejects(() => pool.query('UPDATE owner_statements SET owner_proceeds_cents=1 WHERE id=$1', [o.statementId]), /immutable/);
    await assert.rejects(() => pool.query('UPDATE owner_statements SET owner_proceeds_cents=1, pdf_attachment_id=pdf_attachment_id WHERE id=$1', [o.statementId]), /immutable/);
  });

  test('draft statements get a watermarked, freshly rendered PDF and never an archive', { skip: !HAVE_POPPLER && 'poppler not installed' }, async () => {
    const d = await seed(pool);
    await addUser(pool, d.orgId, 'MANAGER', 'm2@doc.test');
    await generateStatements(pool, d.orgId, d.userId, 2026, 8);
    const [st] = await loadStatements(pool, d.orgId, { year: 2026 });
    const c = await new Client(app).login('m2@doc.test');
    const r = await c.get(`/api/statements/${st.id}/pdf`);
    assert.equal(r.statusCode, 200);
    assert.match(pdfText(r.rawPayload), /DRAFT/);
    assert.ok(!/DRAFT/.test(pdfText(await viewer.get(`/api/statements/${o.statementId}/pdf`).then((x) => x.rawPayload))), 'finalized PDF has no watermark');
  });

  test('owner link: PDF download works without login, only for finalized statements, and only with a valid token', async () => {
    const token = signLink(o.statementId, 'x'.repeat(40), Date.now() + 60_000);
    const r = await app.inject(`/s/${token}/pdf`);
    assert.equal(r.statusCode, 200); assert.equal(r.headers['x-robots-tag'], 'noindex');
    assert.equal(r.rawPayload.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await app.inject(`/s/${token.slice(0, -2)}xx/pdf`)).statusCode, 404);
    assert.equal((await app.inject(`/s/${signLink(o.statementId, 'x'.repeat(40), Date.now() - 1)}/pdf`)).statusCode, 404, 'expired');
    const d = await seed(pool);
    await generateStatements(pool, d.orgId, d.userId, 2026, 7);
    const [draft] = await loadStatements(pool, d.orgId, { year: 2026 });
    assert.equal((await app.inject(`/s/${signLink(draft.id, 'x'.repeat(40), Date.now() + 60_000)}/pdf`)).statusCode, 404, 'a draft is never reachable by link');
  });

  test('annual PDF endpoint, permissions and tenant isolation', async () => {
    const r = await viewer.get(`/api/annual.pdf?year=2026&ownerId=${o.ownerId}`);
    assert.equal(r.statusCode, 200); assert.match(String(r.headers['content-disposition']), /annual-statement-2026\.pdf/);
    assert.equal(r.rawPayload.subarray(0, 5).toString(), '%PDF-');
    if (HAVE_POPPLER) assert.match(pdfText(r.rawPayload).replace(/\s+/g, ''), /\$4,800\.00/);
    assert.equal((await app.inject(`/api/annual.pdf?year=2026&ownerId=${o.ownerId}`)).statusCode, 401);
    assert.equal((await viewer.get(`/api/annual.pdf?year=2026&ownerId=00000000-0000-4000-8000-000000000000`)).statusCode, 404);
    assert.equal((await viewer.get(`/api/annual.pdf?year=1999&ownerId=${o.ownerId}`)).statusCode, 400);
    const other = await finalizedOrg(pool);
    await addUser(pool, other.orgId, 'ADMIN', 'a-other@doc.test');
    const b = await new Client(app).login('a-other@doc.test');
    assert.equal((await b.get(`/api/statements/${o.statementId}/pdf`)).statusCode, 404);
    assert.equal((await b.get(`/api/annual.pdf?year=2026&ownerId=${o.ownerId}`)).statusCode, 404);
    assert.equal((await app.inject('/api/statements/' + o.statementId + '/pdf')).statusCode, 401);
  });

  test('file job for a statement that is not finalized fails permanently instead of retrying', async () => {
    const d = await seed(pool);
    await generateStatements(pool, d.orgId, d.userId, 2026, 6);
    const [st] = await loadStatements(pool, d.orgId, { year: 2026 });
    await enqueue(pool, { orgId: d.orgId, type: STATEMENT_FILES_JOB, payload: { statementId: st.id } });
    await drain();
    const j = (await pool.query(`SELECT status, attempts, last_error FROM jobs WHERE organization_id=$1`, [d.orgId])).rows[0];
    assert.deepEqual([j.status, j.attempts], ['FAILED', 1]);
    assert.match(j.last_error, /not found or not finalized/);
  });
});
