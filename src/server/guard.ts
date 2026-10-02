import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission } from '../auth/permissions.ts';
import type { Pool } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import { getSession, type SessionInfo } from '../repo/auth.ts';
import type { AppConfig } from './config.ts';

declare module 'fastify' { interface FastifyRequest { auth?: SessionInfo } }

export const SESSION_COOKIE = 'sid';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export interface GuardDeps { pool: Pool; config: AppConfig; now: () => Date }

/**
 * Route guard factory. Order: session → Origin → CSRF token → permission.
 * 401 = not signed in, 403 = signed in but not allowed (or failed CSRF/Origin).
 */
export interface GuardOpts { /** Routes a user who still has to enrol in two-factor login may use (enrolment itself, sign-out, who-am-I). */ allowMfaEnrollment?: boolean }

export function makeGuard(d: GuardDeps) {
  return (perm: Permission, opts: GuardOpts = {}) => async (req: FastifyRequest, _reply: FastifyReply) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    const session = raw ? await getSession(d.pool, raw, d.now()) : null;
    if (!session) throw new UserError('Authentication required', 401);
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !d.config.allowedOrigins.includes(origin)) throw new UserError('Origin not allowed', 403);
      const tok = req.headers['x-csrf-token'];
      if (typeof tok !== 'string' || !eq(tok, session.csrf)) throw new UserError('Missing or invalid CSRF token', 403);
    }
    if (!can(session.role, perm)) throw new UserError('You do not have permission to do that', 403);
    if (session.mfaEnrollmentRequired && !opts.allowMfaEnrollment) {
      throw new UserError('Your organization requires two-factor login. Set it up to continue.', 403, 'MFA_ENROLLMENT_REQUIRED');
    }
    req.auth = session;
  };
}
export type Guard = ReturnType<typeof makeGuard>;
export const auth = (req: FastifyRequest): SessionInfo => req.auth!;
