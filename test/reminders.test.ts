import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklist, composeReminder, isComplete, type MonthEndStatus } from '../src/reminders/compose.ts';
import { dueOccurrences, localDate, missedOccurrences, occurrenceAt, offsetLabel, reminderDate, upcoming, validateSchedule, zonedTimeToUtc, type ReminderSchedule } from '../src/reminders/schedule.ts';

const S = (o: Partial<ReminderSchedule> = {}): ReminderSchedule => ({ enabled: true, timezone: 'America/New_York', sendHour: 9, days: [-2, 1, 5], dueDay: 10, ...o });

test('wall-clock time in the org time zone, across daylight saving', () => {
  assert.equal(zonedTimeToUtc(2026, 10, 1, 9, 'America/New_York').toISOString(), '2026-10-01T13:00:00.000Z'); // EDT
  assert.equal(zonedTimeToUtc(2026, 12, 1, 9, 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z'); // EST
  assert.equal(zonedTimeToUtc(2026, 11, 1, 9, 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z'); // DST ended that morning
  assert.equal(zonedTimeToUtc(2026, 3, 8, 2, 'America/New_York').toISOString(), '2026-03-08T07:00:00.000Z'); // 02:00 does not exist → 03:00 EDT
  assert.equal(zonedTimeToUtc(2026, 7, 1, 9, 'UTC').toISOString(), '2026-07-01T09:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 7, 1, 9, 'Asia/Kolkata').toISOString(), '2026-07-01T03:30:00.000Z');
  assert.equal(zonedTimeToUtc(2027, 1, 1, 0, 'Pacific/Auckland').toISOString(), '2026-12-31T11:00:00.000Z');
  assert.equal(localDate(new Date('2026-10-01T03:00:00Z'), 'America/New_York'), '2026-09-30');
});

test('reminder dates: day N of the next month, or days before month end; short months and year wrap', () => {
  assert.deepEqual(reminderDate(2026, 9, 1), { year: 2026, month: 10, day: 1 });
  assert.deepEqual(reminderDate(2026, 12, 5), { year: 2027, month: 1, day: 5 });
  assert.deepEqual(reminderDate(2026, 9, -1), { year: 2026, month: 9, day: 30 });
  assert.deepEqual(reminderDate(2026, 2, -1), { year: 2026, month: 2, day: 28 });
  assert.deepEqual(reminderDate(2028, 2, -3), { year: 2028, month: 2, day: 27 });
  assert.deepEqual(reminderDate(2026, 1, 28), { year: 2026, month: 2, day: 28 });
  assert.equal(offsetLabel(1), '1st of the next month'); assert.equal(offsetLabel(22), '22nd of the next month'); assert.equal(offsetLabel(13), '13th of the next month');
  assert.equal(offsetLabel(-1), 'last day of the month'); assert.equal(offsetLabel(-3), '3 days before month end');
});

test('due: fires once its time has come, never back-fills before notBefore; missed ones are reported separately', () => {
  const s = S();
  const at = occurrenceAt(s, 2026, 9, 1); // Oct 1 09:00 New York
  assert.equal(at.toISOString(), '2026-10-01T13:00:00.000Z');
  const before = new Date(at.getTime() - 60_000), after = new Date(at.getTime() + 60_000);
  assert.deepEqual(dueOccurrences(s, before, new Date(0)).filter((o) => o.offset === 1 && o.month === 9), []);
  const due = dueOccurrences(s, after, new Date(after.getTime() - 24 * 3600_000));
  assert.deepEqual(due.map((o) => [o.year, o.month, o.offset]), [[2026, 9, 1]]);
  assert.deepEqual(dueOccurrences(s, after, after), [], 'nothing older than notBefore');
  assert.deepEqual(dueOccurrences(S({ enabled: false }), after, new Date(0)), []);
  // worker down for 5 days: Oct 5 reminder is due, Oct 1 is missed
  const oct5 = new Date(occurrenceAt(s, 2026, 9, 5).getTime() + 1000);
  const cutoff = new Date(oct5.getTime() - 24 * 3600_000);
  assert.deepEqual(dueOccurrences(s, oct5, cutoff).map((o) => o.offset), [5]);
  assert.deepEqual(missedOccurrences(s, oct5, new Date('2026-09-15T00:00:00Z'), cutoff).map((o) => `${o.month}:${o.offset}`), ['9:-2', '9:1']);
});

test('upcoming lists the next reminders in order', () => {
  const u = upcoming(S(), new Date('2026-10-02T12:00:00Z'), 4);
  assert.deepEqual(u.map((o) => [o.month, o.offset, localDate(o.at, 'America/New_York')]), [[9, 5, '2026-10-05'], [10, -2, '2026-10-30'], [10, 1, '2026-11-01'], [10, 5, '2026-11-05']]);
  assert.deepEqual(upcoming(S({ enabled: false }), new Date()), []);
});

test('validation', () => {
  assert.equal(validateSchedule(S()), null);
  assert.match(validateSchedule(S({ timezone: 'Mars/Base' }))!, /time zone/);
  assert.match(validateSchedule(S({ days: [0] }))!, /days/);
  assert.match(validateSchedule(S({ days: [29] }))!, /days/);
  assert.match(validateSchedule(S({ days: [-11] }))!, /days/);
  assert.match(validateSchedule(S({ days: [1, 1] }))!, /once/);
  assert.match(validateSchedule(S({ days: [1, 2, 3, 4, 5, 6, 7] }))!, /At most/);
  assert.match(validateSchedule(S({ sendHour: 24 }))!, /hour/);
  assert.match(validateSchedule(S({ dueDay: 31 }))!, /due day/);
  assert.match(validateSchedule(S({ days: [] }))!, /at least one/);
  assert.equal(validateSchedule(S({ days: [], enabled: false })), null);
});

const status = (o: Partial<MonthEndStatus> = {}): MonthEndStatus => ({ year: 2026, month: 9, periodStatus: 'REVIEW', activeProperties: 3, earningsImported: 12, unmatchedTransactions: 0,
  propertiesWithoutExpenses: 1, missingReceipts: 2, statements: 3, finalizedUnsent: 0, failedDeliveries: 0, ...o });

test('checklist reflects the month', () => {
  const c = checklist(status({ periodStatus: 'NONE', earningsImported: 0, statements: 0 }));
  assert.deepEqual(c.map((i) => [i.key, i.state]), [['import', 'todo'], ['expenses', 'warn'], ['finalize', 'todo'], ['send', 'later']]);
  assert.match(c[0].detail, /No Airbnb earnings imported for September/);
  assert.match(c[1].detail, /1 property of 3 has no expenses.*2 expenses of \$75 or more without a receipt/);
  assert.equal(checklist(status({ unmatchedTransactions: 4 }))[0].state, 'warn');
  const fin = checklist(status({ periodStatus: 'FINALIZED', finalizedUnsent: 2 }));
  assert.deepEqual(fin.map((i) => i.state), ['done', 'done', 'done', 'todo']);
  assert.equal(checklist(status({ periodStatus: 'LOCKED', failedDeliveries: 1 }))[3].state, 'warn');
  assert.match(checklist(status({ periodStatus: 'FINALIZED', unmatchedTransactions: 1 }))[0].detail, /1 unmatched transaction acknowledged/);
  assert.equal(isComplete(status({ periodStatus: 'FINALIZED' })), true);
  assert.equal(isComplete(status({ periodStatus: 'FINALIZED', finalizedUnsent: 1 })), false);
  assert.equal(isComplete(status()), false);
  // before month end, close steps are "later", not overdue
  assert.deepEqual(checklist(status({ periodStatus: 'NONE', earningsImported: 0, missingReceipts: 0, propertiesWithoutExpenses: 0 }), false).map((i) => i.state), ['later', 'done', 'later', 'later']);
});

test('compose: subjects, due dates, overdue, before month end, escaping, test prefix', () => {
  const base = { orgName: 'Manager <LLC>', offset: 1, dueDay: 10, closeUrl: 'https://app.example.com/close?ym=2026-09' };
  let m = composeReminder({ ...base, status: status(), sendDate: '2026-10-05' });
  assert.equal(m.subject, 'September 2026 close: 2 items open (due Oct 10)');
  assert.match(m.text, /Owner statements are due by Oct 10 \(in 5 days\)/);
  assert.match(m.text, /\[!\] Enter expenses and receipts/);
  assert.match(m.text, /https:\/\/app\.example\.com\/close\?ym=2026-09/);
  assert.ok(m.html.includes('Manager &lt;LLC&gt;') && !m.html.includes('Manager <LLC>'), 'escaped');
  m = composeReminder({ ...base, status: status(), sendDate: '2026-10-12' });
  assert.equal(m.subject, 'September 2026 close: 2 items open (overdue)');
  assert.match(m.text, /overdue: they were due on Oct 10/);
  m = composeReminder({ ...base, status: status(), sendDate: '2026-10-09' });
  assert.match(m.text, /due tomorrow, Oct 10/);
  m = composeReminder({ ...base, offset: -2, status: status({ periodStatus: 'NONE', earningsImported: 0 }), sendDate: '2026-09-29' });
  assert.equal(m.subject, 'September 2026 ends tomorrow: month-end checklist');
  assert.ok(!/due|overdue/.test(m.subject));
  m = composeReminder({ ...base, status: status({ periodStatus: 'FINALIZED' }), sendDate: '2026-10-05', test: true });
  assert.equal(m.subject, '[Test] September 2026 close is complete');
  m = composeReminder({ ...base, dueDay: null, status: status(), sendDate: '2026-10-05' });
  assert.equal(m.subject, 'September 2026 close: 2 items open');
});
