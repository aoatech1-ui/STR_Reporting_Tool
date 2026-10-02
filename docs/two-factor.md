# Two-factor login

Anyone can protect their account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy, …) on top of the password.
Administrators can **require** it for everyone.

## Turn it on (server)

1. Set `MFA_ENCRYPTION_KEY` in `.env` (at least 32 characters): `openssl rand -base64 48`. Restart the app and worker.
2. **Back this key up with your other secrets.** Authenticator secrets are stored encrypted with it. If it is lost, enrolled users cannot sign in until an administrator resets them
   (and an administrator who is also locked out needs `npm run create-admin`-style database access). Changing it has the same effect as losing it.
3. `docker compose run --rm tools` (preflight) reports the status under "two-factor login". Without the key the feature is simply unavailable, and **a user who already has two-factor login
   is never let in with a password alone**: the server refuses (503) until the key is restored.

## Use it (people)

* **Security** in the sidebar → *Turn on two-factor login*: confirm your password, scan the QR code (or type the key), enter the code.
* You then get **10 recovery codes**, shown once. Each works one time if you lose your phone. Save them in a password manager.
* At sign-in: password, then the 6-digit code (or a recovery code via *Use a recovery code instead*).
* *New recovery codes* replaces all old ones. *Turn off* needs the password and a code. Both are in Security.

## Administrators

* **Require for everyone** (Security → Organization policy). You must have two-factor login yourself first. People without it are taken to the Security page when they next
  sign in and can do nothing else until they set it up. While required, nobody can turn their own off.
* **Reset 2FA** (Settings → Users) for someone who lost their phone *and* recovery codes: removes their authenticator and codes, signs them out, and is audited. They sign in with their password and set it up again.
* Settings → Users shows who has 2FA.

## How it protects

| Property | How |
|---|---|
| No session without the second factor | Password check creates a 5-minute, single-use challenge, not a session |
| Guessing | 5 tries per challenge; every wrong code counts toward the same 5-failure / 15-minute account lockout as wrong passwords; a password-only login does not reset that counter |
| Replay | A code's 30-second step is recorded; the same or an earlier step is refused. ±1 step of clock drift is accepted |
| Secrets at rest | AES-256-GCM, bound to the user id, key derived from `MFA_ENCRYPTION_KEY` (HKDF). Recovery codes stored only as keyed hashes |
| Sensitive changes | Enrolling, turning off and regenerating need the password; the last two also need a code. Enrolling signs out the user's other sessions |
| Audit | `MFA_ENABLED`, `MFA_DISABLED`, `MFA_RECOVERY_CODES_REGENERATED`, `MFA_RECOVERY_CODE_USED`, `MFA_RESET`, `MFA_VERIFY_FAILED`, `MFA_POLICY_CHANGED` in the hash-chained audit log |

Standard: RFC 6238 TOTP (SHA-1, 6 digits, 30 s), verified against the RFC test vectors. Not included: SMS codes (weaker, SIM-swap risk), WebAuthn/passkeys (a possible later addition).
Owner statement links are separate: they are signed, expiring links for owners and are unaffected.
