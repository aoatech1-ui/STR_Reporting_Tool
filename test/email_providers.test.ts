import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { brevo, mailersend, mailgun, mailjet, postmark, resend, sendgrid } from '../src/email/providers.ts';
import { smtp, SMTP_PRESETS } from '../src/email/smtp.ts';
import { createEmailProvider, PROVIDER_NAMES } from '../src/email/factory.ts';
import { EmailError, parseSender, type FetchLike } from '../src/email/types.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function fake(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
    return { status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { f, calls };
}
const from = { email: 'statements@pm.example', name: 'PM LLC' };
const msg = { to: ['john@example.com', 'jane@example.com'], subject: 'Sept statement', text: 'hello', html: '<p>hello</p>', idempotencyKey: 'delivery:1' };
const lc = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

test('brevo: endpoint, api-key header, body shape, id normalised', async () => {
  const { f, calls } = fake(201, { messageId: '<abc@smtp-relay.mailin.fr>' });
  const r = await brevo({ from, apiKey: 'KEY', fetch: f }).send(msg);
  assert.equal(r.messageId, 'abc@smtp-relay.mailin.fr');
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(lc(calls[0].headers)['api-key'], 'KEY');
  const b = JSON.parse(calls[0].body);
  assert.deepEqual(b.sender, from); assert.deepEqual(b.to, [{ email: 'john@example.com' }, { email: 'jane@example.com' }]);
  assert.equal(b.textContent, 'hello'); assert.equal(b.htmlContent, '<p>hello</p>');
});

test('resend: bearer auth, formatted from, idempotency-key forwarded', async () => {
  const { f, calls } = fake(200, { id: 're_123' });
  assert.equal((await resend({ from, apiKey: 'K', fetch: f }).send(msg)).messageId, 're_123');
  const h = lc(calls[0].headers);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(h.authorization, 'Bearer K'); assert.equal(h['idempotency-key'], 'delivery:1');
  assert.equal(JSON.parse(calls[0].body).from, 'PM LLC <statements@pm.example>');
});

test('mailjet: basic auth, v3.1 Messages shape, numeric MessageID', async () => {
  const { f, calls } = fake(200, { Messages: [{ Status: 'success', To: [{ MessageID: 1152921500000000, MessageUUID: 'u' }] }] });
  assert.equal((await mailjet({ from, apiKey: 'a', apiSecret: 'b', fetch: f }).send(msg)).messageId, '1152921500000000');
  assert.equal(lc(calls[0].headers).authorization, `Basic ${Buffer.from('a:b').toString('base64')}`);
  const m = JSON.parse(calls[0].body).Messages[0];
  assert.deepEqual(m.From, { Email: 'statements@pm.example', Name: 'PM LLC' }); assert.equal(m.TextPart, 'hello'); assert.equal(m.CustomID, 'delivery:1');
  const bad = fake(200, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'bad sender' }] }] });
  await assert.rejects(() => mailjet({ from, apiKey: 'a', apiSecret: 'b', fetch: bad.f }).send(msg), (e: EmailError) => e.retryable === false && /bad sender/.test(e.message));
});

test('mailersend: bearer, id from x-message-id header', async () => {
  const { f, calls } = fake(202, '', { 'x-message-id': 'ms-1' });
  assert.equal((await mailersend({ from, apiToken: 'T', fetch: f }).send(msg)).messageId, 'ms-1');
  assert.equal(calls[0].url, 'https://api.mailersend.com/v1/email');
  assert.deepEqual(JSON.parse(calls[0].body).from, from);
});

test('postmark: server token header, comma-joined To, in-body error code is permanent', async () => {
  const { f, calls } = fake(200, { MessageID: 'pm-1', ErrorCode: 0 });
  assert.equal((await postmark({ from, serverToken: 'S', fetch: f }).send(msg)).messageId, 'pm-1');
  assert.equal(lc(calls[0].headers)['x-postmark-server-token'], 'S');
  const b = JSON.parse(calls[0].body); assert.equal(b.To, 'john@example.com,jane@example.com'); assert.equal(b.MessageStream, 'outbound');
  const bad = fake(200, { ErrorCode: 300, Message: 'Invalid email request' });
  await assert.rejects(() => postmark({ from, serverToken: 'S', fetch: bad.f }).send(msg), (e: EmailError) => !e.retryable);
});

