import type { Db, Tx } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import { RECEIPT_THRESHOLD_CENTS } from '../accounting/exceptions.ts';
import type { MonthEndStatus } from '../reminders/compose.ts';
import { validateSchedule, type ReminderSchedule } from '../reminders/schedule.ts';
import type { Role } from '../auth/permissions.ts';
import { appendAudit } from './audit.ts';
import { countUnmatched } from './earnings.ts';
import { monthRange } from './periods.ts';

export interface ReminderSettings extends ReminderSchedule { roles: Role[]; effectiveFrom: string; updatedAt: string | null }
export const DEFAULT_SETTINGS: Omit<ReminderSettings, 'effectiveFrom' | 'updatedAt'> = { enabled: false, timezone: 'UTC', sendHour: 9, days: [-2, 1, 5], dueDay: 10, roles: ['ADMIN', 'MANAGER'] };

const mapSettings = (x: any): ReminderSettings => ({ enabled: x.enabled, timezone: x.timezone, sendHour: x.send_hour, days: [...x.days].sort((a: number, b: number) => a - b), dueDay: x.due_day,
  roles: x.roles, effectiveFrom: new Date(x.effective_from).toISOString(), updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null });

export async function getReminderSettings(db: Db, orgId: string): Promise<ReminderSettings> {
  const r = await db.query('SELECT * FROM reminder_settings WHERE organization_id=$1', [orgId]);
  return r.rows[0] ? mapSettings(r.rows[0]) : { ...DEFAULT_SETTINGS, effectiveFrom: new Date(0).toISOString(), updatedAt: null };
}

/** Saves the schedule. Moves effective_from to now so a change never triggers reminders whose time has already passed. */
export async function saveReminderSettings(tx: Tx, orgId: string, actorId: string, s: Omit<ReminderSettings, 'effectiveFrom' | 'updatedAt'>, now: Date): Promise<ReminderSettings> {
  const problem = validateSchedule(s);
  if (problem) throw new UserError(problem);
  if (!s.roles.length) throw new UserError('Choose at least one role to receive reminders');
  const before = await getReminderSettings(tx, orgId);
  const r = await tx.query(
    `INSERT INTO reminder_settings(organization_id, enabled, timezone, send_hour, days, due_day, roles, effective_from, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
     ON CONFLICT (organization_id) DO UPDATE SET enabled=$2, timezone=$3, send_hour=$4, days=$5, due_day=$6, roles=$7, effective_from=$8, updated_at=$8, updated_by=$9
     RETURNING *`, [orgId, s.enabled, s.timezone, s.sendHour, s.days, s.dueDay, s.roles, now, actorId]);
  const after = mapSettings(r.rows[0]);
  const strip = ({ effectiveFrom: _e, updatedAt: _u, ...rest }: ReminderSettings) => rest;
  await appendAudit(tx, orgId, { userId: actorId, action: 'REMINDER_SETTINGS_CHANGED', entityType: 'organization', entityId: orgId, oldValue: strip(before), newValue: strip(after) });
  return after;
}

export async function enabledReminderOrgs(db: Db): Promise<{ orgId: string; settings: ReminderSettings }[]> {
  const r = await db.query('SELECT * FROM reminder_settings WHERE enabled');
  return r.rows.map((x) => ({ orgId: x.organization_id, settings: mapSettings(x) }));
}

