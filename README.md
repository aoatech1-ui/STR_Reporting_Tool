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

## Web API, queue and email (added)

| Area | Where | Notes |
|---|---|---|
| HTTP API | `src/server/` | Fastify 5 + zod. `npm start`. JSON under `/api/*`; money is integer **cents** |
| Auth | `src/auth/`, `src/repo/auth.ts` | scrypt (N=2^17) password hashes, server-side sessions (only a SHA-256 of the cookie token is stored), lockout after 5 failures / 15 min |
| Authorization | `src/auth/permissions.ts` | Routes declare a **permission**, never a role. ADMIN / MANAGER / ACCOUNTANT / VIEWER matrix, evaluated per request so demotion/deactivation is immediate |
| Queue | `src/worker/queue.ts` | Postgres `FOR UPDATE SKIP LOCKED`; exponential backoff; lease reclaim after a worker crash; dedupe keys; uses the DB clock. `npm run worker` |
| Outbox | `src/services/send.ts` | "Send" writes `QUEUED` delivery rows + jobs in **one transaction**; nothing is sent inside the request |
| Email | `src/email/` | 7 HTTP providers + SMTP presets; webhook verification and status mapping |

### Security model
- Cookie `sid`: `HttpOnly`, `SameSite=Strict`, `Secure` when `BASE_URL` is https; 12 h absolute / 2 h idle lifetime; logout and password change revoke server-side.
- Every mutating request needs the per-session `x-csrf-token` header (returned by login and `/api/auth/me`) **and** an allowed `Origin` if one is sent.
- Login: per-IP rate limit, per-account lockout, identical error for unknown user / wrong password / inactive user, dummy hash for unknown emails to equalise timing.
- Errors: only `UserError` messages reach the client; everything else is a generic 500. Postgres integrity errors map to 409/422.
- Public statement links (`/s/:token`): HMAC-signed, 7-day expiry, view-only, rate limited, every view audited. A bare statement id is not a credential.
- Webhooks fail closed: no configured secret means rejected. Signatures use constant-time comparison and a 5-minute replay window.
- No public sign-up. First admin: `npm run create-admin -- --org "Manager LLC" --email you@x.com --name "You"` (password via `ADMIN_PASSWORD` or stdin).

### Endpoints (all under `/api`, JSON, session cookie + CSRF header)
`POST auth/login|logout|change-password`, `GET auth/me`; `GET|POST users`, `PATCH users/:id`, `POST users/:id/password`; `GET|POST|PATCH owners`;
`GET|POST properties`, `POST properties/:id/commission-rules`; `GET expense-categories`; `GET|POST|PATCH|DELETE expenses`, `POST expenses/:id/reverse`;
`POST imports/preview|confirm`; `GET periods`, `GET periods/:ym`, `POST periods/:ym/generate|finalize`; `GET statements`, `GET statements/:id`, `POST statements/:id/send`;
`GET exports/monthly-statements.csv|commissions.csv|transactions.csv|annual.csv`; `GET dashboard`; `GET audit`, `GET audit/verify`; `GET settings/email`.
Unauthenticated: `GET /healthz`, `GET /s/:token[/csv]`, `POST /webhooks/email/:provider`.

### Email providers
Set `EMAIL_PROVIDER` + credentials (see `.env.example`). Secrets live in the environment/secret store, never the database.

| Provider | `EMAIL_PROVIDER` | Webhook auth | Notes |
|---|---|---|---|
| Brevo | `brevo` | `?token=` | Free daily allowance |
| Resend | `resend` | Svix signature (`EMAIL_WEBHOOK_SECRET=whsec_...`) | Honors `Idempotency-Key`, so retries are safest |
| Mailjet | `mailjet` | `?token=` | Free monthly allowance |
| MailerSend | `mailersend` | HMAC `Signature` header | Free monthly allowance |
| Postmark | `postmark` | `?token=` | Strong transactional deliverability (paid) |
| SendGrid | `sendgrid` | `?token=` | |
| Mailgun | `mailgun` | HMAC signing key | `MAILGUN_REGION=eu` supported |
| Gmail / Outlook / Office 365 / Yahoo / AOL / Zoho / iCloud / Fastmail | `gmail`, `outlook`, ... | none (no status callbacks) | SMTP + **app password**. Fine for a handful of owners; see caveats |
| Amazon SES / any SMTP | `ses` / `custom` | none | set `SMTP_HOST` |

**Recommendation:** use a transactional provider (the Brevo, Resend, Mailjet or MailerSend free tiers are plenty for monthly statements) with a verified
sending domain (SPF + DKIM). Mailbox SMTP (Gmail, Outlook.com, Yahoo, AOL) works but has low daily caps, "From must be the mailbox" constraints,
Microsoft is retiring password SMTP for Outlook/365, and there are no delivery/bounce callbacks, so `DELIVERED`/`BOUNCED` never update.
The server logs a warning when one of these is configured.

**Provider adapters were written from the providers' public API documentation and tested against mocked request/response shapes,
not live accounts** (the full pipeline was also run end to end against a local mock of the Resend API). Before go-live, send one real
statement per configured provider and confirm its webhook.

### Running
```
npm run create-admin -- --org "Manager LLC" --email you@example.com --name "You"   # once
npm start            # API
npm run worker       # sends queued deliveries (run one or more; safe to run several)
```
Delivery is **at-least-once**: the handler skips deliveries already sent and forwards a per-delivery idempotency key. The remaining window
(provider accepted the message but the process died before recording `SENT`) can only duplicate on providers that ignore that key.

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
Web UI, PDF rendering, S3 receipt storage, a WhatsApp provider adapter (the delivery path and opt-in rules exist), annual report generator,
recurring/scheduled jobs, MFA, owner portal (Phase 2).
