# STR Owner Accounting & Reporting Platform

Owner accounting, commission calculation, statements and owner communication for a short-term-rental manager.
**Airbnb export → upload → reconcile → expenses → commission → statement → email.**

## Status

This repository currently contains the **domain core**: everything whose correctness matters most and
that the web UI, queue workers and provider integrations will call into. No UI yet.

| Area | Where | Notes |
|---|---|---|
| Money (integer cents) | `src/money.ts` | No floats in any financial path |
| Revenue provider abstraction | `src/providers/types.ts` | `RevenueProvider`: connect/disconnect/getListings/getTransactions/getPayouts/syncTransactions/getConnectionStatus |
| Airbnb CSV provider | `src/providers/airbnbCsv.ts` | Upload only. No scraping, no credentials, no undocumented endpoints |
| Import pipeline | `src/import/engine.ts` | validate → match → dedupe → **preview** → confirmed commit; idempotency keys; never overwrites |
| Commission engine | `src/accounting/commission.ts` | percent-of-gross / percent-of-net / fixed / hybrid; dated rules; stores calculation + explanation |
| Statement engine | `src/accounting/statement.ts` | `net payout − expenses − commission ± adjustments`; every line traceable to a source id; YTD |
| Periods | `src/accounting/period.ts` | DRAFT → REVIEW → FINALIZED → LOCKED; critical exceptions block finalize |
| Exceptions | `src/accounting/exceptions.ts` | negative proceeds, unmatched revenue, missing contact/opt-in… |
| CSV export | `src/export/csv.ts` | deterministic, documented columns, formula-injection safe |
| Delivery | `src/delivery/` | email + WhatsApp (template, opt-in), finalized-only, signed expiring links, resend audited |
| Audit log | `src/audit.ts` | append-only, hash-chained |
| Database | `db/schema.sql` | PostgreSQL; idempotency unique key, closed-period triggers, frozen statements, append-only audit |

## Design decisions

- **Not dependent on Airbnb API.** Airbnb's API is gated by program/scope approval and its terms restrict retaining and analysing
  data. The CSV provider is a complete path; an `AirbnbApiProvider` or PMS provider can later implement the same interface.
- **Booking revenue ≠ payout.** `net_payout_cents` is authoritative and is never derived from the booking total. Component
  fields (gross, cleaning, fees, tax, refunds) are informational and never re-added, so nothing is double-counted.
- **Owner money vs manager revenue.** Commission is stored as its own calculation (rule snapshot, basis, base, rate, amount) and has its
  own CSV (`managerCommissionCsv`); the Airbnb payout is not treated as LLC revenue. Confirm the treatment with the manager's CPA.
- **History is immutable.** Rules are effective-dated and snapshotted into each calculation; finalized periods reject writes at the DB
  level; corrections are adjustments/reversals/superseding statements.
- **Statements are explainable.** `Statement.derivation` reproduces the owner-proceeds number step by step
  (e.g. `20% × $6,000.00 = $1,200.00`); line items sum exactly to proceeds.

### Calculation conventions (confirm per management agreement)
- `PERCENT_GROSS` base = booking revenue + other revenue + refunds (negative) [+ cleaning if `includeCleaningFees`] [+ taxes unless `excludeTaxes`].
- `PERCENT_NET` base = net payout [− cleaning unless `includeCleaningFees`] [− taxes if `excludeTaxes`].
- Percent commission never goes below 0. Rounding is half-away-from-zero at the cent.
- Owner-paid expenses are shown on the statement but not deducted.

## Develop

```
npm install
npm test          # node:test, zero runtime dependencies (Node ≥ 22.18)
npm run typecheck
psql -f db/schema.sql   # requires btree_gist and pgcrypto
```

Tests cover import, duplicate detection, expenses, commission, statements, period locking, CSV, delivery, audit, signed links, and the
acceptance scenario ($6,000 − $500 − $100 − $200 − 20% = **$4,000**).

## Not built yet (next)
Web app + auth/RBAC/CSRF/rate limiting, Postgres repositories and transactional job queue, PDF rendering, S3 receipt storage, real
email/WhatsApp provider adapters + delivery webhooks, annual report generator, owner portal (Phase 2).
