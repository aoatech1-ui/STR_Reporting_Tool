import { randomUUID } from 'node:crypto';
import { withTx, type Db, type Pool } from '../db/pool.ts';
import { commitImport, idempotencyKey, previewImport, type ImportPreview } from '../import/engine.ts';
import { parseAirbnbCsv } from '../providers/airbnbCsv.ts';
import { periodOf } from '../accounting/period.ts';
import { appendAudit } from '../repo/audit.ts';
import { existingKeys, fileHash, PgImportStore } from '../repo/earnings.ts';
import { closedRanges, getOrCreatePeriod } from '../repo/periods.ts';
import { listProperties } from '../repo/properties.ts';

async function buildPreview(db: Db, orgId: string, filename: string, csv: string): Promise<ImportPreview> {
  const parsed = parseAirbnbCsv(csv);
  const [props, closed, keys] = await Promise.all([
    listProperties(db, orgId), closedRanges(db, orgId),
    existingKeys(db, orgId, parsed.records.map((r) => idempotencyKey(orgId, r))),
  ]);
  return previewImport(filename, parsed, {
    orgId, existingKeys: keys, isPeriodLocked: (d) => closed.some((c) => d >= c.start && d <= c.end),
    properties: props.map((p) => ({ id: p.id, name: p.name, airbnbListingId: p.airbnbListingId, airbnbListingName: p.airbnbListingName })),
  });
}

/** Read-only: nothing is written until confirmCsvImport. */
export const previewCsvImport = (pool: Pool, orgId: string, filename: string, csv: string) => buildPreview(pool, orgId, filename, csv);

/**
 * Re-validates the file against current database state inside one transaction (never trusts a stale preview),
 * then writes READY rows + the batch + rejected rows atomically. Concurrent imports of the same rows fail on the unique key.
 */
export async function confirmCsvImport(pool: Pool, orgId: string, userId: string, filename: string, csv: string, confirmed: boolean) {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import:${orgId}`]);
    const preview = await buildPreview(tx, orgId, filename, csv);
    const months = new Set(preview.rows.filter((r) => r.status === 'READY').map((r) => r.record.earningsDate.slice(0, 7)));
    for (const ym of [...months].sort()) { const { year, month } = periodOf(`${ym}-01`); await getOrCreatePeriod(tx, orgId, year, month); }
    const result = await commitImport(preview, { confirmed, batchId: randomUUID(), userId }, new PgImportStore(tx, orgId, fileHash(csv)));
    await appendAudit(tx, orgId, { userId, action: 'REVENUE_IMPORTED', entityType: 'import_batch', entityId: result.batchId, oldValue: null,
      newValue: { filename, ...result, summary: preview.summary } });
    return { ...result, summary: preview.summary };
  });
}
