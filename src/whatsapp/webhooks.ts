import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookAuthError, type WebhookEvent } from '../email/webhooks.ts';
import { digitsOnly } from './types.ts';

export interface WhatsAppInbound { from: string; text: string }
export interface WhatsAppWebhook { statuses: WebhookEvent[]; inbound: WhatsAppInbound[] }

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Exact-word opt-out keywords only, so a sentence like "please don't stop" never unsubscribes anyone. */
export function isOptOut(text: string): boolean {
  return /^(stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out|parar|baja)$/.test(text.trim().toLowerCase().replace(/[.!\s]+$/g, ''));
}

/** Meta's one-time GET handshake when you register the webhook URL. Returns the challenge to echo, or null to refuse. */
export function metaChallenge(query: Record<string, string | undefined>, verifyToken: string | undefined): string | null {
  if (!verifyToken || query['hub.mode'] !== 'subscribe' || !query['hub.verify_token'] || !query['hub.challenge']) return null;
  return safeEq(query['hub.verify_token'], verifyToken) ? query['hub.challenge'] : null;
}

/** Meta signs every POST: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function parseMetaWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, appSecret: string | undefined): WhatsAppWebhook {
  if (!appSecret) throw new WebhookAuthError('Webhook secret not configured');
  const sig = [headers['x-hub-signature-256']].flat()[0];
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  if (!sig || !safeEq(sig, expected)) throw new WebhookAuthError();
  let body: any;
  try { body = JSON.parse(rawBody); } catch { throw new WebhookAuthError('Malformed body'); }
  const out: WhatsAppWebhook = { statuses: [], inbound: [] };
  for (const entry of body?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const v = ch?.value ?? {};
    for (const s of v.statuses ?? []) {
      if (!s?.id) continue;
      if (s.status === 'delivered' || s.status === 'read') out.statuses.push({ messageId: String(s.id), status: 'DELIVERED' });
      else if (s.status === 'failed') {
        const e = s.errors?.[0];
        out.statuses.push({ messageId: String(s.id), status: 'FAILED', reason: String(`${e?.title ?? 'failed'}${e?.code ? ` (code ${e.code})` : ''}${e?.error_data?.details ? `: ${e.error_data.details}` : ''}`).slice(0, 300) });
      }
    }
    for (const m of v.messages ?? []) if (m?.from && m?.type === 'text') out.inbound.push({ from: digitsOnly(String(m.from)), text: String(m.text?.body ?? '') });
  }
  return out;
}

/**
 * Twilio signs callbacks: X-Twilio-Signature = base64(HMAC-SHA1(auth token, full URL + each POST param name+value, sorted by name)).
 * `url` must be exactly the URL configured at Twilio.
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const data = [...params.keys()].sort().reduce((acc, k) => acc + params.getAll(k).sort().map((v) => k + v).join(''), url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function parseTwilioWebhook(url: string, rawForm: string, headers: Record<string, string | string[] | undefined>, authToken: string | undefined, query: Record<string, string | undefined> = {}): WhatsAppWebhook {
  if (!authToken) throw new WebhookAuthError('Webhook secret not configured');
  const params = new URLSearchParams(rawForm);
  const sig = [headers['x-twilio-signature']].flat()[0];
  if (!sig || !safeEq(sig, twilioSignature(authToken, url, params))) throw new WebhookAuthError();
  void query;
  const out: WhatsAppWebhook = { statuses: [], inbound: [] };
  const sid = params.get('MessageSid') ?? params.get('SmsSid');
  const status = params.get('MessageStatus') ?? params.get('SmsStatus');
  if (sid && status) {
    if (status === 'delivered' || status === 'read') out.statuses.push({ messageId: sid, status: 'DELIVERED' });
    else if (status === 'failed' || status === 'undelivered') out.statuses.push({ messageId: sid, status: 'FAILED', reason: `${status}${params.get('ErrorCode') ? ` (code ${params.get('ErrorCode')})` : ''}` });
  } else if (params.get('Body') !== null && params.get('From')) {
    out.inbound.push({ from: digitsOnly((params.get('From') ?? '').replace(/^whatsapp:/, '')), text: params.get('Body') ?? '' });
  }
  return out;
}
