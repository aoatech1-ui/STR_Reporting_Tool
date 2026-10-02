import type { FastifyInstance } from 'fastify';
import { monthlyStatementCsv } from '../../export/csv.ts';
import { withTx } from '../../db/pool.ts';
import { STATEMENT_DISCLAIMER } from '../../accounting/statement.ts';
import { verifyLink } from '../../delivery/links.ts';
import { parseEmailWebhook, WebhookAuthError } from '../../email/webhooks.ts';
import { appendAudit } from '../../repo/audit.ts';
import { applyDeliveryWebhook } from '../../repo/deliveries.ts';
import { loadStatementDoc, statementPdf } from '../../services/documents.ts';
import { getOrganization } from '../../repo/orgs.ts';
import { loadStatements, statementOrg } from '../../repo/statements.ts';
import type { Ctx } from '../app.ts';

export async function publicRoutes(app: FastifyInstance, c: Ctx) {
  app.get('/healthz', { logLevel: 'warn', config: { rateLimit: false } }, async (_req, reply) => {
    try { await c.pool.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  // Owner-facing signed link: unguessable (HMAC), expiring, view-only, rate limited, every view audited.
  async function resolve(token: string) {
    const v = verifyLink(token, c.config.linkSecret, c.now().getTime());
    if (!v.ok) return null;
    const orgId = await statementOrg(c.pool, v.statementId);
    if (!orgId) return null;
    const [s] = await loadStatements(c.pool, orgId, { id: v.statementId, statuses: ['FINALIZED', 'LOCKED'] });
    return s ? { orgId, s } : null;
  }
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get('/s/:token', { config: limit }, async (req, reply) => {
    const r = await resolve((req.params as { token: string }).token);
    if (!r) return reply.code(404).send({ error: 'This link is invalid or has expired' });
    await withTx(c.pool, (tx) => appendAudit(tx, r.orgId, { userId: null, action: 'STATEMENT_VIEWED', entityType: 'owner_statement', entityId: r.s.id, oldValue: null, newValue: null, meta: { ip: req.ip } }));
    reply.header('x-robots-tag', 'noindex');
    const d = (await loadStatementDoc(c.pool, r.orgId, r.s.id, ['FINALIZED', 'LOCKED']))!;
    return { organization: d.organization.displayName, ytd: d.ytd, statementNumber: d.stored.statementNumber, owner: d.stored.ownerName, property: d.stored.propertyName,
      year: d.stored.statement.year, month: d.stored.statement.month, statement: d.stored.statement, disclaimer: d.disclaimer };
  });
  app.get('/s/:token/pdf', { config: limit }, async (req, reply) => {
    const r = await resolve((req.params as { token: string }).token);
    if (!r) return reply.code(404).send({ error: 'This link is invalid or has expired' });
    const f = await statementPdf(c.pool, c.files, r.orgId, r.s.id, ['FINALIZED', 'LOCKED']);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${f.filename}"`).header('x-robots-tag', 'noindex').send(f.bytes);
  });
  app.get('/s/:token/csv', { config: limit }, async (req, reply) => {
    const r = await resolve((req.params as { token: string }).token);
    if (!r) return reply.code(404).send({ error: 'This link is invalid or has expired' });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.s.statementNumber}.csv"`)
      .send(monthlyStatementCsv([{ ownerName: r.s.ownerName, propertyName: r.s.propertyName, statement: r.s.statement }]));
  });

  // Provider delivery-status callbacks. Raw body is needed for signature verification, so this scope parses JSON as a string.
  await app.register(async (w) => {
    w.addContentTypeParser(['application/json', 'application/*+json', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));
    w.post('/webhooks/email/:provider', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const provider = (req.params as { provider: string }).provider;
      if (!c.email || c.email.id !== provider) return reply.code(404).send({ error: 'Not found' });
      let events;
      try {
        events = parseEmailWebhook(provider, { headers: req.headers, query: req.query as Record<string, string>, rawBody: String(req.body ?? '') }, c.config.webhook, c.now().getTime());
      } catch (e) {
        if (e instanceof WebhookAuthError) return reply.code(401).send({ error: 'Unauthorized' });
        throw e;
      }
      let applied = 0;
      for (const ev of events) if (await withTx(c.pool, (tx) => applyDeliveryWebhook(tx, ev.messageId, ev.status, ev.reason))) applied++;
      return { received: events.length, applied };
    });
  });
}
