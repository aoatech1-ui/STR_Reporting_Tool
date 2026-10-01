import { normId, post } from './http.ts';
import { EmailError, formatSender, type EmailMessage, type EmailProvider, type FetchLike, type Sender } from './types.ts';

interface Opts { from: Sender; fetch?: FetchLike }
const J = { 'content-type': 'application/json', accept: 'application/json' };
const need = (name: string, v: string | undefined) => { if (!v) throw new Error(`${name} is required`); return v; };
const missingId = (p: string) => new EmailError(`${p}: accepted but no message id returned`, false);

export function brevo(o: Opts & { apiKey: string }): EmailProvider {
  need('BREVO_API_KEY', o.apiKey);
  return { name: 'brevo', async send(m: EmailMessage) {
    const r = await post('brevo', 'https://api.brevo.com/v3/smtp/email', { ...J, 'api-key': o.apiKey }, JSON.stringify({
      sender: o.from, to: m.to.map((email) => ({ email })), subject: m.subject, textContent: m.text, ...(m.html ? { htmlContent: m.html } : {}) }), o.fetch);
    if (!r.json?.messageId) throw missingId('brevo');
    return { messageId: normId(r.json.messageId) };
  } };
}

export function resend(o: Opts & { apiKey: string }): EmailProvider {
  need('RESEND_API_KEY', o.apiKey);
  return { name: 'resend', async send(m) {
    const r = await post('resend', 'https://api.resend.com/emails', { ...J, authorization: `Bearer ${o.apiKey}`, ...(m.idempotencyKey ? { 'idempotency-key': m.idempotencyKey } : {}) },
      JSON.stringify({ from: formatSender(o.from), to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }), o.fetch);
    if (!r.json?.id) throw missingId('resend');
    return { messageId: normId(r.json.id) };
  } };
}

export function mailjet(o: Opts & { apiKey: string; apiSecret: string }): EmailProvider {
  need('MAILJET_API_KEY', o.apiKey); need('MAILJET_API_SECRET', o.apiSecret);
  const auth = `Basic ${Buffer.from(`${o.apiKey}:${o.apiSecret}`).toString('base64')}`;
  return { name: 'mailjet', async send(m) {
    const r = await post('mailjet', 'https://api.mailjet.com/v3.1/send', { ...J, authorization: auth }, JSON.stringify({ Messages: [{
      From: { Email: o.from.email, ...(o.from.name ? { Name: o.from.name } : {}) }, To: m.to.map((Email) => ({ Email })), Subject: m.subject, TextPart: m.text,
      ...(m.html ? { HTMLPart: m.html } : {}), ...(m.idempotencyKey ? { CustomID: m.idempotencyKey } : {}) }] }), o.fetch);
    const msg = r.json?.Messages?.[0];
    if (msg?.Status && msg.Status !== 'success') throw new EmailError(`mailjet: ${JSON.stringify(msg.Errors?.[0]?.ErrorMessage ?? msg.Status).slice(0, 200)}`, false);
    const id = msg?.To?.[0]?.MessageID ?? msg?.To?.[0]?.MessageUUID;
    if (id === undefined) throw missingId('mailjet');
    return { messageId: String(id) };
  } };
}

export function mailersend(o: Opts & { apiToken: string }): EmailProvider {
  need('MAILERSEND_API_TOKEN', o.apiToken);
  return { name: 'mailersend', async send(m) {
    const r = await post('mailersend', 'https://api.mailersend.com/v1/email', { ...J, authorization: `Bearer ${o.apiToken}` }, JSON.stringify({
      from: o.from, to: m.to.map((email) => ({ email })), subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }), o.fetch);
    const id = r.header('x-message-id');
    if (!id) throw missingId('mailersend');
    return { messageId: normId(id) };
  } };
}

export function postmark(o: Opts & { serverToken: string; stream?: string }): EmailProvider {
  need('POSTMARK_SERVER_TOKEN', o.serverToken);
  return { name: 'postmark', async send(m) {
    const r = await post('postmark', 'https://api.postmarkapp.com/email', { ...J, 'x-postmark-server-token': o.serverToken }, JSON.stringify({
      From: formatSender(o.from), To: m.to.join(','), Subject: m.subject, TextBody: m.text, ...(m.html ? { HtmlBody: m.html } : {}), MessageStream: o.stream ?? 'outbound' }), o.fetch);
    if (r.json?.ErrorCode) throw new EmailError(`postmark: ${String(r.json.Message).slice(0, 200)}`, false);
    if (!r.json?.MessageID) throw missingId('postmark');
    return { messageId: normId(r.json.MessageID) };
  } };
}

export function sendgrid(o: Opts & { apiKey: string }): EmailProvider {
  need('SENDGRID_API_KEY', o.apiKey);
  return { name: 'sendgrid', async send(m) {
    const r = await post('sendgrid', 'https://api.sendgrid.com/v3/mail/send', { ...J, authorization: `Bearer ${o.apiKey}` }, JSON.stringify({
      personalizations: [{ to: m.to.map((email) => ({ email })) }], from: o.from, subject: m.subject,
      content: [{ type: 'text/plain', value: m.text }, ...(m.html ? [{ type: 'text/html', value: m.html }] : [])] }), o.fetch);
    const id = r.header('x-message-id');
    if (!id) throw missingId('sendgrid');
    return { messageId: normId(id) };
  } };
}

export function mailgun(o: Opts & { apiKey: string; domain: string; region?: 'us' | 'eu' }): EmailProvider {
  need('MAILGUN_API_KEY', o.apiKey); need('MAILGUN_DOMAIN', o.domain);
  const base = o.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  const auth = `Basic ${Buffer.from(`api:${o.apiKey}`).toString('base64')}`;
  return { name: 'mailgun', async send(m) {
    const f = new URLSearchParams({ from: formatSender(o.from), subject: m.subject, text: m.text });
    for (const t of m.to) f.append('to', t);
    if (m.html) f.set('html', m.html);
    const r = await post('mailgun', `${base}/v3/${encodeURIComponent(o.domain)}/messages`, { authorization: auth, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, f.toString(), o.fetch);
    if (!r.json?.id) throw missingId('mailgun');
    return { messageId: normId(r.json.id) };
  } };
}
