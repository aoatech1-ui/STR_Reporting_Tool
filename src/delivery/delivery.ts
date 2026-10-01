import { formatMoney } from '../money.ts';
import { signLink } from './links.ts';
import type { AuditLog } from '../audit.ts';

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'FAILED';
export interface DeliveryRecord {
  statementId: string; channel: 'EMAIL' | 'WHATSAPP'; recipient: string; status: DeliveryStatus;
  providerMessageId: string | null; sentAt: string | null; templateId?: string; error?: string; resend: boolean;
}
export interface EmailProvider { send(m: { to: string[]; subject: string; text: string }): Promise<{ messageId: string }> }
export interface WhatsAppProvider { sendTemplate(m: { to: string; template: string; params: string[] }): Promise<{ messageId: string }> }

export interface DeliveryTarget {
  statementId: string; statementStatus: 'DRAFT' | 'REVIEW' | 'FINALIZED' | 'LOCKED';
  propertyName: string; monthLabel: string; ownerProceedsCents: number;
  owner: { emails: string[]; emailEnabled: boolean; whatsappPhone: string | null; whatsappEnabled: boolean; whatsappOptIn: boolean };
}
export interface DeliveryDeps {
  email: EmailProvider; whatsapp: WhatsAppProvider; audit: AuditLog; linkSecret: string; baseUrl: string;
  now: () => number; userId: string; existing: readonly DeliveryRecord[];
  /** WhatsApp bodies are minimal by default; the full statement is behind the signed link. */
  whatsappIncludeSummary?: boolean;
}
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/** Sends only FINALIZED statements. A repeat send needs resend=true and is audited as a resend. */
export async function deliverStatement(t: DeliveryTarget, d: DeliveryDeps, opts: { resend?: boolean } = {}): Promise<DeliveryRecord[]> {
  if (t.statementStatus !== 'FINALIZED' && t.statementStatus !== 'LOCKED') throw new Error('Statements can only be sent after finalization');
  const resend = !!opts.resend;
  const already = (ch: DeliveryRecord['channel']) => d.existing.some((r) => r.statementId === t.statementId && r.channel === ch && r.status !== 'FAILED' && r.status !== 'BOUNCED');
  const url = `${d.baseUrl}/s/${signLink(t.statementId, d.linkSecret, d.now() + LINK_TTL_MS)}`;
  const out: DeliveryRecord[] = [];
  const record = (r: Omit<DeliveryRecord, 'statementId' | 'resend'>) => {
    const full = { ...r, statementId: t.statementId, resend };
    out.push(full);
    d.audit.append({ userId: d.userId, action: resend ? 'STATEMENT_RESENT' : 'STATEMENT_SENT', entityType: 'owner_statement',
      entityId: t.statementId, oldValue: null, newValue: { channel: r.channel, status: r.status, recipient: r.recipient }, at: new Date(d.now()).toISOString() });
  };

  if (t.owner.emailEnabled && t.owner.emails.length && (resend || !already('EMAIL'))) {
    const to = t.owner.emails.join(', ');
    try {
      const res = await d.email.send({ to: t.owner.emails, subject: `${t.monthLabel} owner statement – ${t.propertyName}`,
        text: `Your ${t.monthLabel} owner statement for ${t.propertyName} is ready.\nOwner proceeds: ${formatMoney(t.ownerProceedsCents)}\nView PDF/CSV (link expires in 7 days): ${url}` });
      record({ channel: 'EMAIL', recipient: to, status: 'SENT', providerMessageId: res.messageId, sentAt: new Date(d.now()).toISOString() });
    } catch (e) {
      record({ channel: 'EMAIL', recipient: to, status: 'FAILED', providerMessageId: null, sentAt: null, error: (e as Error).message });
    }
  }
  if (t.owner.whatsappEnabled && t.owner.whatsappOptIn && t.owner.whatsappPhone && (resend || !already('WHATSAPP'))) {
    const template = 'statement_ready';
    const params = [t.monthLabel, t.propertyName, ...(d.whatsappIncludeSummary ? [formatMoney(t.ownerProceedsCents)] : []), url];
    try {
      const res = await d.whatsapp.sendTemplate({ to: t.owner.whatsappPhone, template, params });
      record({ channel: 'WHATSAPP', recipient: t.owner.whatsappPhone, status: 'SENT', providerMessageId: res.messageId, sentAt: new Date(d.now()).toISOString(), templateId: template });
    } catch (e) {
      record({ channel: 'WHATSAPP', recipient: t.owner.whatsappPhone, status: 'FAILED', providerMessageId: null, sentAt: null, templateId: template, error: (e as Error).message });
    }
  }
  return out;
}
