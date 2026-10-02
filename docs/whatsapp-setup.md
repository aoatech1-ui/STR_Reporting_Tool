# WhatsApp notifications

When a statement is sent, owners who have **WhatsApp enabled and have opted in** also get a short WhatsApp message with a secure link to the
statement (PDF and CSV are behind the link, never in the chat). Email still goes out as before; WhatsApp is an extra channel.

Two providers are supported. Pick one:

| | Meta WhatsApp Cloud API | Twilio |
|---|---|---|
| What it is | WhatsApp's own API, direct | A reseller/wrapper with its own console and support |
| Setup effort | More steps in Meta Business Manager | Fewer steps; Twilio handles the Meta side |
| Cost | Meta's per-message pricing | Meta's pricing **plus** Twilio's per-message fee |
| `WHATSAPP_PROVIDER` | `meta` | `twilio` |

Pricing and policies change; check the provider's current pricing page. Statement notifications are normally classified as **utility** messages.

## The three rules WhatsApp imposes

1. **Templates.** A business can only start a conversation with a **pre-approved template**. The app sends template messages only, so you must create the
   templates below and wait for approval (usually minutes to a day). An unapproved template is rejected at send time.
2. **Consent.** You may message only people who have agreed to receive WhatsApp messages from you. The app enforces this: nothing is sent unless the owner's
   **WhatsApp notifications** and **opted in** boxes are ticked. Tick *opted in* only after the owner has actually agreed (a reply, a signed agreement, a form).
   The opt-in time is recorded on the owner.