/** Live status of one accounting month, recomputed every time a reminder is sent. */
export async function monthEndStatus(db: Db, orgId: string, year: number, month: number): Promise<MonthEndStatus> {
  const { start, end } = monthRange(year, month);
  const r = await db.query(
    `WITH p AS (SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND year=$2 AND month=$3)
     SELECT (SELECT status::text FROM p) AS period_status,
       (SELECT count(*)::int FROM properties WHERE organization_id=$1 AND active) AS props,
       (SELECT count(*)::int FROM earnings_transactions WHERE organization_id=$1 AND earnings_date BETWEEN $4 AND $5) AS earnings,
       (SELECT count(*)::int FROM properties pr WHERE pr.organization_id=$1 AND pr.active AND NOT EXISTS
          (SELECT 1 FROM expenses e WHERE e.property_id=pr.id AND e.accounting_period_id IN (SELECT id FROM p))) AS noexp,
       (SELECT count(*)::int FROM expenses e WHERE e.organization_id=$1 AND e.accounting_period_id IN (SELECT id FROM p) AND e.reverses_expense_id IS NULL
          AND e.total_cents >= $6 AND NOT EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id=e.id)) AS noreceipt,
       (SELECT count(*)::int FROM owner_statements s WHERE s.organization_id=$1 AND s.accounting_period_id IN (SELECT id FROM p)) AS statements,
       (SELECT count(*)::int FROM owner_statements s WHERE s.organization_id=$1 AND s.accounting_period_id IN (SELECT id FROM p) AND s.status IN ('FINALIZED','LOCKED')
          AND NOT EXISTS (SELECT 1 FROM statement_deliveries d WHERE d.statement_id=s.id AND d.status IN ('QUEUED','SENT','DELIVERED'))) AS unsent,
       (SELECT count(*)::int FROM owner_statements s WHERE s.organization_id=$1 AND s.accounting_period_id IN (SELECT id FROM p)
          AND EXISTS (SELECT 1 FROM statement_deliveries d WHERE d.statement_id=s.id AND d.status IN ('FAILED','BOUNCED'))
          AND NOT EXISTS (SELECT 1 FROM statement_deliveries d WHERE d.statement_id=s.id AND d.status IN ('QUEUED','SENT','DELIVERED'))) AS failed`,
    [orgId, year, month, start, end, RECEIPT_THRESHOLD_CENTS]);
  const x = r.rows[0];
  return { year, month, periodStatus: x.period_status ?? 'NONE', activeProperties: x.props, earningsImported: x.earnings, unmatchedTransactions: await countUnmatched(db, orgId, start, end),
    propertiesWithoutExpenses: x.noexp, missingReceipts: x.noreceipt, statements: x.statements, finalizedUnsent: x.unsent, failedDeliveries: x.failed };
}

export interface Recipient { id: string; name: string; email: string }
export async function reminderRecipients(db: Db, orgId: string, roles: Role[]): Promise<Recipient[]> {
  const r = await db.query(`SELECT id, name, email FROM users WHERE organization_id=$1 AND active AND month_end_reminders AND role = ANY($2::text[]::user_role[]) ORDER BY name`, [orgId, roles]);
  return r.rows;
}

export interface ReminderRun { id: string; year: number; month: number; offset: number; scheduledFor: string; isTest: boolean; status: string; reason: string | null; sentTo: string[]; subject: string | null; finishedAt: string | null }
const mapRun = (x: any): ReminderRun => ({ id: x.id, year: x.year, month: x.month, offset: x.offset_days, scheduledFor: new Date(x.scheduled_for).toISOString(), isTest: x.is_test, status: x.status,
  reason: x.reason, sentTo: x.sent_to, subject: x.subject, finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null });

export async function listReminderRuns(db: Db, orgId: string, limit = 20): Promise<ReminderRun[]> {
  const r = await db.query('SELECT * FROM reminder_runs WHERE organization_id=$1 ORDER BY scheduled_for DESC, created_at DESC LIMIT $2', [orgId, limit]);
  return r.rows.map(mapRun);
}

export async function getMyReminderPreference(db: Db, userId: string): Promise<boolean> {
  return (await db.query('SELECT month_end_reminders FROM users WHERE id=$1', [userId])).rows[0]?.month_end_reminders ?? false;
}
export async function setMyReminderPreference(tx: Tx, orgId: string, userId: string, on: boolean): Promise<void> {
  await tx.query('UPDATE users SET month_end_reminders=$2, updated_at=now() WHERE id=$1 AND organization_id=$3', [userId, on, orgId]);
}
