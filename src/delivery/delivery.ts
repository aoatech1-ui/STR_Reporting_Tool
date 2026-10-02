import { formatMoney } from '../money.ts';
import { UserError } from '../errors.ts';
import type { WhatsAppTemplateKey } from '../whatsapp/types.ts';

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'FAILED';
export type Channel = 'EMAIL' | 'WHATSAPP';

export interface DeliveryRecord {
  statementId: string; channel: Channel; recipient: string; status: DeliveryStatus;
  providerMessageId: string | null; sentAt: string | null; templateId?: string; error?: string; resend: boolean;
}
export type { WhatsAppProvider } from '../whatsapp/types.ts';

export interface DeliveryTarget {
  statementId: string; statementStatus: 'DRAFT' | 'REVIEW' | 'FINALIZED' | 'LOCKED';
  propertyName: string; monthLabel: string; ownerProceedsCents: number;
  owner: { emails: string[]; emailEnabled: boolean; whatsappPhone: string | null; whatsappEnabled: boolean; whatsappOptIn: boolean };
}
export interface PlannedDelivery { channel: Channel; recipient: string }

/**
 * Decides which deliveries to create. Only FINALIZED/LOCKED statements; WhatsApp only with opt-in;
 * a channel that already has a live (non-failed) delivery is skipped unless this is an explicit resend.
 */
export function planDeliveries(t: DeliveryTarget, existing: readonly Pick<DeliveryRecord, 'statementId' | 'channel' | 'status'>[], opts: { resend?: boolean; emailAvailable?: boolean; whatsappAvailable?: boolean } = {}): PlannedDelivery[] {
  if (t.statementStatus !== 'FINALIZED' && t.statementStatus !== 'LOCKED') throw new UserError('Statements can only be sent after finalization');
  const live = (ch: Channel) => existing.some((r) => r.statementId === t.statementId && r.channel === ch && r.status !== 'FAILED' && r.status !== 'BOUNCED');
  const out: PlannedDelivery[] = [];
  if ((opts.emailAvailable ?? true) && t.owner.emailEnabled && t.owner.emails.length && (opts.resend || !live('EMAIL'))) {
    out.push({ channel: 'EMAIL', recipient: t.owner.emails.join(',') });
  }
  if ((opts.whatsappAvailable ?? true) && t.owner.whatsappEnabled && t.owner.whatsappOptIn && t.owner.whatsappPhone && (opts.resend || !live('WHATSAPP'))) {
    out.push({ channel: 'WHATSAPP', recipient: t.owner.whatsappPhone });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function composeEmail(t: Pick<DeliveryTarget, 'monthLabel' | 'propertyName' | 'ownerProceedsCents'>, url: string) {
  const subject = `${t.monthLabel} owner statement – ${t.propertyName}`.replace(/[\r\n]+/g, ' ');
  const proceeds = formatMoney(t.ownerProceedsCents);
  const text = `Your ${t.monthLabel} owner statement for ${t.propertyName} is ready.\nOwner proceeds: ${proceeds}\nView statement and CSV (secure link, expires in 7 days): ${url}\n\nThis is a management accounting summary, not tax, legal, or investment advice.`;
  const html = `<p>Your <strong>${esc(t.monthLabel)}</strong> owner statement for <strong>${esc(t.propertyName)}</strong> is ready.</p>`
    + `<p>Owner proceeds: <strong>${esc(proceeds)}</strong></p><p><a href="${esc(url)}">View statement and CSV</a> (secure link, expires in 7 days)</p>`
    + `<p style="color:#666;font-size:12px">This is a management accounting summary, not tax, legal, or investment advice.</p>`;
  return { subject, text, html };
}

/**
 * WhatsApp carries no dollar amounts unless the manager opts in; the full statement is behind the signed link.
 * The two variants are two separate approved templates (their variable counts differ): statement_ready / statement_ready_summary.
 */
export function composeWhatsApp(t: Pick<DeliveryTarget, 'monthLabel' | 'propertyName' | 'ownerProceedsCents'>, url: string, includeSummary = false): { template: WhatsAppTemplateKey; params: string[] } {
  return { template: includeSummary ? 'statement_ready_summary' : 'statement_ready', params: [t.monthLabel, t.propertyName, ...(includeSummary ? [formatMoney(t.ownerProceedsCents)] : []), url] };
}

export const LINK_TTL_MS = 7 * 24 * 3600 * 1000;
