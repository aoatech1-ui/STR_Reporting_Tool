# Production deployment

A single-server deployment with Docker Compose: automatic HTTPS, Postgres, a background worker, backups, and a restore procedure that has been
rehearsed. Everything below the "What was verified" heading is explicit about what was tested and what only you can test.

```
Internet ──443──▶ Caddy (TLS, Let's Encrypt) ──▶ app  (API + web UI)  ─┐
                                                 worker (emails, PDFs) ─┼──▶ db (Postgres 16)   volume: pgdata
                                                                        └──▶ files volume (receipts, archived PDFs)
Only Caddy publishes ports (80, 443). The app, worker and database are reachable only inside the Docker network.
```

## 1. What you need

| Item | Notes |
|---|---|
| A server | Linux with Docker Engine + Compose v2. **2 GB RAM / 1 vCPU / 20 GB disk** is a comfortable start. Password hashing is deliberately memory-hard (≈128 MB per sign-in), so avoid 512 MB machines. |
| A domain | e.g. `statements.yourcompany.com`, with an `A` (and `AAAA`) record pointing at the server **before** first start, or Caddy cannot get a certificate. |
| Ports | 80 and 443 open to the internet (80 is needed for certificate issuance and redirects to HTTPS). |
| An email provider | See `.env.example`. A transactional provider (Brevo, Resend, Mailjet, MailerSend, Postmark) is recommended; Gmail works to start (`docs/gmail-setup.md`). |
| A place for backups | Somewhere that is **not** this server (another machine, object storage, a backup service). |

## 2. First deployment

```bash
# on the server
git clone <your repository> str && cd str
cp .env.production.example .env && chmod 600 .env
```

Edit `.env`:

```bash
DOMAIN=statements.yourcompany.com
POSTGRES_PASSWORD=$(openssl rand -hex 24)      # paste the output, not the command
LINK_SECRET=$(openssl rand -base64 48)         # same: paste the output
EMAIL_PROVIDER=...  EMAIL_FROM=...  <provider credentials>   # see .env.example
BACKUP_PASSPHRASE=<long random passphrase>     # encrypts backups; ALSO store it somewhere off this server
```

Start it:

```bash
docker compose up -d --build        # builds the image, migrates the database, starts everything
docker compose ps                   # all services should become "healthy" within about a minute

# create the first administrator (there is no public sign-up)
docker compose run --rm -e ADMIN_PASSWORD='<12+ character passphrase>' tools \
  node src/cli/create-admin.ts --org "Your Company LLC" --email you@yourcompany.com --name "Your Name"

# check the deployment is actually ready
docker compose run --rm tools          # runs the preflight check; fix every FAIL, read every WARN
```

Open `https://<DOMAIN>`, sign in, then work through **Settings → change password**, **Owners**, **Properties** (with each property's Airbnb
listing name), and **Integrations** (email and worker should both show green).

### Email delivery status (recommended)

For HTTP providers, point the provider's webhook at `https://<DOMAIN>/webhooks/email/<provider>` and set `EMAIL_WEBHOOK_TOKEN`
(Brevo, Mailjet, Postmark, SendGrid: append `?token=<value>` to the URL) or `EMAIL_WEBHOOK_SECRET` (Resend, MailerSend, Mailgun: the signing secret).
Without it, deliveries stay at "Sent" and bounces are not recorded. Gmail/SMTP has no webhooks at all.

### WhatsApp (optional)

Follow `docs/whatsapp-setup.md`. The webhook to register is `https://<DOMAIN>/webhooks/whatsapp/meta` (or `/twilio`). It needs the provider's signing secret in `.env`,
or delivery receipts and owners' STOP replies are rejected. `docker compose run --rm tools` checks the credentials.

### Two-factor login (recommended)

Set `MFA_ENCRYPTION_KEY` (`openssl rand -base64 48`) and **back it up with the other secrets**: it encrypts authenticator secrets, and enrolled users cannot sign in without it.
Then turn it on for yourself under Security and consider requiring it for everyone. See `docs/two-factor.md`.

Send one real statement to yourself before inviting owners: `docker compose run --rm tools node src/cli/email-test.ts you@example.com`.

## 3. Backups

What is backed up: the **database** (everything financial, including the audit log) and the **files volume** (receipts and archived statement
PDFs/CSVs). If you use `FILE_STORE=s3`, files live in your bucket instead: turn on bucket versioning and replication there.

```bash
docker compose run --rm backup          # writes encrypted, checksummed files into ./backups
```

Run it from cron and copy `./backups` off the server. Example `crontab -e` (daily 02:15, then sync elsewhere):

```
15 2 * * * cd /opt/str && docker compose run --rm backup >> /var/log/str-backup.log 2>&1 && rclone copy ./backups remote:str-backups
```

