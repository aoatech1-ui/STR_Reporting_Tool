/**
 * Recurring expense schedule. Pure functions over calendar months, no I/O.
 * A template occurs every `intervalMonths` months starting at `startMonth` (YYYY-MM), on `dayOfMonth`
 * (clamped to the month's last day, so 31 means "last day"), until `endMonth` (inclusive) if set.
 */
export interface RecurringSchedule { startMonth: string; endMonth: string | null; intervalMonths: number; dayOfMonth: number }
export interface Occurrence { year: number; month: number; date: string }

export const INTERVALS = [1, 2, 3, 6, 12] as const;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const idx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const ymOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const pad = (n: number) => String(n).padStart(2, '0');
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function occursIn(s: RecurringSchedule, year: number, month: number): boolean {
  const i = year * 12 + month - 1, start = idx(s.startMonth);
  if (i < start || (s.endMonth && i > idx(s.endMonth))) return false;
  return (i - start) % s.intervalMonths === 0;
}

export function occurrenceDate(s: Pick<RecurringSchedule, 'dayOfMonth'>, year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(s.dayOfMonth, dim(year, month)))}`;
}

/** Occurrences dated on or before `today` (YYYY-MM-DD), looking back at most `maxMonths` months. Oldest first. */
export function dueOccurrences(s: RecurringSchedule, today: string, maxMonths = 13): Occurrence[] {
  const t = idx(today.slice(0, 7)), out: Occurrence[] = [];
  for (let i = Math.max(idx(s.startMonth), t - maxMonths + 1); i <= t; i++) {
    const [y, m] = ymOf(i).split('-').map(Number);
    if (!occursIn(s, y, m)) continue;
    const date = occurrenceDate(s, y, m);
    if (date <= today) out.push({ year: y, month: m, date });
  }
  return out;
}

/** The next `n` occurrences dated after `today`. */
export function upcomingOccurrences(s: RecurringSchedule, today: string, n = 6): Occurrence[] {
  const out: Occurrence[] = [];
  for (let i = Math.max(idx(s.startMonth), idx(today.slice(0, 7))); out.length < n && i < idx(today.slice(0, 7)) + 12 * 5; i++) {
    const [y, m] = ymOf(i).split('-').map(Number);
    if (s.endMonth && i > idx(s.endMonth)) break;
    if (!occursIn(s, y, m)) continue;
    const date = occurrenceDate(s, y, m);
    if (date > today) out.push({ year: y, month: m, date });
  }
  return out;
}

export function validateSchedule(s: RecurringSchedule, today: string): string | null {
  if (!YM.test(s.startMonth)) return 'Start month must look like 2026-10';
  if (s.endMonth !== null && !YM.test(s.endMonth)) return 'End month must look like 2026-12';
  if (s.endMonth && idx(s.endMonth) < idx(s.startMonth)) return 'End month is before the start month';
  if (!(INTERVALS as readonly number[]).includes(s.intervalMonths)) return 'Frequency must be monthly, every 2 months, quarterly, twice a year or yearly';
  if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > 31) return 'Day of month must be 1–31';
  if (idx(s.startMonth) < idx(today.slice(0, 7)) - 12) return 'Start month can be at most 12 months in the past';
  return null;
}

const ORD = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
export function describeSchedule(s: Pick<RecurringSchedule, 'intervalMonths' | 'dayOfMonth'>): string {
  const day = s.dayOfMonth >= 31 ? 'on the last day' : `on the ${ORD(s.dayOfMonth)}`;
  const every = { 1: 'Monthly', 2: 'Every 2 months', 3: 'Quarterly', 6: 'Twice a year', 12: 'Yearly' }[s.intervalMonths] ?? `Every ${s.intervalMonths} months`;
  return `${every}, ${day}`;
}