3. **STOP.** If an owner replies `STOP` (also `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `OPT OUT`), the app switches WhatsApp off for that owner **immediately**, records
   when, and writes an audit entry. It never re-enables it by itself: only tick *opted in* again if the owner asks you to resume. Only exact words count, so a sentence such as
   "please don't stop" does not unsubscribe anyone.

## Templates to create

Create these two in your provider's console (language **English (US)**, category **Utility**). Keep the text exactly as shown, including the variable order.
WhatsApp does not allow a variable at the very start or end of the text, which is why each ends with the STOP line.

**`statement_ready`** (default, no amounts) has 3 variables:

```
Hello, your {{1}} owner statement for {{2}} is ready. You can view and download it securely here: {{3}}

Reply STOP to stop receiving these messages.
```

Sample values for approval: `{{1}}` = `September 2026`, `{{2}}` = `123 Main Street`, `{{3}}` = `https://statements.example.com/view/abc123`

**`statement_ready_summary`** (only if you set `WHATSAPP_INCLUDE_SUMMARY=true`; shows the owner's proceeds) has 4 variables:

```
Hello, your {{1}} owner statement for {{2}} is ready. Owner proceeds: {{3}}. You can view and download the full statement securely here: {{4}}

Reply STOP to stop receiving these messages.
```

Sample values: `{{3}}` = `$4,000.00`, `{{4}}` = the same sample link.

By default **no dollar amounts are sent over WhatsApp**; only enable the summary variant if your owners want it.

## Option A: Meta WhatsApp Cloud API

1. In **Meta Business Manager** create (or use) a business account and verify the business if prompted.
2. At developers.facebook.com create an app of type **Business**, add the **WhatsApp** product, and add a phone number. The number must not already be registered on the WhatsApp app (or must be migrated).
3. Create a **System User** (Business Settings → Users → System users), give it access to the WhatsApp account, and generate a token with the permissions `whatsapp_business_messaging` and
   `whatsapp_business_management`. A system-user token does not expire; a temporary token from the console expires in 24 hours and will break sending.
4. Note the **Phone number ID** (WhatsApp → API setup) and the app's **App secret** (App settings → Basic).
5. Create the templates above (WhatsApp Manager → Message templates).
6. Configure the webhook (WhatsApp → Configuration):
   * Callback URL: `https://<DOMAIN>/webhooks/whatsapp/meta`
   * Verify token: any random string you choose; the same value goes in `WHATSAPP_VERIFY_TOKEN`
   * Subscribe to the **messages** field (delivery receipts and replies both arrive through it)
7. Set the environment (see below), restart the app and worker, then run:

```bash
docker compose run --rm tools node src/cli/whatsapp-test.ts --verify-only            # checks the token and phone number id, sends nothing
docker compose run --rm tools node src/cli/whatsapp-test.ts +15551234567 --template hello_world   # Meta's built-in test template
docker compose run --rm tools node src/cli/whatsapp-test.ts +15551234567              # sends your statement_ready template with sample values
```

While the number is in test mode Meta only lets you message numbers you added to the allowed list in the console.

## Option B: Twilio

1. Create a Twilio account and enable **WhatsApp senders** (Messaging → Senders → WhatsApp). For a quick trial use the Twilio **sandbox**; each recipient must first send it the join code.
2. In **Content Template Builder** create the two templates above as WhatsApp templates, submit them for approval, and copy each template's **Content SID** (starts with `HX`).
3. Environment: your **Account SID** (`AC…`), **Auth Token**, the sender number (`TWILIO_WHATSAPP_FROM=+1…`, or a Messaging Service SID) and the two Content SIDs.
4. Delivery receipts: the app asks Twilio to call `https://<DOMAIN>/webhooks/whatsapp/twilio` for every message automatically. For **STOP replies** also set the sender's
   "When a message comes in" URL to the same address (Twilio signs both with your Auth Token, which the app verifies).
5. Run `whatsapp-test.ts --verify-only`, then send yourself one.

## Environment variables

| Variable | Meta | Twilio | Notes |
|---|---|---|---|
| `WHATSAPP_PROVIDER` | `meta` | `twilio` | Unset = WhatsApp disabled |
| `WHATSAPP_META_TOKEN` | required | | System-user token |
| `WHATSAPP_META_PHONE_NUMBER_ID` | required | | |
| `WHATSAPP_META_APP_SECRET` | needed for receipts + STOP | | Signs webhooks; **without it receipts/STOP are rejected** |
| `WHATSAPP_VERIFY_TOKEN` | needed for webhook setup | | Your random string |
| `WHATSAPP_META_API_VERSION` | optional (default `v21.0`) | | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | | required | Token also verifies webhooks |
| `TWILIO_WHATSAPP_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | | one required | `+14155238886` style |
| `TWILIO_CONTENT_SID_STATEMENT_READY` | | required | `HX…` |
| `TWILIO_CONTENT_SID_STATEMENT_READY_SUMMARY` | | if summary enabled | |
| `WHATSAPP_TEMPLATE_STATEMENT_READY` | optional | | Template **name** if you chose a different one (default `statement_ready`) |
| `WHATSAPP_TEMPLATE_STATEMENT_READY_SUMMARY` | optional | | default `statement_ready_summary` |
| `WHATSAPP_TEMPLATE_LANGUAGE` | optional | | default `en_US` |
| `WHATSAPP_INCLUDE_SUMMARY` | optional | optional | `true` to include owner proceeds (uses the summary template) |

Set them for **both** the app and the worker (the Docker `.env` file does this). `docker compose run --rm tools` (the preflight check) verifies the credentials.

## How it behaves

* Sending a statement queues one email and one WhatsApp delivery per owner (where enabled/opted in). The **worker** sends them; **Communications** shows each with its status.
* Statuses: `Sent` → `Delivered` (WhatsApp "delivered" and "read" both count) or `Failed` with the provider's reason. Receipts need the webhook; without it WhatsApp messages stay at `Sent`.
* Transient problems (rate limits, provider outages) are retried with growing delays. Permanent ones (number not on WhatsApp, template not approved, bad token) fail at once with a plain-language reason, and **Resend** on Communications retries after you fix the cause.
* Template variables are sanitized (no line breaks, no empty values), because WhatsApp rejects them.
* Neither WhatsApp API offers an idempotency key. In the rare case the app crashes after WhatsApp accepted a message but before recording it, a retry could send the same notification twice. (Email providers that support idempotency keys avoid this; WhatsApp cannot.)

## Troubleshooting

| What you see | Likely cause |
|---|---|
| `code 190` / "access token invalid or expired" | Token expired (temporary token) or revoked. Create a system-user token. |
| `code 132001` / "template does not exist" | Template name or language does not match an **approved** template. Check `WHATSAPP_TEMPLATE_*` and `WHATSAPP_TEMPLATE_LANGUAGE`. |
| `code 132000` / "variable count" | Template text has a different number of variables than 3 (or 4 for summary). Recreate it exactly as above. |
| `code 131026` / "not reachable on WhatsApp" | The number is not on WhatsApp (or is not E.164). Check the owner's WhatsApp number. |
| `code 131030` / "allowed list" | A test phone number can only message numbers added in the Meta console. |
| Twilio `63016` | Message was not sent as an approved template. Check the Content SIDs. |
| Twilio `63015` | Sandbox: the recipient has not joined, or the number is not on WhatsApp. |
| Messages stay `Sent`, never `Delivered` | Webhook not reachable or secret missing. Integrations screen shows "Webhook secret missing"; check Meta's webhook delivery log. |
| Owner replied STOP but is still opted in | Webhook not configured/verified, or `messages` field not subscribed. |

## What was verified, and what only you can verify

Verified by automated tests (mocked HTTP and locally generated signatures): request formats and authentication for both providers, error classification by code, template selection and
variable order, sanitizing, webhook signature checks (tampered/unsigned/wrong-secret rejected), Meta's verification handshake, delivery receipts, STOP handling (exact words, every matching
owner record, audit entries, no re-enable until a manager does), the send → worker → receipt flow, and the browser flow for enabling WhatsApp and seeing an owner's STOP.

**Not tested against live Meta or Twilio** (no accounts here): your credentials, template approval, number registration, the real webhook calls and the exact field names in live payloads. Before
inviting owners, send a message to yourself and reply STOP once to confirm the whole loop in your account.
