import { createHash } from 'node:crypto';
import type { Pool } from '../db/pool.ts';
import type { FileStore } from '../files/store.ts';
import { verifyAuditChain } from '../repo/audit.ts';

export interface Violation { code: string; message: string; ref?: string }
export interface IntegrityReport { checked: { organizations: number; statements: number; files: number }; violations: Violation[] }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Re-derives what the system promised and reports anything that does not hold. Read-only.
 *  1. every organization's audit hash chain is intact
 *  2. each non-draft statement's line items add up to its owner proceeds, and its snapshot agrees with its columns
 *  3. each finalized statement still matches the source records of its month (net payouts, owner-borne expenses)
 *  4. finalized statements belong to a finalized/locked period
 *  5. with a file store: every archived statement PDF/CSV and (with deep) every receipt matches its recorded SHA-256
 * Run it after a restore, and periodically in production.
 */
export async function verifyDataIntegrity(pool: Pool, o: { files?: FileStore; deep?: boolean } = {}): Promise<IntegrityReport> {
  const violations: Violation[] = [];
  const add = (code: string, message: string, ref?: string) => violations.push({ code, message, ref });

  const orgs = (await pool.query('SELECT id FROM organizations')).rows;
  for (const x of orgs) { const broken = await verifyAuditChain(pool, x.id); if (broken !== null) add('AUDIT_CHAIN_BROKEN', `audit hash chain broken at entry #${broken}`, x.id); }

  const st = (await pool.query(
    `SELECT s.id, s.statement_number, s.status, s.owner_proceeds_cents, s.net_revenue_cents, s.expenses_cents, s.snapshot,
            p.status AS period_status, p.start_date, p.end_date, s.property_id, s.accounting_period_id,
            (SELECT coalesce(sum(l.amount_cents),0)::bigint FROM statement_line_items l WHERE l.statement_id=s.id) AS line_sum,
            (SELECT count(*)::int FROM statement_line_items l WHERE l.statement_id=s.id) AS line_count
     FROM owner_statements s JOIN accounting_periods p ON p.id=s.accounting_period_id`)).rows;
  for (const s of st) {
    if (s.status === 'DRAFT' || s.status === 'REVIEW') continue;
    const ref = s.statement_number;
    if (s.line_count === 0) add('NO_LINE_ITEMS', 'statement has no line items', ref);
    if (s.line_sum !== s.owner_proceeds_cents) add('LINES_DO_NOT_SUM', `line items total ${s.line_sum} but owner proceeds is ${s.owner_proceeds_cents}`, ref);
    if (s.snapshot?.ownerProceedsCents !== s.owner_proceeds_cents) add('SNAPSHOT_MISMATCH', 'stored snapshot disagrees with the statement row', ref);
    if (!['FINALIZED', 'LOCKED'].includes(s.period_status)) add('PERIOD_NOT_CLOSED', `finalized statement in a ${s.period_status} period`, ref);
    const earn = (await pool.query(`SELECT coalesce(sum(net_payout_cents),0)::bigint AS n FROM earnings_transactions WHERE property_id=$1 AND earnings_date BETWEEN $2 AND $3`, [s.property_id, s.start_date, s.end_date])).rows[0].n;
    if (earn !== s.net_revenue_cents) add('REVENUE_CHANGED', `net payouts in the source records now total ${earn}, the statement says ${s.net_revenue_cents}`, ref);
    const exp = (await pool.query(`SELECT coalesce(sum(total_cents) FILTER (WHERE NOT owner_paid),0)::bigint AS n FROM expenses WHERE property_id=$1 AND accounting_period_id=$2`, [s.property_id, s.accounting_period_id])).rows[0].n;
    if (exp !== s.expenses_cents) add('EXPENSES_CHANGED', `owner-borne expenses in the source records now total ${exp}, the statement says ${s.expenses_cents}`, ref);
  }

  let fileCount = 0;
  if (o.files) {
    const arch = (await pool.query(`SELECT a.id, a.storage_key, a.sha256, a.size_bytes, s.statement_number FROM owner_statements s JOIN attachments a ON a.id IN (s.pdf_attachment_id, s.csv_attachment_id)`)).rows;
    const rec = o.deep ? (await pool.query(`SELECT a.id, a.storage_key, a.sha256, a.size_bytes, a.filename AS statement_number FROM expense_receipts r JOIN attachments a ON a.id=r.attachment_id`)).rows : [];
    for (const a of [...arch, ...rec]) {
      fileCount++;
      const bytes = await o.files.get(a.storage_key).catch(() => null);
      if (!bytes) add('FILE_MISSING', `file missing from storage: ${a.storage_key}`, a.statement_number);
      else if (sha256(bytes) !== a.sha256 || bytes.length !== a.size_bytes) add('FILE_CORRUPT', `file does not match its recorded SHA-256: ${a.storage_key}`, a.statement_number);
    }
  }
  return { checked: { organizations: orgs.length, statements: st.length, files: fileCount }, violations };
}
