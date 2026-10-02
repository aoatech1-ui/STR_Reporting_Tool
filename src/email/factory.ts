import { brevo, mailersend, mailgun, mailjet, postmark, resend, sendgrid } from './providers.ts';
import { smtp, SMTP_PRESETS } from './smtp.ts';
import { parseSender, type EmailProvider, type FetchLike } from './types.ts';

export const HTTP_PROVIDERS = ['brevo', 'resend', 'mailjet', 'mailersend', 'postmark', 'sendgrid', 'mailgun'] as const;
export type HttpProviderName = (typeof HTTP_PROVIDERS)[number];
export const PROVIDER_NAMES = [...HTTP_PROVIDERS, ...Object.keys(SMTP_PRESETS)];

export interface EmailSetup { provider: EmailProvider; id: string; warnings: string[] }

/** Builds the configured provider from environment-style variables. Secrets stay in env/secret store, never in the DB. */
export function createEmailProvider(env: Record<string, string | undefined>, fetchImpl?: FetchLike): EmailSetup | null {
  const id = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!id) return null;
  if (!PROVIDER_NAMES.includes(id)) throw new Error(`Unknown EMAIL_PROVIDER "${id}". Choose one of: ${PROVIDER_NAMES.join(', ')}`);
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required (a sender address verified with your provider)');
  const from = parseSender(env.EMAIL_FROM);
  const g = (k: string) => env[k]?.trim() || '';
  const o = { from, fetch: fetchImpl };
  const warnings: string[] = [];
  switch (id as HttpProviderName) {
    case 'brevo': return { id, provider: brevo({ ...o, apiKey: g('BREVO_API_KEY') }), warnings };
    case 'resend': return { id, provider: resend({ ...o, apiKey: g('RESEND_API_KEY') }), warnings };
    case 'mailjet': return { id, provider: mailjet({ ...o, apiKey: g('MAILJET_API_KEY'), apiSecret: g('MAILJET_API_SECRET') }), warnings };
    case 'mailersend': return { id, provider: mailersend({ ...o, apiToken: g('MAILERSEND_API_TOKEN') }), warnings };
    case 'postmark': return { id, provider: postmark({ ...o, serverToken: g('POSTMARK_SERVER_TOKEN') }), warnings };
    case 'sendgrid': return { id, provider: sendgrid({ ...o, apiKey: g('SENDGRID_API_KEY') }), warnings };
    case 'mailgun': return { id, provider: mailgun({ ...o, apiKey: g('MAILGUN_API_KEY'), domain: g('MAILGUN_DOMAIN'), region: g('MAILGUN_REGION') === 'eu' ? 'eu' : 'us' }), warnings };
  }
  const preset = SMTP_PRESETS[id];
  const host = g('SMTP_HOST') || preset.host;
  if (!host) throw new Error('SMTP_HOST is required for EMAIL_PROVIDER=custom');
  if (!g('SMTP_USER') || !g('SMTP_PASS')) throw new Error('SMTP_USER and SMTP_PASS are required for SMTP providers');
  if (preset.note) warnings.push(`${id}: ${preset.note}`);
  if (id !== 'ses' && id !== 'custom') warnings.push('Mailbox SMTP is not designed for automated transactional mail: low daily caps, no delivery webhooks, and throttling risk. Prefer Brevo/Resend/Mailjet/MailerSend/Postmark.');
  if (id !== 'ses' && id !== 'custom' && from.email.toLowerCase() !== g('SMTP_USER').toLowerCase()) {
    warnings.push(`${id} rewrites or rejects a From address that is not the mailbox (or a verified alias). EMAIL_FROM is ${from.email} but SMTP_USER is ${g('SMTP_USER')}.`);
  }
  if (id === 'gmail' && /\s/.test(g('SMTP_PASS')) ) warnings.push('SMTP_PASS contains spaces: remove the spaces Google shows in the 16-character app password.');
  const port = Number(g('SMTP_PORT')) || preset.port;
  return { id, provider: smtp({ from, host, port, secure: g('SMTP_SECURE') ? g('SMTP_SECURE') === 'true' : port === 465, user: g('SMTP_USER'), pass: g('SMTP_PASS') }), warnings };
}
