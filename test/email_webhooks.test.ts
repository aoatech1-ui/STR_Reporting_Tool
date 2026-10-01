import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseEmailWebhook, WebhookAuthError } from '../src/email/webhooks.ts';

const NOW = 1_800_000_000_000;
const hex = (k: string, d: string) => createHmac('sha256', k).update(d).digest('hex');
const req = (body: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}) => ({ headers, query, rawBody: JSON.stringify(body) });
const tokenAuth = { token: 'tok-123' };

test('resend (Svix): valid signature accepted; tampered, stale and missing rejected', () => {
  const secretRaw = Buffer.from('super-secret-bytes').toString('base64');
  const secret = `whsec_${secretRaw}`;
  const body = { type: 'email.delivered', data: { email_id: 're_1' } };
  const raw = JSON.stringify(body), ts = String(Math.floor(NOW / 1000)), id = 'msg_1';
  const sig = createHmac('sha256', Buffer.from(secretRaw, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  const headers = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
  assert.deepEqual(parseEmailWebhook('resend', { headers, query: {}, rawBody: raw }, { signingSecret: secret }, NOW), [{ messageId: 're_1', status: 'DELIVERED' }]);
  assert.deepEqual(parseEmailWebhook('resend', { headers: { ...headers, 'svix-signature': `v1,bogus v1,${sig}` }, query: {}, rawBody: raw }, { signingSecret: secret }, NOW).length, 1, 'rotation: any matching sig');
  assert.throws(() => parseEmailWebhook('resend', { headers, query: {}, rawBody: raw.replace('re_1', 're_2') }, { signingSecret: secret }, NOW), WebhookAuthError);
  assert.throws(() => parseEmailWebhook('resend', { headers, query: {}, rawBody: raw }, { signingSecret: secret }, NOW + 10 * 60_000), WebhookAuthError);
  assert.throws(() => parseEmailWebhook('resend', { headers: {}, query: {}, rawBody: raw }, { signingSecret: secret }, NOW), WebhookAuthError);
  assert.throws(() => parseEmailWebhook('resend', { headers, query: {}, rawBody: raw }, {}, NOW), /not configured/);
  const bounce = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_9', bounce: { message: 'mailbox full' } } });
  const s2 = createHmac('sha256', Buffer.from(secretRaw, 'base64')).update(`${id}.${ts}.${bounce}`).digest('base64');
  assert.deepEqual(parseEmailWebhook('resend', { headers: { ...headers, 'svix-signature': `v1,${s2}` }, query: {}, rawBody: bounce }, { signingSecret: secret }, NOW), [{ messageId: 're_9', status: 'BOUNCED', reason: 'mailbox full' }]);
});

test('mailersend: HMAC of raw body in Signature header', () => {
  const raw = JSON.stringify({ type: 'activity.hard_bounced', data: { email: { message: { id: 'ms-1' } } } });
  const ok = { headers: { signature: hex('sec', raw) }, query: {}, rawBody: raw };
  assert.deepEqual(parseEmailWebhook('mailersend', ok, { signingSecret: 'sec' }, NOW)[0], { messageId: 'ms-1', status: 'BOUNCED', reason: 'hard bounce' });
  assert.throws(() => parseEmailWebhook('mailersend', { ...ok, rawBody: raw + ' ' }, { signingSecret: 'sec' }, NOW), WebhookAuthError);
  assert.throws(() => parseEmailWebhook('mailersend', ok, { signingSecret: 'other' }, NOW), WebhookAuthError);
});

test('mailgun: signature over timestamp+token, freshness enforced, permanent failures only', () => {
  const ts = String(Math.floor(NOW / 1000)), token = 'abc';
  const mk = (event: string, severity?: string) => JSON.stringify({ signature: { timestamp: ts, token, signature: hex('key', ts + token) }, 'event-data': { event, severity, message: { headers: { 'message-id': 'mg-1@x' } } } });
  assert.deepEqual(parseEmailWebhook('mailgun', { headers: {}, query: {}, rawBody: mk('delivered') }, { signingSecret: 'key' }, NOW), [{ messageId: 'mg-1@x', status: 'DELIVERED' }]);
  assert.equal(parseEmailWebhook('mailgun', { headers: {}, query: {}, rawBody: mk('failed', 'permanent') }, { signingSecret: 'key' }, NOW)[0].status, 'BOUNCED');
  assert.equal(parseEmailWebhook('mailgun', { headers: {}, query: {}, rawBody: mk('failed', 'temporary') }, { signingSecret: 'key' }, NOW).length, 0);
  assert.throws(() => parseEmailWebhook('mailgun', { headers: {}, query: {}, rawBody: mk('delivered') }, { signingSecret: 'wrong' }, NOW), WebhookAuthError);
  assert.throws(() => parseEmailWebhook('mailgun', { headers: {}, query: {}, rawBody: mk('delivered') }, { signingSecret: 'key' }, NOW + 3600_000), WebhookAuthError);
});

test('token-authenticated providers reject missing/wrong/unset token (fail closed)', () => {
  const b = { event: 'delivered', 'message-id': '<b-1@x>' };
  assert.deepEqual(parseEmailWebhook('brevo', req(b, {}, { token: 'tok-123' }), tokenAuth, NOW), [{ messageId: 'b-1@x', status: 'DELIVERED' }]);
  for (const p of ['brevo', 'mailjet', 'postmark', 'sendgrid']) {
    assert.throws(() => parseEmailWebhook(p, req(b), tokenAuth, NOW), WebhookAuthError, `${p} no token`);
    assert.throws(() => parseEmailWebhook(p, req(b, {}, { token: 'nope' }), tokenAuth, NOW), WebhookAuthError, `${p} wrong token`);
    assert.throws(() => parseEmailWebhook(p, req(b, {}, { token: 'tok-123' }), {}, NOW), WebhookAuthError, `${p} unset`);
  }
  assert.throws(() => parseEmailWebhook('brevo', { headers: {}, query: { token: 'tok-123' }, rawBody: '{not json' }, tokenAuth, NOW), WebhookAuthError);
});

test('event mapping per provider; transient events ignored', () => {
  const t = { token: 'tok-123' }, q = { token: 'tok-123' };
  const run = (p: string, body: unknown) => parseEmailWebhook(p, req(body, {}, q), t, NOW);
  assert.equal(run('brevo', { event: 'hard_bounce', 'message-id': '<x>', reason: 'no such user' })[0].status, 'BOUNCED');
  assert.equal(run('brevo', { event: 'soft_bounce', 'message-id': '<x>' }).length, 0);
  assert.equal(run('brevo', { event: 'opened', 'message-id': '<x>' }).length, 0);
  assert.deepEqual(run('mailjet', [{ event: 'sent', MessageID: 123 }, { event: 'bounce', MessageID: 124, hard_bounce: true, error: 'user unknown' }, { event: 'bounce', MessageID: 125, hard_bounce: false }, { event: 'blocked', MessageID: 126 }]).map((e) => [e.messageId, e.status]),
    [['123', 'DELIVERED'], ['124', 'BOUNCED'], ['126', 'FAILED']]);
  assert.deepEqual(run('postmark', { RecordType: 'Delivery', MessageID: 'p-1' }), [{ messageId: 'p-1', status: 'DELIVERED' }]);
  assert.equal(run('postmark', { RecordType: 'Bounce', MessageID: 'p-2', Description: 'bad mailbox' })[0].status, 'BOUNCED');
  assert.deepEqual(run('sendgrid', [{ event: 'delivered', sg_message_id: 'abc123.filter0001.99' }, { event: 'deferred', sg_message_id: 'zzz.f' }, { event: 'bounce', sg_message_id: 'def.f', reason: '550' }]).map((e) => [e.messageId, e.status]),
    [['abc123', 'DELIVERED'], ['def', 'BOUNCED']]);
  assert.throws(() => parseEmailWebhook('gmail', req({}, {}, q), t, NOW), WebhookAuthError);
});
