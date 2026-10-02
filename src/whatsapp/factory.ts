import type { FetchLike } from '../email/types.ts';
import { metaWhatsApp } from './meta.ts';
import { twilioWhatsApp } from './twilio.ts';
import type { WhatsAppProvider, WhatsAppTemplateKey } from './types.ts';

export const WHATSAPP_PROVIDERS = ['meta', 'twilio'] as const;
export interface WhatsAppSetup {
  id: string; provider: WhatsAppProvider; includeSummary: boolean; warnings: string[];
  /** Secrets for verifying inbound webhooks. Fail closed when missing. */
  webhook: { metaAppSecret?: string; metaVerifyToken?: string; twilioAuthToken?: string };
  templates: Record<WhatsAppTemplateKey, string>;
}

/** Builds the configured WhatsApp provider from the environment. Returns null when WHATSAPP_PROVIDER is unset. */
export function createWhatsAppProvider(env: Record<string, string | undefined>, baseUrl?: string, fetchImpl?: FetchLike): WhatsAppSetup | null {
  const id = env.WHATSAPP_PROVIDER?.trim().toLowerCase();
  if (!id) return null;
  if (!(WHATSAPP_PROVIDERS as readonly string[]).includes(id)) throw new Error(`Unknown WHATSAPP_PROVIDER "${id}". Choose one of: ${WHATSAPP_PROVIDERS.join(', ')}`);
  const g = (k: string) => env[k]?.trim() || '';
  const includeSummary = g('WHATSAPP_INCLUDE_SUMMARY') === 'true';
  const warnings: string[] = [];
  const language = g('WHATSAPP_TEMPLATE_LANGUAGE') || 'en_US';

  if (id === 'meta') {
    const templates = { statement_ready: g('WHATSAPP_TEMPLATE_STATEMENT_READY') || 'statement_ready', statement_ready_summary: g('WHATSAPP_TEMPLATE_STATEMENT_READY_SUMMARY') || 'statement_ready_summary' };
    const provider = metaWhatsApp({ accessToken: g('WHATSAPP_META_TOKEN'), phoneNumberId: g('WHATSAPP_META_PHONE_NUMBER_ID'), apiVersion: g('WHATSAPP_META_API_VERSION') || undefined, language, templates, fetch: fetchImpl });
    if (!g('WHATSAPP_META_APP_SECRET')) warnings.push('WHATSAPP_META_APP_SECRET is not set: delivery receipts and STOP replies will be rejected (they are signed with the app secret).');
    if (!g('WHATSAPP_VERIFY_TOKEN')) warnings.push('WHATSAPP_VERIFY_TOKEN is not set: Meta cannot verify the webhook URL.');
    return { id, provider, includeSummary, warnings, templates, webhook: { metaAppSecret: g('WHATSAPP_META_APP_SECRET') || undefined, metaVerifyToken: g('WHATSAPP_VERIFY_TOKEN') || undefined } };
  }

  const contentSids: Partial<Record<WhatsAppTemplateKey, string>> = { statement_ready: g('TWILIO_CONTENT_SID_STATEMENT_READY') || undefined, statement_ready_summary: g('TWILIO_CONTENT_SID_STATEMENT_READY_SUMMARY') || undefined };
  if (!contentSids.statement_ready) throw new Error('TWILIO_CONTENT_SID_STATEMENT_READY is required (the HX... Content SID of your approved template)');
  if (includeSummary && !contentSids.statement_ready_summary) throw new Error('TWILIO_CONTENT_SID_STATEMENT_READY_SUMMARY is required when WHATSAPP_INCLUDE_SUMMARY=true');
  const provider = twilioWhatsApp({ accountSid: g('TWILIO_ACCOUNT_SID'), authToken: g('TWILIO_AUTH_TOKEN'), from: g('TWILIO_WHATSAPP_FROM') || undefined,
    messagingServiceSid: g('TWILIO_MESSAGING_SERVICE_SID') || undefined, contentSids, statusCallback: baseUrl ? `${baseUrl}/webhooks/whatsapp/twilio` : undefined, fetch: fetchImpl });
  if (g('TWILIO_ACCOUNT_SID').startsWith('AC') === false) warnings.push('TWILIO_ACCOUNT_SID should start with "AC".');
  return { id, provider, includeSummary, warnings, templates: { statement_ready: contentSids.statement_ready, statement_ready_summary: contentSids.statement_ready_summary ?? '' }, webhook: { twilioAuthToken: g('TWILIO_AUTH_TOKEN') } };
}
