import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { annualOwnerCsv, managerCommissionCsv, monthlyStatementCsv, monthlyTransactionCsv } from '../../export/csv.ts';
import { UserError } from '../../errors.ts';
import { getDashboard } from '../../repo/dashboard.ts';
import { listAudit, verifyAuditChain } from '../../repo/audit.ts';
import { listDeliveries } from '../../repo/deliveries.ts';
import { getPeriod, listPeriods, monthRange } from '../../repo/periods.ts';
import { loadStatementDoc, statementPdf, annualDoc, annualPdf } from '../../services/documents.ts';
import { getStatementFiles } from '../../repo/statements.ts';
import { listAllDeliveries } from '../../repo/deliveries.ts';
import { listImportBatches, listRevenue } from '../../repo/earnings.ts';
import { loadStatements, type StatementStatus } from '../../repo/statements.ts';
import { confirmCsvImport, previewCsvImport } from '../../services/import.ts';
import { finalizePeriod, generateStatements } from '../../services/close.ts';
import { queueStatementDelivery } from '../../services/send.ts';
import { auth } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Id = z.object({ id: z.uuid() });
const split = (ym: string) => ({ year: +ym.slice(0, 4), month: +ym.slice(5) });
const CsvBody = z.object({ filename: z.string().min(1).max(255), csv: z.string().min(1).max(10 * 1024 * 1024) });
const STATUSES = ['DRAFT', 'REVIEW', 'FINALIZED', 'LOCKED'] as const;

const summary = (s: Awaited<ReturnType<typeof loadStatements>>[number]) => ({
  id: s.id, statementNumber: s.statementNumber, status: s.status, ownerId: s.ownerId, ownerName: s.ownerName, propertyId: s.propertyId, propertyName: s.propertyName,
  year: s.statement.year, month: s.statement.month, netPayoutCents: s.statement.revenue.netPayoutCents, expensesCents: s.statement.expensesCents,
  commissionCents: s.statement.commission.commissionCents, ownerProceedsCents: s.statement.ownerProceedsCents, finalizedAt: s.finalizedAt,
});

