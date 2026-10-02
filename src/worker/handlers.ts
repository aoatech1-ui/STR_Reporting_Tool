import { type Pool, withTx } from '../db/pool.ts';
import { composeEmail, composeWhatsApp, LINK_TTL_MS, type WhatsAppProvider } from '../delivery/delivery.ts';
import { signLink } from '../delivery/links.ts';
import { EmailError, type EmailProvider } from '../email/types.ts';
import { appendAudit } from '../repo/audit.ts';
import { loadStatements } from '../repo/statements.ts';
import { PermanentError } from '../errors.ts';
import type { FileStore } from '../files/store.ts';
import { renderStatementPdf } from '../pdf/render.ts';
import { insertAttachment } from '../repo/attachments.ts';
import { attachStatementFiles, getStatementFiles } from '../repo/statements.ts';
import { loadStatementDoc, sha256, statementCsv } from '../services/documents.ts';
import { STATEMENT_FILES_JOB } from '../services/close.ts';
import { DELIVERY_JOB, ownerTarget } from '../services/send.ts';
import { getOwner } from '../repo/owners.ts';
import type { Handler, Job } from './queue.ts';

export interface DeliveryDeps { pool: Pool; files: FileStore; email: EmailProvider | null; whatsapp: WhatsAppProvider | null; linkSecret: string; baseUrl: string; now?: () => number; whatsappIncludeSummary?: boolean }

/**
 * Sends one QUEUED delivery. Idempotent: a delivery that is no longer QUEUED is skipped, so a duplicate job or a retry after
 * a crash cannot send twice. The provider gets a per-delivery idempotency key for the same reason. The residual at-least-once
 * window is: provider accepted the message, then the process died before the SENT update — a retry then relies on that key.
 */
export function deliveryHandler(d: DeliveryDeps): Handler {
  const now = d.now ?? Date.now;
  const note = (e: Error) => e.message.slice(0, 300);

  async function run(job: Job) {
    const { rows } = await d.pool.query('SELECT * FROM statement_deliveries WHERE id=$1', [job.payload.deliveryId]);
    const del = rows[0];
    if (!del || del.status !== 'QUEUED') return;
    const [st] = await loadStatements(d.pool, del.organization_id, { id: del.statement_id });
    if (!st || (st.status !== 'FINALIZED' && st.status !== 'LOCKED')) throw new EmailError('Statement is not finalized', false);
    const owner = (await getOwner(d.pool, del.organization_id, st.ownerId))!;
    const target = ownerTarget(st, st.id, owner);
    const url = `${d.baseUrl}/view/${signLink(st.id, d.linkSecret, now() + LINK_TTL_MS)}`;

    let providerId: string;
    if (del.channel === 'EMAIL') {
      if (!d.email) throw new EmailError('Email provider is not configured', false);
      const m = composeEmail(target, url);
      providerId = (await d.email.send({ to: String(del.recipient).split(',').map((x) => x.trim()).filter(Boolean), ...m, idempotencyKey: `delivery:${del.id}` })).messageId;
    } else {
      if (!d.whatsapp) throw new EmailError('WhatsApp provider is not configured', false);
      const m = composeWhatsApp(target, url, d.whatsappIncludeSummary);
      providerId = (await d.whatsapp.sendTemplate({ to: del.recipient, template: m.template, params: m.params })).messageId;
    }
    await withTx(d.pool, async (tx) => {
      await tx.query(`UPDATE statement_deliveries SET status='SENT', provider_message_id=$2, sent_at=$3, attempts=$4, failure_reason=NULL WHERE id=$1`, [del.id, providerId, new Date(now()), job.attempts]);
      await appendAudit(tx, del.organization_id, { userId: del.requested_by, action: del.resend ? 'STATEMENT_RESENT' : 'STATEMENT_SENT', entityType: 'owner_statement', entityId: del.statement_id,
        oldValue: null, newValue: { channel: del.channel, status: 'SENT', recipient: del.recipient, deliveryId: del.id }, at: new Date(now()).toISOString() });
    });
  }

  return {
    run,
    // visible while retrying: attempts + last error on the delivery row
    async onRetry(job, err) { await d.pool.query('UPDATE statement_deliveries SET attempts=$2, failure_reason=$3 WHERE id=$1', [job.payload.deliveryId, job.attempts, note(err)]); },
    async onGiveUp(job, err) {
      await withTx(d.pool, async (tx) => {
        const r = await tx.query(`UPDATE statement_deliveries SET status='FAILED', attempts=$2, failure_reason=$3 WHERE id=$1 AND status='QUEUED' RETURNING organization_id, statement_id, channel, requested_by`,
          [job.payload.deliveryId, job.attempts, note(err)]);
        const x = r.rows[0];
        if (x) await appendAudit(tx, x.organization_id, { userId: x.requested_by, action: 'STATEMENT_SEND_FAILED', entityType: 'owner_statement', entityId: x.statement_id, oldValue: null, newValue: { channel: x.channel, error: note(err), attempts: job.attempts } });
      });
    },
  };
}

/**
 * Renders the finalized statement's PDF and CSV once, stores them, records size + SHA-256, and links them to the statement.
 * Idempotent: a statement that already has its files is skipped; storage keys are deterministic so a retry overwrites safely.
 */
export function statementFilesHandler(d: DeliveryDeps): Handler {
  return {
    async run(job) {
      const { statementId, orgId } = job.payload as { statementId: string; orgId?: string };
      const org = orgId ?? job.orgId;
      if (!org) throw new PermanentError('Job has no organization');
      const doc = await loadStatementDoc(d.pool, org, statementId, ['FINALIZED', 'LOCKED']);
      if (!doc) throw new PermanentError('Statement not found or not finalized');
      const existing = await getStatementFiles(d.pool, org, statementId);
      if (existing.pdf && existing.csv) return;
      const pdf = await renderStatementPdf(doc.pdf), csv = Buffer.from(statementCsv(doc.stored), 'utf8');
      const base = `${org}/statements/${statementId}/${doc.stored.statementNumber}`;
      await d.files.put(`${base}.pdf`, pdf, 'application/pdf');
      await d.files.put(`${base}.csv`, csv, 'text/csv');
      await withTx(d.pool, async (tx) => {
        const pdfId = await insertAttachment(tx, org, null, { storageKey: `${base}.pdf`, filename: `${doc.stored.statementNumber}.pdf`, contentType: 'application/pdf', sizeBytes: pdf.length, sha256: sha256(pdf) });
        const csvId = await insertAttachment(tx, org, null, { storageKey: `${base}.csv`, filename: `${doc.stored.statementNumber}.csv`, contentType: 'text/csv', sizeBytes: csv.length, sha256: sha256(csv) });
        await attachStatementFiles(tx, org, statementId, pdfId, csvId);
        await appendAudit(tx, org, { userId: null, action: 'STATEMENT_FILES_GENERATED', entityType: 'owner_statement', entityId: statementId, oldValue: null,
          newValue: { pdfSha256: sha256(pdf), pdfBytes: pdf.length, csvSha256: sha256(csv) } });
      });
    },
  };
}

export const buildHandlers = (d: DeliveryDeps): Record<string, Handler> => ({ [DELIVERY_JOB]: deliveryHandler(d), [STATEMENT_FILES_JOB]: statementFilesHandler(d) });
