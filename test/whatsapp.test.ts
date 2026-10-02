import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { metaWhatsApp } from '../src/whatsapp/meta.ts';
import { twilioWhatsApp } from '../src/whatsapp/twilio.ts';
import { createWhatsAppProvider } from '../src/whatsapp/factory.ts';
import { cleanParam, digitsOnly } from '../src/whatsapp/types.ts';
import { isOptOut, metaChallenge, parseMetaWebhook, parseTwilioWebhook, twilioSignature } from '../src/whatsapp/webhooks.ts';
import { WebhookAuthError } from '../src/email/webhooks.ts';
import { EmailError, type FetchLike } from '../src/email/types.ts';
import { composeWhatsApp } from '../src/delivery/delivery.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fake(status: number, body: unknown = {}) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => { calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) }; };
  return { f, calls };
}
const lc = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const meta = (f: FetchLike) => metaWhatsApp({ accessToken: 'EAAB-secret-token', phoneNumberId: '1055', language: 'en_US', templates: { statement_ready: 'statement_ready', statement_ready_summary: 'statement_ready_summary' }, fetch: f });
const msg = { to: '+1 (555) 123-4567', template: 'statement_ready' as const, params: ['September 2026', '123 Main Street', 'https://x.test/view/t'] };

test('meta: endpoint, bearer auth, template payload with variables in order, digits-only recipient, message id', async () => {
  const { f, calls } = fake(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] });
  assert.equal((await meta(f).sendTemplate(msg)).messageId, 'wamid.ABC');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/1055/messages');
  assert.equal(lc(calls[0].headers).authorization, 'Bearer EAAB-secret-token');
  const b = JSON.parse(calls[0].body!);
  assert.deepEqual([b.messaging_product, b.to, b.type, b.template.name, b.template.language.code], ['whatsapp', '15551234567', 'template', 'statement_ready', 'en_US']);
  assert.deepEqual(b.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'September 2026' }, { type: 'text', text: '123 Main Street' }, { type: 'text', text: 'https://x.test/view/t' }] }]);
});

test('meta: the summary template is selected by key; unknown API version honoured', async () => {
  const { f, calls } = fake(200, { messages: [{ id: 'w' }] });
  const p = metaWhatsApp({ accessToken: 't', phoneNumberId: '9', apiVersion: 'v22.0', language: 'es', templates: { statement_ready: 'a', statement_ready_summary: 'b' }, fetch: f });
  await p.sendTemplate({ ...msg, template: 'statement_ready_summary' });
  assert.match(calls[0].url, /\/v22\.0\/9\/messages$/);
  assert.deepEqual([JSON.parse(calls[0].body!).template.name, JSON.parse(calls[0].body!).template.language.code], ['b', 'es']);
});

test('meta: errors are classified by Meta error code; secrets never appear in messages', async () => {
  const err = (status: number, code: number, message = 'boom') => meta(fake(status, { error: { message, type: 'OAuthException', code } }).f).sendTemplate(msg);
  await assert.rejects(() => err(401, 190), (e: EmailError) => e instanceof EmailError && !e.retryable && /renew WHATSAPP_META_TOKEN/.test(e.message) && !e.message.includes('EAAB-secret-token'));
  await assert.rejects(() => err(400, 131026), (e: EmailError) => !e.retryable && /not reachable on WhatsApp/.test(e.message));
  await assert.rejects(() => err(400, 132001), (e: EmailError) => !e.retryable && /not approved/.test(e.message));
  await assert.rejects(() => err(400, 132000), (e: EmailError) => !e.retryable && /variable count/.test(e.message));
  await assert.rejects(() => err(400, 131030), (e: EmailError) => !e.retryable && /allowed list/.test(e.message));
  for (const code of [130429, 131056, 80007, 4, 613]) await assert.rejects(() => err(400, code), (e: EmailError) => e.retryable === true, `code ${code} is retryable even on HTTP 400`);
  await assert.rejects(() => err(429, 999), (e: EmailError) => e.retryable);
  await assert.rejects(() => err(503, 1), (e: EmailError) => e.retryable);
  await assert.rejects(() => meta(fake(200, {}).f).sendTemplate(msg), (e: EmailError) => !e.retryable && /no message id/.test(e.message));
  await assert.rejects(() => meta(async () => { throw new Error('connect ECONNRESET EAAB-secret-token'); }).sendTemplate(msg), (e: EmailError) => e.retryable && !e.message.includes('EAAB'));
});

