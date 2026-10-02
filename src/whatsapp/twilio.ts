import { get, post, type Classifier } from '../email/http.ts';
import { EmailError, type FetchLike } from '../email/types.ts';
import { cleanParam, digitsOnly, type WhatsAppMessage, type WhatsAppProvider, type WhatsAppTemplateKey } from './types.ts';

export interface TwilioOptions {
  accountSid: string; authToken: string; from?: string; messagingServiceSid?: string;
  /** Content Template SIDs (HX...) for each logical template. */
  contentSids: Partial<Record<WhatsAppTemplateKey, string>>; statusCallback?: string; fetch?: FetchLike;
}

const RETRY_CODES = new Set([20429, 20500, 20503, 30008]);
const CLASSIFY: Classifier = (_status, json) => {
  const code = json?.code as number | undefined;
  const hint: Record<number, string> = {
    20003: 'authentication failed: check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN',
    21211: 'invalid recipient phone number',
    21608: 'the sender is not a WhatsApp-enabled number',
    63016: 'outside the 24-hour window the message must use an approved template',
    63015: 'recipient has not opted in to this sender (sandbox) or is not on WhatsApp',
    63007: 'the sender could not be found on the channel (check TWILIO_WHATSAPP_FROM)',
    63032: 'WhatsApp could not deliver this template (policy or quality restriction)',
  };
  return { retryable: code !== undefined && RETRY_CODES.has(code) ? true : undefined, message: code !== undefined ? `${json?.message ?? ''} (code ${code}${hint[code] ? `: ${hint[code]}` : ''})`.slice(0, 260) : undefined };
};

/** Twilio's WhatsApp channel. Templates are Twilio Content Templates approved for WhatsApp. */
export function twilioWhatsApp(o: TwilioOptions): WhatsAppProvider {
  if (!o.accountSid) throw new Error('TWILIO_ACCOUNT_SID is required');
  if (!o.authToken) throw new Error('TWILIO_AUTH_TOKEN is required');
  if (!o.from && !o.messagingServiceSid) throw new Error('TWILIO_WHATSAPP_FROM (or TWILIO_MESSAGING_SERVICE_SID) is required');
  const auth = { authorization: `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`, accept: 'application/json' };
  const root = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
  return {
    name: 'twilio',
    async sendTemplate(m: WhatsAppMessage) {
      const sid = o.contentSids[m.template];
      if (!sid) throw new EmailError(`whatsapp-twilio: no Content SID configured for ${m.template}`, false);
      const f = new URLSearchParams({ To: `whatsapp:+${digitsOnly(m.to)}`, ContentSid: sid,
        ContentVariables: JSON.stringify(Object.fromEntries(m.params.map((p, i) => [String(i + 1), cleanParam(p)]))) });
      if (o.messagingServiceSid) f.set('MessagingServiceSid', o.messagingServiceSid); else f.set('From', `whatsapp:${o.from}`);
      if (o.statusCallback) f.set('StatusCallback', o.statusCallback);
      const r = await post('whatsapp-twilio', `${root}/Messages.json`, { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, f.toString(), o.fetch, CLASSIFY);
      if (!r.json?.sid) throw new EmailError('whatsapp-twilio: accepted but no message sid returned', false);
      return { messageId: String(r.json.sid) };
    },
    async verify() {
      const r = await get('whatsapp-twilio', `${root}.json`, auth, o.fetch, CLASSIFY);
      if (r.json?.status !== 'active') throw new EmailError(`whatsapp-twilio: account status is "${r.json?.status ?? 'unknown'}"`, false);
    },
  };
}
