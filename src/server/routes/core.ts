import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.ts';
import { UserError } from '../../errors.ts';
import { createExpense, deleteExpense, getExpense, listExpenses, reverseExpense, updateExpense } from '../../repo/expenses.ts';
import { listCategories } from '../../repo/orgs.ts';
import { createOwner, getOwner, listOwners, updateOwner } from '../../repo/owners.ts';
import { getPeriod } from '../../repo/periods.ts';
import { createProperty, getProperty, listProperties, listRules, setCommissionRule, updateProperty } from '../../repo/properties.ts';
import { deleteReceipt, readReceipt, uploadReceipt } from '../../services/receipts.ts';
import { listReceipts } from '../../repo/receipts.ts';
import { RECEIPT_THRESHOLD_CENTS } from '../../accounting/exceptions.ts';
import { auth } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Id = z.object({ id: z.uuid() });
const Ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Date10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Cents = z.number().int().safe();
const opt = <T extends z.ZodType>(t: T) => t.nullable().optional();

const OwnerBody = z.object({
  legalName: z.string().min(1).max(200), displayName: z.string().min(1).max(200), email: opt(z.string().max(320)), secondaryEmail: opt(z.string().max(320)),
  emailEnabled: z.boolean().optional(), phone: opt(z.string().max(40)), whatsappPhone: opt(z.string().max(20)), whatsappEnabled: z.boolean().optional(), whatsappOptIn: z.boolean().optional(),
  mailingAddress: opt(z.string().max(500)), taxReportingName: opt(z.string().max(200)), taxIdStatus: z.enum(['NOT_COLLECTED', 'ON_FILE_EXTERNALLY', 'REQUESTED']).optional(),
  notes: opt(z.string().max(5000)), active: z.boolean().optional(),
}).strict();

const PropertyBody = z.object({
  name: z.string().min(1).max(200), ownerId: z.uuid(), address: z.string().max(300).optional(), city: z.string().max(100).optional(), state: z.string().max(50).optional(),
  zip: z.string().max(20).optional(), airbnbListingId: opt(z.string().max(100)), airbnbListingName: opt(z.string().max(300)),
  managementStartDate: opt(Date10), managementEndDate: opt(Date10), notes: opt(z.string().max(5000)),
}).strict();

const RuleBody = z.object({
  type: z.enum(['PERCENT_GROSS', 'PERCENT_NET', 'FIXED', 'HYBRID']), rateBps: z.number().int().min(0).max(10000), fixedCents: Cents.min(0).default(0),
  includeCleaningFees: z.boolean().default(true), excludeTaxes: z.boolean().default(false), hybridBasis: z.enum(['GROSS', 'NET']).default('NET'), effectiveFrom: Date10,
}).strict();

const ExpenseBody = z.object({
  propertyId: z.uuid(), date: Date10, vendor: z.string().min(1).max(200), description: z.string().max(1000).optional(), category: z.string().min(1).max(100),
  amountCents: Cents, taxCents: Cents.optional(), paymentMethod: z.string().max(50).optional(), reimbursable: z.boolean().optional(), ownerPaid: z.boolean().optional(),
  recurring: z.boolean().optional(), notes: z.string().max(2000).optional(), accountingMonth: Ym.optional(),
}).strict();

