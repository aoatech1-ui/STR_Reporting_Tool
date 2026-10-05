import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.ts';
import { UserError } from '../../errors.ts';
import { createRecurring, deleteRecurring, getRecurring, listPostings, listRecurring, monthLabel, postDue, skipOccurrence, unskipOccurrence, updateRecurring, upcomingFor } from '../../repo/recurring.ts';
import { orgToday } from '../../services/recurring.ts';
import { auth } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Id = z.object({ id: z.uuid() });
const Ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Body = z.object({
  propertyId: z.uuid(), vendor: z.string().min(1).max(200), description: z.string().max(500).nullable().optional(), category: z.string().min(1).max(100),
  amountCents: z.number().int().refine((v) => v !== 0, 'cannot be zero').refine((v) => Math.abs(v) <= 100_000_000, 'is too large'),
  taxCents: z.number().int().min(-100_000_000).max(100_000_000).optional(), ownerPaid: z.boolean().optional(), reimbursable: z.boolean().optional(),
  paymentMethod: z.string().max(100).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  intervalMonths: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]), dayOfMonth: z.number().int().min(1).max(31),
  startMonth: Ym, endMonth: Ym.nullable().optional(),
}).strict();
const split = (ym: string) => ({ year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) });

export async function recurringRoutes(app: FastifyInstance, c: Ctx) {
  const today = (orgId: string) => orgToday(c.pool, orgId, c.now());

  app.get('/api/recurring-expenses', { preHandler: c.guard('read') }, async (req) => {
    const a = auth(req);
    const q = z.object({ propertyId: z.uuid().optional() }).parse(req.query);
    const t = await today(a.orgId);
    const rows = await listRecurring(c.pool, a.orgId, q);
    const last = new Map((await c.pool.query(
      `SELECT DISTINCT ON (recurring_expense_id) recurring_expense_id, year, month, status, expense_id FROM recurring_expense_postings WHERE organization_id=$1
       ORDER BY recurring_expense_id, year DESC, month DESC`, [a.orgId])).rows.map((x) => [x.recurring_expense_id, x]));
    return {
      today: t,
      recurring: rows.map((r) => {
        const l = last.get(r.id);
        return { ...r, next: upcomingFor(r, t, 1)[0]?.date ?? null, last: l ? { month: monthLabel(l.year, l.month), status: l.status, expenseId: l.expense_id } : null };
      }),
      monthlyEquivalentCents: rows.filter((r) => r.active && !r.ownerPaid).reduce((s, r) => s + Math.round((r.amountCents + r.taxCents) / r.intervalMonths), 0),
    };
  });

  app.get('/api/recurring-expenses/:id', { preHandler: c.guard('read') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const r = await getRecurring(c.pool, a.orgId, id);
    if (!r) throw new UserError('Recurring expense not found');
    const t = await today(a.orgId);
    const postings = await listPostings(c.pool, a.orgId, id);
    const handled = new Set(postings.map((p) => `${p.year}-${p.month}`));
    return {
      recurring: r, today: t,
      postings: postings.map((p) => ({ ...p, monthLabel: monthLabel(p.year, p.month), ym: `${p.year}-${String(p.month).padStart(2, '0')}` })),
      upcoming: upcomingFor(r, t, 6).map((o) => ({ ...o, monthLabel: monthLabel(o.year, o.month), ym: o.date.slice(0, 7), skipped: handled.has(`${o.year}-${o.month}`) })),
    };
  });

  app.post('/api/recurring-expenses', { preHandler: c.guard('expenses:write') }, async (req, reply) => {
    const a = auth(req); const b = Body.parse(req.body);
    const t = await today(a.orgId);
    const id = await withTx(c.pool, (tx) => createRecurring(tx, a.orgId, a.id, { ...b, endMonth: b.endMonth ?? null }, t));
    // Anything already due (this month's, if its day has passed; or earlier months when starting in the past) is posted right away.
    const res = await postDue(c.pool, a.orgId, t, a.id);
    return reply.code(201).send({ id, ...res });
  });

  app.patch('/api/recurring-expenses/:id', { preHandler: c.guard('expenses:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = Body.partial().extend({ active: z.boolean().optional() }).strict().parse(req.body);
    const t = await today(a.orgId);
    await withTx(c.pool, (tx) => updateRecurring(tx, a.orgId, a.id, id, b, t));
    return { ok: true, ...(await postDue(c.pool, a.orgId, t, a.id)) };
  });

  app.delete('/api/recurring-expenses/:id', { preHandler: c.guard('expenses:write') }, async (req) => {
    const a = auth(req);
    await withTx(c.pool, (tx) => deleteRecurring(tx, a.orgId, a.id, Id.parse(req.params).id));
    return { ok: true };
  });

  app.post('/api/recurring-expenses/:id/skip', { preHandler: c.guard('expenses:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const b = z.object({ month: Ym, reason: z.string().max(300).optional() }).strict().parse(req.body);
    const { year, month } = split(b.month);
    await withTx(c.pool, (tx) => skipOccurrence(tx, a.orgId, a.id, id, year, month, b.reason));
    return { ok: true };
  });

  app.post('/api/recurring-expenses/:id/unskip', { preHandler: c.guard('expenses:write') }, async (req) => {
    const a = auth(req); const { id } = Id.parse(req.params);
    const { year, month } = split(z.object({ month: Ym }).strict().parse(req.body).month);
    await withTx(c.pool, (tx) => unskipOccurrence(tx, a.orgId, a.id, id, year, month));
    return { ok: true, ...(await postDue(c.pool, a.orgId, await today(a.orgId), a.id)) };
  });

  /** "Post due now": what the worker does every minute, for when it is not running. */
  app.post('/api/recurring-expenses/run', { preHandler: c.guard('expenses:write') }, async (req) => {
    const a = auth(req);
    return postDue(c.pool, a.orgId, await today(a.orgId), a.id);
  });
}