* Files are written as `.partial` and renamed only when complete; the dump's table of contents is read back to catch truncation.
* `BACKUP_PASSPHRASE` set ⇒ AES-256 encryption (gpg). **Lose the passphrase and the backups are unreadable.**
* `BACKUP_KEEP_DAYS` (default 14) prunes old local copies. Keep longer-lived copies off-server (monthly, yearly) for year-end reporting.
* Data-loss window (RPO) is up to one backup interval. For tighter RPO use a managed Postgres with point-in-time recovery (§7).

### Restore (disaster recovery)

```bash
docker compose down                      # or: docker compose stop app worker   (to restore over the live database)
docker compose up -d db                  # empty database only (after a total loss, volumes are recreated)
docker compose run --rm restore \
  --db /backups/db-<timestamp>.dump.gpg --files /backups/files-<timestamp>.tgz.gpg --yes
docker compose up -d
docker compose run --rm tools node src/cli/verify-data.ts --deep     # proves the data came back intact
```

The restore verifies each file against its checksum manifest, runs the database restore in **one transaction** (all or nothing), and
re-applies ownership so the app can write. `restore` replaces the target database; the `--yes` flag is required.

### Practise it

A backup you have never restored is a hope, not a backup. Quarterly, restore into a scratch database and verify it:

```bash
docker compose exec -T db psql -U str -d postgres -c "CREATE DATABASE str_restore"
docker compose run --rm -e PGDATABASE=str_restore restore --db /backups/db-<timestamp>.dump.gpg --yes
docker compose run --rm -e DATABASE_URL=postgres://str:$POSTGRES_PASSWORD@db:5432/str_restore tools node src/cli/verify-data.ts
```

`verify-data` re-derives every finalized statement from its source records, re-checks the audit log's hash chain, and re-hashes archived files.
Run it on the live system weekly too (`docker compose run --rm tools node src/cli/verify-data.ts --deep`).

## 4. Updating

```bash
docker compose run --rm backup                 # always back up first: migrations only move forward
git pull
docker compose up -d --build                   # rebuilds, runs new migrations, restarts app and worker
docker compose run --rm tools                  # preflight again
```

The app **refuses to start** if migrations are pending, so a half-updated deployment fails loudly instead of misbehaving. There is no automatic
down-migration: to roll back, restore the pre-update backup together with the previous image
(`APP_IMAGE=<previous tag> docker compose up -d`). To avoid building on the server, build and push an image in CI and set `APP_IMAGE`.

## 5. Monitoring

| What | How |
|---|---|
| Site up | An external uptime monitor on `https://<DOMAIN>/healthz` (returns `{"ok":true}`; 503 if the database is unreachable). |
| Worker alive | **Integrations** screen shows the worker; the worker container has its own health check. If it is down, statements are not emailed and PDFs are not archived. |
| Failed deliveries | **Dashboard → Failed deliveries** and **Communications**. |
| Readiness | `docker compose run --rm tools` any time; schedule it and alert on a non-zero exit. |
| Data integrity | `verify-data` weekly (see above); alert on non-zero exit. |
| Logs | `docker compose logs -f app worker` (structured JSON; cookies and CSRF tokens are redacted; health checks are not logged). Rotated at 5 × 20 MB. |
| Disk | Watch free space for the Docker volumes (`docker system df -v`) and `./backups`. |

## 6. Security checklist

- [ ] Firewall allows only 22 (ideally key-only SSH), 80 and 443. Postgres and the app are not published; keep it that way.
- [ ] `.env` is `chmod 600`, never committed, and not copied into tickets or chat.
- [ ] Every user has their own account and the least role needed (Settings → Users). Keep **two** administrators so a lost password is not an outage.
- [ ] `LINK_SECRET` is random and ≥ 32 characters. Rotating it invalidates statement links already emailed.
- [ ] Email credentials are an app password / API key scoped to sending; revoke them at the provider if leaked.
- [ ] Backups are encrypted, copied off-server, and a restore has been rehearsed.
- [ ] OS security updates are applied (e.g. `unattended-upgrades`) and Docker images are rebuilt periodically to pick up base-image fixes.
- [ ] `TRUST_PROXY=true` is only correct because Caddy is the sole entry point. If you expose the app port directly, set it to `false`.
- [ ] Review **Audit log → Verify log integrity** occasionally. A failed check means someone with database access altered history.

The application itself enforces: HTTPS-only cookies (`HttpOnly`, `Secure`, `SameSite=Strict`), CSRF tokens + Origin checks, login lockout and rate limits,
role-based access, immutable finalized periods and statements (enforced in the database), an append-only hash-chained audit log, signed expiring
owner links, strict CSP, and containers that are read-only, unprivileged, with all Linux capabilities dropped.

