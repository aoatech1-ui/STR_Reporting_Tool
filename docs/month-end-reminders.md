# Month-end reminders

Scheduled emails to your **team** (never to owners) with a live checklist for the month: Airbnb import, expenses and receipts, review and finalize,
sending statements. They only report. Nothing is finalized or sent to owners automatically: the close stays a manual approval.

## Set up

Settings → **Month-end reminders** (administrators and managers can edit; anyone with settings access can see it):

* **Days**: before month end (7, 5, 3, 2 days before, or the last day) and/or days of the following month (1st, 2nd, 3rd, 5th, 7th, 10th, 15th). Up to 6.
* **Send at** and **time zone**: wall-clock time in your time zone, so 9:00 AM stays 9:00 AM across daylight-saving changes.
* **Statements due by**: optional. Reminders then say "due Oct 10 (in 5 days)" and, after that day, "overdue".
* **Who receives them**: by role (default Admin + Manager). Each person can opt out under Settings → Your account.
* **Send me a test** emails the current checklist for last month to you only, marked `[Test]`.

Requirements: an email provider (see Integrations) and the **worker** running. `docker compose run --rm tools` (preflight) warns if reminders are on but email is not configured.

## What the reminder contains

| Item | Source (recomputed when the reminder is sent) |
|---|---|
| Airbnb earnings | Transactions imported for the month; unmatched listings |
| Expenses and receipts | Active properties with no expenses; expenses of $75+ without a receipt |
| Review and finalize | Period status and number of statements |
| Send | Finalized statements not yet sent; failed deliveries |

The same checklist is shown live at the top of **Monthly close**.

## Behaviour

* **Once only.** Each reminder (organization + month + day) is created once, even with several workers or after a restart, and each person is emailed at most once per reminder, including retries.
* **Skips finished months.** A reminder after month end is skipped when the month is finalized and every statement was sent ("Nothing to do"). It is also skipped if reminders were turned off in the meantime.
* **No back-filling.** Saving the schedule never triggers reminders whose time has already passed. If no worker was running at the scheduled time, a reminder up to 24 hours late is still sent; an older one is recorded as **Missed** instead of arriving days late.
* **History** on the settings card shows every reminder: Sent (with recipient count), Skipped (why), Failed (provider error), Missed.
* Schedule changes are recorded in the audit log (`REMINDER_SETTINGS_CHANGED`).

Not included: WhatsApp reminders to staff (would need separately approved WhatsApp templates), reminders to owners.
