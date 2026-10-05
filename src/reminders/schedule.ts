/**
 * Month-end reminder schedule. Pure functions, no I/O.
 *
 * A reminder is identified by the accounting month it is about plus an offset:
 *   offset 1..28   → that day of the FOLLOWING month (the close: "September ended, close it")
 *   offset -1..-10 → days before the month ends; -1 is the month's last day ("September ends soon")
 * Times are wall-clock in the organization's time zone, so "9:00 on the 1st" stays 9:00 across daylight-saving changes.
 */

export interface ReminderSchedule { enabled: boolean; timezone: string; sendHour: number; days: number[]; dueDay: number | null }
export interface Occurrence { year: number; month: number; offset: number; at: Date }

export const MIN_OFFSET = -10, MAX_OFFSET = 28, MAX_DAYS = 6;

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const addMonths = (y: number, m: number, n: number) => { const i = y * 12 + (m - 1) + n; return { year: Math.floor(i / 12), month: (i % 12) + 1 }; };

/** Offset (minutes) of `tz` from UTC at instant `ms`. */
function tzOffsetMinutes(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60_000;
}

/** The UTC instant of a wall-clock time in `tz`. In a DST gap the time moves forward by the gap (02:30 → 03:30). */
export function zonedTimeToUtc(y: number, m: number, d: number, hour: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, hour);
  const t1 = naive - tzOffsetMinutes(naive, tz) * 60_000;
  const t2 = naive - tzOffsetMinutes(t1, tz) * 60_000; // second pass settles instants near a transition
  if (t2 + tzOffsetMinutes(t2, tz) * 60_000 === naive) return new Date(t2);
  return new Date(Math.max(t1, t2)); // the wall time does not exist (spring forward): use the instant just after the gap
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Calendar date a reminder is sent on, for accounting month y/m. */
export function reminderDate(y: number, m: number, offset: number): { year: number; month: number; day: number } {
  if (offset > 0) { const n = addMonths(y, m, 1); return { ...n, day: Math.min(offset, daysInMonth(n.year, n.month)) }; }
  return { year: y, month: m, day: daysInMonth(y, m) + offset + 1 };
}

export const occurrenceAt = (s: Pick<ReminderSchedule, 'timezone' | 'sendHour'>, y: number, m: number, offset: number): Date => {
  const d = reminderDate(y, m, offset);
  return zonedTimeToUtc(d.year, d.month, d.day, s.sendHour, s.timezone);
};

/** Occurrences for accounting months from `from` (inclusive), in time order. */
function occurrencesAround(s: ReminderSchedule, now: Date, monthsBack: number, monthsAhead: number): Occurrence[] {
  const [y, m] = localDate(now, s.timezone).split('-').map(Number);
  const out: Occurrence[] = [];
  for (let i = -monthsBack; i <= monthsAhead; i++) {
    const p = addMonths(y, m, i);
    for (const offset of s.days) out.push({ year: p.year, month: p.month, offset, at: occurrenceAt(s, p.year, p.month, offset) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Occurrences whose time has come and that are newer than `notBefore` (never back-fill older ones). */
export function dueOccurrences(s: ReminderSchedule, now: Date, notBefore: Date): Occurrence[] {
  if (!s.enabled) return [];
  return occurrencesAround(s, now, 2, 0).filter((o) => o.at <= now && o.at > notBefore);
}

/** Occurrences that were due between `since` and `notBefore`, i.e. missed (worker was down longer than the grace period). */
export function missedOccurrences(s: ReminderSchedule, now: Date, since: Date, notBefore: Date): Occurrence[] {
  if (!s.enabled) return [];
  return occurrencesAround(s, now, 2, 0).filter((o) => o.at > since && o.at <= notBefore && o.at <= now);
}

export function upcoming(s: ReminderSchedule, now: Date, n = 4): Occurrence[] {
  if (!s.enabled || !s.days.length) return [];
  return occurrencesAround(s, now, 1, 2).filter((o) => o.at > now).slice(0, n);
}

export function validateSchedule(s: ReminderSchedule): string | null {
  if (!isValidTimeZone(s.timezone)) return `Unknown time zone "${s.timezone}"`;
  if (!Number.isInteger(s.sendHour) || s.sendHour < 0 || s.sendHour > 23) return 'Send hour must be 0–23';
  if (s.days.length > MAX_DAYS) return `At most ${MAX_DAYS} reminders per month`;
  if (new Set(s.days).size !== s.days.length) return 'Each reminder day can appear only once';
  for (const d of s.days) if (!Number.isInteger(d) || d === 0 || d < MIN_OFFSET || d > MAX_OFFSET) return 'Reminder days must be 1–28 (day of the next month) or −1 to −10 (days before month end)';
  if (s.dueDay !== null && (!Number.isInteger(s.dueDay) || s.dueDay < 1 || s.dueDay > 28)) return 'Statement due day must be 1–28';
  if (s.enabled && !s.days.length) return 'Choose at least one reminder day';
  return null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
/** "1st of the next month", "last day of the month", "3 days before month end" (−3 = the 3rd-to-last day, e.g. Sep 28). */
export function offsetLabel(offset: number): string {
  if (offset > 0) return `${ord(offset)} of the next month`;
  if (offset === -1) return 'last day of the month';
  return `${-offset} days before month end`;
}