## 7. Scaling and alternatives

* **One app replica.** Request rate limits are held in memory per process; a second replica would double them. This is ample for a property
  management business; the worker can be run in several copies safely (jobs are claimed with `SKIP LOCKED`).
* **Managed Postgres** (RDS, Cloud SQL, Neon, Supabase, DigitalOcean, Crunchy…): set `DATABASE_URL` and `DB_SSL=true` (add `DB_SSL_CA_FILE` for a private CA;
  `DB_SSL=no-verify` encrypts without verifying and should be a last resort). The role must be able to `CREATE EXTENSION pgcrypto, btree_gist`
  (both are "trusted" extensions on Postgres 13+, so the database owner can). Managed point-in-time recovery then gives a far smaller data-loss window; keep `backup.sh` as an independent copy.
* **S3-compatible files** (`FILE_STORE=s3`): AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO. Remove the `files` volume mounts if you go this way.
* **Platforms (Render, Fly.io, Railway, Cloud Run…):** the image runs unchanged. Create three services from it: web (`node src/server/main.ts`, health check `/healthz`),
  worker (`node src/worker/main.ts`), and a release/pre-deploy command (`node src/db/migrate.ts`). Use their managed Postgres and an S3-compatible bucket
  for files (their local disks are ephemeral). Set `BASE_URL`, `TRUST_PROXY=true`, and the secrets above. These platform setups are **not tested** here.

## 8. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Browser shows a certificate error / Caddy loops | DNS does not point at this server yet, or ports 80/443 are blocked. `docker compose logs caddy`. |
| App container exits: "Refusing to start: N migration(s) not applied" | Run `docker compose run --rm migrate` (or `docker compose up -d`, which runs it first). |
| "No background worker is running" on Integrations | `docker compose up -d worker`; `docker compose logs worker`. |
| Statements stay "Queued" | Worker down, or the provider is rejecting: check Communications for the error text and run `email-test`. |
| A user is locked out | Five failed sign-ins lock an account for 15 minutes. Admin: reset their password in Settings. To clear it immediately: `docker compose exec db psql -U str -d str -c "UPDATE users SET locked_until=NULL, failed_logins=0 WHERE email='them@example.com'"`. |
| Uploads fail with 413 | File over 10 MB (receipts) or 12 MB (CSV imports); Caddy enforces 12 MB. |
| PDF shows `?` instead of a character | The PDF fonts cover Latin-1 only (accented Western European names are fine). |
| `verify-data` reports `FILE_MISSING` / `FILE_CORRUPT` | A stored file was lost or altered. Statement PDFs are rebuilt on demand from the immutable snapshot; restore receipts from backup. |
| `verify-data` reports `REVENUE_CHANGED` / `EXPENSES_CHANGED` / `AUDIT_CHAIN_BROKEN` | Finalized records no longer match their statement: someone altered data outside the app. Treat as an incident; restore from a backup taken before the change and investigate. |

## What was verified, and what only you can verify

Verified in a sandbox with a real Docker daemon, using the exact files in this repository:

* The image builds from a clean checkout, contains no dev tooling (no vite/typescript/playwright), and runs as a non-root user.
* `docker compose up` brings up Postgres → migration → app + worker + Caddy; all health checks go healthy; the app and worker run with a read-only root
  filesystem and no Linux capabilities and still import, upload receipts, close a month, archive PDFs and serve signed owner links.
* Over HTTPS through Caddy: HSTS, CSP, `Secure`/`HttpOnly`/`SameSite=Strict` cookies, HTTP→HTTPS redirect, and the app port is not reachable from outside.
* Graceful shutdown (both containers exit 0 on `stop`), data surviving a Docker daemon restart.
* **Disaster recovery:** an encrypted backup was taken, then the stack and **all volumes were destroyed**; from the backup alone the system was restored
  and the original administrator password, finalized statement, archived PDF and receipt all worked, new files could be written, and the audit chain was intact.
  Wrong passphrase and tampered backup files were both refused. A scratch-database restore matched every table's row count, kept the immutability triggers, and passed `verify-data --deep`.
* Preflight and `verify-data` detect each failure mode they claim to (automated tests).
* `npm audit` reports no known vulnerabilities in production dependencies at the time of writing.

Not verifiable from here, so check these yourself on the real server:

* **A real Let's Encrypt certificate** (the sandbox used Caddy's internal CA with `DOMAIN=localhost`).
* **Your email provider**: send a real statement; confirm delivery and, if you configured them, the webhook status updates.
* **Your S3-compatible bucket** if you use one: upload a receipt and download it.
* **Your DNS, firewall and off-server backup copy.**
* The GitHub Actions workflow in `.github/workflows/ci.yml` has been syntax-checked but not run.
