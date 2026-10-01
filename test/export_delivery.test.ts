import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualOwnerCsv, managerCommissionCsv, monthlyStatementCsv, monthlyTransactionCsv } from '../src/export/csv.ts';
import { buildStatement } from '../src/accounting/statement.ts';
import { deliverStatement, type DeliveryDeps, type DeliveryTarget } from '../src/delivery/delivery.ts';
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
const deps = (o: Partial<DeliveryDeps> = {}) => {
  const sent = { email: [] as any[], wa: [] as any[] };
  const d: DeliveryDeps = { email: { async send(m) { sent.email.push(m); return { messageId: 'em1' }; } },
    whatsapp: { async sendTemplate(m) { sent.wa.push(m); return { messageId: 'wa1' }; } },
    audit: new AuditLog(), linkSecret: 's', baseUrl: 'https://x.test', now: () => 1000, userId: 'u', existing: [], ...o };
  return { d, sent };
};

test('never sends before finalization', async () => {
  const { d, sent } = deps();
  await assert.rejects(() => deliverStatement(target({ statementStatus: 'REVIEW' }), d), /after finalization/);
  assert.equal(sent.email.length + sent.wa.length, 0);
});

test('email + WhatsApp delivery records, audit trail, and WhatsApp omits amounts by default', async () => {
  const { d, sent } = deps();
  const recs = await deliverStatement(target(), d);
  assert.deepEqual(recs.map((r) => [r.channel, r.status, r.providerMessageId]), [['EMAIL', 'SENT', 'em1'], ['WHATSAPP', 'SENT', 'wa1']]);
  assert.match(sent.email[0].text, /\$4,000\.00/);
  assert.ok(!sent.wa[0].params.some((p: string) => p.includes('$')));
  assert.match(sent.wa[0].params.at(-1), /^https:\/\/x\.test\/s\//);
  assert.equal(d.audit.all().length, 2);
});

test('WhatsApp requires opt-in; duplicates need explicit resend; failures are recorded', async () => {
  const noOptIn = deps();
  const r1 = await deliverStatement(target({ owner: { ...target().owner, whatsappOptIn: false } }), noOptIn.d);
  assert.deepEqual(r1.map((r) => r.channel), ['EMAIL']);

  const prior = deps({ existing: r1 });
  assert.equal((await deliverStatement(target({ owner: { ...target().owner, whatsappEnabled: false } }), prior.d)).length, 0);
  const resent = await deliverStatement(target({ owner: { ...target().owner, whatsappEnabled: false } }), prior.d, { resend: true });
  assert.equal(resent[0].resend, true);
  assert.equal(prior.d.audit.all()[0].action, 'STATEMENT_RESENT');

  const failing = deps({ email: { async send() { throw new Error('boom'); } } });
  const f = await deliverStatement(target(), failing.d);
  assert.deepEqual([f[0].status, f[0].error], ['FAILED', 'boom']);
});
