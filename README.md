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

**Starting with Gmail?** Follow [docs/gmail-setup.md](docs/gmail-setup.md), then check it with `npm run email:test -- you@example.com`.

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

## Web UI (added)

React + TypeScript single-page app in `web/`, built with Vite and **served by the API server itself** (same origin, so the session cookie and CSRF
token need no cross-site configuration). No UI component library; the design system is `web/src/styles.css` (light/dark, print styles).

```
npm run build:web        # builds web/dist (the server serves it automatically when present)
npm start                # API + UI on PORT (default 3000)
npm run dev:web          # Vite dev server with hot reload; proxies /api to a locally running server on :3000
```

| Screen | Route | Notes |
|---|---|---|
| Login | `/login` | Returns you to the page you originally asked for |
| Dashboard | `/` | Month and YTD figures, "needs attention" counters that link to the fix |
| Owners / Owner detail | `/owners`, `/owners/:id` | Contacts, email/WhatsApp opt-in, properties, YTD proceeds, statement history |
| Properties / Property detail | `/properties`, `/properties/:id` | Tabs: overview, revenue, expenses, commission, statements |
| Commission settings | `/commission` | Dated rules; changes apply forward only |
| Revenue | `/revenue` | Booking revenue and net payout shown separately |
| Airbnb import | `/import` | Upload → review → confirm → results; unmatched listings explained; import history |
| Expenses / Detail | `/expenses`, `/expenses/:id` | Dollars in, integer cents out; edit/delete while open, reversal once closed; history |
| Monthly close | `/close?ym=2026-09` | Checklist, exceptions, per-property totals, finalize (acknowledge critical issues), send |
| Statement preview / history | `/statements/:id`, `/statements` | Full statement, Print/Save as PDF, CSV, send/resend, delivery status |
| Annual reports | `/annual` | Monthly table, category totals, explanation, CSV, print |
| Communications | `/communications` | Every email/WhatsApp message with status; resend failures |
| Integrations | `/integrations` | Revenue sources, email provider and warnings, queue health |
| Settings / Audit log | `/settings`, `/audit` | Password, users and roles; searchable audit trail with integrity check |
| Owner statement page | `/view/:token` | Public signed link from the email. No login, no manager navigation |

Principles: **the browser never calculates money.** Every figure (statement lines, commission, totals, YTD, annual) is computed by the server and
only formatted client-side; typed dollar amounts are converted to integer cents at the form boundary and validated again by the server.
Buttons a role cannot use are hidden (permissions come from `/api/auth/me`), but the server enforces them regardless.

"Download PDF" fetches the server-rendered PDF; **Print** still uses the browser's print dialog with a dedicated print stylesheet.

### PDFs and receipts (added)

