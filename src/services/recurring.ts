import type { Pool } from '../db/pool.ts';
import { postDue } from '../repo/recurring.ts';
import { localDate } from '../reminders/schedule.ts';

/** The organization's calendar date. Its time zone is the one set for month-end reminders (UTC if never set). */
export async function orgToday(pool: Pool, orgId: string, now: Date): Promise<string> {
  const tz = (await pool.query('SELECT timezone FROM reminder_settings WHERE organization_id=$1', [orgId])).rows[0]?.timezone ?? 'UTC';
  return localDate(now, tz);
}

/** Worker task: posts recurring expenses whose date has come, for every organization. `now` defaults to the database clock. */
export async function postDueRecurringExpenses(pool: Pool, now?: Date): Promise<number> {
  const at = now ?? (await pool.query('SELECT now() AS t')).rows[0].t as Date;
  let posted = 0;
  const orgs = (await pool.query('SELECT DISTINCT organization_id FROM recurring_expenses WHERE active')).rows.map((r) => r.organization_id as string);
  for (const orgId of orgs) {
    try { posted += (await postDue(pool, orgId, await orgToday(pool, orgId, at), null)).posted; }
    catch (e) { console.error(`recurring expenses (org ${orgId}): ${(e as Error).message}`); } // one org's problem must not block the others
  }
  return posted;
}
