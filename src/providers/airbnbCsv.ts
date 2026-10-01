import { parseCsv } from '../csv.ts';
import { parseMoney } from '../money.ts';
import type {
  ConnectionStatus, EarningsKind, EarningsRecord, ListingRef, ParseResult, RevenueProvider, RowIssue,
} from './types.ts';

/** Column aliases for Airbnb's transaction-history export (case-insensitive). */
const ALIASES: Record<string, string[]> = {
  date: ['date'],
  type: ['type'],
  confirmationCode: ['confirmation code', 'confirmation_code'],
  referenceCode: ['reference code', 'reference'],
  startDate: ['start date', 'check-in', 'checkin'],
  endDate: ['end date', 'check-out', 'checkout'],
  listing: ['listing', 'listing name'],
  listingId: ['listing id'],
  currency: ['currency'],
  amount: ['amount'],
  paidOut: ['paid out'],
  payoutDate: ['payout date', 'arriving by date'],
  serviceFee: ['service fee', 'host fee'],
  cleaningFee: ['cleaning fee'],
  grossEarnings: ['gross earnings'],
  taxes: ['occupancy taxes', 'taxes'],
};
const REQUIRED = ['date', 'type', 'listing', 'amount'];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Accepts YYYY-MM-DD or MM/DD/YYYY. */
export function normalizeDate(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let y: string, m: string, d: string;
  if (ISO.test(s)) [y, m, d] = s.split('-');
  else {
    const mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!mm) return null;
    [, m, d, y] = mm;
  }
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

const KIND_BY_TYPE: Record<string, EarningsKind | 'PAYOUT'> = {
  reservation: 'RESERVATION',
  'adjustment': 'ADJUSTMENT',
  'resolution adjustment': 'ADJUSTMENT',
  'resolution payout': 'ADJUSTMENT',
  'refund': 'REFUND',
  'co-host payout': 'CO_HOST_PAYOUT',
  'pass through tax': 'TAX_PASS_THROUGH',
  'payout': 'PAYOUT',
};

export function parseAirbnbCsv(text: string): ParseResult {
  const issues: RowIssue[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) return { records: [], issues, headerErrors: ['File is empty'] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  const missing = REQUIRED.filter((k) => col[k] === undefined);
  if (missing.length) {
    return { records: [], issues, headerErrors: missing.map((k) => `Missing required column: ${ALIASES[k][0]}`) };
  }

  const records: EarningsRecord[] = [];
  rows.slice(1).forEach((r, idx) => {
    const row = idx + 1;
    const get = (k: string) => (col[k] === undefined ? '' : (r[col[k]] ?? '').trim());
    const issue = (severity: RowIssue['severity'], code: string, message: string) =>
      issues.push({ row, severity, code, message });

    const typeRaw = get('type');
    const kind = KIND_BY_TYPE[typeRaw.toLowerCase()];
    if (!kind) return issue('ERROR', 'UNKNOWN_TYPE', `Unrecognized transaction type "${typeRaw}"`);
    if (kind === 'PAYOUT') return issue('INFO', 'PAYOUT_ROW_SKIPPED', 'Payout settlement row; earnings rows carry the amounts');

    const earningsDate = normalizeDate(get('date'));
    if (!earningsDate) return issue('ERROR', 'INVALID_DATE', `Invalid date "${get('date')}"`);

    const money = (k: string, required: boolean): number | null => {
      const raw = get(k);
      if (raw === '') return required ? null : 0;
      const v = parseMoney(raw);
      if (v === null) issue('ERROR', 'INVALID_AMOUNT', `Invalid ${ALIASES[k][0]} "${raw}"`);
      return v;
    };
    const net = money('amount', true);
    if (net === null) {
      if (get('amount') === '') issue('ERROR', 'INVALID_AMOUNT', 'Missing amount');
      return;
    }
    const gross = money('grossEarnings', false), cleaning = money('cleaningFee', false);
    const fee = money('serviceFee', false), tax = money('taxes', false);
    if ([gross, cleaning, fee, tax].includes(null)) return;

    const checkIn = normalizeDate(get('startDate')), checkOut = normalizeDate(get('endDate'));
    if (checkIn && checkOut && checkOut < checkIn) issue('WARNING', 'STAY_DATES_REVERSED', 'Check-out is before check-in');

    const res = get('confirmationCode') || null;
    const ref = get('referenceCode');
    if (kind === 'REFUND' || (kind === 'ADJUSTMENT' && net < 0)) issue('WARNING', 'NEGATIVE_ADJUSTMENT', `${typeRaw} reduces payout by ${Math.abs(net) / 100}`);

    records.push({
      source: 'AIRBNB_CSV_IMPORT',
      sourceTransactionId: [kind, res ?? ref ?? '', earningsDate, net].join('|'),
      kind,
      reservationId: res,
      listingName: get('listing'),
      listingId: get('listingId') || null,
      earningsDate,
      payoutDate: normalizeDate(get('payoutDate')),
      checkIn, checkOut,
      grossBookingCents: kind === 'RESERVATION' ? gross! : 0,
      cleaningFeeCents: cleaning!,
      otherRevenueCents: 0,
      platformFeeCents: Math.abs(fee!),
      taxCents: tax!,
      adjustmentCents: kind === 'ADJUSTMENT' ? net : 0,
      refundCents: kind === 'REFUND' ? net : 0,
      coHostPayoutCents: kind === 'CO_HOST_PAYOUT' ? net : 0,
      netPayoutCents: net,
      currency: get('currency') || 'USD',
      sourceRow: row,
    });
  });
  return { records, issues, headerErrors: [] };
}

/** CSV-backed provider: data arrives by upload, never by contacting Airbnb. */
export class AirbnbCsvProvider implements RevenueProvider {
  readonly kind = 'AIRBNB_CSV_IMPORT' as const;
  private loaded: ParseResult = { records: [], issues: [], headerErrors: [] };

  loadCsv(text: string): ParseResult { return (this.loaded = parseAirbnbCsv(text)); }
  async connect(): Promise<void> { /* nothing to connect: manual upload */ }
  async disconnect(): Promise<void> { this.loaded = { records: [], issues: [], headerErrors: [] }; }
  async getConnectionStatus(): Promise<ConnectionStatus> {
    return { connected: true, detail: 'Manual CSV upload (no Airbnb credentials stored)' };
  }
  async getListings(): Promise<ListingRef[]> {
    const seen = new Map<string, ListingRef>();
    for (const r of this.loaded.records) seen.set(r.listingId ?? r.listingName, { id: r.listingId, name: r.listingName });
    return [...seen.values()];
  }
  async getTransactions(range: { from: string; to: string }) {
    return this.loaded.records.filter((r) => r.earningsDate >= range.from && r.earningsDate <= range.to);
  }
  async getPayouts(range: { from: string; to: string }) {
    return (await this.getTransactions(range)).filter((r) => r.payoutDate);
  }
  async syncTransactions(range: { from: string; to: string }): Promise<ParseResult> {
    return { ...this.loaded, records: await this.getTransactions(range) };
  }
}
