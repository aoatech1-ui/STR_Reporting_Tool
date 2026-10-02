# Sending statements through Gmail

Gmail works for getting started (a handful of owners, one statement each per month). It is an ordinary mailbox, not a transactional
service, so read the limits at the bottom before relying on it.

## 1. Prepare the Google account
1. Use a dedicated mailbox (e.g. `statements@yourdomain.com` on Google Workspace, or a new `@gmail.com`), not your personal inbox.
2. Turn on **2-Step Verification**: Google Account → Security → 2-Step Verification.
3. Create an **App Password**: Google Account → Security → 2-Step Verification → *App passwords* (or search "App passwords").
   Name it "STR Reporting Tool". Google shows 16 characters in groups of four. **Remove the spaces** when you paste it.
   If the "App passwords" option is missing, 2-Step Verification is off, or the Workspace admin has disabled it.
4. Never use your normal Google password here.

## 2. Configure
Set these in the environment of **both** the API and the worker (never commit them):

```
EMAIL_PROVIDER=gmail
EMAIL_FROM="Your Company <statements@yourdomain.com>"   # the address must be the mailbox itself
SMTP_USER=statements@yourdomain.com                    # the same mailbox
SMTP_PASS=abcdefghijklmnop                             # the 16-character app password, no spaces
```
Preset: `smtp.gmail.com`, port 465, TLS. Nothing else to set.

`EMAIL_FROM` must equal `SMTP_USER` (or be an alias added under Gmail → Settings → Accounts → *Send mail as*). Otherwise Gmail silently
rewrites the sender to the mailbox. The server warns at start-up if they differ.

## 3. Verify with a real message
```
npm run email:test -- --verify-only            # logs in, sends nothing
npm run email:test -- you@example.com          # sends one real test email
```
A failed login prints a hint. `535` / `EAUTH` means a wrong address or app password.

Then finalize a month and click Send on one statement addressed to yourself. The worker (`npm run worker`) must be running.

## 4. What to expect
- Statements go out one email per owner, with a secure link. Owners' CSVs are behind the link, not attached.
- **Delivery status**: Gmail SMTP has no callbacks, so deliveries stay at `SENT` and never become `DELIVERED` or `BOUNCED`. A bounce
  arrives as a message in the Gmail inbox, which you need to read yourself.
- **Limits**: about 500 recipients per day on a free `@gmail.com` account and about 2,000 per day on Google Workspace. Exceeding it
  blocks sending for roughly 24 hours. A property manager with a few dozen owners is far inside this.
- **Spam placement**: mail from a plain `@gmail.com` is fine for owners who expect it. On a custom domain, make sure SPF, DKIM and DMARC
  are set up in Google Workspace so statements do not land in spam.
- **Security**: the app password lets anyone holding it send mail as this mailbox. Keep it in your secret store, and revoke it at
  Google if it leaks (revoking never affects your normal password).

## 5. Moving off Gmail later
Change `EMAIL_PROVIDER` and the matching credentials (see `.env.example`) and restart the API and worker. Brevo, Resend, Mailjet and
MailerSend have free tiers and add delivery/bounce tracking. Nothing else in the app changes, and already-sent statements stay as recorded.
