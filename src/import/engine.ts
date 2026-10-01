import { createHash } from 'node:crypto';
import type { EarningsRecord, ParseResult, RowIssue } from '../providers/types.ts';

export interface PropertyRef { id: string; name: string; airbnbListingId?: string | null; airbnbListingName?: string | null }

export type RowStatus = 'READY' | 'DUPLICATE_EXISTING' | 'DUPLICATE_IN_FILE' | 'UNMATCHED_PROPERTY' | 'PERIOD_LOCKED';
export interface PreviewRow { record: EarningsRecord; status: RowStatus; propertyId: string | null; idempotencyKey: string }
export interface ImportPreview {
  filename: string;
  headerErrors: string[];
  rows: PreviewRow[];
  issues: RowIssue[];
  summary: Record<RowStatus, number> & { errors: number; total: number };
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function idempotencyKey(orgId: string, r: EarningsRecord): string {
  return createHash('sha256').update(`${orgId}|${r.source}|${r.sourceTransactionId}`).digest('hex');
}

export function matchProperty(r: EarningsRecord, props: PropertyRef[]): PropertyRef | null {
  if (r.listingId) {
    const byId = props.find((p) => p.airbnbListingId && p.airbnbListingId === r.listingId);
    if (byId) return byId;
  }
  const name = norm(r.listingName);
  const hits = props.filter((p) => norm(p.airbnbListingName) === name && name !== '');
  return hits.length === 1 ? hits[0] : null; // ambiguous names are never auto-matched
}

export interface ImportContext {
  orgId: string;
  properties: PropertyRef[];
  existingKeys: ReadonlySet<string>;
  /** True if the accounting month containing this date is FINALIZED/LOCKED. */
  isPeriodLocked: (earningsDate: string) => boolean;
}

/** Step 1: validate + match + dedupe. Writes nothing. */
export function previewImport(filename: string, parsed: ParseResult, ctx: ImportContext): ImportPreview {
  const seen = new Set<string>();
  const rows: PreviewRow[] = parsed.records.map((record) => {
    const key = idempotencyKey(ctx.orgId, record);
    const prop = matchProperty(record, ctx.properties);
    let status: RowStatus = 'READY';
    if (ctx.existingKeys.has(key)) status = 'DUPLICATE_EXISTING';
    else if (seen.has(key)) status = 'DUPLICATE_IN_FILE';
    else if (!prop) status = 'UNMATCHED_PROPERTY';
    else if (ctx.isPeriodLocked(record.earningsDate)) status = 'PERIOD_LOCKED';
    seen.add(key);
    return { record, status, propertyId: prop?.id ?? null, idempotencyKey: key };
  });
  const summary = { READY: 0, DUPLICATE_EXISTING: 0, DUPLICATE_IN_FILE: 0, UNMATCHED_PROPERTY: 0, PERIOD_LOCKED: 0,
    errors: parsed.issues.filter((i) => i.severity === 'ERROR').length + parsed.headerErrors.length, total: rows.length };
  for (const r of rows) summary[r.status]++;
  return { filename, headerErrors: parsed.headerErrors, rows, issues: parsed.issues, summary };
}

export interface StoredEarnings extends EarningsRecord { propertyId: string; importBatchId: string; idempotencyKey: string }
export interface ImportStore {
  /** Must be atomic (single DB transaction) and enforce UNIQUE(idempotency_key). */
  commitBatch(batch: { id: string; filename: string; importedBy: string; recordCount: number; failedCount: number }, rows: StoredEarnings[]): Promise<void>;
}
export interface ImportResult { batchId: string; imported: number; skipped: number }

/**
 * Step 2: persist READY rows only, after explicit manager confirmation.
 * Never overwrites; duplicates/unmatched/locked rows are skipped and reported.
 */
export async function commitImport(
  preview: ImportPreview, opts: { confirmed: boolean; batchId: string; userId: string }, store: ImportStore,
): Promise<ImportResult> {
  if (!opts.confirmed) throw new Error('Import requires explicit manager confirmation');
  if (preview.headerErrors.length) throw new Error(`Cannot import: ${preview.headerErrors.join('; ')}`);
  const ready = preview.rows.filter((r) => r.status === 'READY');
  const rows: StoredEarnings[] = ready.map((r) => ({
    ...r.record, propertyId: r.propertyId!, importBatchId: opts.batchId, idempotencyKey: r.idempotencyKey,
  }));
  const skipped = preview.rows.length - ready.length;
  await store.commitBatch(
    { id: opts.batchId, filename: preview.filename, importedBy: opts.userId, recordCount: preview.rows.length, failedCount: skipped }, rows);
  return { batchId: opts.batchId, imported: rows.length, skipped };
}
