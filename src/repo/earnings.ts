import { createHash } from 'node:crypto';
import type { Db, Tx } from '../db/pool.ts';
import type { ImportStore, RejectedRow, StoredEarnings } from '../import/engine.ts';
import type { EarningsRecord } from '../providers/types.ts';

const map = (x: any): EarningsRecord => ({
  source: x.source, sourceTransactionId: x.source_transaction_id, kind: x.kind, reservationId: x.reservation_id, listingName: '', listingId: null,
  earningsDate: x.earnings_date, payoutDate: x.payout_date, checkIn: x.check_in, checkOut: x.check_out, grossBookingCents: x.gross_booking_cents,
  cleaningFeeCents: x.cleaning_fee_cents, otherRevenueCents: x.other_revenue_cents, platformFeeCents: x.platform_fee_cents, taxCents: x.tax_cents,
  adjustmentCents: x.adjustment_cents, refundCents: x.refund_cents, coHostPayoutCents: x.co_host_payout_cents, netPayoutCents: x.net_payout_cents,
  currency: x.currency, sourceRow: x.source_row ?? 0,
});

export async function listEarnings(db: Db, orgId: string, propertyId: string, start: string, end: string): Promise<EarningsRecord[]> {
  const r = await db.query(
    `SELECT * FROM earnings_transactions WHERE organization_id=$1 AND property_id=$2 AND earnings_date BETWEEN $3 AND $4 ORDER BY earnings_date, source_transaction_id`,
    [orgId, propertyId, start, end]);
  return r.rows.map(map);
}

export async function existingKeys(db: Db, orgId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await db.query('SELECT idempotency_key FROM earnings_transactions WHERE organization_id=$1 AND idempotency_key = ANY($2::text[])', [orgId, keys]);
  return new Set(r.rows.map((x) => x.idempotency_key));
}

/** Rejected UNMATCHED rows in a date range that have not since been imported (e.g. after the property was created). */
export async function countUnmatched(db: Db, orgId: string, start: string, end: string): Promise<number> {
  const r = await db.query(
    `SELECT count(DISTINCT j.idempotency_key) AS n FROM import_rejected_rows j
     WHERE j.organization_id=$1 AND j.status='UNMATCHED_PROPERTY' AND j.earnings_date BETWEEN $2 AND $3
       AND NOT EXISTS (SELECT 1 FROM earnings_transactions e WHERE e.organization_id=j.organization_id AND e.idempotency_key=j.idempotency_key)`, [orgId, start, end]);
  return r.rows[0].n;
}

export const fileHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** ImportStore on Postgres. Runs inside the caller's transaction so batch + rows + rejects commit atomically. */
export class PgImportStore implements ImportStore {
  private tx: Tx; private orgId: string; private fileSha256: string | null;
  constructor(tx: Tx, orgId: string, fileSha256: string | null = null) { this.tx = tx; this.orgId = orgId; this.fileSha256 = fileSha256; }

