import { createHash, randomBytes } from 'node:crypto';
import type { Db, Pool, Tx } from '../db/pool.ts';
import { withTx } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import {
  decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, newTotpSecret, otpauthUri, verifyTotp, type MfaKeys,
} from '../auth/mfa.ts';
import { appendAudit } from './audit.ts';
import { LOCKOUT_MS, MAX_FAILED_LOGINS, type AuthUser } from './auth.ts';

export const ENROLLMENT_TTL_MS = 15 * 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const GENERIC = 'Invalid verification code';

export function requireKeys(keys: MfaKeys | null | undefined): MfaKeys {
  if (!keys) throw new UserError('Two-factor login is not available: the server has no MFA_ENCRYPTION_KEY configured', 503);
  return keys;
}

export interface MfaStatus { enabled: boolean; enabledAt: string | null; enrollmentPending: boolean; recoveryCodesRemaining: number; orgRequires: boolean; serverReady: boolean }

export async function mfaStatus(db: Db, orgId: string, userId: string, serverReady: boolean): Promise<MfaStatus> {
  const r = await db.query(
    `SELECT u.totp_enabled_at, u.totp_pending_at, o.require_mfa,
            (SELECT count(*)::int FROM mfa_recovery_codes c WHERE c.user_id = u.id AND c.used_at IS NULL) AS remaining
     FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1 AND u.organization_id = $2`, [userId, orgId]);
  const x = r.rows[0];
  if (!x) throw new UserError('User not found');
  return { enabled: !!x.totp_enabled_at, enabledAt: x.totp_enabled_at ? new Date(x.totp_enabled_at).toISOString() : null,
    enrollmentPending: !!x.totp_pending_at, recoveryCodesRemaining: x.remaining, orgRequires: x.require_mfa, serverReady };
}

