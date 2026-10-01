import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualOwnerCsv, managerCommissionCsv, monthlyStatementCsv, monthlyTransactionCsv } from '../src/export/csv.ts';
import { buildStatement } from '../src/accounting/statement.ts';
import { composeEmail, composeWhatsApp, planDeliveries, type DeliveryTarget } from '../src/delivery/delivery.ts';
import { signLink, verifyLink } from '../src/delivery/links.ts';
import { AuditLog } from '../src/audit.ts';
import { csvCell, parseCsv } from '../src/csv.ts';
import { earning, rule } from './helpers.ts';

const stmt = () => buildStatement({ ownerId: 'o', propertyId: 'p', periodId: 'per', year: 2026, month: 9, earnings: [earning()], rule: rule(),
  expenses: [{ id: 'e1', date: '2026-09-10', vendor: 'Acme', description: 'Fix', category: 'Repairs', amountCents: 80000, taxCents: 0, ownerPaid: false }] });
const rows = () => [{ ownerName: 'John Smith', propertyName: '123 Main Street', statement: stmt() }];

test('monthly statement CSV is deterministic with documented columns', () => {
  const a = monthlyStatementCsv(rows()), b = monthlyStatementCsv(rows());
  assert.equal(a, b);
  const [head, line] = parseCsv(a);
  assert.deepEqual(head.slice(0, 3), ['Statement Month', 'Owner', 'Property']);
  assert.deepEqual(line, ['2026-09', 'John Smith', '123 Main Street', '7000.00', '1000.00', '0.00', '6000.00', '800.00', '1200.00', '4000.00']);
});

test('commission, transaction and annual CSVs', () => {
  assert.match(managerCommissionCsv(rows()), /20% × \$6,000\.00 = \$1,200\.00/);
  const tx = parseCsv(monthlyTransactionCsv(rows()));
  assert.equal(tx.length, 1 + 3); // earnings, expense, commission
  const annual = parseCsv(annualOwnerCsv(2026, [stmt()]));
  assert.equal(annual.length, 1 + 12 + 1);
  assert.deepEqual(annual.at(-1), ['Total', '7000.00', '1000.00', '800.00', '1200.00', '4000.00']);
});

test('CSV cells neutralize formula injection and quote specials', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('-12.00', { numeric: true }), '-12.00');
});

test('signed links verify, expire and reject tampering', () => {
  const t = signLink('st1', 'secret', 2000);
  assert.deepEqual(verifyLink(t, 'secret', 1000), { ok: true, statementId: 'st1' });
  assert.deepEqual(verifyLink(t, 'secret', 3000), { ok: false, reason: 'EXPIRED' });
  assert.equal(verifyLink(t.replace('st1', 'st2'), 'secret', 1000).ok, false);
  assert.equal(verifyLink(t, 'other', 1000).ok, false);
});

test('audit log is hash-chained and detects tampering', () => {
  const log = new AuditLog();
  log.append({ userId: 'u', action: 'EXPENSE_CREATED', entityType: 'expense', entityId: 'e1', oldValue: null, newValue: { a: 1 }, at: 't' });
  log.append({ userId: 'u', action: 'STATEMENT_FINALIZED', entityType: 'statement', entityId: 's1', oldValue: null, newValue: null, at: 't' });
  assert.ok(log.verify());
  const tampered = log.all().map((e, i) => (i === 0 ? { ...e, newValue: { a: 2 } } : e));
  assert.equal(log.verify(tampered), false);
});

const target = (o: Partial<DeliveryTarget> = {}): DeliveryTarget => ({ statementId: 'st1', statementStatus: 'FINALIZED', propertyName: '123 Main Street',
  monthLabel: 'September 2026', ownerProceedsCents: 400000,
  owner: { emails: ['john@example.com'], emailEnabled: true, whatsappPhone: '+15550001', whatsappEnabled: true, whatsappOptIn: true }, ...o });

test('never plans a send before finalization', () => {
  assert.throws(() => planDeliveries(target({ statementStatus: 'REVIEW' }), []), /after finalization/);
  assert.throws(() => planDeliveries(target({ statementStatus: 'DRAFT' }), []), /after finalization/);
});

test('plans email + WhatsApp; WhatsApp requires opt-in; unavailable channels are skipped', () => {
  assert.deepEqual(planDeliveries(target(), []).map((p) => p.channel), ['EMAIL', 'WHATSAPP']);
  assert.deepEqual(planDeliveries(target({ owner: { ...target().owner, whatsappOptIn: false } }), []).map((p) => p.channel), ['EMAIL']);
  assert.deepEqual(planDeliveries(target(), [], { whatsappAvailable: false }).map((p) => p.channel), ['EMAIL']);
  assert.deepEqual(planDeliveries(target(), [], { emailAvailable: false }).map((p) => p.channel), ['WHATSAPP']);
  const two = planDeliveries(target({ owner: { ...target().owner, emails: ['a@x.com', 'b@x.com'] } }), []);
  assert.equal(two[0].recipient, 'a@x.com,b@x.com');
});

test('a live delivery blocks duplicates (incl. QUEUED); failed/bounced do not; resend overrides', () => {
  const ex = (status: any) => [{ statementId: 'st1', channel: 'EMAIL' as const, status }];
  for (const s of ['QUEUED', 'SENT', 'DELIVERED']) assert.ok(!planDeliveries(target(), ex(s)).some((p) => p.channel === 'EMAIL'), s);
  for (const s of ['FAILED', 'BOUNCED']) assert.ok(planDeliveries(target(), ex(s)).some((p) => p.channel === 'EMAIL'), s);
  assert.ok(planDeliveries(target(), ex('DELIVERED'), { resend: true }).some((p) => p.channel === 'EMAIL'));
});

test('email is escaped; WhatsApp omits amounts unless opted in', () => {
  const e = composeEmail({ monthLabel: 'September 2026', propertyName: '<b>Evil & Co</b>', ownerProceedsCents: 400000 }, 'https://x.test/s/t?a=1&b="2"');
  assert.match(e.text, /\$4,000\.00/);
  assert.ok(!e.html.includes('<b>Evil'));
  assert.match(e.html, /&lt;b&gt;Evil &amp; Co&lt;\/b&gt;/);
  assert.match(e.html, /a=1&amp;b=&quot;2&quot;/);
  assert.equal(e.subject.includes('\n'), false);
  assert.ok(!composeWhatsApp(target(), 'https://x.test/s/t').params.some((p) => p.includes('$')));
  assert.ok(composeWhatsApp(target(), 'https://x.test/s/t', true).params.includes('$4,000.00'));
});
