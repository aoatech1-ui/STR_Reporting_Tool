import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.ts';
import { getWorkerStatus } from '../../repo/ops.ts';
import { getMyReminderPreference, getReminderSettings, listReminderRuns, monthEndStatus, reminderRecipients, saveReminderSettings, setMyReminderPreference } from '../../repo/reminders.ts';
import { checklist, isComplete } from '../../reminders/compose.ts';
import { localDate, monthLabel, offsetLabel, upcoming } from '../../reminders/schedule.ts';
import { queueTestReminder } from '../../services/reminders.ts';
import { auth } from '../guard.ts';
import type { Ctx } from '../app.ts';

const Role = z.enum(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER']);
const YM = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export async function reminderRoutes(app: FastifyInstance, c: Ctx) {
  const view = async (orgId: string) => {
    const settings = await getReminderSettings(c.pool, orgId);
    const now = c.now();
    return {
      settings,
      upcoming: upcoming(settings, now, 4).map((o) => ({ at: o.at.toISOString(), localDate: localDate(o.at, settings.timezone), month: monthLabel(o.year, o.month), when: offsetLabel(o.offset) })),
      runs: (await listReminderRuns(c.pool, orgId, 20)).map((r) => ({ ...r, monthLabel: monthLabel(r.year, r.month), when: r.isTest ? 'Test' : offsetLabel(r.offset) })),
      recipients: (await reminderRecipients(c.pool, orgId, settings.roles)).map((r) => ({ name: r.name, email: r.email })),
      emailConfigured: !!c.email,
      workerActive: (await getWorkerStatus(c.pool)).active > 0,
    };
  };

  app.get('/api/settings/reminders', { preHandler: c.guard('settings:view') }, async (req) => view(auth(req).orgId));

  app.put('/api/settings/reminders', { preHandler: c.guard('reminders:manage') }, async (req) => {
    const a = auth(req);
    const b = z.object({
      enabled: z.boolean(), timezone: z.string().min(1).max(64), sendHour: z.number().int().min(0).max(23),
      days: z.array(z.number().int()).max(6), dueDay: z.number().int().min(1).max(28).nullable(), roles: z.array(Role).min(1).max(4),
    }).strict().parse(req.body);
    await withTx(c.pool, (tx) => saveReminderSettings(tx, a.orgId, a.id, { ...b, roles: [...new Set(b.roles)] }, c.now()));
    return view(a.orgId);
  });

  app.post('/api/settings/reminders/test', { preHandler: c.guard('reminders:manage'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = auth(req);
    const id = await queueTestReminder(c.pool, a.orgId, a.id, c.now());
    return reply.code(202).send({ id, sendsTo: a.email });
  });

  app.get('/api/close/checklist', { preHandler: c.guard('read') }, async (req) => {
    const { ym } = z.object({ ym: YM }).parse(req.query);
    const [y, m] = ym.split('-').map(Number);
    const status = await monthEndStatus(c.pool, auth(req).orgId, y, m);
    const s = await getReminderSettings(c.pool, auth(req).orgId);
    const today = localDate(c.now(), s.timezone);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { status, complete: isComplete(status), items: checklist(status, today > lastDay) };
  });

  app.get('/api/me/preferences', { preHandler: c.guard('read') }, async (req) => ({ monthEndReminders: await getMyReminderPreference(c.pool, auth(req).id) }));
  app.put('/api/me/preferences', { preHandler: c.guard('read') }, async (req) => {
    const a = auth(req);
    const b = z.object({ monthEndReminders: z.boolean() }).strict().parse(req.body);
    await withTx(c.pool, (tx) => setMyReminderPreference(tx, a.orgId, a.id, b.monthEndReminders));
    return { monthEndReminders: b.monthEndReminders };
  });
}
