import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAirbnbCsv, AirbnbCsvProvider } from '../src/providers/airbnbCsv.ts';
import { commitImport, previewImport, type ImportStore, type StoredEarnings } from '../src/import/engine.ts';
import { AIRBNB_CSV } from './helpers.ts';

const props = [{ id: 'p1', name: '123 Main', airbnbListingName: '123 Main Street' }];
const ctx = (o = {}) => ({ orgId: 'o1', properties: props, existingKeys: new Set<string>(), isPeriodLocked: () => false, ...o });

test('rejects files missing required columns', () => {
  const r = parseAirbnbCsv('Foo,Bar\n1,2\n');
  assert.ok(r.headerErrors.length >= 1);
  assert.equal(r.records.length, 0);
});

test('parses reservations, adjustments; skips payout rows; flags invalid amounts', () => {
  const r = parseAirbnbCsv(AIRBNB_CSV);
  assert.equal(r.records.length, 5); // 3 reservations (incl. dup) + adjustment + Mystery Cabin
  assert.ok(r.issues.some((i) => i.code === 'PAYOUT_ROW_SKIPPED'));
  assert.ok(r.issues.some((i) => i.code === 'INVALID_AMOUNT' && i.row === 6));
  assert.ok(r.issues.some((i) => i.code === 'NEGATIVE_ADJUSTMENT'));
  const hm1 = r.records[0];
  assert.equal(hm1.netPayoutCents, 485000);
  assert.equal(hm1.grossBookingCents, 500000); // booking revenue != payout
  assert.equal(hm1.platformFeeCents, 15000);
  const adj = r.records.find((x) => x.kind === 'ADJUSTMENT')!;
  assert.equal(adj.adjustmentCents, -2500);
});

test('preview detects duplicates, unmatched properties and existing records', () => {
  const parsed = parseAirbnbCsv(AIRBNB_CSV);
  const first = previewImport('a.csv', parsed, ctx());
  assert.equal(first.summary.READY, 3);
  assert.equal(first.summary.DUPLICATE_IN_FILE, 1);
  assert.equal(first.summary.UNMATCHED_PROPERTY, 1);
  const existing = new Set([first.rows[0].idempotencyKey]);
  const second = previewImport('a.csv', parsed, ctx({ existingKeys: existing }));
  assert.equal(second.rows[0].status, 'DUPLICATE_EXISTING');
});

test('locked periods block import of rows', () => {
  const p = previewImport('a.csv', parseAirbnbCsv(AIRBNB_CSV), ctx({ isPeriodLocked: () => true }));
  assert.equal(p.summary.READY, 0);
  assert.ok(p.summary.PERIOD_LOCKED > 0);
});

test('commit needs confirmation, writes only READY rows with batch id, and is not repeatable', async () => {
  const preview = previewImport('a.csv', parseAirbnbCsv(AIRBNB_CSV), ctx());
  const stored: StoredEarnings[] = [];
  const store: ImportStore = { async commitBatch(_b, rows) { stored.push(...rows); } };
  await assert.rejects(() => commitImport(preview, { confirmed: false, batchId: 'b1', userId: 'u' }, store), /confirmation/);
  assert.equal(stored.length, 0);
  const res = await commitImport(preview, { confirmed: true, batchId: 'b1', userId: 'u' }, store);
  assert.deepEqual([res.imported, res.skipped], [3, 2]);
  assert.ok(stored.every((r) => r.importBatchId === 'b1' && r.propertyId === 'p1' && r.source === 'AIRBNB_CSV_IMPORT'));
  // re-import of same file: everything is a duplicate now
  const again = previewImport('a.csv', parseAirbnbCsv(AIRBNB_CSV), ctx({ existingKeys: new Set(stored.map((s) => s.idempotencyKey)) }));
  assert.equal(again.summary.READY, 0);
});

test('CSV provider works without any Airbnb connection', async () => {
  const p = new AirbnbCsvProvider();
  p.loadCsv(AIRBNB_CSV);
  assert.equal((await p.getConnectionStatus()).connected, true);
  const sync = await p.syncTransactions({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(sync.records.length, 5);
  assert.equal((await p.getListings()).length, 2);
});