  async commitBatch(
    batch: { id: string; filename: string; importedBy: string; recordCount: number; failedCount: number },
    rows: StoredEarnings[], rejected: RejectedRow[],
  ): Promise<void> {
    await this.tx.query(
      `INSERT INTO import_batches(id, organization_id, source, filename, file_sha256, imported_by, record_count, successful_count, failed_count, status)
       VALUES ($1,$2,'AIRBNB_CSV_IMPORT',$3,$4,$5,$6,$7,$8,'COMMITTED')`,
      [batch.id, this.orgId, batch.filename, this.fileSha256, batch.importedBy, batch.recordCount, rows.length, batch.failedCount]);
    for (const r of rows) {
      await this.tx.query(
        `INSERT INTO earnings_transactions(organization_id, property_id, import_batch_id, source, source_transaction_id, idempotency_key, kind, reservation_id, source_row,
           check_in, check_out, earnings_date, payout_date, gross_booking_cents, cleaning_fee_cents, other_revenue_cents, platform_fee_cents, tax_cents,
           adjustment_cents, refund_cents, co_host_payout_cents, net_payout_cents, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [this.orgId, r.propertyId, batch.id, r.source, r.sourceTransactionId, r.idempotencyKey, r.kind, r.reservationId, r.sourceRow, r.checkIn, r.checkOut,
          r.earningsDate, r.payoutDate, r.grossBookingCents, r.cleaningFeeCents, r.otherRevenueCents, r.platformFeeCents, r.taxCents, r.adjustmentCents,
          r.refundCents, r.coHostPayoutCents, r.netPayoutCents, r.currency]);
    }
    for (const j of rejected) {
      // Re-uploading the same file must not list the same open exception twice.
      await this.tx.query(
        `INSERT INTO import_rejected_rows(organization_id, import_batch_id, source_row, status, idempotency_key, earnings_date, listing_name, net_payout_cents, record)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
         WHERE NOT EXISTS (SELECT 1 FROM import_rejected_rows x WHERE x.organization_id=$1 AND x.idempotency_key=$5 AND x.status=$4)`,
        [this.orgId, batch.id, j.record.sourceRow, j.status, j.idempotencyKey, j.record.earningsDate, j.record.listingName, j.record.netPayoutCents, JSON.stringify(j.record)]);
    }
  }
}

export interface RevenueRow { id: string; propertyId: string; propertyName: string; kind: string; reservationId: string | null; checkIn: string | null; checkOut: string | null; earningsDate: string; payoutDate: string | null;
  grossBookingCents: number; cleaningFeeCents: number; platformFeeCents: number; taxCents: number; adjustmentCents: number; refundCents: number; netPayoutCents: number; importBatchId: string }

export async function listRevenue(db: Db, orgId: string, f: { start: string; end: string; propertyId?: string }): Promise<RevenueRow[]> {
  const r = await db.query(
    `SELECT e.*, p.name AS property_name FROM earnings_transactions e JOIN properties p ON p.id = e.property_id
     WHERE e.organization_id=$1 AND e.earnings_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR e.property_id=$4) ORDER BY e.earnings_date, p.name, e.source_transaction_id`,
    [orgId, f.start, f.end, f.propertyId ?? null]);
  return r.rows.map((x) => ({ id: x.id, propertyId: x.property_id, propertyName: x.property_name, kind: x.kind, reservationId: x.reservation_id, checkIn: x.check_in, checkOut: x.check_out,
    earningsDate: x.earnings_date, payoutDate: x.payout_date, grossBookingCents: x.gross_booking_cents, cleaningFeeCents: x.cleaning_fee_cents, platformFeeCents: x.platform_fee_cents,
    taxCents: x.tax_cents, adjustmentCents: x.adjustment_cents, refundCents: x.refund_cents, netPayoutCents: x.net_payout_cents, importBatchId: x.import_batch_id }));
}

export async function listImportBatches(db: Db, orgId: string, limit = 50) {
  const r = await db.query(
    `SELECT b.id, b.filename, b.imported_at, b.record_count, b.successful_count, b.failed_count, b.status, u.name AS imported_by,
       (SELECT count(*)::int FROM import_rejected_rows j WHERE j.import_batch_id=b.id AND j.status='UNMATCHED_PROPERTY'
          AND NOT EXISTS (SELECT 1 FROM earnings_transactions e WHERE e.organization_id=j.organization_id AND e.idempotency_key=j.idempotency_key)) AS unmatched,
       (SELECT count(*)::int FROM import_rejected_rows j WHERE j.import_batch_id=b.id AND j.status='PERIOD_LOCKED') AS locked
     FROM import_batches b JOIN users u ON u.id=b.imported_by WHERE b.organization_id=$1 ORDER BY b.imported_at DESC LIMIT $2`, [orgId, limit]);
  return r.rows.map((x) => ({ id: x.id, filename: x.filename, importedAt: new Date(x.imported_at).toISOString(), importedBy: x.imported_by, records: x.record_count,
    imported: x.successful_count, skipped: x.failed_count, status: x.status, unmatched: x.unmatched, locked: x.locked }));
}