test('sendgrid: personalizations shape, id from header', async () => {
  const { f, calls } = fake(202, '', { 'x-message-id': 'sg-1' });
  assert.equal((await sendgrid({ from, apiKey: 'K', fetch: f }).send(msg)).messageId, 'sg-1');
  const b = JSON.parse(calls[0].body);
  assert.deepEqual(b.personalizations[0].to, [{ email: 'john@example.com' }, { email: 'jane@example.com' }]);
  assert.deepEqual(b.content.map((c: any) => c.type), ['text/plain', 'text/html']);
});

test('mailgun: form body, basic api:key auth, domain in URL, EU region', async () => {
  const { f, calls } = fake(200, { id: '<mg-1@pm.example>', message: 'Queued' });
  assert.equal((await mailgun({ from, apiKey: 'K', domain: 'mg.pm.example', fetch: f }).send(msg)).messageId, 'mg-1@pm.example');
  assert.equal(calls[0].url, 'https://api.mailgun.net/v3/mg.pm.example/messages');
  assert.equal(lc(calls[0].headers).authorization, `Basic ${Buffer.from('api:K').toString('base64')}`);
  const form = new URLSearchParams(calls[0].body);
  assert.deepEqual(form.getAll('to'), ['john@example.com', 'jane@example.com']); assert.equal(form.get('subject'), 'Sept statement');
  const eu = fake(200, { id: '<x>' });
  await mailgun({ from, apiKey: 'K', domain: 'd', region: 'eu', fetch: eu.f }).send(msg);
  assert.ok(eu.calls[0].url.startsWith('https://api.eu.mailgun.net/'));
});

test('error classification: 5xx/429/408/network retryable; 4xx permanent; secrets never leak', async () => {
  const mk = (status: number) => resend({ from, apiKey: 'SECRET-KEY-123', fetch: fake(status, { message: 'nope' }).f });
  for (const s of [500, 502, 503, 429, 408]) await assert.rejects(() => mk(s).send(msg), (e: EmailError) => e instanceof EmailError && e.retryable && e.status === s);
  for (const s of [400, 401, 403, 404, 422]) await assert.rejects(() => mk(s).send(msg), (e: EmailError) => e instanceof EmailError && !e.retryable);
  const down = resend({ from, apiKey: 'SECRET-KEY-123', fetch: async () => { throw Object.assign(new Error('connect ECONNREFUSED with SECRET-KEY-123'), { name: 'FetchError' }); } });
  await assert.rejects(() => down.send(msg), (e: EmailError) => e.retryable && !e.message.includes('SECRET-KEY-123'));
  await assert.rejects(() => mk(401).send(msg), (e: EmailError) => !e.message.includes('SECRET-KEY-123'));
  await assert.rejects(() => resend({ from, apiKey: 'K', fetch: fake(200, {}).f }).send(msg), (e: EmailError) => !e.retryable && /no message id/.test(e.message));
});

test('missing credentials fail at construction, not at first send', () => {
  assert.throws(() => brevo({ from, apiKey: '' }), /BREVO_API_KEY/);
  assert.throws(() => mailjet({ from, apiKey: 'a', apiSecret: '' }), /MAILJET_API_SECRET/);
});

test('smtp: sends through the transport, normalises id, classifies errors', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const r = await smtp({ from, host: 'h', port: 465, secure: true, user: 'u', pass: 'p', transport }).send(msg);
  assert.ok(r.messageId.length > 0 && !r.messageId.startsWith('<'));
  const failing = (code: number | undefined) => ({ sendMail: async () => { throw Object.assign(new Error('x'), { responseCode: code, code: 'EAUTH' }); } }) as any;
  await assert.rejects(() => smtp({ from, host: 'h', port: 1, secure: false, user: 'u', pass: 'p', transport: failing(535) }).send(msg), (e: EmailError) => !e.retryable);
  await assert.rejects(() => smtp({ from, host: 'h', port: 1, secure: false, user: 'u', pass: 'p', transport: failing(451) }).send(msg), (e: EmailError) => e.retryable);
  await assert.rejects(() => smtp({ from, host: 'h', port: 1, secure: false, user: 'u', pass: 'p', transport: failing(undefined) }).send(msg), (e: EmailError) => e.retryable);
});

