import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Pool } from '../db/pool.ts';
import type { EmailSetup } from '../email/factory.ts';
import { UserError } from '../errors.ts';
import type { AppConfig } from './config.ts';
import { makeGuard } from './guard.ts';
import { accountingRoutes } from './routes/accounting.ts';
import { authRoutes } from './routes/auth.ts';
import { coreRoutes } from './routes/core.ts';
import { publicRoutes } from './routes/public.ts';

export interface AppDeps { pool: Pool; config: AppConfig; email: EmailSetup | null; now?: () => Date; logger?: boolean }
export type Ctx = { pool: Pool; config: AppConfig; email: EmailSetup | null; now: () => Date; guard: ReturnType<typeof makeGuard> };

const PG_STATUS: Record<string, [number, string]> = {
  '23505': [409, 'A record with these details already exists'], '23503': [409, 'This record is referenced by, or references, another record'],
  '23514': [422, 'A value is out of range'], '23502': [422, 'A required value is missing'], '22P02': [422, 'A value has the wrong format'],
  '40P01': [409, 'Conflicting update, please retry'], '40001': [409, 'Conflicting update, please retry'],
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] } : false,
    trustProxy: deps.config.trustProxy, bodyLimit: 12 * 1024 * 1024 });
  const ctx: Ctx = { pool: deps.pool, config: deps.config, email: deps.email, now, guard: makeGuard({ pool: deps.pool, config: deps.config, now }) };

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (deps.config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store'); // financial data is never cached
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message });
    if (err?.code && PG_STATUS[err.code]) { const [s, m] = PG_STATUS[err.code]; return reply.code(s).send({ error: m }); }
    if (err?.code === 'P0001') return reply.code(422).send({ error: String(err.message) }); // raised by our DB integrity triggers
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.statusCode === 429 ? 'Too many requests' : err.message });
    req.log.error({ err: { message: err?.message, code: err?.code } }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));

  await app.register(async (a) => { await authRoutes(a, ctx); await coreRoutes(a, ctx); await accountingRoutes(a, ctx); });
  await app.register(async (a) => publicRoutes(a, ctx));
  return app;
}