**Server-side PDFs** (`src/pdf/render.ts`, `pdfkit`, no browser needed). Statement and annual-report PDFs are laid out from the same server-calculated
snapshot as the on-screen statement: letter size, repeating table headers, page X of Y, a diagonal DRAFT watermark on unfinalized statements, and
keep-together rules so the owner summary never splits across pages. Output is **deterministic**: the same statement renders to the same bytes.
Standard PDF fonts are used, which cover Latin-1 (accents are fine); characters outside it (e.g. CJK) print as `?` rather than as garbage.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /api/statements/:id/pdf` | any signed-in role | Archived file if present and its SHA-256 verifies; otherwise rendered on demand |
| `GET /api/annual.pdf?year&ownerId` | any signed-in role | Finalized statements only |
| `GET /s/:token/pdf` | owner, via signed link | Finalized statements only; expired/tampered links 404 |

**Archive.** Finalizing a month enqueues one `generate_statement_files` job per statement. The worker renders the PDF and CSV, stores both, records size and
SHA-256, links them to the statement, and writes an audit entry. A database trigger lets those two links be set **once** and never changed.
If a stored file is ever corrupted or missing, the download falls back to a fresh render of the immutable snapshot instead of serving bad bytes.

**Receipts.** `PUT /api/expenses/:id/receipt?filename=` with the raw file as the body (PDF, PNG, JPEG or WebP, up to 10 MB, up to 10 per expense).
- The type is decided from the file's **bytes**, never its name or declared type, so HTML/SVG/executables are refused whatever they claim to be.
- Storage keys are server-generated (`<org>/receipts/<uuid>.<ext>`); the user's filename is display-only and sanitized.
- Downloads are always `attachment` with `nosniff`; each file's SHA-256 is checked on read.
- Receipts can be **added** to an expense in a closed month (documentation changes no figure) but can only be **removed** while the month is open.
- Expenses of $75.00 or more without a receipt raise a `MISSING_RECEIPT` warning in the monthly close and show a Missing badge in the expense list.
- Uploads authenticate before the body is read, are rate-limited, and need the CSRF token like every other write.

**Storage** is pluggable: `FILE_STORE=local` (a directory on a persistent, backed-up volume) or `FILE_STORE=s3` for any S3-compatible service
(AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO). See `.env.example`. The S3 client is exercised in tests against a local
S3-compatible server; it has not been run against a live cloud bucket, so test one upload and one download before relying on it.

### Tests
`npm run test:e2e` drives a real Chromium through the whole manager journey (login, owner, property, import, expenses, close, preview, send,
receipt upload and removal, PDF downloads whose text is checked, owner link, annual report, viewer permissions, phone layout) against a real Postgres, saves screenshots, renders the statement to PDF,
and fails on any JavaScript error or CSP violation. It uses the Chromium at `/opt/pw-browsers/chromium` (override with `CHROME_PATH`).

## Production deployment (added)

**Start here: [docs/DEPLOY.md](docs/DEPLOY.md)**, a runbook for a single-server Docker Compose deployment with automatic HTTPS, backups, restore, updates,
monitoring and a security checklist. In the repository:

| File | Purpose |
|---|---|
| `Dockerfile` | One image for API+UI, worker and CLIs. Production dependencies only, non-root, health check. |
| `docker-compose.yml` + `deploy/Caddyfile` | Postgres, one-shot migration, app, worker, Caddy (TLS). Read-only containers, all capabilities dropped, only 80/443 published. |
| `.env.production.example` | Everything you must set, with how to generate each secret. |
| `npm run preflight` | Checks config, secrets, database, migrations, extensions, administrator, audit chain, file storage, email login, worker liveness, clock skew. Exit code 1 on any failure. |
| `npm run verify-data` | Re-derives finalized statements from source records, checks the audit hash chain and archived-file hashes. Run after restores and weekly. |
| `scripts/backup.sh`, `scripts/restore.sh` | Checksummed, optionally AES-256-encrypted backups; all-or-nothing restore. |
| `.github/workflows/ci.yml` | Typecheck, unit + database tests on real Postgres, browser tests, dependency audit, Docker build. |

Safety behaviors: the server refuses to start if database migrations are pending; the Integrations screen and preflight say plainly when no worker is running
(the classic "emails queued but nothing sending" failure); `/healthz` returns 503 if the database is unreachable. A full disaster recovery (destroy everything, restore
from an encrypted backup) was rehearsed with these exact files; see the "What was verified" section of the runbook for what was and was not tested.

## WhatsApp (added)

Owners with WhatsApp enabled **and** opted in also receive a short template message with the secure statement link when you send a statement.
Providers: **Meta WhatsApp Cloud API** and **Twilio** (`src/whatsapp/`). Setup, template text to create, webhooks and troubleshooting: **[docs/whatsapp-setup.md](docs/whatsapp-setup.md)**.
Check a setup with `npm run whatsapp:test -- --verify-only` (and `-- +15551234567` to send one).

* Consent is enforced: nothing is sent without the owner's opt-in. An owner replying **STOP** is opted out immediately (recorded, audited); only a manager can re-enable it.
* No dollar amounts in the message by default; `WHATSAPP_INCLUDE_SUMMARY=true` switches to the second template that includes the owner proceeds.
* Signed webhooks (`/webhooks/whatsapp/meta|twilio`) update delivery status (Sent → Delivered/Failed) and process STOP; they fail closed without the provider's signing secret.
* Errors are classified by provider code (rate limits retried; bad token, unapproved template, number not on WhatsApp fail at once with a plain-language reason).
* Verified with mocked HTTP, locally generated signatures and a browser test; **not yet exercised against live Meta/Twilio accounts** (see the guide).

## Two-factor login (added)

TOTP authenticator codes + 10 one-time recovery codes, optional per user or required for the whole organization; admin reset; audited. Needs `MFA_ENCRYPTION_KEY`.
Details, operations and the security properties: **[docs/two-factor.md](docs/two-factor.md)**.

## Month-end reminders (added)

Scheduled emails to the team with a live checklist (import, expenses/receipts, finalize, send), in the organization's time zone, with an optional due date;
skipped when the month is done; exactly-once per reminder; test send; per-person opt-out; history. They report only: nothing is finalized or sent automatically.
The same checklist is shown on Monthly close. Details: **[docs/month-end-reminders.md](docs/month-end-reminders.md)**.

## Recurring expenses (added)

Templates (monthly to yearly, any day, start/end month) that post ordinary expenses into their month: on their day by the worker, and for the whole month
whenever it is reviewed or finalized; exactly once per month; never into a finalized month (recorded as skipped); skip / undo skip; stop; edits apply forward.
Details: **[docs/recurring-expenses.md](docs/recurring-expenses.md)**.

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
A WhatsApp provider adapter (the delivery path and opt-in rules exist), annual report generator,
recurring/scheduled jobs, MFA, owner portal (Phase 2).
