import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommission, selectRule } from '../src/accounting/commission.ts';
import { buildStatement, computeYtd, totalsFrom, type ExpenseInput } from '../src/accounting/statement.ts';
import { assertEditable, transition } from '../src/accounting/period.ts';
import { evaluateStatement } from '../src/accounting/exceptions.ts';
import { formatMoney, mulBps, parseMoney, toDecimal } from '../src/money.ts';
import { earning, rule } from './helpers.ts';

const exp = (id: string, category: string, amountCents: number, o: Partial<ExpenseInput> = {}): ExpenseInput =>
  ({ id, date: '2026-09-10', vendor: 'V', description: category, category, amountCents, taxCents: 0, ownerPaid: false, ...o });

const input = (o = {}) => ({ ownerId: 'o', propertyId: 'p', periodId: 'per', year: 2026, month: 9, earnings: [earning()],
  expenses: [exp('e1', 'Repairs', 50000), exp('e2', 'Supplies', 10000), exp('e3', 'Maintenance', 20000)], rule: rule(), ...o });

test('money parsing/formatting is exact', () => {
  assert.equal(parseMoney('$1,234.56'), 123456);
  assert.equal(parseMoney('(12.50)'), -1250);
  assert.equal(parseMoney('1.5'), 150);
  assert.equal(parseMoney('abc'), null);
  assert.equal(formatMoney(-123456), '-$1,234.56');
  assert.equal(toDecimal(400000), '4000.00');
  assert.equal(mulBps(1, 5000), 1); // half rounds away from zero
  assert.equal(mulBps(-1, 5000), -1);
});

test('ACCEPTANCE: $6,000 − 500 − 100 − 200 − 20% commission = $4,000, fully explained', () => {
  const s = buildStatement(input());
  assert.equal(s.commission.commissionCents, 120000);
  assert.equal(s.expensesCents, 80000);
  assert.equal(s.ownerProceedsCents, 400000);
  assert.equal(s.commission.explanation, '20% × $6,000.00 = $1,200.00');
  assert.deepEqual(s.derivation, [
    'Airbnb net payout $6,000.00', '− property expenses $800.00',
    '− management fee $1,200.00 (20% × $6,000.00 = $1,200.00)', '= owner net proceeds $4,000.00']);
  // every dollar traces to a source line: lines sum to proceeds
  assert.equal(s.lines.reduce((a, l) => a + l.amountCents, 0), s.ownerProceedsCents);
});

test('commission types: gross, fixed, hybrid, cleaning/tax policy', () => {
  const t = totalsFrom([earning({ cleaningFeeCents: 10000, taxCents: 5000 })]);
  assert.equal(calculateCommission(t, rule({ type: 'PERCENT_GROSS', includeCleaningFees: false, excludeTaxes: true })).baseCents, 700000);
  assert.equal(calculateCommission(t, rule({ type: 'PERCENT_GROSS', includeCleaningFees: true, excludeTaxes: true })).baseCents, 710000);
  assert.equal(calculateCommission(t, rule({ type: 'PERCENT_NET', includeCleaningFees: false, excludeTaxes: true })).baseCents, 585000);
  assert.equal(calculateCommission(t, rule({ type: 'FIXED', fixedCents: 30000 })).commissionCents, 30000);
  const h = calculateCommission(t, rule({ type: 'HYBRID', rateBps: 1000, fixedCents: 5000, hybridBasis: 'GROSS', excludeTaxes: true, includeCleaningFees: false }));
  assert.equal(h.commissionCents, 70000 + 5000);
  assert.match(h.explanation, /10% × \$7,000\.00 = \$700\.00 \+ \$50\.00 fixed = \$750\.00/);
});

test('refunds reduce the gross commission base; negative base never yields negative commission', () => {
  const r = calculateCommission(totalsFrom([earning({ refundCents: -100000, grossBookingCents: 0, netPayoutCents: -100000 })]), rule());
  assert.equal(r.commissionCents, 0);
});

test('owner-paid expenses are shown but not deducted', () => {
  const s = buildStatement(input({ expenses: [exp('e1', 'Repairs', 50000, { ownerPaid: true })] }));
  assert.equal(s.expensesCents, 0);
  assert.equal(s.ownerPaidExpensesCents, 50000);
  assert.equal(s.ownerProceedsCents, 480000);
});