test('factory: every provider builds from env; consumer mailboxes carry warnings', () => {
  const base = { EMAIL_FROM: 'PM LLC <statements@pm.example>' };
  const creds: Record<string, Record<string, string>> = {
    brevo: { BREVO_API_KEY: 'k' }, resend: { RESEND_API_KEY: 'k' }, mailjet: { MAILJET_API_KEY: 'a', MAILJET_API_SECRET: 'b' }, mailersend: { MAILERSEND_API_TOKEN: 't' },
    postmark: { POSTMARK_SERVER_TOKEN: 't' }, sendgrid: { SENDGRID_API_KEY: 'k' }, mailgun: { MAILGUN_API_KEY: 'k', MAILGUN_DOMAIN: 'd.example' },
  };
  for (const name of PROVIDER_NAMES) {
    const env = { ...base, EMAIL_PROVIDER: name, ...(creds[name] ?? { SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_HOST: 'smtp.example' }) };
    const s = createEmailProvider(env)!;
    assert.equal(s.id, name);
    const smtpLike = name in SMTP_PRESETS;
    assert.equal(s.provider.name, smtpLike ? 'smtp' : name);
    if (smtpLike && !['ses', 'custom'].includes(name)) assert.ok(s.warnings.some((w) => /transactional/.test(w)), name);
    else assert.ok(!s.warnings.some((w) => /transactional/.test(w)), name); // SES/custom/HTTP providers: no mailbox warning
  }
  for (const n of ['brevo', 'resend', 'mailjet', 'mailersend', 'gmail', 'outlook', 'office365', 'yahoo', 'aol', 'zoho']) assert.ok(PROVIDER_NAMES.includes(n), n);
  assert.equal(createEmailProvider({}), null);
  assert.throws(() => createEmailProvider({ EMAIL_PROVIDER: 'carrier-pigeon', ...base }), /Unknown EMAIL_PROVIDER/);
  assert.throws(() => createEmailProvider({ EMAIL_PROVIDER: 'brevo' }), /EMAIL_FROM/);
  assert.throws(() => createEmailProvider({ EMAIL_PROVIDER: 'gmail', ...base }), /SMTP_USER/);
  assert.throws(() => createEmailProvider({ EMAIL_PROVIDER: 'brevo', ...base }), /BREVO_API_KEY/);
});

test('sender parsing and header-injection safety', () => {
  assert.deepEqual(parseSender('PM LLC <a@b.co>'), { email: 'a@b.co', name: 'PM LLC' });
  assert.deepEqual(parseSender('a@b.co'), { email: 'a@b.co' });
  assert.throws(() => parseSender('not an address'));
});

test('gmail: preset warnings for From mismatch and spaced app passwords; matching config is clean of mismatch warnings', () => {
  const env = { EMAIL_PROVIDER: 'gmail', EMAIL_FROM: 'PM LLC <statements@pm.example>', SMTP_USER: 'statements@pm.example', SMTP_PASS: 'abcdefghijklmnop' };
  const ok = createEmailProvider(env)!;
  assert.equal(ok.provider.name, 'smtp');
  assert.ok(!ok.warnings.some((w) => /rewrites or rejects/.test(w)) && !ok.warnings.some((w) => /spaces/.test(w)));
  assert.ok(ok.warnings.some((w) => /500 recipients/.test(w)), 'documents the daily cap');
  assert.ok(createEmailProvider({ ...env, SMTP_USER: 'other@gmail.com' })!.warnings.some((w) => /rewrites or rejects/.test(w)));
  assert.ok(createEmailProvider({ ...env, SMTP_USER: 'STATEMENTS@pm.example' })!.warnings.every((w) => !/rewrites or rejects/.test(w)), 'case-insensitive');
  assert.ok(createEmailProvider({ ...env, SMTP_PASS: 'abcd efgh ijkl mnop' })!.warnings.some((w) => /spaces/.test(w)));
});

test('smtp verify(): ok passes; bad credentials give an actionable, non-retryable error', async () => {
  const good = { verify: async () => true, sendMail: async () => ({}) } as any;
  await smtp({ from, host: 'h', port: 465, secure: true, user: 'u', pass: 'p', transport: good }).verify!();
  const bad = { verify: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }); } } as any;
  await assert.rejects(() => smtp({ from, host: 'h', port: 465, secure: true, user: 'u', pass: 'p', transport: bad }).verify!(), (e: EmailError) => !e.retryable && /App Password/.test(e.message) && !e.message.includes('Invalid login'));
});
