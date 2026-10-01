import { AuditLog } from '../audit.ts';
import { deliverStatement, type DeliveryRecord, type EmailProvider, type WhatsAppProvider } from '../delivery/delivery.ts';
import { withTx, type Pool } from '../db/pool.ts';
import { appendAudit } from '../repo/audit.ts';
import { insertDelivery, listDeliveries } from '../repo/deliveries.ts';
import { getOwner } from '../repo/owners.ts';
import { loadStatements } from '../repo/statements.ts';

export interface SendDeps { email: EmailProvider; whatsapp: WhatsAppProvider; linkSecret: string; baseUrl: string; now?: () => number; whatsappIncludeSummary?: boolean }

const monthLabel = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Sends a FINALIZED statement and persists every attempt (including failures) plus audit entries.
 * Provider calls happen outside any DB transaction; outcomes are then recorded atomically.
 */
export async function sendStatement(pool: Pool, orgId: string, userId: string, statementId: string, deps: SendDeps, opts: { resend?: boolean } = {}): Promise<DeliveryRecord[]> {
  const [stored] = await loadStatements(pool, orgId, { id: statementId });
  if (!stored) throw new Error('Statement not found');
  const owner = (await getOwner(pool, orgId, stored.ownerId))!;
  const existing = await listDeliveries(pool, statementId);
  const collector = new AuditLog();
  const records = await deliverStatement({
    statementId, statementStatus: stored.status, propertyName: stored.propertyName, ownerProceedsCents: stored.statement.ownerProceedsCents,
    monthLabel: monthLabel(stored.statement.year, stored.statement.month),
    owner: { emails: [owner.email, owner.secondaryEmail].filter((e): e is string => !!e), emailEnabled: owner.emailEnabled,
      whatsappPhone: owner.whatsappPhone, whatsappEnabled: owner.whatsappEnabled, whatsappOptIn: owner.whatsappOptIn },
  }, { email: deps.email, whatsapp: deps.whatsapp, audit: collector, linkSecret: deps.linkSecret, baseUrl: deps.baseUrl, now: deps.now ?? Date.now,
    userId, existing, whatsappIncludeSummary: deps.whatsappIncludeSummary }, opts);
  await withTx(pool, async (tx) => {
    for (const r of records) await insertDelivery(tx, r);
    for (const a of collector.all()) await appendAudit(tx, orgId, { userId, action: a.action, entityType: a.entityType, entityId: a.entityId, oldValue: a.oldValue, newValue: a.newValue, at: a.at });
  });
  return records;
}
