import type { CommissionRule } from '../src/accounting/commission.ts';
import type { EarningsRecord } from '../src/providers/types.ts';

export const rule = (o: Partial<CommissionRule> = {}): CommissionRule => ({
  id: 'rule-1', type: 'PERCENT_NET', rateBps: 2000, fixedCents: 0, includeCleaningFees: true, excludeTaxes: false,
  hybridBasis: 'NET', effectiveFrom: '2026-01-01', effectiveTo: null, ...o,
});

export const earning = (o: Partial<EarningsRecord> = {}): EarningsRecord => ({
  source: 'AIRBNB_CSV_IMPORT', sourceTransactionId: 'RESERVATION|HM1|2026-09-05|600000', kind: 'RESERVATION', reservationId: 'HM1',
  listingName: '123 Main Street', listingId: null, earningsDate: '2026-09-05', payoutDate: null, checkIn: '2026-09-01', checkOut: '2026-09-05',
  grossBookingCents: 700000, cleaningFeeCents: 0, otherRevenueCents: 0, platformFeeCents: 100000, taxCents: 0, adjustmentCents: 0,
  refundCents: 0, coHostPayoutCents: 0, netPayoutCents: 600000, currency: 'USD', sourceRow: 1, ...o,
});

export const AIRBNB_CSV = `Date,Type,Confirmation Code,Start Date,End Date,Listing,Currency,Amount,Paid out,Service fee,Cleaning fee,Gross earnings,Occupancy taxes
09/05/2026,Reservation,HM1,09/01/2026,09/05/2026,123 Main Street,USD,"$4,850.00",,150.00,100.00,5000.00,0.00
09/12/2026,Reservation,HM2,09/08/2026,09/12/2026,123 Main Street,USD,1150.00,,50.00,0.00,1200.00,0.00
09/15/2026,Payout,,,,,USD,6000.00,,,,,
09/20/2026,Adjustment,HM1,,,123 Main Street,USD,-25.00,,,,,
09/21/2026,Reservation,HM9,09/18/2026,09/20/2026,Mystery Cabin,USD,300.00,,10.00,0.00,310.00,0.00
09/22/2026,Reservation,HM10,09/18/2026,09/20/2026,123 Main Street,USD,abc,,10.00,0.00,310.00,0.00
09/12/2026,Reservation,HM2,09/08/2026,09/12/2026,123 Main Street,USD,1150.00,,50.00,0.00,1200.00,0.00
`;