test('expense tax included, category totals, manual adjustments', () => {
  const s = buildStatement(input({ expenses: [exp('e1', 'Repairs', 10000, { taxCents: 800 })], adjustments: [{ id: 'a1', description: 'Credit', amountCents: -5000 }] }));
  assert.deepEqual(s.expensesByCategory, { Repairs: 10800 });
  assert.equal(s.ownerProceedsCents, 600000 - 10800 - 120000 - 5000);
});

test('rule history: effective-dated rules never change past statements', () => {
  const old = rule({ id: 'old', rateBps: 2000, effectiveTo: '2026-09-30' });
  const nu = rule({ id: 'new', rateBps: 2500, effectiveFrom: '2026-10-01' });
  const sept = buildStatement(input({ rule: selectRule([old, nu], '2026-09-30') }));
  assert.equal(sept.commission.commissionCents, 120000);
  assert.equal(selectRule([old, nu], '2026-10-31').id, 'new');
  assert.throws(() => selectRule([old], '2026-10-31'), /No commission rule/);
  assert.throws(() => selectRule([rule(), rule({ id: 'x' })], '2026-10-31'), /Overlapping/);
});

test('YTD sums finalized statements through the month', () => {
  const sep = buildStatement(input());
  const aug = buildStatement(input({ month: 8 }));
  const y = computeYtd([aug, sep], 2026, 9);
  assert.equal(y.ownerProceedsCents, 800000);
  assert.equal(y.commissionsCents, 240000);
  assert.equal(computeYtd([aug, sep], 2026, 8).ownerProceedsCents, 400000);
});

test('period state machine and locking', () => {
  const p = { id: 'p', year: 2026, month: 9, status: 'DRAFT' as const };
  assert.throws(() => transition(p, 'FINALIZED'), /Illegal/);
  const review = transition(p, 'REVIEW');
  assert.throws(() => transition(review, 'FINALIZED', { criticalExceptions: 1 }), /critical exception/);
  const fin = transition(review, 'FINALIZED', { criticalExceptions: 1, managerAcknowledged: true });
  assert.throws(() => assertEditable(fin), /adjustment/);
  assert.throws(() => transition(fin, 'DRAFT'), /Illegal/);
  assert.doesNotThrow(() => assertEditable(review));
});

test('exceptions: negative proceeds and unmatched revenue are critical', () => {
  const s = buildStatement(input({ expenses: [exp('e', 'Repairs', 900000)] }));
  const ex = evaluateStatement(s, { email: null, emailEnabled: true, whatsappPhone: '+1', whatsappEnabled: true, whatsappOptIn: false },
    { unmatchedTransactions: 2, uncategorizedExpenses: 0, negativeExpenses: 0 });
  const codes = ex.map((e) => e.code);
  for (const c of ['NEGATIVE_OWNER_PROCEEDS', 'UNMATCHED_REVENUE', 'MISSING_OWNER_EMAIL', 'MISSING_WHATSAPP_OPT_IN']) assert.ok(codes.includes(c), c);
  assert.equal(ex.filter((e) => e.severity === 'CRITICAL').length, 2);
});

import { buildAnnualReport } from '../src/accounting/annual.ts';
test('annual report: monthly table, totals, category totals, tax-safe wording', () => {
  const sep = buildStatement(input()); const oct = buildStatement(input({ month: 10, expenses: [exp('e9', 'Repairs', 30000), exp('e8', 'Cleaning', 5000)] }));
  const prior = buildStatement(input({ year: 2025 }));
  const r = buildAnnualReport(2026, [sep, oct, prior]);
  assert.equal(r.months.length, 12);
  assert.equal(r.statementCount, 2, 'other years excluded');
  assert.equal(r.months[8].ownerProceedsCents, 400000);
  assert.equal(r.months[9].ownerProceedsCents, 600000 - 35000 - 120000);
  assert.equal(r.totals.ownerProceedsCents, 400000 + 445000);
  assert.equal(r.totals.commissionCents, 240000);
  assert.deepEqual(r.expenseCategories.find((c) => c.category === 'Repairs'), { category: 'Repairs', cents: 80000 });
  assert.equal(r.totals.ownerProceedsCents, r.months.reduce((a, m) => a + m.ownerProceedsCents, 0));
  assert.match(r.disclaimer, /not a tax return/);
  assert.ok(!/guarantee/i.test(r.explanation));
});

test('expense line text has no dangling colon when there is no description', () => {
  const s = buildStatement(input({ expenses: [{ ...exp('e1', 'Repairs', 100), description: '' }, exp('e2', 'Supplies', 200)] }));
  const text = s.lines.filter((l) => l.type === 'EXPENSE').map((l) => l.description);
  assert.deepEqual(text, ['V', 'V: Supplies']);
});