/** Creates (or replaces) a pending secret. It only becomes active when the user proves they can generate a code (confirmEnrollment). */
export async function startEnrollment(tx: Tx, keys: MfaKeys, orgId: string, userId: string, issuer: string, now: Date): Promise<{ secret: string; uri: string }> {
  const u = (await tx.query('SELECT email, totp_enabled_at FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId, orgId])).rows[0];
  if (!u) throw new UserError('User not found');
  if (u.totp_enabled_at) throw new UserError('Two-factor login is already enabled. Disable it first to set it up again.');
  const secret = newTotpSecret();
  await tx.query('UPDATE users SET totp_pending_enc=$2, totp_pending_at=$3 WHERE id=$1', [userId, encryptSecret(secret, userId, keys), now]);
  return { secret, uri: otpauthUri(secret, u.email, issuer) };
}

async function storeRecoveryCodes(tx: Tx, keys: MfaKeys, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
  for (const c of codes) await tx.query('INSERT INTO mfa_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, hashRecoveryCode(c, keys)]);
  return codes;
}

/** Activates MFA. Returns the recovery codes: the only time they are ever readable. Other sessions are ended so a stolen session cannot outlive the change. */
export async function confirmEnrollment(tx: Tx, keys: MfaKeys, orgId: string, userId: string, code: string, now: Date, keepSessionId: string): Promise<string[]> {
  const u = (await tx.query('SELECT totp_enabled_at, totp_pending_enc, totp_pending_at FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId, orgId])).rows[0];
  if (!u) throw new UserError('User not found');
  if (u.totp_enabled_at) throw new UserError('Two-factor login is already enabled');
  if (!u.totp_pending_enc || now.getTime() - new Date(u.totp_pending_at).getTime() > ENROLLMENT_TTL_MS) throw new UserError('Setup expired. Start again.');
  const secret = decryptSecret(u.totp_pending_enc, userId, keys);
  const step = verifyTotp(secret, code, now.getTime());
  if (step === null) throw new UserError(GENERIC);
  await tx.query(`UPDATE users SET totp_secret_enc=$2, totp_enabled_at=$3, totp_last_step=$4, totp_pending_enc=NULL, totp_pending_at=NULL, updated_at=now() WHERE id=$1`,
    [userId, u.totp_pending_enc, now, step]);
  const codes = await storeRecoveryCodes(tx, keys, userId);
  await tx.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [userId, keepSessionId]);
  await appendAudit(tx, orgId, { userId, action: 'MFA_ENABLED', entityType: 'user', entityId: userId, oldValue: null, newValue: null, at: now.toISOString() });
  return codes;
}

type Factor = 'totp' | 'recovery';
interface LockedUser { id: string; organization_id: string; totp_secret_enc: string | null; totp_last_step: string | null; failed_logins: number; locked_until: string | null; active: boolean }

/**
 * Checks a TOTP code or a recovery code for a user row that is already locked FOR UPDATE.
 * TOTP: a step at or before the last accepted one is refused (replay). Recovery code: consumed atomically, single use.
 */
async function checkFactor(tx: Tx, keys: MfaKeys, u: LockedUser, code: string, now: Date): Promise<Factor | null> {
  if (!u.totp_secret_enc) return null;
  const trimmed = code.trim();
  if (looksLikeRecoveryCode(trimmed) && !/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
    const r = await tx.query('UPDATE mfa_recovery_codes SET used_at=$3 WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL', [u.id, hashRecoveryCode(trimmed, keys), now]);
    if (r.rowCount === 1) {
      await appendAudit(tx, u.organization_id, { userId: u.id, action: 'MFA_RECOVERY_CODE_USED', entityType: 'user', entityId: u.id, oldValue: null, newValue: null, at: now.toISOString() });
      return 'recovery';
    }
    return null;
  }
  const step = verifyTotp(decryptSecret(u.totp_secret_enc, u.id, keys), trimmed, now.getTime(), { lastStep: u.totp_last_step === null ? null : Number(u.totp_last_step) });
  if (step === null) return null;
  await tx.query('UPDATE users SET totp_last_step=$2 WHERE id=$1', [u.id, step]);
  return 'totp';
}

/** A wrong second factor counts toward the same lockout as a wrong password. */
async function registerFailure(tx: Tx, u: LockedUser, now: Date, where: string): Promise<boolean> {
  const fails = u.failed_logins + 1, lock = fails >= MAX_FAILED_LOGINS;
  await tx.query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [u.id, lock ? 0 : fails, lock ? new Date(now.getTime() + LOCKOUT_MS) : null]);
  if (lock) await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1', [u.id]);
  await appendAudit(tx, u.organization_id, { userId: u.id, action: lock ? 'ACCOUNT_LOCKED' : 'MFA_VERIFY_FAILED', entityType: 'user', entityId: u.id, oldValue: null, newValue: { failedLogins: fails, where }, at: now.toISOString() });
  return lock;
}

const lockUser = async (tx: Tx, userId: string): Promise<LockedUser | undefined> =>
  (await tx.query('SELECT id, organization_id, totp_secret_enc, totp_last_step, failed_logins, locked_until, active FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];

// ---------- login challenge ----------

export async function createChallenge(tx: Tx, userId: string, now: Date, ip?: string): Promise<string> {
  const t = randomBytes(32).toString('base64url');
  await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 AND (expires_at < $2 OR created_at < $3)', [userId, now, new Date(now.getTime() - 60 * 60_000)]);
  await tx.query('INSERT INTO mfa_challenges(user_id, token_hash, expires_at, ip) VALUES ($1,$2,$3,$4)', [userId, sha(t), new Date(now.getTime() + CHALLENGE_TTL_MS), ip ?? null]);
  return t;
}

/** Second step of login. Single-use challenge, 5 tries, 5 minutes. Counters are committed before the error is thrown. */
export async function completeChallenge(pool: Pool, keys: MfaKeys, rawToken: string, code: string, now: Date): Promise<AuthUser> {
  type Outcome = { user: AuthUser } | { error: UserError };
  const expired = { error: new UserError('Sign-in expired. Please sign in again.', 401) };
  const out = await withTx(pool, async (tx): Promise<Outcome> => {
    const ch = (await tx.query('SELECT id, user_id, expires_at, attempts FROM mfa_challenges WHERE token_hash=$1 FOR UPDATE', [sha(rawToken)])).rows[0];
    if (!ch) return expired;
    if (new Date(ch.expires_at) <= now || ch.attempts >= CHALLENGE_MAX_ATTEMPTS) { await tx.query('DELETE FROM mfa_challenges WHERE id=$1', [ch.id]); return expired; }
    const u = await lockUser(tx, ch.user_id);
    if (!u || !u.active) return expired;
    if (u.locked_until && new Date(u.locked_until) > now) return { error: new UserError('Too many failed attempts. Try again later.', 429) };
    const factor = await checkFactor(tx, keys, u, code, now);
    if (!factor) {
      const locked = await registerFailure(tx, u, now, 'login');
      if (!locked) {
        if (ch.attempts + 1 >= CHALLENGE_MAX_ATTEMPTS) await tx.query('DELETE FROM mfa_challenges WHERE id=$1', [ch.id]);
        else await tx.query('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=$1', [ch.id]);
      }
      return { error: new UserError(locked ? 'Too many failed attempts. Try again later.' : GENERIC, locked ? 429 : 401) };
    }
    await tx.query('DELETE FROM mfa_challenges WHERE id=$1', [ch.id]);
    await tx.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    const full = (await tx.query('SELECT id, organization_id, name, email, role FROM users WHERE id=$1', [u.id])).rows[0];
    return { user: { id: full.id, orgId: full.organization_id, name: full.name, email: full.email, role: full.role } };
  });
  if ('error' in out) throw out.error;
  return out.user;
}

// ---------- changes by a signed-in user (password is checked by the caller; the second factor here) ----------

/** Verifies a code for an already signed-in user doing a sensitive change. Wrong codes count toward lockout. */
async function requireFactor(pool: Pool, keys: MfaKeys, orgId: string, userId: string, code: string, now: Date, action: (tx: Tx, factor: Factor) => Promise<unknown>): Promise<unknown> {
  type Outcome = { value: unknown } | { error: UserError };
  const out = await withTx(pool, async (tx): Promise<Outcome> => {
    const u = await lockUser(tx, userId);
    if (!u || u.organization_id !== orgId) return { error: new UserError('User not found') };
    if (!u.totp_secret_enc) return { error: new UserError('Two-factor login is not enabled') };
    if (u.locked_until && new Date(u.locked_until) > now) return { error: new UserError('Too many failed attempts. Try again later.', 429) };
    const factor = await checkFactor(tx, keys, u, code, now);
    if (!factor) {
      const locked = await registerFailure(tx, u, now, 'settings');
      return { error: new UserError(locked ? 'Too many failed attempts. Try again later.' : GENERIC, locked ? 429 : 403) };
    }
    return { value: await action(tx, factor) };
  });
  if ('error' in out) throw out.error;
  return out.value;
}

export async function disableMfa(pool: Pool, keys: MfaKeys, orgId: string, userId: string, code: string, now: Date): Promise<void> {
  await requireFactor(pool, keys, orgId, userId, code, now, async (tx) => {
    const o = (await tx.query('SELECT require_mfa FROM organizations WHERE id=$1', [orgId])).rows[0];
    if (o?.require_mfa) throw new UserError('Your organization requires two-factor login, so it cannot be turned off');
    await tx.query('UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL, totp_pending_enc=NULL, totp_pending_at=NULL, updated_at=now() WHERE id=$1', [userId]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    await appendAudit(tx, orgId, { userId, action: 'MFA_DISABLED', entityType: 'user', entityId: userId, oldValue: null, newValue: null, at: now.toISOString() });
  });
}

export async function regenerateRecoveryCodes(pool: Pool, keys: MfaKeys, orgId: string, userId: string, code: string, now: Date): Promise<string[]> {
  return await requireFactor(pool, keys, orgId, userId, code, now, async (tx) => {
    const codes = await storeRecoveryCodes(tx, keys, userId);
    await appendAudit(tx, orgId, { userId, action: 'MFA_RECOVERY_CODES_REGENERATED', entityType: 'user', entityId: userId, oldValue: null, newValue: null, at: now.toISOString() });
    return codes;
  }) as string[];
}

// ---------- administration ----------

/** For a user who lost their phone and recovery codes. Ends their sessions; they must enrol again at next login if the policy demands it. */
export async function adminResetMfa(tx: Tx, orgId: string, actorId: string, userId: string): Promise<void> {
  if (actorId === userId) throw new UserError('Use "Turn off two-factor" for your own account');
  const u = (await tx.query('SELECT totp_enabled_at FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId, orgId])).rows[0];
  if (!u) throw new UserError('User not found');
  if (!u.totp_enabled_at) throw new UserError('This user has no two-factor login set up');
  await tx.query('UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL, totp_pending_enc=NULL, totp_pending_at=NULL, updated_at=now() WHERE id=$1', [userId]);
  await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
  await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1', [userId]);
  await tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await appendAudit(tx, orgId, { userId: actorId, action: 'MFA_RESET', entityType: 'user', entityId: userId, oldValue: null, newValue: null });
}

export async function getSecurityPolicy(db: Db, orgId: string): Promise<{ requireMfa: boolean; usersWithMfa: number; activeUsers: number }> {
  const r = await db.query(
    `SELECT o.require_mfa, (SELECT count(*)::int FROM users u WHERE u.organization_id=o.id AND u.active AND u.totp_enabled_at IS NOT NULL) AS with_mfa,
            (SELECT count(*)::int FROM users u WHERE u.organization_id=o.id AND u.active) AS active
     FROM organizations o WHERE o.id=$1`, [orgId]);
  const x = r.rows[0];
  return { requireMfa: x.require_mfa, usersWithMfa: x.with_mfa, activeUsers: x.active };
}

/** Turning the policy on requires the acting admin to be enrolled already, so enabling it can never lock the organization out of its own settings. */
export async function setRequireMfa(tx: Tx, orgId: string, actorId: string, required: boolean): Promise<void> {
  const cur = (await tx.query('SELECT require_mfa FROM organizations WHERE id=$1 FOR UPDATE', [orgId])).rows[0];
  if (required) {
    const me = (await tx.query('SELECT totp_enabled_at FROM users WHERE id=$1', [actorId])).rows[0];
    if (!me?.totp_enabled_at) throw new UserError('Turn on two-factor login for your own account before requiring it for everyone');
  }
  if (cur.require_mfa === required) return;
  await tx.query('UPDATE organizations SET require_mfa=$2, updated_at=now() WHERE id=$1', [orgId, required]);
  await appendAudit(tx, orgId, { userId: actorId, action: 'MFA_POLICY_CHANGED', entityType: 'organization', entityId: orgId, oldValue: { requireMfa: cur.require_mfa }, newValue: { requireMfa: required } });
}