test('meta: verify() reads the phone number (sends nothing); bad token is a clear permanent error', async () => {
  const ok = fake(200, { display_phone_number: '+1 555-123-4567', verified_name: 'PM LLC' });
  await meta(ok.f).verify!();
  assert.equal(ok.calls[0].method, 'GET'); assert.equal(ok.calls[0].body, undefined); assert.match(ok.calls[0].url, /\/1055\?fields=/);
  await assert.rejects(() => meta(fake(401, { error: { message: 'Invalid OAuth access token', code: 190 } }).f).verify!(), (e: EmailError) => !e.retryable && /190/.test(e.message));
  assert.throws(() => metaWhatsApp({ accessToken: '', phoneNumberId: '1', language: 'en_US', templates: { statement_ready: 'a', statement_ready_summary: 'b' } }), /WHATSAPP_META_TOKEN/);
});

const tw = (f: FetchLike, o: Partial<Parameters<typeof twilioWhatsApp>[0]> = {}) => twilioWhatsApp({ accountSid: 'AC123', authToken: 'tok', from: '+14155238886', contentSids: { statement_ready: 'HXaaa', statement_ready_summary: 'HXbbb' }, statusCallback: 'https://app.test/webhooks/whatsapp/twilio', fetch: f, ...o });

test('twilio: form body with whatsapp: prefixes, content SID and numbered variables, basic auth, status callback', async () => {
  const { f, calls } = fake(201, { sid: 'SM999', status: 'queued' });
  assert.equal((await tw(f).sendTemplate(msg)).messageId, 'SM999');
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(lc(calls[0].headers).authorization, `Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  const form = new URLSearchParams(calls[0].body);
  assert.deepEqual([form.get('To'), form.get('From'), form.get('ContentSid'), form.get('StatusCallback')], ['whatsapp:+15551234567', 'whatsapp:+14155238886', 'HXaaa', 'https://app.test/webhooks/whatsapp/twilio']);
  assert.deepEqual(JSON.parse(form.get('ContentVariables')!), { 1: 'September 2026', 2: '123 Main Street', 3: 'https://x.test/view/t' });
});

test('twilio: messaging service instead of From; missing content SID; error codes', async () => {
  const { f, calls } = fake(201, { sid: 'SM1' });
  await tw(f, { from: undefined, messagingServiceSid: 'MG1' }).sendTemplate({ ...msg, to: '+15551234567' });
  const form = new URLSearchParams(calls[0].body); assert.equal(form.get('MessagingServiceSid'), 'MG1'); assert.equal(form.get('From'), null); assert.equal(form.get('To'), 'whatsapp:+15551234567');
  await assert.rejects(() => tw(f, { contentSids: {} }).sendTemplate({ ...msg, template: 'statement_ready_summary' }), (e: EmailError) => !e.retryable && /no Content SID/.test(e.message));
  const err = (status: number, code: number) => tw(fake(status, { code, message: 'x', status }).f).sendTemplate(msg);
  await assert.rejects(() => err(400, 63016), (e: EmailError) => !e.retryable && /template/.test(e.message));
  await assert.rejects(() => err(400, 21211), (e: EmailError) => !e.retryable && /invalid recipient/.test(e.message));
  await assert.rejects(() => err(401, 20003), (e: EmailError) => !e.retryable && /TWILIO_AUTH_TOKEN/.test(e.message) && !e.message.includes('tok'));
  await assert.rejects(() => err(429, 20429), (e: EmailError) => e.retryable);
  await assert.rejects(() => err(500, 20500), (e: EmailError) => e.retryable);
  await tw(fake(200, { status: 'active' }).f).verify!();
  await assert.rejects(() => tw(fake(200, { status: 'suspended' }).f).verify!(), /suspended/);
  assert.throws(() => twilioWhatsApp({ accountSid: 'AC', authToken: 't', contentSids: {} }), /TWILIO_WHATSAPP_FROM/);
});

test('template variables are sanitised: no newlines/tabs/runs of spaces, never empty', () => {
  assert.equal(cleanParam('Beach  House\n\tUnit   4'), 'Beach House Unit 4');
  assert.equal(cleanParam('   '), '-'); assert.equal(cleanParam(''), '-');
  assert.equal(cleanParam('x'.repeat(2000)).length, 1000);
  assert.equal(cleanParam('a b'), 'a b');
  assert.equal(digitsOnly('+1 (555) 123-4567'), '15551234567');
});

test('composeWhatsApp picks the template and variable list; no amount unless opted in', () => {
  const t = { monthLabel: 'September 2026', propertyName: 'P', ownerProceedsCents: 400000 };
  assert.deepEqual(composeWhatsApp(t, 'U'), { template: 'statement_ready', params: ['September 2026', 'P', 'U'] });
  assert.deepEqual(composeWhatsApp(t, 'U', true), { template: 'statement_ready_summary', params: ['September 2026', 'P', '$4,000.00', 'U'] });
});

test('factory: nothing configured = null; meta/twilio build; misconfiguration fails loudly', () => {
  assert.equal(createWhatsAppProvider({}), null);
  const m = createWhatsAppProvider({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_TOKEN: 't', WHATSAPP_META_PHONE_NUMBER_ID: '1' })!;
  assert.equal(m.provider.name, 'meta'); assert.equal(m.includeSummary, false);
  assert.equal(m.warnings.length, 2, 'app secret + verify token missing');
  assert.deepEqual(m.templates, { statement_ready: 'statement_ready', statement_ready_summary: 'statement_ready_summary' });
  const m2 = createWhatsAppProvider({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_TOKEN: 't', WHATSAPP_META_PHONE_NUMBER_ID: '1', WHATSAPP_META_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_TEMPLATE_STATEMENT_READY: 'owner_stmt', WHATSAPP_INCLUDE_SUMMARY: 'true' })!;
  assert.deepEqual([m2.warnings.length, m2.templates.statement_ready, m2.includeSummary, m2.webhook.metaAppSecret], [0, 'owner_stmt', true, 's']);
  const t = createWhatsAppProvider({ WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'a', TWILIO_WHATSAPP_FROM: '+14155238886', TWILIO_CONTENT_SID_STATEMENT_READY: 'HX1' }, 'https://app.test')!;
  assert.equal(t.provider.name, 'twilio'); assert.equal(t.webhook.twilioAuthToken, 'a');
  assert.throws(() => createWhatsAppProvider({ WHATSAPP_PROVIDER: 'carrier-pigeon' }), /Unknown WHATSAPP_PROVIDER/);
  assert.throws(() => createWhatsAppProvider({ WHATSAPP_PROVIDER: 'meta' }), /WHATSAPP_META_TOKEN/);
  assert.throws(() => createWhatsAppProvider({ WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'a', TWILIO_WHATSAPP_FROM: '+1' }), /CONTENT_SID_STATEMENT_READY/);
  assert.throws(() => createWhatsAppProvider({ WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'a', TWILIO_WHATSAPP_FROM: '+1', TWILIO_CONTENT_SID_STATEMENT_READY: 'HX1', WHATSAPP_INCLUDE_SUMMARY: 'true' }), /SUMMARY/);
});

const metaBody = (v: object) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...v } }] }] });
const sign = (raw: string, secret = 'appsecret') => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` });

test('meta webhook: signature required (fail closed); statuses and STOP replies extracted', () => {
  const raw = metaBody({ statuses: [{ id: 'w1', status: 'sent' }, { id: 'w2', status: 'delivered' }, { id: 'w3', status: 'read' },
    { id: 'w4', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'not on WhatsApp' } }] }],
    messages: [{ from: '15551234567', id: 'm1', type: 'text', text: { body: ' STOP ' } }, { from: '15559999999', id: 'm2', type: 'image' }] });
  const r = parseMetaWebhook(raw, sign(raw), 'appsecret');
  assert.deepEqual(r.statuses.map((s) => [s.messageId, s.status]), [['w2', 'DELIVERED'], ['w3', 'DELIVERED'], ['w4', 'FAILED']]);
  assert.match(r.statuses[2].reason!, /Message undeliverable \(code 131026\): not on WhatsApp/);
  assert.deepEqual(r.inbound, [{ from: '15551234567', text: ' STOP ' }]);
  assert.throws(() => parseMetaWebhook(raw, {}, 'appsecret'), WebhookAuthError);
  assert.throws(() => parseMetaWebhook(raw, sign(raw, 'other'), 'appsecret'), WebhookAuthError);
  assert.throws(() => parseMetaWebhook(raw + ' ', sign(raw), 'appsecret'), WebhookAuthError, 'body tampering');
  assert.throws(() => parseMetaWebhook(raw, sign(raw), undefined), /not configured/);
  const junk = '{not json'; assert.throws(() => parseMetaWebhook(junk, sign(junk), 'appsecret'), WebhookAuthError);
  const empty = JSON.stringify({}); assert.deepEqual(parseMetaWebhook(empty, sign(empty), 'appsecret'), { statuses: [], inbound: [] });
});

