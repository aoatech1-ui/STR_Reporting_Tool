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
| Database | `db/migrations/*.sql` | PostgreSQL; idempotency unique key, closed-period triggers, frozen statements, append-only audit |
| Data layer | `src/db/`, `src/repo/` | `pg` pool, `withTx`, migration runner; org-scoped repositories for owners, properties, commission rules, periods, expenses, earnings, statements, deliveries, dashboard |
| Services | `src/services/` | `previewCsvImport` / `confirmCsvImport`, `generateStatements` / `finalizePeriod`, `sendStatement` — each is one atomic transaction |
| Persistent audit | `src/repo/audit.ts` | Per-org hash chain written under an advisory lock; `verifyAuditChain` detects tampering |

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
npm test               # unit tests (no database needed; Node ≥ 22.18)
npm run test:db        # integration tests against real Postgres (boots a throwaway cluster, or set TEST_DATABASE_URL)
npm run typecheck
DATABASE_URL=postgres://… npm run migrate   # applies db/migrations in order; idempotent (needs btree_gist, pgcrypto)
```

### Data-layer rules
- Every write takes a `Tx` from `withTx`; reads accept a `Pool`. Every query is scoped by `organization_id`.
- Money is `bigint` cents in Postgres, parsed to JS numbers (error if outside the safe-integer range). `date` columns stay `'YYYY-MM-DD'` strings.
- `confirmCsvImport` re-validates the file against live DB state inside its transaction and serialises per org; it never trusts a previous preview.
- `finalizePeriod` regenerates statements in the same transaction it locks them in, so the locked numbers are the current numbers.
- Corrections to closed months: `reverseExpense` posts a negating entry into an open month. Direct edits are blocked in the app **and** by DB triggers.
- `sendStatement` calls the email/WhatsApp provider outside a DB transaction and records outcomes (including failures) afterwards. A crash
  between send and record could leave a sent email unrecorded; a `QUEUED`-first outbox with the job queue closes that gap.

Unit tests cover import, duplicate detection, expenses, commission, statements, period locking, CSV, delivery, audit, signed links, and the
acceptance scenario ($6,000 − $500 − $100 − $200 − 20% = **$4,000**).

## Not built yet (next)
Web app + auth/RBAC/CSRF/rate limiting, job queue/outbox, PDF rendering, S3 receipt storage, real
email/WhatsApp provider adapters + delivery webhooks, annual report generator, owner portal (Phase 2).
