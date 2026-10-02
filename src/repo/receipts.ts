import type { Db, Tx } from '../db/pool.ts';
import { assertEditable } from '../accounting/period.ts';
import { UserError } from '../errors.ts';
import { appendAudit } from './audit.ts';
import { mapAttachment, type AttachmentRow } from './attachments.ts';

export async function listReceipts(db: Db, orgId: string, expenseId: string): Promise<AttachmentRow[]> {
  const r = await db.query(
    `SELECT a.* FROM expense_receipts r JOIN attachments a ON a.id=r.attachment_id WHERE r.organization_id=$1 AND r.expense_id=$2 ORDER BY r.created_at, a.id`, [orgId, expenseId]);
  return r.rows.map(mapAttachment);
}

/** Links an already-stored attachment. Allowed in closed months: documenting an expense does not change any figure. */
export async function linkReceipt(tx: Tx, orgId: string, userId: string, expenseId: string, att: { id: string; filename: string; sha256: string }): Promise<void> {
  await tx.query('INSERT INTO expense_receipts(organization_id, expense_id, attachment_id, created_by) VALUES ($1,$2,$3,$4)', [orgId, expenseId, att.id, userId]);
  await appendAudit(tx, orgId, { userId, action: 'RECEIPT_ADDED', entityType: 'expense', entityId: expenseId, oldValue: null, newValue: { attachmentId: att.id, filename: att.filename, sha256: att.sha256 } });
}

/** Removing evidence is only possible while the month is open. Returns the storage key to delete after commit. */
export async function unlinkReceipt(tx: Tx, orgId: string, userId: string, attachmentId: string): Promise<string> {
  const r = await tx.query(
    `SELECT r.expense_id, a.storage_key, a.filename, a.sha256, p.id AS pid, p.year, p.month, p.status
     FROM expense_receipts r JOIN attachments a ON a.id=r.attachment_id JOIN expenses e ON e.id=r.expense_id JOIN accounting_periods p ON p.id=e.accounting_period_id
     WHERE r.attachment_id=$1 AND r.organization_id=$2 FOR UPDATE OF r`, [attachmentId, orgId]);
  const x = r.rows[0];
  if (!x) throw new UserError('Receipt not found');
  assertEditable({ id: x.pid, year: x.year, month: x.month, status: x.status });
  await tx.query('DELETE FROM expense_receipts WHERE attachment_id=$1', [attachmentId]);
  await tx.query('DELETE FROM attachments WHERE id=$1', [attachmentId]);
  await appendAudit(tx, orgId, { userId, action: 'RECEIPT_REMOVED', entityType: 'expense', entityId: x.expense_id, oldValue: { attachmentId, filename: x.filename, sha256: x.sha256 }, newValue: null });
  return x.storage_key;
}
