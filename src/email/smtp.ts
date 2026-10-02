import nodemailer, { type Transporter } from 'nodemailer';
import { EmailError, formatSender, type EmailMessage, type EmailProvider, type Sender } from './types.ts';

export interface SmtpPreset { host: string; port: number; secure: boolean; note?: string }

/** Consumer / business mailboxes. Convenient for low volume; see `note` for caveats. Use an app password, never the account password. */
export const SMTP_PRESETS: Record<string, SmtpPreset> = {
  gmail:    { host: 'smtp.gmail.com', port: 465, secure: true, note: 'Requires 2-Step Verification + an App Password. ~500 recipients/day. From must be the mailbox (or a verified alias).' },
  outlook:  { host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Outlook.com/Hotmail: Microsoft is phasing out password SMTP AUTH; may stop working. Low daily limits.' },
  office365:{ host: 'smtp.office365.com', port: 587, secure: false, note: 'Microsoft 365: SMTP AUTH must be enabled for the mailbox; Basic auth is being retired by Microsoft in favour of OAuth.' },
  yahoo:    { host: 'smtp.mail.yahoo.com', port: 465, secure: true, note: 'Requires an app password. Strict sending limits and DMARC enforcement.' },
  aol:      { host: 'smtp.aol.com', port: 465, secure: true, note: 'Requires an app password. Strict sending limits.' },
  zoho:     { host: 'smtp.zoho.com', port: 465, secure: true, note: 'Use smtp.zoho.eu / .in for other data centres (SMTP_HOST). App-specific password recommended.' },
  icloud:   { host: 'smtp.mail.me.com', port: 587, secure: false, note: 'Requires an app-specific password.' },
  fastmail: { host: 'smtp.fastmail.com', port: 465, secure: true, note: 'Requires an app password.' },
  ses:      { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, note: 'Amazon SES SMTP credentials (set SMTP_HOST for your region). Sender/domain must be verified.' },
  custom:   { host: '', port: 587, secure: false },
};

export interface SmtpOptions { from: Sender; host: string; port: number; secure: boolean; user: string; pass: string; transport?: Transporter }

export function smtp(o: SmtpOptions): EmailProvider {
  const t = o.transport ?? nodemailer.createTransport({ host: o.host, port: o.port, secure: o.secure, requireTLS: !o.secure, auth: { user: o.user, pass: o.pass },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  return { name: 'smtp',
    async verify() {
      try { await t.verify(); }
      catch (e) {
        const err = e as { responseCode?: number; code?: string };
        const hint = err.responseCode === 535 || err.code === 'EAUTH' ? ' (authentication rejected: check SMTP_USER and use an App Password)' : '';
        throw new EmailError(`smtp: ${err.code ?? 'error'}${err.responseCode ? ` ${err.responseCode}` : ''}${hint}`, false, err.responseCode);
      }
    },
    async send(m: EmailMessage) {
    try {
      const info = await t.sendMail({ from: formatSender(o.from), to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
      if ((info.rejected?.length ?? 0) > 0 && (info.accepted?.length ?? 0) === 0) throw new EmailError('smtp: all recipients rejected', false);
      return { messageId: String(info.messageId ?? '').replace(/^<|>$/g, '') };
    } catch (e) {
      if (e instanceof EmailError) throw e;
      const err = e as { responseCode?: number; code?: string };
      // 5xx replies (bad auth 535, mailbox/sender rejected) are definitive; 4xx and connection errors are transient.
      const permanent = typeof err.responseCode === 'number' && err.responseCode >= 500;
      throw new EmailError(`smtp: ${err.code ?? 'error'}${err.responseCode ? ` ${err.responseCode}` : ''}`, !permanent, err.responseCode);
    }
  } };
}
