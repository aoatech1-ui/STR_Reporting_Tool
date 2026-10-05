import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSchedule, dueOccurrences, occurrenceDate, occursIn, upcomingOccurrences, validateSchedule, type RecurringSchedule } from '../src/accounting/recurring.ts';

const S = (o: Partial<RecurringSchedule> = {}): RecurringSchedule => ({ startMonth: '2026-07', endMonth: null, intervalMonths: 1, dayOfMonth: 1, ...o });

test('occurs every N months from the start, until the end month', () => {
  assert.equal(occursIn(S(), 2026, 6), false);
  assert.equal(occursIn(S(), 2026, 7), true);
  assert.equal(occursIn(S(), 2027, 3), true);
  const q = S({ intervalMonths: 3 });
  assert.deepEqual([7, 8, 9, 10, 11, 12].map((m) => occursIn(q, 2026, m)), [true, false, false, true, false, false]);
  assert.equal(occursIn(q, 2027, 1), true);
  const y = S({ intervalMonths: 12, startMonth: '2026-03' });
  assert.equal(occursIn(y, 2027, 3), true); assert.equal(occursIn(y, 2027, 4), false);
  const ended = S({ endMonth: '2026-09' });
  assert.equal(occursIn(ended, 2026, 9), true); assert.equal(occursIn(ended, 2026, 10), false);
});

test('day of month is clamped to the month end (31 = last day; leap years)', () => {
  assert.equal(occurrenceDate({ dayOfMonth: 31 }, 2026, 2), '2026-02-28');
  assert.equal(occurrenceDate({ dayOfMonth: 31 }, 2028, 2), '2028-02-29');
  assert.equal(occurrenceDate({ dayOfMonth: 30 }, 2026, 4), '2026-04-30');
  assert.equal(occurrenceDate({ dayOfMonth: 15 }, 2026, 9), '2026-09-15');
});

test('due occurrences: dated on or before today, oldest first, bounded look-back', () => {
  const s = S({ dayOfMonth: 15 });
  assert.deepEqual(dueOccurrences(s, '2026-09-14').map((o) => o.date), ['2026-07-15', '2026-08-15']);
  assert.deepEqual(dueOccurrences(s, '2026-09-15').map((o) => o.date), ['2026-07-15', '2026-08-15', '2026-09-15']);
  assert.deepEqual(dueOccurrences(S({ startMonth: '2024-01' }), '2026-09-30').length, 13, 'never more than 13 months back');
  assert.deepEqual(dueOccurrences(S({ startMonth: '2026-12' }), '2026-09-30'), []);
});

test('upcoming occurrences', () => {
  assert.deepEqual(upcomingOccurrences(S({ intervalMonths: 3, dayOfMonth: 31 }), '2026-10-05', 3).map((o) => o.date), ['2026-10-31', '2027-01-31', '2027-04-30']);
  assert.deepEqual(upcomingOccurrences(S({ endMonth: '2026-11' }), '2026-10-05', 5).map((o) => o.date), ['2026-11-01']);
  assert.deepEqual(upcomingOccurrences(S({ startMonth: '2027-02' }), '2026-10-05', 1).map((o) => o.date), ['2027-02-01']);
});

test('validation and description', () => {
  const today = '2026-10-05';
  assert.equal(validateSchedule(S(), today), null);
  assert.match(validateSchedule(S({ startMonth: '2026-13' }), today)!, /Start month/);
  assert.match(validateSchedule(S({ endMonth: '2026-06' }), today)!, /before the start/);
  assert.match(validateSchedule(S({ intervalMonths: 4 }), today)!, /Frequency/);
  assert.match(validateSchedule(S({ dayOfMonth: 0 }), today)!, /Day of month/);
  assert.match(validateSchedule(S({ startMonth: '2025-09' }), today)!, /12 months/);
  assert.equal(describeSchedule({ intervalMonths: 1, dayOfMonth: 1 }), 'Monthly, on the 1st');
  assert.equal(describeSchedule({ intervalMonths: 3, dayOfMonth: 31 }), 'Quarterly, on the last day');
  assert.equal(describeSchedule({ intervalMonths: 12, dayOfMonth: 22 }), 'Yearly, on the 22nd');
});
