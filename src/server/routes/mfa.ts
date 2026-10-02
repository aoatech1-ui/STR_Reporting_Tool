import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { withTx } from '../../db/pool.ts';
import { UserError } from '../../errors.ts';
import { checkCurrentPassword } from '../../repo/auth.ts';
import {
  confirmEnrollment, disableMfa, getSecurityPolicy, mfaStatus, regenerateRecoveryCodes, requireKeys, setRequireMfa, startEnrollment,
} from '../../repo/mfa.ts';
import { auth } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Password = z.string().min(1).max(256);
const Code = z.string().min(1).max(64);

export async function mfaRoutes(app: FastifyInstance, c: Ctx) {
  const limit = { rateLimit: { max: c.config.loginRateLimit, timeWindow: '1 minute' } };
  const open = { allowMfaEnrollment: true };
  const issuer = async (orgId: string) => (await c.pool.query('SELECT display_name FROM organizations WHERE id=$1', [orgId])).rows[0]?.display_name ?? 'Owner statements';
  const needPassword = async (a: { orgId: string; id: string }, password: string) => {
    if (!(await checkCurrentPassword(c.pool, a.orgId, a.id, password))) throw new UserError('Password is incorrect', 403);
  };

  app.get('/api/mfa/status', { preHandler: c.guard('read', open) }, async (req) => {
    const a = auth(req);
    return mfaStatus(c.pool, a.orgId, a.id, !!c.config.mfaKeys);
  });

  // The password is asked again so a hijacked session cannot enrol its own authenticator.
  app.post('/api/mfa/enroll/start', { preHandler: c.guard('read', open), config: limit }, async (req) => {
    const a = auth(req);
    const keys = requireKeys(c.config.mfaKeys);
    const b = z.object({ password: Password }).strict().parse(req.body);
    await needPassword(a, b.password);
    const iss = await issuer(a.orgId);
    const e = await withTx(c.pool, (tx) => startEnrollment(tx, keys, a.orgId, a.id, iss, c.now()));
    return { secret: e.secret, uri: e.uri, qr: await QRCode.toString(e.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  app.post('/api/mfa/enroll/confirm', { preHandler: c.guard('read', open), config: limit }, async (req) => {
    const a = auth(req);
    const keys = requireKeys(c.config.mfaKeys);
    const b = z.object({ code: Code }).strict().parse(req.body);
    const codes = await withTx(c.pool, (tx) => confirmEnrollment(tx, keys, a.orgId, a.id, b.code, c.now(), a.sessionId));
    return { recoveryCodes: codes };
  });

  app.post('/api/mfa/recovery-codes', { preHandler: c.guard('read', open), config: limit }, async (req) => {
    const a = auth(req);
    const keys = requireKeys(c.config.mfaKeys);
    const b = z.object({ password: Password, code: Code }).strict().parse(req.body);
    await needPassword(a, b.password);
    return { recoveryCodes: await regenerateRecoveryCodes(c.pool, keys, a.orgId, a.id, b.code, c.now()) };
  });

  app.post('/api/mfa/disable', { preHandler: c.guard('read', open), config: limit }, async (req) => {
    const a = auth(req);
    const keys = requireKeys(c.config.mfaKeys);
    const b = z.object({ password: Password, code: Code }).strict().parse(req.body);
    await needPassword(a, b.password);
    await disableMfa(c.pool, keys, a.orgId, a.id, b.code, c.now());
    return { ok: true };
  });

  app.get('/api/settings/security', { preHandler: c.guard('settings:view', open) }, async (req) => getSecurityPolicy(c.pool, auth(req).orgId));

  app.put('/api/settings/security', { preHandler: c.guard('users:manage', open) }, async (req) => {
    const a = auth(req);
    const b = z.object({ requireMfa: z.boolean() }).strict().parse(req.body);
    if (b.requireMfa) requireKeys(c.config.mfaKeys);
    await withTx(c.pool, (tx) => setRequireMfa(tx, a.orgId, a.id, b.requireMfa));
    return getSecurityPolicy(c.pool, a.orgId);
  });
}
