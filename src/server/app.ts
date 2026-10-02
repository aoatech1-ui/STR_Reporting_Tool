import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Pool } from '../db/pool.ts';
import { LocalDiskStore, type FileStore } from '../files/store.ts';
import type { EmailSetup } from '../email/factory.ts';
import type { WhatsAppSetup } from '../whatsapp/factory.ts';
import { UserError } from '../errors.ts';
import type { AppConfig } from './config.ts';
import { makeGuard } from './guard.ts';
import { accountingRoutes } from './routes/accounting.ts';
import { authRoutes } from './routes/auth.ts';
import { mfaRoutes } from './routes/mfa.ts';
import { coreRoutes } from './routes/core.ts';
import { publicRoutes } from './routes/public.ts';

export interface AppDeps { pool: Pool; config: AppConfig; email: EmailSetup | null; whatsapp?: WhatsAppSetup | null; now?: () => Date; logger?: boolean | { level: string }; /** Receipts and generated statement files (default: ./data/files on local disk). */ files?: FileStore; /** Built UI directory (default: web/dist). The API runs without it. */ webDir?: string }
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const API_PREFIXES = ['/api/', '/s/', '/webhooks/', '/healthz'];
const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";
// The UI is a same-origin SPA: scripts only from self (no inline/eval). Inline styles are allowed for React style props.
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export type Ctx = { pool: Pool; config: AppConfig; email: EmailSetup | null; whatsapp: WhatsAppSetup | null; files: FileStore; now: () => Date; guard: ReturnType<typeof makeGuard> };

const PG_STATUS: Record<string, [number, string]> = {
  '23505': [409, 'A record with these details already exists'], '23503': [409, 'This record is referenced by, or references, another record'],
  '23514': [422, 'A value is out of range'], '23502': [422, 'A required value is missing'], '22P02': [422, 'A value has the wrong format'],
  '40P01': [409, 'Conflicting update, please retry'], '40001': [409, 'Conflicting update, please retry'],
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ? { ...(typeof deps.logger === 'object' ? deps.logger : {}), redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] } : false,
    trustProxy: deps.config.trustProxy, bodyLimit: 12 * 1024 * 1024 });
  const ctx: Ctx = { pool: deps.pool, config: deps.config, email: deps.email, whatsapp: deps.whatsapp ?? null, files: deps.files ?? new LocalDiskStore(process.env.FILE_STORE_DIR || './data/files'), now, guard: makeGuard({ pool: deps.pool, config: deps.config, now }) };

  await app.register(cookie);
  // Receipt uploads arrive as the raw file body. Type is verified from the bytes later; this only lets the body through to the route.
  app.addContentTypeParser(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
      .header('content-security-policy', API_PREFIXES.some((p) => req.url.startsWith(p)) ? STRICT_CSP : UI_CSP);
    if (deps.config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store'); // financial data is never cached
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (err?.code && PG_STATUS[err.code]) { const [s, m] = PG_STATUS[err.code]; return reply.code(s).send({ error: m }); }
    if (err?.code === 'P0001') return reply.code(422).send({ error: String(err.message) }); // raised by our DB integrity triggers
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.statusCode === 429 ? 'Too many requests' : err.message });
    req.log.error({ err: { message: err?.message, code: err?.code } }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error' });
  });
  const webDir = deps.webDir ?? DEFAULT_WEB_DIR;
  const hasUi = existsSync(`${webDir}/index.html`);
  if (hasUi) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false, cacheControl: false,
      setHeaders: (res, path) => { res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'); } });
  }
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes (/owners, /view/:token, ...) get the SPA shell. Not for API-ish paths, file-like paths (/x.js), or clients that
    // explicitly refuse HTML. `Accept: */*` (curl, uptime monitors, link checkers) counts as willing: they must see the app, not a 404.
    const accept = String(req.headers.accept ?? '');
    const path = req.url.split('?')[0];
    const wantsHtml = accept === '' || accept.includes('text/html') || accept.includes('*/*');
    if (hasUi && req.method === 'GET' && wantsHtml && !API_PREFIXES.some((p) => req.url.startsWith(p)) && (path.startsWith('/view/') || !/\.[A-Za-z0-9]{1,8}$/.test(path))) { // owner links contain dots but are app routes
      return reply.header('cache-control', 'no-store').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  await app.register(async (a) => { await authRoutes(a, ctx); await mfaRoutes(a, ctx); await coreRoutes(a, ctx); await accountingRoutes(a, ctx); });
  await app.register(async (a) => publicRoutes(a, ctx));
  return app;
}
