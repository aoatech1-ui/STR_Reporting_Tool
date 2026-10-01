import { type Pool, withTx } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import { planDeliveries } from '../delivery/delivery.ts';
import { appendAudit } from '../repo/audit.ts';
import { insertQueuedDelivery, listDeliveries } from '../repo/deliveries.ts';
import { getOwner } from '../repo/owners.ts';
import { loadStatements } from '../repo/statements.ts';
import { enqueue } from '../worker/queue.ts';

export const DELIVERY_JOB = 'send_delivery';
export const ownerTarget = (s: { status: any; propertyName: string; statement: { year: number; month: number; ownerProceedsCents: number } }, id: string, owner: NonNullable<Awaited<ReturnType<typeof getOwner>>>) => ({
  statementId: id, statementStatus: s.status, propertyName: s.propertyName, ownerProceedsCents: s.statement.ownerProceedsCents,
  monthLabel: new Date(Date.UTC(s.statement.year, s.statement.month - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  owner: { emails: [owner.email, owner.secondaryEmail].filter((e): e is string => !!e), emailEnabled: owner.emailEnabled,
    whatsappPhone: owner.whatsappPhone, whatsappEnabled: owner.whatsappEnabled, whatsappOptIn: owner.whatsappOptIn },
});

/**
 * Outbox: in ONE transaction, record QUEUED deliveries and enqueue one job per delivery. Nothing is sent here.
 * If the transaction commits, the send will happen (with retries); if it rolls back, nothing happened. The statement row is
 * locked so two simultaneous "send" clicks cannot both queue the same channel.
 */
export async function queueStatementDelivery(pool: Pool, orgId: string, userId: string, statementId: string, opts: { resend?: boolean; emailAvailable: boolean; whatsappAvailable: boolean }) {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT 1 FROM owner_statements WHERE id=$1 AND organization_id=$2 FOR UPDATE', [statementId, orgId]);
    const [stored] = await loadStatements(tx, orgId, { id: statementId });
    if (!stored) throw new UserError('Statement not found');
    const owner = (await getOwner(tx, orgId, stored.ownerId))!;
    const plan = planDeliveries(ownerTarget(stored, statementId, owner), await listDeliveries(tx, statementId), opts);
    if (plan.length === 0) {
      if (!opts.emailAvailable && owner.emailEnabled) throw new UserError('No email provider is configured', 503);
      return { deliveryIds: [] as string[], planned: plan };
    }
    const deliveryIds: string[] = [];
    for (const p of plan) {
      const id = await insertQueuedDelivery(tx, orgId, userId, { statementId, channel: p.channel, recipient: p.recipient, resend: !!opts.resend, templateId: p.channel === 'WHATSAPP' ? 'statement_ready' : undefined });
      await enqueue(tx, { orgId, type: DELIVERY_JOB, payload: { deliveryId: id }, dedupeKey: `delivery:${id}` });
      deliveryIds.push(id);
    }
    await appendAudit(tx, orgId, { userId, action: opts.resend ? 'STATEMENT_RESEND_QUEUED' : 'STATEMENT_SEND_QUEUED', entityType: 'owner_statement', entityId: statementId, oldValue: null, newValue: { channels: plan.map((p) => p.channel) } });
    return { deliveryIds, planned: plan };
  });
}