export async function accountingRoutes(app: FastifyInstance, c: Ctx) {
  const g = c.guard;

  app.post('/api/imports/preview', { preHandler: g('import:write') }, async (req) => {
    const b = CsvBody.parse(req.body);
    const p = await previewCsvImport(c.pool, auth(req).orgId, b.filename, b.csv);
    return { ...p, rows: p.rows.map((r) => ({ status: r.status, propertyId: r.propertyId, record: r.record })) };
  });
  app.post('/api/imports/confirm', { preHandler: g('import:write') }, async (req) => {
    const a = auth(req);
    const b = CsvBody.extend({ confirmed: z.literal(true, { error: 'Import must be explicitly confirmed' }) }).strict().parse(req.body);
    return confirmCsvImport(c.pool, a.orgId, a.id, b.filename, b.csv, b.confirmed);
  });

  app.get('/api/periods', { preHandler: g('read') }, async (req) => ({ periods: await listPeriods(c.pool, auth(req).orgId) }));
  app.get('/api/periods/:ym', { preHandler: g('read') }, async (req) => {
    const a = auth(req); const { ym } = z.object({ ym: Ym }).parse(req.params); const { year, month } = split(ym);
    const period = await getPeriod(c.pool, a.orgId, year, month);
    const statements = period ? (await loadStatements(c.pool, a.orgId, { periodId: period.id })).map(summary) : [];
    const t = (k: 'netPayoutCents' | 'expensesCents' | 'commissionCents' | 'ownerProceedsCents') => statements.reduce((acc, x) => acc + x[k], 0);
    return { period, statements, totals: { netPayoutCents: t('netPayoutCents'), expensesCents: t('expensesCents'), commissionCents: t('commissionCents'), ownerProceedsCents: t('ownerProceedsCents') } };
  });
  app.post('/api/periods/:ym/generate', { preHandler: g('period:review') }, async (req) => {
    const a = auth(req); const { year, month } = split(z.object({ ym: Ym }).parse(req.params).ym);
    const r = await generateStatements(c.pool, a.orgId, a.id, year, month);
    return { period: r.period, exceptions: r.exceptions, statements: r.statements.map((s) => ({ id: s.id, propertyId: s.statement.propertyId, ownerProceedsCents: s.statement.ownerProceedsCents, derivation: s.statement.derivation })) };
  });
  app.post('/api/periods/:ym/finalize', { preHandler: g('period:finalize') }, async (req) => {
    const a = auth(req); const { year, month } = split(z.object({ ym: Ym }).parse(req.params).ym);
    const b = z.object({ acknowledgeCritical: z.boolean().optional() }).strict().parse(req.body ?? {});
    return finalizePeriod(c.pool, a.orgId, a.id, year, month, b);
  });

  app.get('/api/statements', { preHandler: g('read') }, async (req) => {
    const q = z.object({ ym: Ym.optional(), ownerId: z.uuid().optional(), propertyId: z.uuid().optional(), status: z.enum(STATUSES).optional() }).parse(req.query);
    const a = auth(req);
    let periodId: string | undefined;
    if (q.ym) { const p = await getPeriod(c.pool, a.orgId, +q.ym.slice(0, 4), +q.ym.slice(5)); if (!p) return { statements: [] }; periodId = p.id; }
    return { statements: (await loadStatements(c.pool, a.orgId, { periodId, ownerId: q.ownerId, propertyId: q.propertyId, statuses: q.status ? [q.status] : undefined })).map(summary) };
  });
  app.get('/api/statements/:id', { preHandler: g('read') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const d = await loadStatementDoc(c.pool, a.orgId, id);
    if (!d) throw new UserError('Statement not found');
    const files = await getStatementFiles(c.pool, a.orgId, id);
    return {
      statement: { ...summary(d.stored), detail: d.stored.statement, generatedAt: d.stored.generatedAt },
      ytd: d.ytd, organization: d.organization, property: d.property, owner: d.owner, disclaimer: d.disclaimer,
      deliveries: await listDeliveries(c.pool, id),
      files: { pdfArchived: !!files.pdf, pdfSha256: files.pdf?.sha256 ?? null, pdfBytes: files.pdf?.sizeBytes ?? null },
    };
  });
  app.get('/api/statements/:id/pdf', { preHandler: g('read') }, async (req, reply) => {
    const a = auth(req);
    const f = await statementPdf(c.pool, c.files, a.orgId, Id.parse(req.params).id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${f.filename}"`).send(f.bytes);
  });
  app.get('/api/statements/:id/csv', { preHandler: g('read') }, async (req, reply) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const [s] = await loadStatements(c.pool, a.orgId, { id });
    if (!s) throw new UserError('Statement not found');
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${s.statementNumber}.csv"`)
      .send(monthlyStatementCsv([{ ownerName: s.ownerName, propertyName: s.propertyName, statement: s.statement }]));
  });
  app.post('/api/statements/:id/send', { preHandler: g('statements:send') }, async (req, reply) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = z.object({ resend: z.boolean().optional() }).strict().parse(req.body ?? {});
    const r = await queueStatementDelivery(c.pool, a.orgId, a.id, id, { resend: b.resend, emailAvailable: !!c.email, whatsappAvailable: false });
    return reply.code(202).send({ queued: r.planned, deliveryIds: r.deliveryIds });
  });

  const csv = (reply: any, name: string, body: string) => reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(body);
  const exportStatements = async (req: any) => {
    const a = auth(req);
    const q = z.object({ ym: Ym, includeDrafts: z.enum(['true', 'false']).optional() }).parse(req.query);
    const p = await getPeriod(c.pool, a.orgId, +q.ym.slice(0, 4), +q.ym.slice(5));
    if (!p) throw new UserError('Period not found');
    const statuses: StatementStatus[] = q.includeDrafts === 'true' ? [...STATUSES] : ['FINALIZED', 'LOCKED'];
    return { ym: q.ym, rows: (await loadStatements(c.pool, a.orgId, { periodId: p.id, statuses })).map((s) => ({ ownerName: s.ownerName, propertyName: s.propertyName, statement: s.statement })) };
  };
  app.get('/api/exports/monthly-statements.csv', { preHandler: g('read') }, async (req, reply) => { const e = await exportStatements(req); return csv(reply, `statements-${e.ym}.csv`, monthlyStatementCsv(e.rows)); });
  app.get('/api/exports/commissions.csv', { preHandler: g('read') }, async (req, reply) => { const e = await exportStatements(req); return csv(reply, `commissions-${e.ym}.csv`, managerCommissionCsv(e.rows)); });
  app.get('/api/exports/transactions.csv', { preHandler: g('read') }, async (req, reply) => { const e = await exportStatements(req); return csv(reply, `transactions-${e.ym}.csv`, monthlyTransactionCsv(e.rows)); });
  app.get('/api/exports/annual.csv', { preHandler: g('read') }, async (req, reply) => {
    const a = auth(req);
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100), ownerId: z.uuid(), propertyId: z.uuid().optional() }).parse(req.query);
    const rows = await loadStatements(c.pool, a.orgId, { year: q.year, ownerId: q.ownerId, propertyId: q.propertyId, statuses: ['FINALIZED', 'LOCKED'] });
    return csv(reply, `annual-${q.year}.csv`, annualOwnerCsv(q.year, rows.map((s) => s.statement)));
  });

  app.get('/api/revenue', { preHandler: g('read') }, async (req) => {
    const q = z.object({ ym: Ym, propertyId: z.uuid().optional() }).parse(req.query);
    const { start, end } = monthRange(+q.ym.slice(0, 4), +q.ym.slice(5));
    const rows = await listRevenue(c.pool, auth(req).orgId, { start, end, propertyId: q.propertyId });
    const t = (k: 'grossBookingCents' | 'cleaningFeeCents' | 'platformFeeCents' | 'taxCents' | 'adjustmentCents' | 'refundCents' | 'netPayoutCents') => rows.reduce((a, x) => a + x[k], 0);
    return { rows, totals: { grossBookingCents: t('grossBookingCents'), cleaningFeeCents: t('cleaningFeeCents'), platformFeeCents: t('platformFeeCents'), taxCents: t('taxCents'), adjustmentCents: t('adjustmentCents'), refundCents: t('refundCents'), netPayoutCents: t('netPayoutCents') } };
  });
  app.get('/api/imports', { preHandler: g('read') }, async (req) => ({ batches: await listImportBatches(c.pool, auth(req).orgId) }));
  app.get('/api/deliveries', { preHandler: g('read') }, async (req) => {
    const q = z.object({ status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { deliveries: await listAllDeliveries(c.pool, auth(req).orgId, q) };
  });
  const AnnualQ = z.object({ year: z.coerce.number().int().min(2000).max(2100), ownerId: z.uuid(), propertyId: z.uuid().optional() });
  app.get('/api/annual', { preHandler: g('read') }, async (req) => {
    const q = AnnualQ.parse(req.query);
    const d = await annualDoc(c.pool, auth(req).orgId, q.year, q.ownerId, q.propertyId);
    return { organization: d.organization, owner: { id: d.owner.id, displayName: d.owner.displayName, legalName: d.owner.legalName }, properties: d.properties, report: d.report };
  });
  app.get('/api/annual.pdf', { preHandler: g('read') }, async (req, reply) => {
    const q = AnnualQ.parse(req.query);
    const bytes = await annualPdf(c.pool, auth(req).orgId, q.year, q.ownerId, q.propertyId, c.now().toISOString());
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="annual-statement-${q.year}.pdf"`).send(bytes);
  });

  app.get('/api/dashboard', { preHandler: g('read') }, async (req) => {
    const q = z.object({ ym: Ym.optional() }).parse(req.query);
    const d = c.now(); const ym = q.ym ?? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { ym, ...(await getDashboard(c.pool, auth(req).orgId, +ym.slice(0, 4), +ym.slice(5))) };
  });

  app.get('/api/audit', { preHandler: g('audit:read') }, async (req) => {
    const q = z.object({ entityType: z.string().max(60).optional(), entityId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { entries: await listAudit(c.pool, auth(req).orgId, q) };
  });
  app.get('/api/audit/verify', { preHandler: g('audit:read') }, async (req) => {
    const broken = await verifyAuditChain(c.pool, auth(req).orgId);
    return { intact: broken === null, firstBrokenId: broken };
  });
}
