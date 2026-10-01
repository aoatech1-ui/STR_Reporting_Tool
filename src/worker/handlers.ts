import { type Pool, withTx } from '../db/pool.ts';
import { composeEmail, composeWhatsApp, LINK_TTL_MS, type WhatsAppProvider } from '../delivery/delivery.ts';
import { signLink } from '../delivery/links.ts';
import { EmailError, type EmailProvider } from '../email/types.ts';
import { appendAudit } from '../repo/audit.ts';
import { loadStatements } from '../repo/statements.ts';
import { DELIVERY_JOB, ownerTarget } from '../services/send.ts';
import { getOwner } from '../repo/owners.ts';
import type { Handler, Job } from './queue.ts';

export interface DeliveryDeps { pool: Pool; email: EmailProvider | null; whatsapp: WhatsAppProvider | null; linkSecret: string; baseUrl: string; now?: () => number; whatsappIncludeSummary?: boolean }

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
    const url = `${d.baseUrl}/s/${signLink(st.id, d.linkSecret, now() + LINK_TTL_MS)}`;

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

export const buildHandlers = (d: DeliveryDeps): Record<string, Handler> => ({ [DELIVERY_JOB]: deliveryHandler(d) });
