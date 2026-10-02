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

export async function listAllDeliveries(db: Db, orgId: string, f: { status?: string; limit?: number } = {}) {
  const r = await db.query(
    `SELECT d.id, d.statement_id, d.channel, d.recipient, d.status, d.provider_message_id, d.sent_at, d.created_at, d.failure_reason, d.attempts, d.resend,
            s.statement_number, o.display_name AS owner_name, p.name AS property_name, ap.year, ap.month
     FROM statement_deliveries d JOIN owner_statements s ON s.id=d.statement_id JOIN owners o ON o.id=s.owner_id JOIN properties p ON p.id=s.property_id
       JOIN accounting_periods ap ON ap.id=s.accounting_period_id
     WHERE d.organization_id=$1 AND ($2::text IS NULL OR d.status::text=$2) ORDER BY d.created_at DESC LIMIT $3`, [orgId, f.status ?? null, f.limit ?? 200]);
  return r.rows.map((x) => ({ id: x.id, statementId: x.statement_id, statementNumber: x.statement_number, ownerName: x.owner_name, propertyName: x.property_name, year: x.year, month: x.month,
    channel: x.channel, recipient: x.recipient, status: x.status, providerMessageId: x.provider_message_id, sentAt: x.sent_at ? new Date(x.sent_at).toISOString() : null,
    createdAt: new Date(x.created_at).toISOString(), error: x.failure_reason, attempts: x.attempts, resend: x.resend }));
}
