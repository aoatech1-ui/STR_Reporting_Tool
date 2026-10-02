/** Logical template names. Providers map these to their own identifiers (Meta template name, Twilio Content SID). */
export type WhatsAppTemplateKey = 'statement_ready' | 'statement_ready_summary';

export interface WhatsAppMessage {
  to: string;                       // E.164, e.g. +15551234567
  template: WhatsAppTemplateKey;
  /** Ordered template variables: {{1}}, {{2}}, ... */
  params: string[];
}

export interface WhatsAppProvider {
  readonly name: string;
  sendTemplate(m: WhatsAppMessage): Promise<{ messageId: string }>;
  /** Read-only credential/connectivity check (sends nothing). */
  verify?(): Promise<void>;
}

/**
 * WhatsApp template variables may not contain newlines, tabs or runs of spaces, and may not be empty.
 * Values here come from user-entered names, so they are normalised rather than trusted.
 */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

export function cleanParam(v: string): string {
  const s = String(v).replace(CONTROL, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 1000);
  return s || '-';
}

export const digitsOnly = (phone: string) => phone.replace(/\D/g, '');
