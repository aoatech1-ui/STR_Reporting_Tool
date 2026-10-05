import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../src/db/pool.ts';
import type { EmailMessage, EmailProvider } from '../../src/email/types.ts';
import { EmailError } from '../../src/email/types.ts';
import { runPreflight } from '../../src/ops/preflight.ts';
import { buildApp } from '../../src/server/app.ts';
import { scheduleDueReminders } from '../../src/services/reminders.ts';
import { queueStatementDelivery } from '../../src/services/send.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import { finalizedOrg, freshDb, seed, skip, tmpStore } from './helper.ts';
import { addUser, Client, testConfig } from './httpkit.ts';

const T = (iso: string) => new Date(iso);
const NY = { enabled: true, timezone: 'America/New_York', sendHour: 9, days: [-2, 1, 5], dueDay: 10, roles: ['ADMIN', 'MANAGER'] };

describe('month-end reminders', { skip }, () => {
  let pool: Pool, close: () => Promise<void>;
  const inbox: EmailMessage[] = [];
  let failNext: ((m: EmailMessage) => Error | null) | null = null;
  const email: EmailProvider = { name: 'fake', async send(m) { const e = failNext?.(m); if (e) throw e; inbox.push(m); return { messageId: `m${inbox.length}` }; } };
  const clock = { t: T('2026-09-20T12:00:00Z') };
  const now = () => new Date(clock.t);
  let app: FastifyInstance;
  const handlers = (e: EmailProvider | null = email) => buildHandlers({ pool, files: tmpStore(), email: e, whatsapp: null, linkSecret: 'x'.repeat(40), baseUrl: 'https://app.test' });
  const drain = async (h = handlers()) => { let n = 0; while (await runOnce(pool, h, { backoffSeconds: () => 0 })) n++; return n; };
  const runs = async (orgId: string) => (await pool.query(`SELECT * FROM reminder_runs WHERE organization_id=$1 ORDER BY scheduled_for, created_at`, [orgId])).rows;

  before(async () => {
    ({ pool, close } = await freshDb());
    app = await buildApp({ pool, config: testConfig(), email: { id: 'fake', provider: email, warnings: [] }, files: tmpStore(), now });
  });
  after(async () => { await app.close(); await close(); });

  async function org(prefix: string) {
    const s = await seed(pool);
    await addUser(pool, s.orgId, 'ADMIN', `${prefix}-admin@r.test`);
    await addUser(pool, s.orgId, 'MANAGER', `${prefix}-mgr@r.test`);
    await addUser(pool, s.orgId, 'VIEWER', `${prefix}-viewer@r.test`);
    await addUser(pool, s.orgId, 'ACCOUNTANT', `${prefix}-acct@r.test`);
    return s;
  }
  const enable = async (prefix: string, at: string, body: object = NY) => {
    clock.t = T(at);
    const c = await new Client(app).login(`${prefix}-admin@r.test`);
    const r = await c.call('PUT', '/api/settings/reminders', body);
    assert.equal(r.statusCode, 200, r.body);
    return { c, view: r.json() };
  };

  test('settings: defaults, validation, permissions, audit; upcoming shows the next local times', async () => {
    const s = await org('a');
    const admin = await new Client(app).login('a-admin@r.test');
    const d = (await admin.get('/api/settings/reminders')).json();
    assert.equal(d.settings.enabled, false); assert.deepEqual(d.settings.days, [-2, 1, 5]); assert.deepEqual(d.upcoming, []);
    for (const bad of [{ ...NY, timezone: 'Mars/Base' }, { ...NY, days: [0] }, { ...NY, days: [31] }, { ...NY, days: [] }, { ...NY, sendHour: 25 }])
      assert.ok([400, 422].includes((await admin.call('PUT', '/api/settings/reminders', bad)).statusCode), JSON.stringify(bad));
    const viewer = await new Client(app).login('a-viewer@r.test');
    assert.equal((await viewer.get('/api/settings/reminders')).statusCode, 403);
    const acct = await new Client(app).login('a-acct@r.test');
    assert.equal((await acct.call('PUT', '/api/settings/reminders', NY)).statusCode, 403);
    clock.t = T('2026-10-02T12:00:00Z');
    const mgr = await new Client(app).login('a-mgr@r.test');
    const r = await mgr.call('PUT', '/api/settings/reminders', NY);
    assert.equal(r.statusCode, 200, r.body);
    const v = r.json();
    assert.deepEqual(v.upcoming.map((u: any) => [u.localDate, u.month, u.when]), [['2026-10-05', 'September 2026', '5th of the next month'], ['2026-10-30', 'October 2026', '2 days before month end'], ['2026-11-01', 'October 2026', '1st of the next month'], ['2026-11-05', 'October 2026', '5th of the next month']]);
    assert.equal(v.upcoming[0].at, '2026-10-05T13:00:00.000Z');
    assert.deepEqual(v.recipients.map((x: any) => x.email).filter((e: string) => e.endsWith('r.test')).sort(), ['a-admin@r.test', 'a-mgr@r.test']);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='REMINDER_SETTINGS_CHANGED'`, [s.orgId])).rowCount);
  });

  test('scheduler: fires at local 9:00 once, even with concurrent workers; goes to the chosen roles; respects personal opt-out', async () => {
    const s = await org('b');
    await enable('b', '2026-09-20T12:00:00Z');
    const viewer = await new Client(app).login('b-mgr@r.test');
    assert.equal((await viewer.call('PUT', '/api/me/preferences', { monthEndReminders: false })).statusCode, 200);
    assert.equal((await viewer.get('/api/me/preferences')).json().monthEndReminders, false);
    assert.equal(await scheduleDueReminders(pool, T('2026-09-29T12:59:00Z')), 0, 'not yet: 8:59 New York');
    await Promise.all([1, 2, 3].map(() => scheduleDueReminders(pool, T('2026-09-29T13:00:30Z'))));
    await scheduleDueReminders(pool, T('2026-09-29T13:05:00Z'));
    assert.equal((await runs(s.orgId)).length, 1, 'exactly one run across concurrent and repeated scheduler calls');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE organization_id=$1 AND type='send_month_end_reminder'`, [s.orgId])).rows[0].n, 1);
    inbox.length = 0;
    await drain();
    const to = inbox.map((m) => m.to[0]).sort();
    assert.ok(to.includes('b-admin@r.test') && !to.includes('b-mgr@r.test') && !to.includes('b-viewer@r.test') && !to.includes('b-acct@r.test'), to.join());
    assert.equal(inbox.find((m) => m.to[0] === 'b-admin@r.test')!.subject, 'September 2026 ends tomorrow: month-end checklist');
    assert.match(inbox[0].text, /https:\/\/app\.test\/close\?ym=2026-09/);
    const [r] = await runs(s.orgId);
    assert.equal(r.status, 'SENT'); assert.equal(r.offset_days, -2); assert.ok(r.sent_to.includes('b-admin@r.test'));
    // Oct 1: the close reminder, with the due date
    await scheduleDueReminders(pool, T('2026-10-01T13:00:00Z'));
    inbox.length = 0; await drain();
    assert.match(inbox.find((m) => m.to[0] === 'b-admin@r.test')!.subject, /^September 2026 close: \d+ items? open \(due Oct 10\)$/);
    assert.match(inbox[0].text, /Import Airbnb earnings/);
  });

  test('a finished month is skipped; reminders turned off before sending are skipped', async () => {
    const f = await finalizedOrg(pool);
    await addUser(pool, f.orgId, 'ADMIN', 'c-admin@r.test');
    await enable('c', '2026-09-20T12:00:00Z');
    await queueStatementDelivery(pool, f.orgId, f.userId, f.statementId, { emailAvailable: true, whatsappAvailable: false });
    await pool.query(`UPDATE statement_deliveries SET status='SENT' WHERE statement_id=$1`, [f.statementId]);
    // the delivery job itself must not interfere: drop its queued job
    await pool.query(`DELETE FROM jobs WHERE type <> 'send_month_end_reminder'`);
    await scheduleDueReminders(pool, T('2026-10-01T13:00:10Z'));
    inbox.length = 0; await drain();
    assert.equal(inbox.filter((m) => m.to[0] === 'c-admin@r.test').length, 0);
    let rs = await runs(f.orgId);
    assert.equal(rs.at(-1).status, 'SKIPPED'); assert.match(rs.at(-1).reason, /finalized and every statement was sent/);
    // turned off between scheduling and sending
    await scheduleDueReminders(pool, T('2026-10-05T13:00:10Z'));
    assert.equal((await runs(f.orgId)).at(-1).status, 'QUEUED');
    await pool.query(`UPDATE reminder_settings SET enabled=false WHERE organization_id=$1`, [f.orgId]);
    await drain();
    rs = await runs(f.orgId);
    assert.equal(rs.at(-1).status, 'SKIPPED'); assert.match(rs.at(-1).reason, /turned off/);
  });

  test('worker down: late by under 24h still sends, older ones are recorded as MISSED; never back-fills before the schedule was saved', async () => {
    const s = await org('d');
    await enable('d', '2026-09-01T12:00:00Z');
    await scheduleDueReminders(pool, T('2026-10-06T10:00:00Z')); // Oct 5 09:00 is 21h late: still sent
    const rs = await runs(s.orgId);
    assert.deepEqual(rs.map((r) => [r.month, r.offset_days, r.status]), [[9, -2, 'MISSED'], [9, 1, 'MISSED'], [9, 5, 'QUEUED']]);
    await drain();
    // a schedule saved after today's 9:00 does not fire for today
    const s2 = await org('e');
    await enable('e', '2026-10-01T13:30:00Z');
    await scheduleDueReminders(pool, T('2026-10-01T13:31:00Z'));
    assert.equal((await runs(s2.orgId)).length, 0, 'no MISSED rows either');
  });

  test('retries never email the same person twice; no email provider fails the run with a reason', async () => {
    const s = await org('f');
    await enable('f', '2026-09-20T12:00:00Z');
    await scheduleDueReminders(pool, T('2026-10-01T13:00:00Z'));
    inbox.length = 0;
    let failed = false;
    failNext = (m) => (m.to[0] === 'f-mgr@r.test' && !failed ? (failed = true, new EmailError('Rate limited', true)) : null);
    await drain();
    failNext = null;
    const admins = inbox.filter((m) => m.to[0] === 'f-admin@r.test').length;
    assert.equal(admins, 1, 'admin got exactly one email although the job ran twice');
    assert.equal(inbox.filter((m) => m.to[0] === 'f-mgr@r.test').length, 1);
    const oct1 = (await runs(s.orgId)).find((r) => r.offset_days === 1);
    assert.equal(oct1.status, 'SENT'); assert.equal(oct1.sent_to.length, 3, 'admin, manager and the seeded manager');
    assert.equal((await runs(s.orgId)).find((r) => r.offset_days === -2).status, 'MISSED', 'Sep 29 was more than 24h before the first scheduler run');
    assert.ok(inbox.every((m) => m.idempotencyKey?.startsWith('reminder:')));
    // no provider
    await scheduleDueReminders(pool, T('2026-10-05T13:00:00Z'));
    await drain(handlers(null));
    const last = (await runs(s.orgId)).at(-1);
    assert.equal(last.status, 'FAILED'); assert.match(last.reason, /Email is not configured/);
  });

  test('test send goes only to the requester, marked [Test]; history and checklist endpoints', async () => {
    const s = await org('g');
    const { c } = await enable('g', '2026-10-03T12:00:00Z');
    const r = await c.post('/api/settings/reminders/test');
    assert.equal(r.statusCode, 202, r.body);
    inbox.length = 0; await drain();
    assert.equal(inbox.length, 1); assert.equal(inbox[0].to[0], 'g-admin@r.test');
    assert.match(inbox[0].subject, /^\[Test\] September 2026 close/);
    const v = (await c.get('/api/settings/reminders')).json();
    assert.equal(v.runs[0].isTest, true); assert.equal(v.runs[0].status, 'SENT'); assert.equal(v.runs[0].when, 'Test');
    assert.ok(v.emailConfigured);
    const viewer = await new Client(app).login('g-viewer@r.test');
    assert.equal((await viewer.post('/api/settings/reminders/test')).statusCode, 403);
    const cl = (await viewer.get('/api/close/checklist?ym=2026-09')).json();
    assert.deepEqual(cl.items.map((i: any) => i.key), ['import', 'expenses', 'finalize', 'send']);
    assert.equal(cl.complete, false);
    assert.equal((await viewer.get('/api/close/checklist?ym=2026-13')).statusCode, 400);
    void s;
  });

  test('tenant isolation: runs and settings are per organization', async () => {
    const h = await org('h');
    const c = await new Client(app).login('h-admin@r.test');
    const v = (await c.get('/api/settings/reminders')).json();
    assert.equal(v.settings.enabled, false); assert.deepEqual(v.runs, []);
    void h;
  });

  test('preflight warns when reminders are on but email is not configured', async () => {
    const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', BASE_URL: 'https://app.example.com', LINK_SECRET: 'k3Jx9QpL2mZ7vB5nR8tY4wC6dF1hG0sA', TRUST_PROXY: 'true' };
    const cs = (await runPreflight(env, pool, { files: tmpStore() })).filter((x) => x.name === 'month-end reminders');
    assert.equal(cs[0].level, 'warn'); assert.match(cs[0].detail, /no email provider/);
  });
});
