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
      await this.tx.query(
        `INSERT INTO import_rejected_rows(organization_id, import_batch_id, source_row, status, idempotency_key, earnings_date, listing_name, net_payout_cents, record)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [this.orgId, batch.id, j.record.sourceRow, j.status, j.idempotencyKey, j.record.earningsDate, j.record.listingName, j.record.netPayoutCents, JSON.stringify(j.record)]);
    }
  }
}
