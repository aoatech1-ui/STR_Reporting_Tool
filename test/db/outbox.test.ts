import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { queueStatementDelivery } from '../../src/services/send.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import { applyDeliveryWebhook, listDeliveries } from '../../src/repo/deliveries.ts';
import { listAudit, verifyAuditChain } from '../../src/repo/audit.ts';
import { getDashboard } from '../../src/repo/dashboard.ts';
import { generateStatements } from '../../src/services/close.ts';
import { loadStatements } from '../../src/repo/statements.ts';
import { updateOwner } from '../../src/repo/owners.ts';
import { verifyLink } from '../../src/delivery/links.ts';
import { EmailError, type EmailProvider } from '../../src/email/types.ts';
import { finalizedOrg, freshDb, seed, skip, tmpStore } from './helper.ts';

describe('outbox + worker', { skip }, () => {
  let pool: Pool, close: () => Promise<void>;
  before(async () => { ({ pool, close } = await freshDb()); });
  after(async () => { await close(); });

  const clock = { t: Date.parse('2026-10-05T12:00:00Z') };
  const now = () => new Date(clock.t);
  const mkEmail = (script: (n: number) => Error | void) => {
    const sent: any[] = []; let n = 0;
    const p: EmailProvider = { name: 'fake', async send(m) { const e = script(++n); if (e) throw e; sent.push(m); return { messageId: `em-${sent.length}` }; } };
    return { p, sent };
  };
  const handlers = (email: EmailProvider | null, whatsapp: any = null) =>
    buildHandlers({ pool, files: tmpStore(), email, whatsapp, linkSecret: 'link-secret', baseUrl: 'https://app.test', now: () => clock.t });
  const drain = async (h: ReturnType<typeof handlers>, secs = 0) => { let n = 0; while (await runOnce(pool, h, { now, backoffSeconds: () => secs })) n++; return n; };
  /** A finalized org whose statement-file job has already run, so tests below only see delivery jobs. */
  const settled = async () => { const o = await finalizedOrg(pool); await drain(handlers(null)); return o; };
  const queue = (o: Awaited<ReturnType<typeof finalizedOrg>>, opts: any = {}) => queueStatementDelivery(pool, o.orgId, o.userId, o.statementId, { emailAvailable: true, whatsappAvailable: false, ...opts });

  test('queueing writes QUEUED rows + jobs atomically and sends nothing', async () => {
    const o = await settled();
    const { sent, p } = mkEmail(() => {});
    const r = await queue(o);
    assert.equal(r.deliveryIds.length, 1);
    assert.deepEqual((await listDeliveries(pool, o.statementId)).map((d) => [d.channel, d.status]), [['EMAIL', 'QUEUED']]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE organization_id=$1 AND type='send_delivery' AND status='QUEUED'`, [o.orgId])).rows[0].n, 1);
    assert.equal(sent.length, 0);
    await drain(handlers(p)); // leave nothing queued for the next test
    assert.equal(sent.length, 1);
  });

  test('double-click does not queue twice; worker sends once with a verifiable link and idempotency key', async () => {
    const o = await settled();
    const { sent, p } = mkEmail(() => {});
    await queue(o);
    assert.equal((await queue(o)).deliveryIds.length, 0, 'QUEUED counts as live');
    await drain(handlers(p));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['john@example.com']);
    assert.equal(sent[0].idempotencyKey.startsWith('delivery:'), true);
    assert.match(sent[0].text, /\$4,800\.00/); // $6,000 net payout − 20% commission, no expenses
    const url = sent[0].text.match(/https:\/\/app\.test\/view\/(\S+)/)![1];
    assert.deepEqual(verifyLink(url, 'link-secret', clock.t), { ok: true, statementId: o.statementId });
    const [d] = await listDeliveries(pool, o.statementId);
    assert.deepEqual([d.status, d.providerMessageId], ['SENT', 'em-1']);
    assert.equal((await queue(o)).deliveryIds.length, 0, 'SENT also blocks duplicates');
    assert.equal(await verifyAuditChain(pool, o.orgId), null);
    const actions = (await listAudit(pool, o.orgId, { entityId: o.statementId })).map((a) => a.action);
    for (const a of ['STATEMENT_FINALIZED', 'STATEMENT_SEND_QUEUED', 'STATEMENT_SENT']) assert.ok(actions.includes(a), a);
  });

  test('re-running a job for an already-sent delivery never sends again (idempotent handler)', async () => {
    const o = await settled();
    const { sent, p } = mkEmail(() => {});
    await queue(o);
    const h = handlers(p);
    await drain(h);
    await pool.query(`UPDATE jobs SET status='QUEUED', run_at=now() WHERE organization_id=$1 AND type='send_delivery'`, [o.orgId]); // simulate duplicate delivery of the job
    await drain(h);
    assert.equal(sent.length, 1);
  });

  test('transient provider failure: retried with backoff, then SENT; attempts and last error visible while retrying', async () => {
    const o = await settled();
    const { sent, p } = mkEmail((n) => (n <= 2 ? new EmailError('HTTP 503', true, 503) : undefined));
    await queue(o);
    const h = handlers(p);
    assert.equal(await drain(h, 60), 1, 'first attempt fails and is scheduled for later');
    let [d] = await listDeliveries(pool, o.statementId);
    assert.deepEqual([d.status, d.error], ['QUEUED', 'HTTP 503']);
    assert.equal(await drain(h, 60), 0, 'not due yet');
    clock.t += 61_000;
    assert.equal(await drain(h, 60), 1);
    clock.t += 61_000;
    assert.equal(await drain(h, 60), 1);
    [d] = await listDeliveries(pool, o.statementId);
    assert.equal(d.status, 'SENT'); assert.equal(sent.length, 1);
    assert.equal((await pool.query(`SELECT attempts FROM statement_deliveries WHERE id=$1`, [d.id])).rows[0].attempts, 3);
  });

  test('permanent provider rejection fails immediately, is audited, and shows on the dashboard; resend can recover', async () => {
    const o = await settled();
    const bad = mkEmail(() => new EmailError('HTTP 401 invalid api key', false, 401));
    await queue(o);
    assert.equal(await drain(handlers(bad.p)), 1);
    const [d] = await listDeliveries(pool, o.statementId);
    assert.deepEqual([d.status, d.error], ['FAILED', 'HTTP 401 invalid api key']);
    assert.equal((await pool.query(`SELECT status, attempts FROM jobs WHERE organization_id=$1 AND type='send_delivery'`, [o.orgId])).rows[0].status, 'FAILED');
    assert.equal((await getDashboard(pool, o.orgId, 2026, 9)).failedDeliveries, 1);
    assert.ok((await listAudit(pool, o.orgId, { entityId: o.statementId })).some((a) => a.action === 'STATEMENT_SEND_FAILED'));

    const good = mkEmail(() => {});
    assert.equal((await queue(o)).deliveryIds.length, 1, 'FAILED does not block a new attempt');
    await drain(handlers(good.p));
    assert.equal(good.sent.length, 1);
    assert.equal((await getDashboard(pool, o.orgId, 2026, 9)).failedDeliveries, 0, 'recovered');
  });

  test('exhausted retries give up as FAILED', async () => {
    const o = await settled();
    const { p } = mkEmail(() => new EmailError('HTTP 500', true, 500));
    await queue(o);
    await pool.query(`UPDATE jobs SET max_attempts=2 WHERE organization_id=$1 AND type='send_delivery'`, [o.orgId]);
    const h = handlers(p);
    await drain(h, 0);
    await drain(h, 0);
    assert.equal((await listDeliveries(pool, o.statementId))[0].status, 'FAILED');
  });

  test('missing provider: refused at queue time (503), and a stale job fails permanently', async () => {
    const o = await settled();
    await assert.rejects(() => queue(o, { emailAvailable: false }), (e: any) => e.status === 503 && /No email provider/.test(e.message));
    await queue(o);
    await drain(handlers(null));
    assert.equal((await listDeliveries(pool, o.statementId))[0].status, 'FAILED');
  });

  test('explicit resend creates a new delivery and is audited as a resend; webhooks advance status', async () => {
    const o = await settled();
    const { sent, p } = mkEmail(() => {});
    await queue(o); await drain(handlers(p));
    assert.equal((await queue(o, { resend: true })).deliveryIds.length, 1);
    await drain(handlers(p));
    assert.equal(sent.length, 2);
    assert.ok((await listAudit(pool, o.orgId, { entityId: o.statementId })).some((a) => a.action === 'STATEMENT_RESENT'));
    assert.equal(await withTx(pool, (tx) => applyDeliveryWebhook(tx, 'em-1', 'DELIVERED')), true);
    assert.equal(await withTx(pool, (tx) => applyDeliveryWebhook(tx, 'em-1', 'BOUNCED')), false, 'terminal state is not overwritten');
    assert.equal(await withTx(pool, (tx) => applyDeliveryWebhook(tx, 'unknown-id', 'DELIVERED')), false);
  });

  test('WhatsApp: only with opt-in + provider; message carries no amount', async () => {
    const o = await settled();
    const email = mkEmail(() => {}); const wa: any[] = [];
    const waProv = { async sendTemplate(m: any) { wa.push(m); return { messageId: 'wa-1' }; } };
    assert.equal((await queue(o, { whatsappAvailable: true })).planned.length, 2);
    await drain(handlers(email.p, waProv));
    assert.equal(wa.length, 1);
    assert.equal(wa[0].to, '+15550001111');
    assert.ok(!wa[0].params.some((x: string) => x.includes('$')));
    const o2 = await settled();
    await withTx(pool, (tx) => updateOwner(tx, o2.orgId, o2.userId, o2.ownerId, { whatsappOptIn: false }));
    assert.deepEqual((await queue(o2, { whatsappAvailable: true })).planned.map((p) => p.channel), ['EMAIL']);
  });

  test('unfinalized statements cannot be queued; tenant isolation on queueing', async () => {
    const o = await seed(pool);
    await generateStatements(pool, o.orgId, o.userId, 2026, 8);
    const [st] = await loadStatements(pool, o.orgId, { year: 2026 });
    await assert.rejects(() => queueStatementDelivery(pool, o.orgId, o.userId, st.id, { emailAvailable: true, whatsappAvailable: false }), /after finalization/);
    const f = await finalizedOrg(pool);
    await assert.rejects(() => queueStatementDelivery(pool, o.orgId, o.userId, f.statementId, { emailAvailable: true, whatsappAvailable: false }), /Statement not found/);
  });

  test('queueing is all-or-nothing: a failure after the delivery insert leaves no orphan rows', async () => {
    const o = await settled();
    await pool.query(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await pool.query(`CREATE TRIGGER jobs_boom BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION boom()`);
    try { await assert.rejects(() => queue(o), /boom/); } finally { await pool.query('DROP TRIGGER jobs_boom ON jobs'); }
    assert.equal((await listDeliveries(pool, o.statementId)).length, 0);
  });
});
