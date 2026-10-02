import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, passwordProblem, verifyPassword, type ScryptCost, DEFAULT_COST } from '../auth/password.ts';
import type { Role } from '../auth/permissions.ts';
import type { Db, Pool, Tx } from '../db/pool.ts';
import { withTx } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import { appendAudit } from './audit.ts';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
export const SESSION_IDLE_MS = 2 * 3600_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export interface AuthUser { id: string; orgId: string; name: string; email: string; role: Role }
export interface SessionInfo extends AuthUser { sessionId: string; csrf: string; mfaEnabled: boolean; mfaEnrollmentRequired: boolean }
export interface AuthResult { user: AuthUser; mfaRequired: boolean }

let dummyHash: Promise<string> | undefined; // equalises timing for unknown emails
const getDummy = (cost: ScryptCost) => (dummyHash ??= hashPassword('not-a-real-password', cost));

/**
 * Verifies credentials with lockout. Failure counters are committed before an error is thrown.
 * The same generic error is returned for unknown user, wrong password and inactive user.
 */
export async function authenticate(pool: Pool, email: string, password: string, now: Date, cost: ScryptCost = DEFAULT_COST): Promise<AuthResult> {
  type Outcome = AuthResult | { error: UserError };
  const out: Outcome = await withTx(pool, async (tx): Promise<Outcome> => {
    const r = await tx.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email.trim().toLowerCase()]);
    const u = r.rows[0];
    const bad = { error: new UserError('Invalid email or password', 401) };
    if (!u || !u.password_hash) { await verifyPassword(password, await getDummy(cost)); return bad; }
    if (u.locked_until && new Date(u.locked_until) > now) {
      return { error: new UserError('Too many failed attempts. Try again later.', 429) };
    }
    const ok = await verifyPassword(password, u.password_hash);
    if (!ok || !u.active) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILED_LOGINS;
      await tx.query('UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1', [u.id, lock ? 0 : fails, lock ? new Date(now.getTime() + LOCKOUT_MS) : null]);
      await appendAudit(tx, u.organization_id, { userId: u.id, action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', entityType: 'user', entityId: u.id, oldValue: null, newValue: { failedLogins: fails }, at: now.toISOString() });
      return bad;
    }
    const user = { id: u.id, orgId: u.organization_id, name: u.name, email: u.email, role: u.role };
    // With MFA the failure counter is only reset after the second factor succeeds; otherwise someone who knows the password could
    // reset it by logging in again and so guess codes forever.
    if (u.totp_enabled_at) return { user, mfaRequired: true };
    await tx.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    return { user, mfaRequired: false };
  });
  if ('error' in out) throw out.error;
  return out;
}

export async function createSession(tx: Tx, user: AuthUser, now: Date, meta: { ip?: string; userAgent?: string } = {}) {
  const t = token(), csrf = token();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await tx.query('INSERT INTO sessions(user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)',
    [user.id, sha(t), csrf, now, expiresAt, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null]);
  await appendAudit(tx, user.orgId, { userId: user.id, action: 'LOGIN_SUCCEEDED', entityType: 'user', entityId: user.id, oldValue: null, newValue: null, at: now.toISOString(), meta: { ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) } });
  return { token: t, csrf, expiresAt };
}

/** Role/active are read fresh on every request, so deactivation or demotion takes effect immediately. */
export async function getSession(db: Db, rawToken: string, now: Date): Promise<SessionInfo | null> {
  const r = await db.query(
    `SELECT s.id AS sid, s.csrf_token, s.last_seen_at, s.expires_at, u.id, u.organization_id, u.name, u.email, u.role, u.active, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled, o.require_mfa
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.organization_id WHERE s.token_hash = $1`, [sha(rawToken)]);
  const x = r.rows[0];
  if (!x || !x.active) return null;
  if (new Date(x.expires_at) <= now || now.getTime() - new Date(x.last_seen_at).getTime() > SESSION_IDLE_MS) {
    await db.query('DELETE FROM sessions WHERE id=$1', [x.sid]);
    return null;
  }
  if (now.getTime() - new Date(x.last_seen_at).getTime() > 60_000) await db.query('UPDATE sessions SET last_seen_at=$2 WHERE id=$1', [x.sid, now]);
  return { sessionId: x.sid, csrf: x.csrf_token, id: x.id, orgId: x.organization_id, name: x.name, email: x.email, role: x.role,
    mfaEnabled: x.mfa_enabled, mfaEnrollmentRequired: x.require_mfa && !x.mfa_enabled };
}