test('meta verification handshake', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '12345' };
  assert.equal(metaChallenge(q, 'vt'), '12345');
  assert.equal(metaChallenge({ ...q, 'hub.verify_token': 'nope' }, 'vt'), null);
  assert.equal(metaChallenge({ ...q, 'hub.mode': 'unsubscribe' }, 'vt'), null);
  assert.equal(metaChallenge(q, undefined), null);
  assert.equal(metaChallenge({}, 'vt'), null);
});

test('twilio webhook: signature over URL + sorted params; statuses and inbound STOP', () => {
  const url = 'https://app.test/webhooks/whatsapp/twilio', token = 'authtoken';
  const mk = (o: Record<string, string>) => { const raw = new URLSearchParams(o).toString(); return { raw, headers: { 'x-twilio-signature': twilioSignature(token, url, new URLSearchParams(o)) } }; };
  const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', new URLSearchParams({ CallSid: 'CA1', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' }));
  assert.equal(sig, createHmac('sha1', '12345').update('https://mycompany.com/myapp.php?foo=1&bar=2CallSidCA1Caller+14158675310Digits1234From+14158675310To+18005551212').digest('base64'), 'concatenation order is URL then name+value pairs sorted by name');
  let w = mk({ MessageSid: 'SMx', MessageStatus: 'delivered', To: 'whatsapp:+1555' });
  assert.deepEqual(parseTwilioWebhook(url, w.raw, w.headers, token).statuses, [{ messageId: 'SMx', status: 'DELIVERED' }]);
  w = mk({ MessageSid: 'SMy', MessageStatus: 'undelivered', ErrorCode: '63016' });
  assert.deepEqual(parseTwilioWebhook(url, w.raw, w.headers, token).statuses, [{ messageId: 'SMy', status: 'FAILED', reason: 'undelivered (code 63016)' }]);
  w = mk({ MessageSid: 'SMz', MessageStatus: 'sent' });
  assert.deepEqual(parseTwilioWebhook(url, w.raw, w.headers, token), { statuses: [], inbound: [] });
  w = mk({ From: 'whatsapp:+1 555 123 4567', Body: 'Stop', MessageSid: 'SMin' });
  assert.deepEqual(parseTwilioWebhook(url, w.raw, w.headers, token).inbound, [{ from: '15551234567', text: 'Stop' }]);
  assert.throws(() => parseTwilioWebhook(url, w.raw, {}, token), WebhookAuthError);
  assert.throws(() => parseTwilioWebhook(url, w.raw, w.headers, 'wrong'), WebhookAuthError);
  assert.throws(() => parseTwilioWebhook('https://evil.test/x', w.raw, w.headers, token), WebhookAuthError, 'URL is part of the signature');
  assert.throws(() => parseTwilioWebhook(url, w.raw, w.headers, undefined), /not configured/);
});

test('opt-out keywords are exact words only', () => {
  for (const y of ['STOP', 'stop', ' Stop ', 'STOP.', 'stopall', 'Unsubscribe', 'CANCEL', 'end', 'QUIT', 'opt out', 'opt-out', 'OPTOUT', 'parar', 'baja']) assert.equal(isOptOut(y), true, y);
  for (const n of ["please don't stop", 'stop sending me the amount', 'start', 'thanks', 'ok', '', 'when does the statement end', 'cancel my booking please']) assert.equal(isOptOut(n), false, n);
});
