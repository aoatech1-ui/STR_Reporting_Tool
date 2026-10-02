import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.ts';
import { GRANTS } from '../../auth/permissions.ts';
import { UserError } from '../../errors.ts';
import { authenticate, checkCurrentPassword, createSession, deleteSession, listUsers, setPassword, updateUser, SESSION_ABSOLUTE_MS } from '../../repo/auth.ts';
import { createUser } from '../../repo/orgs.ts';
import { getJobStats, getWorkerStatus } from '../../repo/ops.ts';
import { auth, SESSION_COOKIE } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Role = z.enum(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER']);

export async function authRoutes(app: FastifyInstance, c: Ctx) {
  const cookieOpts = { httpOnly: true, secure: c.config.cookieSecure, sameSite: 'strict' as const, path: '/' };

  app.post('/api/auth/login', { config: { rateLimit: { max: c.config.loginRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().max(320), password: z.string().min(1).max(256) }).strict().parse(req.body);
    const now = c.now();
    const user = await authenticate(c.pool, body.email, body.password, now, c.config.scryptCost);
    const s = await withTx(c.pool, (tx) => createSession(tx, user, now, { ip: req.ip, userAgent: req.headers['user-agent'] }));
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, permissions: [...GRANTS[user.role]], csrfToken: s.csrf };
  });

  app.post('/api/auth/logout', { preHandler: c.guard('read') }, async (req, reply) => {
    await deleteSession(c.pool, req.cookies[SESSION_COOKIE]!);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: c.guard('read') }, async (req) => {
    const a = auth(req);
    return { user: { id: a.id, name: a.name, email: a.email, role: a.role }, permissions: [...GRANTS[a.role]], csrfToken: a.csrf };
  });

  app.post('/api/auth/change-password', { preHandler: c.guard('read'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const a = auth(req);
    const b = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).strict().parse(req.body);
    if (!(await checkCurrentPassword(c.pool, a.orgId, a.id, b.currentPassword))) throw new UserError('Current password is incorrect', 403);
    await withTx(c.pool, (tx) => setPassword(tx, a.orgId, a.id, a.id, b.newPassword, a.sessionId, c.config.scryptCost));
    return { ok: true };
  });

  app.get('/api/users', { preHandler: c.guard('users:manage') }, async (req) => ({ users: await listUsers(c.pool, auth(req).orgId) }));

  app.post('/api/users', { preHandler: c.guard('users:manage') }, async (req, reply) => {
    const a = auth(req);
    const b = z.object({ name: z.string().min(1).max(200), email: z.email().max(320), role: Role, password: z.string().max(256) }).strict().parse(req.body);
    const id = await withTx(c.pool, (tx) => createUser(tx, a.orgId, b, c.config.scryptCost));
    return reply.code(201).send({ id });
  });

  app.patch('/api/users/:id', { preHandler: c.guard('users:manage') }, async (req) => {
    const a = auth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ role: Role.optional(), active: z.boolean().optional(), name: z.string().min(1).max(200).optional() }).strict().parse(req.body);
    if (id === a.id && (b.active === false || (b.role && b.role !== a.role))) throw new UserError('You cannot change your own role or deactivate yourself');
    await withTx(c.pool, (tx) => updateUser(tx, a.orgId, a.id, id, b));
    return { ok: true };
  });

  app.post('/api/users/:id/password', { preHandler: c.guard('users:manage') }, async (req) => {
    const a = auth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ newPassword: z.string().max(256) }).strict().parse(req.body);
    await withTx(c.pool, (tx) => setPassword(tx, a.orgId, a.id, id, b.newPassword, id === a.id ? a.sessionId : undefined, c.config.scryptCost));
    return { ok: true };
  });

  app.get("/api/settings/email", { preHandler: c.guard("settings:view") }, async (req) => ({
    configured: !!c.email, provider: c.email?.id ?? null, warnings: c.email?.warnings ?? [], jobs: await getJobStats(c.pool, auth(req).orgId), worker: await getWorkerStatus(c.pool), webhooksConfigured: !!(c.config.webhook.token || c.config.webhook.signingSecret), storage: c.files.kind,
    whatsapp: c.whatsapp ? { configured: true, provider: c.whatsapp.id, templates: c.whatsapp.templates, includeSummary: c.whatsapp.includeSummary, warnings: c.whatsapp.warnings,
      webhooksConfigured: c.whatsapp.id === 'meta' ? !!(c.whatsapp.webhook.metaAppSecret && c.whatsapp.webhook.metaVerifyToken) : !!c.whatsapp.webhook.twilioAuthToken } : { configured: false },
  }));
}