export async function deleteSession(db: Db, rawToken: string): Promise<void> { await db.query('DELETE FROM sessions WHERE token_hash=$1', [sha(rawToken)]); }

export async function setPassword(tx: Tx, orgId: string, actorId: string, userId: string, newPassword: string, keepSessionId?: string, cost: ScryptCost = DEFAULT_COST): Promise<void> {
  const u = (await tx.query('SELECT email FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId, orgId])).rows[0];
  if (!u) throw new UserError('User not found');
  const problem = passwordProblem(newPassword, u.email);
  if (problem) throw new UserError(problem, 422);
  await tx.query('UPDATE users SET password_hash=$2, password_changed_at=now(), failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1', [userId, await hashPassword(newPassword, cost)]);
  await tx.query('DELETE FROM sessions WHERE user_id=$1 AND ($2::uuid IS NULL OR id <> $2)', [userId, keepSessionId ?? null]);
  await appendAudit(tx, orgId, { userId: actorId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId, oldValue: null, newValue: null });
}

export async function checkCurrentPassword(db: Db, orgId: string, userId: string, password: string): Promise<boolean> {
  const r = await db.query('SELECT password_hash FROM users WHERE id=$1 AND organization_id=$2', [userId, orgId]);
  return !!r.rows[0]?.password_hash && verifyPassword(password, r.rows[0].password_hash);
}

export interface UserRow { id: string; name: string; email: string; role: Role; active: boolean; lockedUntil: string | null; mfaEnabled: boolean }
export async function listUsers(db: Db, orgId: string): Promise<UserRow[]> {
  const r = await db.query('SELECT id, name, email, role, active, locked_until, (totp_enabled_at IS NOT NULL) AS mfa_enabled FROM users WHERE organization_id=$1 ORDER BY name', [orgId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, active: x.active, lockedUntil: x.locked_until ? new Date(x.locked_until).toISOString() : null, mfaEnabled: x.mfa_enabled }));
}

/** Role/active changes. Refuses to leave the organization without an active ADMIN. Deactivation ends all sessions. */
export async function updateUser(tx: Tx, orgId: string, actorId: string, id: string, patch: { role?: Role; active?: boolean; name?: string }): Promise<void> {
  const cur = (await tx.query('SELECT id, role, active, name FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, orgId])).rows[0];
  if (!cur) throw new UserError('User not found');
  const next = { role: patch.role ?? cur.role, active: patch.active ?? cur.active, name: patch.name ?? cur.name };
  if (cur.role === 'ADMIN' && cur.active && (next.role !== 'ADMIN' || !next.active)) {
    await tx.query(`SELECT 1 FROM users WHERE organization_id=$1 AND role='ADMIN' AND active FOR UPDATE`, [orgId]);
    const n = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE organization_id=$1 AND role='ADMIN' AND active AND id<>$2`, [orgId, id])).rows[0].n;
    if (n === 0) throw new UserError('Cannot remove the last active administrator');
  }
  await tx.query('UPDATE users SET role=$2, active=$3, name=$4, updated_at=now() WHERE id=$1', [id, next.role, next.active, next.name]);
  if (!next.active) await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  await appendAudit(tx, orgId, { userId: actorId, action: 'USER_UPDATED', entityType: 'user', entityId: id, oldValue: { role: cur.role, active: cur.active, name: cur.name }, newValue: next });
}
