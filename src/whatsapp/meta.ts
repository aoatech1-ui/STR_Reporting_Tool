import { get, post, type Classifier } from '../email/http.ts';
import { EmailError, type FetchLike } from '../email/types.ts';
import { cleanParam, digitsOnly, type WhatsAppMessage, type WhatsAppProvider, type WhatsAppTemplateKey } from './types.ts';

export interface MetaOptions {
  accessToken: string; phoneNumberId: string; apiVersion?: string; language: string;
  templates: Record<WhatsAppTemplateKey, string>; fetch?: FetchLike;
}

/** Meta error codes that mean "try again later" (rate limits, throttling). Everything else in the 4xx range is final. */
const RETRY_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
const CLASSIFY: Classifier = (_status, json) => {
  const code = json?.error?.code as number | undefined;
  const hint: Record<number, string> = {
    190: 'access token is invalid or expired: renew WHATSAPP_META_TOKEN (use a System User token that does not expire)',
    131026: 'recipient is not reachable on WhatsApp (number not on WhatsApp, or has not accepted the latest terms)',
    131030: 'recipient number is not on the allowed list (a test number can only message numbers added in the Meta console)',
    132000: 'template variable count does not match the approved template',
    132001: 'template does not exist, or is not approved in this language',
    132012: 'template variable format does not match the approved template',
    131042: 'WhatsApp Business account has a payment problem',
  };
  const th = code !== undefined ? ` (code ${code}${hint[code] ? `: ${hint[code]}` : ''})` : '';
  return { retryable: code !== undefined && RETRY_CODES.has(code) ? true : undefined, message: th ? `${json?.error?.message ?? ''}${th}`.slice(0, 260) : undefined };
};

/** WhatsApp Business Cloud API (Meta, direct). Business-initiated messages must use an approved template. */
export function metaWhatsApp(o: MetaOptions): WhatsAppProvider {
  if (!o.accessToken) throw new Error('WHATSAPP_META_TOKEN is required');
  if (!o.phoneNumberId) throw new Error('WHATSAPP_META_PHONE_NUMBER_ID is required');
  const base = `https://graph.facebook.com/${o.apiVersion ?? 'v21.0'}`;
  const auth = { authorization: `Bearer ${o.accessToken}`, accept: 'application/json' };
  return {
    name: 'meta',
    async sendTemplate(m: WhatsAppMessage) {
      const r = await post('whatsapp-meta', `${base}/${encodeURIComponent(o.phoneNumberId)}/messages`, { ...auth, 'content-type': 'application/json' }, JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: digitsOnly(m.to), type: 'template',
        template: { name: o.templates[m.template], language: { code: o.language }, components: [{ type: 'body', parameters: m.params.map((p) => ({ type: 'text', text: cleanParam(p) })) }] },
      }), o.fetch, CLASSIFY);
      const id = r.json?.messages?.[0]?.id;
      if (!id) throw new EmailError('whatsapp-meta: accepted but no message id returned', false);
      return { messageId: String(id) };
    },
    async verify() {
      const r = await get('whatsapp-meta', `${base}/${encodeURIComponent(o.phoneNumberId)}?fields=display_phone_number,verified_name`, auth, o.fetch, CLASSIFY);
      if (!r.json?.display_phone_number) throw new EmailError('whatsapp-meta: phone number id returned no number', false);
    },
  };
}
