import { createHmac, timingSafeEqual } from 'node:crypto';
import { normId } from './http.ts';

export interface WebhookEvent { messageId: string; status: 'DELIVERED' | 'BOUNCED' | 'FAILED'; reason?: string }
export class WebhookAuthError extends Error { constructor(m = 'Invalid webhook signature') { super(m); this.name = 'WebhookAuthError'; } }

export interface WebhookRequest { headers: Record<string, string | string[] | undefined>; query: Record<string, string | undefined>; rawBody: string }
export interface WebhookSecrets { /** shared secret in the webhook URL (?token=) — Brevo, Mailjet, Postmark, SendGrid */ token?: string; /** provider signing secret — Resend (whsec_…), MailerSend, Mailgun */ signingSecret?: string }

const TOLERANCE_MS = 5 * 60_000;
const h = (r: WebhookRequest, n: string) => { const v = r.headers[n]; return Array.isArray(v) ? v[0] : v; };
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hmac = (key: string | Buffer, data: string, enc: 'hex' | 'base64') => createHmac('sha256', key).update(data).digest(enc);

/** Fail closed: a provider whose secret is not configured is rejected, never accepted unauthenticated. */
function authenticate(provider: string, r: WebhookRequest, s: WebhookSecrets, body: any, nowMs: number): void {
  switch (provider) {
    case 'resend': { // Svix scheme
      if (!s.signingSecret) throw new WebhookAuthError('Webhook secret not configured');
      const id = h(r, 'svix-id'), ts = h(r, 'svix-timestamp'), sigs = h(r, 'svix-signature');
      if (!id || !ts || !sigs || Math.abs(nowMs - Number(ts) * 1000) > TOLERANCE_MS) throw new WebhookAuthError();
      const key = Buffer.from(s.signingSecret.replace(/^whsec_/, ''), 'base64');
      const expected = hmac(key, `${id}.${ts}.${r.rawBody}`, 'base64');
      if (!sigs.split(' ').some((p) => safeEq(p.replace(/^v1,/, ''), expected))) throw new WebhookAuthError();
      return;
    }
    case 'mailersend': {
      if (!s.signingSecret) throw new WebhookAuthError('Webhook secret not configured');
      const sig = h(r, 'signature');
      if (!sig || !safeEq(sig, hmac(s.signingSecret, r.rawBody, 'hex'))) throw new WebhookAuthError();
      return;
    }
    case 'mailgun': {
      if (!s.signingSecret) throw new WebhookAuthError('Webhook secret not configured');
      const sg = body?.signature;
      if (!sg?.timestamp || !sg?.token || !sg?.signature || Math.abs(nowMs - Number(sg.timestamp) * 1000) > TOLERANCE_MS) throw new WebhookAuthError();
      if (!safeEq(String(sg.signature), hmac(s.signingSecret, `${sg.timestamp}${sg.token}`, 'hex'))) throw new WebhookAuthError();
      return;
    }
    default: {
      if (!s.token || !r.query.token || !safeEq(r.query.token, s.token)) throw new WebhookAuthError();
    }
  }
}

const arr = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/** Verifies authenticity, then normalises provider events to terminal delivery outcomes. Transient events (soft bounce, deferred) are ignored. */
export function parseEmailWebhook(provider: string, r: WebhookRequest, secrets: WebhookSecrets, nowMs = Date.now()): WebhookEvent[] {
  let body: any;
  try { body = JSON.parse(r.rawBody); } catch { throw new WebhookAuthError('Malformed body'); }
  authenticate(provider, r, secrets, body, nowMs);
  const out: WebhookEvent[] = [];
  const add = (id: unknown, status: WebhookEvent['status'], reason?: unknown) => {
    if (id !== undefined && id !== null && String(id) !== '') out.push({ messageId: normId(String(id)), status, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
  };
  switch (provider) {
    case 'resend': {
      const t = body.type;
      if (t === 'email.delivered') add(body.data?.email_id, 'DELIVERED');
      else if (t === 'email.bounced') add(body.data?.email_id, 'BOUNCED', body.data?.bounce?.message ?? 'bounced');
      else if (t === 'email.failed') add(body.data?.email_id, 'FAILED', body.data?.reason ?? 'failed');
      break;
    }
    case 'brevo':
      switch (body.event) {
        case 'delivered': add(body['message-id'], 'DELIVERED'); break;
        case 'hard_bounce': case 'blocked': case 'invalid_email': add(body['message-id'], 'BOUNCED', body.reason ?? body.event); break;
        case 'error': add(body['message-id'], 'FAILED', body.reason ?? 'error'); break;
      }
      break;
    case 'mailjet':
      for (const e of arr(body)) {
        if (e.event === 'sent') add(e.MessageID, 'DELIVERED');
        else if (e.event === 'bounce' && e.hard_bounce) add(e.MessageID, 'BOUNCED', e.error);
        else if (e.event === 'blocked') add(e.MessageID, 'FAILED', e.error ?? 'blocked');
      }
      break;
    case 'mailersend': {
      const id = body.data?.email?.message?.id ?? body.data?.email?.message_id;
      if (body.type === 'activity.delivered') add(id, 'DELIVERED');
      else if (body.type === 'activity.hard_bounced') add(id, 'BOUNCED', body.data?.morph?.readable_reason ?? 'hard bounce');
      break;
    }
    case 'postmark':
      if (body.RecordType === 'Delivery') add(body.MessageID, 'DELIVERED');
      else if (body.RecordType === 'Bounce') add(body.MessageID, 'BOUNCED', body.Description ?? body.Type);
      break;
    case 'sendgrid':
      for (const e of arr(body)) {
        const id = String(e.sg_message_id ?? '').split('.')[0]; // header id is the prefix of the event id
        if (e.event === 'delivered') add(id, 'DELIVERED');
        else if (e.event === 'bounce') add(id, 'BOUNCED', e.reason);
        else if (e.event === 'dropped') add(id, 'FAILED', e.reason);
      }
      break;
    case 'mailgun': {
      const ev = body['event-data'] ?? {};
      const id = ev.message?.headers?.['message-id'];
      if (ev.event === 'delivered') add(id, 'DELIVERED');
      else if (ev.event === 'failed' && ev.severity === 'permanent') add(id, 'BOUNCED', ev['delivery-status']?.description ?? ev.reason);
      break;
    }
    default: throw new WebhookAuthError(`No webhook support for provider "${provider}"`);
  }
  return out;
}
