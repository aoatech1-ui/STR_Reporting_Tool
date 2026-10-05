import { withTx, type Pool, type Tx } from '../db/pool.ts';
import type { EmailProvider } from '../email/types.ts';
import { PermanentError, UserError } from '../errors.ts';
import { getOrganization } from '../repo/orgs.ts';
import { enabledReminderOrgs, getReminderSettings, monthEndStatus, reminderRecipients, type Recipient, type ReminderSettings } from '../repo/reminders.ts';
import { composeReminder, isComplete } from '../reminders/compose.ts';
import { addMonths, dueOccurrences, localDate, missedOccurrences, type Occurrence } from '../reminders/schedule.ts';
import { enqueue, type Handler } from '../worker/queue.ts';

export const REMINDER_JOB = 'send_month_end_reminder';
/** A reminder more than this late (worker down) is recorded as MISSED instead of arriving at a strange time. */
export const GRACE_MS = 24 * 3600_000;
const LOOKBACK_MS = 7 * 24 * 3600_000;

async function insertRun(tx: Tx, orgId: string, o: Occurrence, status: 'QUEUED' | 'MISSED', reason: string | null): Promise<string | null> {
  const r = await tx.query(
    `INSERT INTO reminder_runs(organization_id, year, month, offset_days, scheduled_for, status, reason, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6='MISSED' THEN now() END)
     ON CONFLICT (organization_id, year, month, offset_days) WHERE NOT is_test DO NOTHING RETURNING id`, [orgId, o.year, o.month, o.offset, o.at, status, reason]);
  return r.rows[0]?.id ?? null;
}

/**
 * Called every minute by every worker. Creates at most one run per org/month/offset (unique index), and its job in the same
 * transaction, so several workers or a restart can never double-send. `now` defaults to the database clock.
 */
export async function scheduleDueReminders(pool: Pool, now?: Date): Promise<number> {
  const at = now ?? (await pool.query('SELECT now() AS t')).rows[0].t as Date;
  let queued = 0;
  for (const { orgId, settings } of await enabledReminderOrgs(pool)) {
    const effective = new Date(settings.effectiveFrom);
    const cutoff = new Date(Math.max(at.getTime() - GRACE_MS, effective.getTime()));
    const due = dueOccurrences(settings, at, cutoff);
    const missed = missedOccurrences(settings, at, new Date(Math.max(effective.getTime(), at.getTime() - LOOKBACK_MS)), cutoff);
    if (!due.length && !missed.length) continue;
    await withTx(pool, async (tx) => {
      for (const o of missed) await insertRun(tx, orgId, o, 'MISSED', 'Not sent: no worker was running at the scheduled time (more than 24 hours ago)');
      for (const o of due) {
        const id = await insertRun(tx, orgId, o, 'QUEUED', null);
        if (id) { await enqueue(tx, { orgId, type: REMINDER_JOB, payload: { runId: id }, dedupeKey: `reminder:${id}`, maxAttempts: 8 }); queued++; }
      }
    });
  }
  return queued;
}

/** "Send me a test": the month that most recently ended, to the requesting user only. */
export async function queueTestReminder(pool: Pool, orgId: string, userId: string, now: Date): Promise<string> {
  const s = await getReminderSettings(pool, orgId);
  const [y, m] = localDate(now, s.timezone).split('-').map(Number);
  const p = addMonths(y, m, -1);
  return withTx(pool, async (tx) => {
    const recent = await tx.query(`SELECT count(*)::int AS n FROM reminder_runs WHERE organization_id=$1 AND is_test AND requested_by=$2 AND created_at > $3`, [orgId, userId, new Date(now.getTime() - 60_000)]);
    if (recent.rows[0].n >= 3) throw new UserError('Please wait a minute before sending another test', 429);
    const id = (await tx.query(`INSERT INTO reminder_runs(organization_id, year, month, offset_days, scheduled_for, is_test, requested_by) VALUES ($1,$2,$3,0,$4,true,$5) RETURNING id`,
      [orgId, p.year, p.month, now, userId])).rows[0].id;
    await enqueue(tx, { orgId, type: REMINDER_JOB, payload: { runId: id }, dedupeKey: `reminder:${id}`, maxAttempts: 3 });
    return id;
  });
}

export interface ReminderDeps { pool: Pool; email: EmailProvider | null; baseUrl: string }

export function reminderHandler(d: ReminderDeps): Handler {
  const finish = (id: string, status: 'SENT' | 'SKIPPED' | 'FAILED', reason: string | null) =>
    d.pool.query(`UPDATE reminder_runs SET status=$2, reason=$3, finished_at=now() WHERE id=$1 AND status='QUEUED'`, [id, status, reason]);
  return {
    async run(job) {
      const run = (await d.pool.query('SELECT * FROM reminder_runs WHERE id=$1', [job.payload.runId])).rows[0];
      if (!run || run.status !== 'QUEUED') return;
      const orgId: string = run.organization_id;
      const settings: ReminderSettings = await getReminderSettings(d.pool, orgId);
      if (!run.is_test && !settings.enabled) return void await finish(run.id, 'SKIPPED', 'Reminders were turned off before it was sent');
      const status = await monthEndStatus(d.pool, orgId, run.year, run.month);
      const sendDate = localDate(new Date(run.scheduled_for), settings.timezone);
      if (!run.is_test && run.offset_days > 0 && isComplete(status)) return void await finish(run.id, 'SKIPPED', 'Nothing to do: the month is finalized and every statement was sent');
      let recipients: Recipient[];
      if (run.is_test) recipients = (await d.pool.query('SELECT id, name, email FROM users WHERE id=$1 AND organization_id=$2 AND active', [run.requested_by, orgId])).rows;
      else recipients = await reminderRecipients(d.pool, orgId, settings.roles);
      recipients = recipients.filter((r) => r.email);
      if (!recipients.length) return void await finish(run.id, 'SKIPPED', 'No one to send to: every recipient has turned reminders off or no user has a matching role');
      if (!d.email) throw new PermanentError('Email is not configured, so reminders cannot be sent');
      const org = await getOrganization(d.pool, orgId);
      const ym = `${run.year}-${String(run.month).padStart(2, '0')}`;
      const msg = composeReminder({ orgName: org.displayName, status, offset: run.offset_days, sendDate, dueDay: settings.dueDay, closeUrl: `${d.baseUrl}/close?ym=${ym}`, test: run.is_test });
      const done = new Set<string>(run.sent_to);
      for (const r of recipients) {
        const to = r.email.toLowerCase();
        if (done.has(to)) continue; // already sent before a retry
        await d.email.send({ to: [r.email], subject: msg.subject, text: msg.text, html: msg.html, idempotencyKey: `reminder:${run.id}:${r.id}` });
        await d.pool.query('UPDATE reminder_runs SET sent_to = array_append(sent_to, $2), subject=$3 WHERE id=$1', [run.id, to, msg.subject]);
      }
      await finish(run.id, 'SENT', null);
    },
    async onRetry(job, err) { await d.pool.query(`UPDATE reminder_runs SET reason=$2 WHERE id=$1`, [job.payload.runId, `Retrying: ${err.message.slice(0, 300)}`]); },
    async onGiveUp(job, err) { await finish(job.payload.runId, 'FAILED', err.message.slice(0, 300)); },
  };
}
