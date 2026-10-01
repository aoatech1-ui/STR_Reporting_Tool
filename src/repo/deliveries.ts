import type { Db, Tx } from '../db/pool.ts';
import type { DeliveryRecord, DeliveryStatus } from '../delivery/delivery.ts';

/** Outbox row. Always starts QUEUED; the worker moves it to SENT/FAILED. */
export async function insertQueuedDelivery(tx: Tx, orgId: string, userId: string, d: { statementId: string; channel: 'EMAIL' | 'WHATSAPP'; recipient: string; resend: boolean; templateId?: string }): Promise<string> {
  const x = await tx.query(
    `INSERT INTO statement_deliveries(organization_id, statement_id, channel, recipient, status, template_id, resend, requested_by)
     VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7) RETURNING id`, [orgId, d.statementId, d.channel, d.recipient, d.templateId ?? null, d.resend, userId]);
  return x.rows[0].id;
}

export async function listDeliveries(db: Db, statementId: string): Promise<(DeliveryRecord & { id: string })[]> {
  const r = await db.query('SELECT * FROM statement_deliveries WHERE statement_id=$1 ORDER BY sent_at NULLS LAST, id', [statementId]);
  return r.rows.map((x) => ({ id: x.id, statementId: x.statement_id, channel: x.channel, recipient: x.recipient, status: x.status, providerMessageId: x.provider_message_id,
    sentAt: x.sent_at ? new Date(x.sent_at).toISOString() : null, templateId: x.template_id ?? undefined, error: x.failure_reason ?? undefined, resend: x.resend }));
}

/** Provider webhook: advance SENT → DELIVERED / BOUNCED / FAILED. Never moves a terminal state backwards. */
export async function applyDeliveryWebhook(tx: Tx, providerMessageId: string, status: Extract<DeliveryStatus, 'DELIVERED' | 'BOUNCED' | 'FAILED'>, reason?: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE statement_deliveries SET status=$2::delivery_status, delivered_at = CASE WHEN $2::text='DELIVERED' THEN now() ELSE delivered_at END, failure_reason = COALESCE($3, failure_reason)
     WHERE provider_message_id=$1 AND status IN ('QUEUED','SENT')`, [providerMessageId, status, reason ?? null]);
  return (r.rowCount ?? 0) > 0;
}

export async function countFailedDeliveries(db: Db, orgId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*) AS n FROM statement_deliveries d JOIN owner_statements s ON s.id=d.statement_id
     WHERE s.organization_id=$1 AND d.status IN ('FAILED','BOUNCED')
       AND NOT EXISTS (SELECT 1 FROM statement_deliveries g WHERE g.statement_id=d.statement_id AND g.channel=d.channel AND g.status IN ('SENT','DELIVERED') AND g.id<>d.id)`, [orgId]);
  return r.rows[0].n;
}
