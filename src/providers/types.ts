import type { Cents } from '../money.ts';

export type RevenueSourceKind = 'AIRBNB_CSV_IMPORT' | 'AIRBNB_API' | 'PMS_API' | 'OTHER_CHANNEL';
export type EarningsKind = 'RESERVATION' | 'ADJUSTMENT' | 'REFUND' | 'CO_HOST_PAYOUT' | 'TAX_PASS_THROUGH';

/** Normalized earnings record. Booking revenue and payout are deliberately separate fields. */
export interface EarningsRecord {
  source: RevenueSourceKind;
  sourceTransactionId: string;   // stable id; basis of idempotency
  kind: EarningsKind;
  reservationId: string | null;
  listingName: string;
  listingId: string | null;
  earningsDate: string;          // YYYY-MM-DD
  payoutDate: string | null;
  checkIn: string | null;
  checkOut: string | null;
  grossBookingCents: Cents;
  cleaningFeeCents: Cents;
  otherRevenueCents: Cents;
  platformFeeCents: Cents;       // stored positive; subtracted
  taxCents: Cents;
  adjustmentCents: Cents;        // signed
  refundCents: Cents;            // signed (negative reduces)
  coHostPayoutCents: Cents;
  netPayoutCents: Cents;         // authoritative amount to the owner pool; != booking total
  currency: string;
  sourceRow: number;             // 1-based data row, for audit/trace
}

export interface RowIssue { row: number; severity: 'ERROR' | 'WARNING' | 'INFO'; code: string; message: string }
export interface ParseResult { records: EarningsRecord[]; issues: RowIssue[]; headerErrors: string[] }

export interface ListingRef { id: string | null; name: string }
export interface ConnectionStatus { connected: boolean; detail: string }

/** Pluggable revenue source. The app must work fully with only AirbnbCsvProvider. */
export interface RevenueProvider {
  readonly kind: RevenueSourceKind;
  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): Promise<ConnectionStatus>;
  getListings(): Promise<ListingRef[]>;
  getTransactions(range: { from: string; to: string }): Promise<EarningsRecord[]>;
  getPayouts(range: { from: string; to: string }): Promise<EarningsRecord[]>;
  /** Returns normalized records; persistence happens only via the confirmed import pipeline. */
  syncTransactions(range: { from: string; to: string }): Promise<ParseResult>;
}
