import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnnualReport } from '../src/accounting/annual.ts';
import { buildStatement, computeYtd, STATEMENT_DISCLAIMER, type ExpenseInput } from '../src/accounting/statement.ts';
import { pdfText, renderAnnualPdf, renderStatementPdf, type StatementPdfInput } from '../src/pdf/render.ts';
import { earning, rule } from './helpers.ts';

const HAVE_POPPLER = spawnSync('pdftotext', ['-v']).status !== null;
const skip = HAVE_POPPLER ? false : 'pdftotext (poppler-utils) not installed';
const tmp = mkdtempSync(join(tmpdir(), 'pdf-test-'));
const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const has = (t: string, needle: string) => squash(t).includes(squash(needle)); // headings are letter-spaced in the PDF
const text = (buf: Buffer) => { const f = join(tmp, `${Math.random().toString(36).slice(2)}.pdf`); writeFileSync(f, buf); return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); };
const pages = (buf: Buffer) => { const f = join(tmp, `${Math.random().toString(36).slice(2)}.pdf`); writeFileSync(f, buf); return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [f], { encoding: 'utf8' }))![1]); };

const exp = (n: number, o: Partial<ExpenseInput> = {}): ExpenseInput => ({ id: `e${n}`, date: '2026-09-10', vendor: `Vendor ${n}`, description: n % 2 ? 'Supplies run' : '', category: ['Repairs', 'Supplies', 'Maintenance'][n % 3], amountCents: 10000 + n * 100, taxCents: 0, ownerPaid: false, ...o });
const stmt = (expenses: ExpenseInput[], month = 9) => buildStatement({ ownerId: 'o', propertyId: 'p', periodId: 'x', year: 2026, month, earnings: [earning()], rule: rule(), expenses });
const input = (s = stmt([exp(1, { amountCents: 50000 }), exp(2, { amountCents: 10000 }), exp(3, { amountCents: 20000 })]), o: Partial<StatementPdfInput> = {}): StatementPdfInput => ({
  orgName: 'Manager LLC', statementNumber: 'STM-202609-ABCD1234', generatedAt: '2026-10-02T10:00:00Z', ownerName: 'John Smith', propertyName: '123 Main Street', propertyAddress: '123 Main Street, Austin, TX',
  statement: s, ytd: computeYtd([s], 2026, 9), disclaimer: STATEMENT_DISCLAIMER, ...o });

test('statement PDF: valid file with the full calculation, acceptance figures and disclaimer', { skip }, async () => {
  const buf = await renderStatementPdf(input());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.subarray(-32).toString().includes('%%EOF'));
  const t = text(buf);
  for (const must of ['Owner Statement', 'September 2026', 'John Smith', '123 Main Street, Austin, TX', 'STM-202609-ABCD1234', 'Generated Oct 2, 2026', 'Net Airbnb payout', '$6,000.00',
    'Total property expenses', '$800.00', 'Management fee: 20% × $6,000.00 = $1,200.00', '$1,200.00', 'OWNER NET PROCEEDS', '$4,000.00', 'YTD owner proceeds', 'not tax, legal, or investment advice']) {
    assert.ok(has(t, must), `PDF text contains "${must}"`);
  }
  assert.ok(t.includes('-$800.00') && t.includes('-$1,200.00'), 'deductions are shown negative');
  assert.ok(!t.includes('DRAFT'));
  const n = pages(buf);
  assert.ok(n <= 2);
  assert.ok(t.includes(`Page ${n} of ${n}`));
});

test('statement PDF bytes are deterministic (an archived copy equals a re-render)', async () => {
  const a = await renderStatementPdf(input()), b = await renderStatementPdf(input());
  assert.ok(a.equals(b));
  const changed = await renderStatementPdf(input(stmt([exp(1, { amountCents: 50001 })])));
  assert.ok(!a.equals(changed));
});

test('draft statements are watermarked; finalized ones are not', { skip }, async () => {
  assert.match(text(await renderStatementPdf(input(undefined, { draft: true }))), /DRAFT/);
  assert.ok(!/DRAFT/.test(text(await renderStatementPdf(input()))));
});

test('long statements paginate: header repeats, footer numbers every page, totals appear once, summary is not split', { skip }, async () => {
  const many = Array.from({ length: 60 }, (_, i) => exp(i + 1));
  const buf = await renderStatementPdf(input(stmt(many)));
  const n = pages(buf), t = text(buf);
  assert.ok(n >= 3, `got ${n} pages`);
  for (let i = 1; i <= n; i++) assert.ok(t.includes(`Page ${i} of ${n}`), `footer page ${i}`);
  assert.ok((t.match(/VENDOR AND DESCRIPTION/g) ?? []).length >= 2, 'table header repeats on continuation pages');
  assert.equal((t.match(/Total property expenses/g) ?? []).length, 1);
  assert.equal((t.match(/OWNER NET PROCEEDS/g) ?? []).length, 1);
  const pageOf = (s: string) => t.split('\f').findIndex((pg) => pg.includes(s));
  assert.equal(pageOf('Less: management commission'), pageOf('OWNER NET PROCEEDS'), 'owner summary and proceeds banner share a page');
  for (const e of many) assert.ok(t.includes(e.vendor), e.vendor);
});

test('text safe for standard PDF fonts: Latin-1 kept, others replaced, never throws', { skip }, async () => {
  assert.equal(pdfText('José Müller — 5 × 2 \u2212 3 \u2192 ok'), 'José Müller — 5 × 2 - 3 -> ok');
  assert.equal(pdfText('王小明 Zoë'), '??? Zoë');
  const buf = await renderStatementPdf(input(stmt([exp(1, { vendor: 'Café Müller 王', description: 'tuyau d\'eau — réparé' })]), { ownerName: 'Zoë Łukasz' }));
  const t = text(buf);
  assert.ok(t.includes('Café Müller ?') && t.includes('réparé') && t.includes('Zoë'));
});

test('negative owner proceeds and owner-paid expenses render', { skip }, async () => {
  const t = text(await renderStatementPdf(input(stmt([exp(1, { amountCents: 900000 }), exp(2, { amountCents: 25000, ownerPaid: true })]))));
  assert.match(t, /OWNER NET PROCEEDS\s+-\$/);
  assert.match(t, /not deducted/);
});

test('annual PDF: monthly table, totals, categories, explanation, no tax-return claims', { skip }, async () => {
  const report = buildAnnualReport(2026, [stmt([exp(1, { amountCents: 50000 })], 8), stmt([exp(2, { amountCents: 30000 })], 9)]);
  const buf = await renderAnnualPdf({ orgName: 'Manager LLC', ownerName: 'John Smith', properties: ['123 Main Street'], report, preparedOn: '2026-10-02' });
  const t = text(buf);
  for (const must of ['Annual Owner Statement 2026', 'John Smith', 'January', 'December', 'Total', 'Expenses by category', 'Maintenance', 'Supplies', 'not a tax return', 'Annual owner net proceeds', 'Prepared Oct 2, 2026']) assert.ok(has(t, must), must);
  assert.ok(t.includes(`$${(report.totals.ownerProceedsCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`));
  assert.ok((await renderAnnualPdf({ orgName: 'M', ownerName: 'J', properties: [], report, preparedOn: '2026-10-02' })).subarray(0, 5).toString() === '%PDF-');
});