export async function coreRoutes(app: FastifyInstance, c: Ctx) {
  const g = c.guard;

  app.get('/api/owners', { preHandler: g('read') }, async (req) => ({ owners: await listOwners(c.pool, auth(req).orgId) }));
  app.get('/api/owners/:id', { preHandler: g('read') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const owner = await getOwner(c.pool, a.orgId, id);
    if (!owner) throw new UserError('Owner not found');
    return { owner, properties: (await listProperties(c.pool, a.orgId)).filter((p) => p.ownerId === id) };
  });
  app.post('/api/owners', { preHandler: g('owners:write') }, async (req, reply) => {
    const a = auth(req); const b = OwnerBody.parse(req.body);
    return reply.code(201).send({ id: await withTx(c.pool, (tx) => createOwner(tx, a.orgId, a.id, b as any)) });
  });
  app.patch('/api/owners/:id', { preHandler: g('owners:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params); const b = OwnerBody.partial().parse(req.body);
    return { owner: await withTx(c.pool, (tx) => updateOwner(tx, a.orgId, a.id, id, b as any)) };
  });

  app.get('/api/properties', { preHandler: g('read') }, async (req) => ({ properties: await listProperties(c.pool, auth(req).orgId) }));
  app.get('/api/properties/:id', { preHandler: g('read') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const property = await getProperty(c.pool, a.orgId, id);
    if (!property) throw new UserError('Property not found');
    return { property, commissionRules: await listRules(c.pool, id) };
  });
  app.post('/api/properties', { preHandler: g('properties:write') }, async (req, reply) => {
    const a = auth(req); const b = PropertyBody.parse(req.body);
    return reply.code(201).send({ id: await withTx(c.pool, (tx) => createProperty(tx, a.orgId, a.id, b as any)) });
  });
  app.patch('/api/properties/:id', { preHandler: g('properties:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = PropertyBody.omit({ ownerId: true }).partial().extend({ active: z.boolean().optional() }).strict().parse(req.body);
    return { property: await withTx(c.pool, (tx) => updateProperty(tx, a.orgId, a.id, id, b as any)) };
  });
  app.post('/api/properties/:id/commission-rules', { preHandler: g('commission:write') }, async (req, reply) => {
    const a = auth(req); const { id } = Id.parse(req.params); const b = RuleBody.parse(req.body);
    return reply.code(201).send({ id: await withTx(c.pool, (tx) => setCommissionRule(tx, a.orgId, a.id, id, b)) });
  });

  app.get('/api/expense-categories', { preHandler: g('read') }, async (req) => ({ categories: await listCategories(c.pool, auth(req).orgId) }));
  app.get('/api/expenses', { preHandler: g('read') }, async (req) => {
    const a = auth(req);
    const q = z.object({ ym: Ym.optional(), propertyId: z.uuid().optional(), ownerId: z.uuid().optional() }).parse(req.query);
    let periodId: string | undefined;
    if (q.ym) {
      const p = await getPeriod(c.pool, a.orgId, +q.ym.slice(0, 4), +q.ym.slice(5));
      if (!p) return { expenses: [], totals: { chargedCents: 0, ownerPaidCents: 0 }, receiptThresholdCents: RECEIPT_THRESHOLD_CENTS };
      periodId = p.id;
    }
    const expenses = await listExpenses(c.pool, a.orgId, { periodId, propertyId: q.propertyId, ownerId: q.ownerId });
    const tot = (paid: boolean) => expenses.filter((e) => e.ownerPaid === paid).reduce((acc, e) => acc + e.amountCents + e.taxCents, 0);
    return { expenses, totals: { chargedCents: tot(false), ownerPaidCents: tot(true) }, receiptThresholdCents: RECEIPT_THRESHOLD_CENTS };
  });
  app.get('/api/expenses/:id', { preHandler: g('read') }, async (req) => {
    const a = auth(req);
    const e = await getExpense(c.pool, a.orgId, Id.parse(req.params).id);
    if (!e) throw new UserError('Expense not found');
    return { expense: e, receipts: (await listReceipts(c.pool, a.orgId, e.id)).map(({ storageKey: _k, ...r }) => r) };
  });
  app.post('/api/expenses', { preHandler: g('expenses:write') }, async (req, reply) => {
    const a = auth(req); const b = ExpenseBody.parse(req.body);
    return reply.code(201).send({ id: await withTx(c.pool, (tx) => createExpense(tx, a.orgId, a.id, b)) });
  });
  app.patch('/api/expenses/:id', { preHandler: g('expenses:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = ExpenseBody.pick({ vendor: true, description: true, category: true, amountCents: true, taxCents: true, ownerPaid: true, notes: true, reimbursable: true }).partial().strict().parse(req.body);
    await withTx(c.pool, (tx) => updateExpense(tx, a.orgId, a.id, id, b));
    return { ok: true };
  });
  app.delete('/api/expenses/:id', { preHandler: g('expenses:write') }, async (req) => {
    const a = auth(req);
    const keys = await withTx(c.pool, (tx) => deleteExpense(tx, a.orgId, a.id, Id.parse(req.params).id));
    for (const k of keys) await c.files.delete(k).catch(() => {}); // after commit; a leftover blob is harmless
    return { ok: true };
  });
  app.post('/api/expenses/:id/reverse', { preHandler: g('expenses:write') }, async (req, reply) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = z.object({ intoMonth: Ym, reason: z.string().min(3).max(500) }).strict().parse(req.body);
    return reply.code(201).send({ id: await withTx(c.pool, (tx) => reverseExpense(tx, a.orgId, a.id, id, b.intoMonth, b.reason)) });
  });

  // Raw-body upload (PDF/PNG/JPEG/WebP, <=10 MB). Auth runs in onRequest so an unauthenticated client is refused before the body is read.
  app.put('/api/expenses/:id/receipt', { onRequest: g('expenses:write'), bodyLimit: 10 * 1024 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const { filename } = z.object({ filename: z.string().max(300).optional() }).parse(req.query);
    const r = await uploadReceipt(c.pool, c.files, a.orgId, a.id, id, filename, req.body as Buffer);
    return reply.code(201).send({ receipt: r });
  });
  app.get('/api/receipts/:id', { preHandler: g('read') }, async (req, reply) => {
    const { att, bytes } = await readReceipt(c.pool, c.files, auth(req).orgId, Id.parse(req.params).id);
    // Always a download, with sniffing disabled: an uploaded file can never be rendered as a page in our origin.
    return reply.header('content-type', att.contentType).header('content-disposition', `attachment; filename="${att.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")}"`)
      .header('x-content-type-options', 'nosniff').send(bytes);
  });
  app.get('/api/receipts/:id/preview', { preHandler: g('read') }, async (req, reply) => {
    const { att, bytes } = await readReceipt(c.pool, c.files, auth(req).orgId, Id.parse(req.params).id);
    if (!att.contentType.startsWith('image/')) throw new UserError('Preview is only available for images', 415);
    return reply.header('content-type', att.contentType).header('content-disposition', 'inline').header('x-content-type-options', 'nosniff').send(bytes);
  });
  app.delete('/api/receipts/:id', { preHandler: g('expenses:write') }, async (req) => {
    const a = auth(req);
    await deleteReceipt(c.pool, c.files, a.orgId, a.id, Id.parse(req.params).id);
    return { ok: true };
  });
}
