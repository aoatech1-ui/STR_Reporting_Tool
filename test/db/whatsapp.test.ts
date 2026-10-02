import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { buildApp } from '../../src/server/app.ts';
import { queueStatementDelivery } from '../../src/services/send.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import { listDeliveries } from '../../src/repo/deliveries.ts';
import { listAudit } from '../../src/repo/audit.ts';
import { getOwner, createOwner, updateOwner } from '../../src/repo/owners.ts';
import { createWhatsAppProvider, type WhatsAppSetup } from '../../src/whatsapp/factory.ts';
import { twilioSignature } from '../../src/whatsapp/webhooks.ts';
import { runPreflight } from '../../src/ops/preflight.ts';
import { EmailError } from '../../src/email/types.ts';
import type { WhatsAppMessage, WhatsAppProvider } from '../../src/whatsapp/types.ts';
import { addUser, Client, testConfig } from './httpkit.ts';
import { finalizedOrg, freshDb, skip, tmpStore } from './helper.ts';

const BASE = 'https://app.test';
const META_ENV = { WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_TOKEN: 'tok', WHATSAPP_META_PHONE_NUMBER_ID: '1', WHATSAPP_META_APP_SECRET: 'appsecret', WHATSAPP_VERIFY_TOKEN: 'vt' };
const TWILIO_ENV = { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twtoken', TWILIO_WHATSAPP_FROM: '+14155238886', TWILIO_CONTENT_SID_STATEMENT_READY: 'HX1', TWILIO_CONTENT_SID_STATEMENT_READY_SUMMARY: 'HX2' };

describe('WhatsApp: sending, delivery receipts, STOP', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, o: Awaited<ReturnType<typeof finalizedOrg>>, app: FastifyInstance, twApp: FastifyInstance, noWaApp: FastifyInstance, mgr: Client;
  const files = tmpStore();
  const sentWa: WhatsAppMessage[] = []; let waAttempts = 0; let waBehaviour: (n: number) => Error | void = () => {};
  const fakeWa: WhatsAppProvider = { name: 'fake', async sendTemplate(m) { const e = waBehaviour(++waAttempts); if (e) throw e; sentWa.push(m); return { messageId: `wamid.${sentWa.length}` }; } };
  const sentMail: any[] = [];
  const email = { name: 'fake', async send(m: any) { sentMail.push(m); return { messageId: `em-${sentMail.length}` }; } };
  const metaSetup = (): WhatsAppSetup => ({ ...createWhatsAppProvider(META_ENV)!, provider: fakeWa });
  const handlers = (includeSummary = false) => buildHandlers({ pool, files, email, whatsapp: fakeWa, whatsappIncludeSummary: includeSummary, linkSecret: 'x'.repeat(40), baseUrl: BASE });
  const drain = async (h = handlers()) => { while (await runOnce(pool, h)) { /* drain */ } };
  const q = (opts: object = {}) => queueStatementDelivery(pool, o.orgId, o.userId, o.statementId, { emailAvailable: true, whatsappAvailable: true, ...opts });

  const metaBody = (v: object) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...v } }] }] });
  const metaPost = (a: FastifyInstance, raw: string, secret: string | null = 'appsecret', provider = 'meta') => a.inject({ method: 'POST', url: `/webhooks/whatsapp/${provider}`,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } : {}) }, payload: raw });
  const twPost = (params: Record<string, string>, signWith: string | null = 'twtoken') => {
    const body = new URLSearchParams(params);
    return twApp.inject({ method: 'POST', url: '/webhooks/whatsapp/twilio', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signWith ? { 'x-twilio-signature': twilioSignature(signWith, `${BASE}/webhooks/whatsapp/twilio`, body) } : {}) }, payload: body.toString() });
  };
  const reset = async () => { waAttempts = 0; sentWa.length = 0; sentMail.length = 0; waBehaviour = () => {}; await pool.query('DELETE FROM statement_deliveries'); await pool.query('DELETE FROM jobs'); };

  before(async () => {
    ({ pool, close } = await freshDb());
    o = await finalizedOrg(pool);
    await pool.query('DELETE FROM jobs');
    await addUser(pool, o.orgId, 'MANAGER', 'm@wa.test'); await addUser(pool, o.orgId, 'ADMIN', 'a@wa.test');
    app = await buildApp({ pool, config: testConfig({ baseUrl: BASE }), email: { id: 'fake', provider: email, warnings: [] }, whatsapp: metaSetup(), files });
    twApp = await buildApp({ pool, config: testConfig({ baseUrl: BASE }), email: null, whatsapp: { ...createWhatsAppProvider(TWILIO_ENV, BASE)!, provider: fakeWa }, files });
    noWaApp = await buildApp({ pool, config: testConfig({ baseUrl: BASE }), email: { id: 'fake', provider: email, warnings: [] }, files });
    mgr = await new Client(app).login('m@wa.test');
  });
  after(async () => { await app.close(); await twApp.close(); await noWaApp.close(); await close(); });

  test('send: email and WhatsApp are queued together; the worker sends the approved template with no dollar amount; template recorded', async () => {
    await reset();
    const r = await q();
    assert.deepEqual(r.planned.map((p) => p.channel), ['EMAIL', 'WHATSAPP']);
    await drain();
    assert.equal(sentWa.length, 1);
    assert.deepEqual([sentWa[0].to, sentWa[0].template], ['+15550001111', 'statement_ready']);
    assert.equal(sentWa[0].params.length, 3);
    assert.deepEqual(sentWa[0].params.slice(0, 2), ['September 2026', '123 Main Street']);
    assert.match(sentWa[0].params[2], /^https:\/\/app\.test\/view\//);
    assert.ok(!sentWa[0].params.some((p) => p.includes('$')), 'no financial amount in the message');
    const d = (await listDeliveries(pool, o.statementId)).find((x) => x.channel === 'WHATSAPP')!;
    assert.deepEqual([d.status, d.providerMessageId, d.templateId, d.recipient], ['SENT', 'wamid.1', 'statement_ready', '+15550001111']);
  });

  test('the summary variant is a different template with the amount as the third variable', async () => {
    await reset();
    await q({ resend: true });
    await drain(handlers(true));
    assert.equal(sentWa[0].template, 'statement_ready_summary');
    assert.deepEqual(sentWa[0].params.slice(0, 3), ['September 2026', '123 Main Street', '$4,800.00']);
    assert.equal((await listDeliveries(pool, o.statementId)).find((x) => x.channel === 'WHATSAPP')!.templateId, 'statement_ready_summary');
  });

  test('API: the send endpoint queues WhatsApp only when a provider is configured', async () => {
    await reset();
    const withWa = await mgr.post(`/api/statements/${o.statementId}/send`);
    assert.deepEqual(withWa.json().queued.map((x: any) => x.channel), ['EMAIL', 'WHATSAPP']);
    await reset();
    const m2 = await new Client(noWaApp).login('m@wa.test');
    assert.deepEqual((await m2.post(`/api/statements/${o.statementId}/send`)).json().queued.map((x: any) => x.channel), ['EMAIL']);
    await reset();
  });

  test('provider rejections: permanent fails at once with the reason; transient is retried then sent', async () => {
    await reset();
    waBehaviour = () => new EmailError('whatsapp-meta: HTTP 400 (code 131026: recipient is not reachable on WhatsApp)', false, 400);
    await q({ emailAvailable: false });
    await drain();
    let d = (await listDeliveries(pool, o.statementId))[0];
    assert.deepEqual([d.channel, d.status], ['WHATSAPP', 'FAILED']); assert.match(d.error!, /not reachable on WhatsApp/);
    assert.ok((await listAudit(pool, o.orgId, { entityId: o.statementId })).some((a) => a.action === 'STATEMENT_SEND_FAILED'));

    await reset();
    waBehaviour = (n) => (n === 1 ? new EmailError('HTTP 503', true, 503) : undefined);
    await q({ emailAvailable: false });
    const h = handlers();
    while (await runOnce(pool, h, { backoffSeconds: () => 0 })) { /* retry immediately */ }
    d = (await listDeliveries(pool, o.statementId))[0];
    assert.deepEqual([d.status, d.providerMessageId], ['SENT', 'wamid.1']);
  });

  test('Meta webhook: handshake, signature required, delivery receipts update the delivery', async () => {
    await reset();
    await q({ emailAvailable: false }); await drain();
    const mid = (await listDeliveries(pool, o.statementId))[0].providerMessageId!;
    assert.equal((await app.inject(`/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=987`)).body, '987');
    assert.equal((await app.inject(`/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=987`)).statusCode, 403);
    assert.equal((await noWaApp.inject(`/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=1`)).statusCode, 403);

    const delivered = metaBody({ statuses: [{ id: mid, status: 'delivered' }] });
    assert.equal((await metaPost(app, delivered, null)).statusCode, 401, 'unsigned');
    assert.equal((await metaPost(app, delivered, 'wrong')).statusCode, 401, 'wrong secret');
    assert.equal((await metaPost(noWaApp, delivered)).statusCode, 404, 'WhatsApp not configured');
    assert.equal((await metaPost(app, delivered, 'appsecret', 'twilio')).statusCode, 404, 'only the configured provider');
    const ok = await metaPost(app, delivered);
    assert.deepEqual(ok.json(), { received: 1, applied: 1, optedOut: 0 });
    assert.equal((await listDeliveries(pool, o.statementId))[0].status, 'DELIVERED');
    // a late "failed" never overwrites a delivered message; unknown ids are ignored
    assert.equal((await metaPost(app, metaBody({ statuses: [{ id: mid, status: 'failed', errors: [{ code: 1, title: 'x' }] }] }))).json().applied, 0);
    assert.equal((await metaPost(app, metaBody({ statuses: [{ id: 'wamid.unknown', status: 'delivered' }] }))).json().applied, 0);
  });

  test('Meta webhook: a failure receipt after sending marks the message failed with the reason', async () => {
    await reset();
    await q({ emailAvailable: false }); await drain();
    const mid = (await listDeliveries(pool, o.statementId))[0].providerMessageId!;
    const r = await metaPost(app, metaBody({ statuses: [{ id: mid, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'not on WhatsApp' } }] }] }));
    assert.equal(r.json().applied, 1);
    const d = (await listDeliveries(pool, o.statementId))[0];
    assert.deepEqual([d.status], ['FAILED']); assert.match(d.error!, /Message undeliverable \(code 131026\): not on WhatsApp/);
  });

  test('STOP reply opts the owner out immediately: recorded, audited, and WhatsApp is no longer planned', async () => {
    await reset();
    const owner0 = (await getOwner(pool, o.orgId, o.ownerId))!;
    assert.deepEqual([owner0.whatsappOptIn, owner0.whatsappOptOutAt], [true, null]);
    const hello = await metaPost(app, metaBody({ messages: [{ from: '15550001111', id: 'm0', type: 'text', text: { body: "please don't stop" } }] }));
    assert.equal(hello.json().optedOut, 0, 'a sentence is not an opt-out');
    assert.equal((await metaPost(app, metaBody({ messages: [{ from: '15557777777', id: 'm1', type: 'text', text: { body: 'STOP' } }] }))).json().optedOut, 0, 'unknown number');
    assert.equal((await getOwner(pool, o.orgId, o.ownerId))!.whatsappOptIn, true);

    const stop = await metaPost(app, metaBody({ messages: [{ from: '15550001111', id: 'm2', type: 'text', text: { body: ' Stop ' } }] }));
    assert.equal(stop.json().optedOut, 1);
    const owner1 = (await getOwner(pool, o.orgId, o.ownerId))!;
    assert.equal(owner1.whatsappOptIn, false); assert.ok(owner1.whatsappOptOutAt);
    const a = (await listAudit(pool, o.orgId, { entityType: 'owner', entityId: o.ownerId })).find((x) => x.action === 'WHATSAPP_OPT_OUT')!;
    assert.deepEqual([a.userName, (a.newValue as any).via], [null, 'owner replied STOP']);
    assert.equal((await metaPost(app, metaBody({ messages: [{ from: '15550001111', id: 'm3', type: 'text', text: { body: 'STOP' } }] }))).json().optedOut, 0, 'idempotent');

    assert.deepEqual((await q({ resend: true })).planned.map((p) => p.channel), ['EMAIL'], 'no WhatsApp after STOP');
    const ex = (await mgr.get(`/api/owners/${o.ownerId}`)).json().owner;
    assert.ok(ex.whatsappOptOutAt, 'the UI can show when the owner opted out');

    // only the manager re-enabling consent (after the owner asks) restores it
    await withTx(pool, (tx) => updateOwner(tx, o.orgId, o.userId, o.ownerId, { whatsappOptIn: true }));
    const owner2 = (await getOwner(pool, o.orgId, o.ownerId))!;
    assert.deepEqual([owner2.whatsappOptIn, owner2.whatsappOptOutAt], [true, null]);
    await reset();
    assert.deepEqual((await q()).planned.map((p) => p.channel), ['EMAIL', 'WHATSAPP']);
  });

  test('STOP applies to every owner record with that number, each audited in its own organization', async () => {
    const other = await finalizedOrg(pool);
    await withTx(pool, (tx) => updateOwner(tx, other.orgId, other.userId, other.ownerId, { whatsappPhone: '+1 555 000 1111'.replace(/ /g, '') }));
    const r = await metaPost(app, metaBody({ messages: [{ from: '15550001111', id: 'x', type: 'text', text: { body: 'unsubscribe' } }] }));
    assert.equal(r.json().optedOut, 2);
    for (const org of [o, other]) {
      assert.equal((await getOwner(pool, org.orgId, org.ownerId))!.whatsappOptIn, false);
      assert.ok((await listAudit(pool, org.orgId, { entityId: org.ownerId })).some((x) => x.action === 'WHATSAPP_OPT_OUT'));
    }
    await withTx(pool, (tx) => updateOwner(tx, o.orgId, o.userId, o.ownerId, { whatsappOptIn: true }));
    await pool.query('DELETE FROM jobs');
  });

  test('Twilio callbacks: signed status receipts and STOP replies', async () => {
    await reset();
    await q({ emailAvailable: false }); await drain();
    const sid = (await listDeliveries(pool, o.statementId))[0].providerMessageId!;
    assert.equal((await twPost({ MessageSid: sid, MessageStatus: 'delivered' }, null)).statusCode, 401);
    assert.equal((await twPost({ MessageSid: sid, MessageStatus: 'delivered' }, 'wrong')).statusCode, 401);
    assert.equal((await twPost({ MessageSid: sid, MessageStatus: 'sent' })).json().applied, 0, 'intermediate states ignored');
    assert.equal((await twPost({ MessageSid: sid, MessageStatus: 'delivered' })).json().applied, 1);
    assert.equal((await listDeliveries(pool, o.statementId))[0].status, 'DELIVERED');
    const stop = await twPost({ From: 'whatsapp:+15550001111', Body: 'STOP', MessageSid: 'SMin1' });
    assert.equal(stop.json().optedOut, 1);
    assert.equal((await getOwner(pool, o.orgId, o.ownerId))!.whatsappOptIn, false);
    await withTx(pool, (tx) => updateOwner(tx, o.orgId, o.userId, o.ownerId, { whatsappOptIn: true }));
  });

  test('settings expose WhatsApp status to administrators; preflight reports credentials and template reminder', async () => {
    const admin = await new Client(app).login('a@wa.test');
    const s = (await admin.get('/api/settings/email')).json();
    assert.deepEqual([s.whatsapp.configured, s.whatsapp.provider, s.whatsapp.webhooksConfigured, s.whatsapp.templates.statement_ready], [true, 'meta', true, 'statement_ready']);
    assert.equal((await (await new Client(noWaApp).login('a@wa.test')).get('/api/settings/email')).json().whatsapp.configured, false);
    const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1/x', BASE_URL: 'https://app.example.com', LINK_SECRET: 'k8Vq2mZp9XcR4tYb7NwLs3HdFj6GaE1uQ5oB0iTe', TRUST_PROXY: 'true' };
    const none = await runPreflight(base, pool, { files: tmpStore() });
    assert.equal(none.find((c) => c.name === 'whatsapp')!.level, 'warn');
    const bad = await runPreflight({ ...base, ...META_ENV, WHATSAPP_META_APP_SECRET: '' }, pool, { files: tmpStore() });
    assert.ok(bad.some((c) => c.name === 'whatsapp' && /APP_SECRET/.test(c.detail)), 'missing signing secret is called out');
    assert.ok(bad.some((c) => c.name === 'whatsapp templates' && /APPROVED/.test(c.detail)));
  });

  test('owner records: opted-out state is visible and creating an opted-in owner still works', async () => {
    const id = await withTx(pool, (tx) => createOwner(tx, o.orgId, o.userId, { legalName: 'New', displayName: 'New', whatsappPhone: '+15551230000', whatsappEnabled: true, whatsappOptIn: true }));
    const n = (await getOwner(pool, o.orgId, id))!;
    assert.deepEqual([n.whatsappOptIn, n.whatsappOptOutAt], [true, null]);
  });
});
