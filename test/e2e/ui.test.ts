import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.ts';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { createOrganization, createUser } from '../../src/repo/orgs.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import type { EmailProvider } from '../../src/email/types.ts';
import { createWhatsAppProvider } from '../../src/whatsapp/factory.ts';
import type { WhatsAppMessage, WhatsAppProvider } from '../../src/whatsapp/types.ts';
import { CSV, freshDb, skip, tmpStore } from '../db/helper.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const COST = { N: 1024, r: 8, p: 1 };
const PW = 'correct horse battery staple';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/ui-shots';
const E2E_SKIP = skip || (statSafe(CHROME) ? false : `Chromium not found at ${CHROME}`);
function statSafe(p: string) { try { return statSync(p); } catch { return null; } }

describe('browser: manager UI end to end', { skip: E2E_SKIP, timeout: 180_000 }, () => {
  let pool: Pool, closeDb: () => Promise<void>, app: FastifyInstance, browser: Browser, ctx: BrowserContext, page: Page, base: string;
  const files = tmpStore();
  const sent: any[] = [];
  const emailProvider: EmailProvider = { name: 'fake', async send(m) { sent.push(m); return { messageId: `em-${sent.length}` }; } };
  const sentWa: WhatsAppMessage[] = [];
  const waProvider: WhatsAppProvider = { name: 'fake', async sendTemplate(m) { sentWa.push(m); return { messageId: `wamid.e2e${sentWa.length}` }; } };
  const WA_ENV = { WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_TOKEN: 't', WHATSAPP_META_PHONE_NUMBER_ID: '1', WHATSAPP_META_APP_SECRET: 'e2e-app-secret', WHATSAPP_VERIFY_TOKEN: 'vt' };
  const problems: string[] = [];

  before(async () => {
    mkdirSync(SHOTS, { recursive: true });
    ({ pool, close: closeDb } = await freshDb());
    await withTx(pool, async (tx) => {
      const org = await createOrganization(tx, { legalName: 'Manager LLC', displayName: 'Manager LLC' });
      await createUser(tx, org, { name: 'Maria Manager', email: 'maria@example.com', role: 'MANAGER', password: PW }, COST);
      await createUser(tx, org, { name: 'Vic Viewer', email: 'vic@example.com', role: 'VIEWER', password: PW }, COST);
    });
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    app = await buildApp({ pool, config: { baseUrl: base, linkSecret: 'x'.repeat(40), cookieSecure: false, trustProxy: false, allowedOrigins: [base], loginRateLimit: 1000, webhook: {}, scryptCost: COST },
      email: { id: 'fake', provider: emailProvider, warnings: [] }, whatsapp: { ...createWhatsAppProvider(WA_ENV)!, provider: waProvider }, files });
    await app.listen({ port, host: '127.0.0.1' });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    ctx.setDefaultTimeout(10_000);
    page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|415|422)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  });
  after(async () => { await browser?.close(); await app?.close(); await closeDb?.(); });

  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const login = async (p: Page, email: string, pw = PW) => { await p.goto(`${base}/login`); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw); await p.getByRole('button', { name: 'Sign in' }).click(); };

  test('unauthenticated visitors are sent to login; bad password shows an error', async () => {
    await page.goto(`${base}/owners`);
    await page.waitForURL(/\/login/);
    await shot('01-login');
    await login(page, 'maria@example.com', 'wrong-password-123');
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Invalid email or password/);
    await login(page, 'maria@example.com');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    assert.match(page.url(), /\/owners$/, 'returns to the page originally requested');
    await page.goto(`${base}/`);
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  });

  test('create owner and property with commission', async () => {
    await page.getByRole('link', { name: 'Owners' }).click();
    await page.getByRole('button', { name: 'Add owner' }).click();
    await page.getByLabel('Legal name').fill('John Smith');
    await page.getByLabel('Display name').fill('John Smith');
    await page.getByLabel('Primary email').fill('john@example.com');
    await page.getByRole('button', { name: 'Save owner' }).click();
    await page.getByRole('cell', { name: /John Smith/ }).first().waitFor();

    await page.getByRole('link', { name: 'Properties' }).click();
    await page.getByRole('button', { name: 'Add property' }).click();
    await page.getByLabel('Property name').fill('123 Main Street');
    await page.getByLabel('Street address').fill('123 Main Street');
    await page.getByLabel('City').fill('Austin');
    await page.getByLabel('Airbnb listing name').fill('123 Main Street');
    await page.getByRole('button', { name: 'Save property' }).click();
    await page.getByRole('heading', { name: '123 Main Street' }).waitFor();
    await page.getByRole('tab', { name: 'Commission' }).click();
    await page.getByText('20% of Airbnb net payout').first().waitFor();
    await shot('02-property-commission');
  });

  test('Airbnb import: preview shows unmatched listing, requires confirmation, then imports', async () => {
    await page.getByRole('link', { name: 'Airbnb import' }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'september.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.getByRole('button', { name: 'Check file' }).click();
    await page.locator('.chips').getByText('ready to import').waitFor();
    assert.match(await page.locator('.chips').innerText(), /2\s*ready to import/);
    await page.getByText('Mystery Cabin').first().waitFor();
    await shot('03-import-preview');
    await page.getByRole('button', { name: /Continue with 2 transactions/ }).click();
    const importBtn = page.getByRole('button', { name: 'Import transactions' });
    assert.equal(await importBtn.isDisabled(), true, 'cannot import until the box is ticked');
    await page.getByLabel(/I have reviewed the preview/).check();
    await importBtn.click();
    await page.getByText('Import complete').waitFor();
    assert.match(await page.locator('.chips').first().innerText(), /2\s*imported/);
  });

  test('revenue shows booking vs payout; expenses are entered in dollars', async () => {
    await page.goto(`${base}/revenue?ym=2026-09`);
    await page.getByRole('cell', { name: '$6,000.00' }).last().waitFor();
    await shot('04-revenue');
    await page.goto(`${base}/expenses?ym=2026-09`);
    for (const [vendor, cat, amt] of [['Fix-It Roofing', 'Repairs', '500'], ['Costco', 'Supplies', '100.00'], ['HVAC Co', 'Maintenance', '200']]) {
      await page.getByRole('button', { name: 'Add expense' }).click();
      await page.getByLabel('Vendor').fill(vendor);
      await page.getByLabel('Category').fill(cat);
      await page.getByLabel('Amount ($)').fill(amt);
      if (vendor === 'Fix-It Roofing') await page.getByLabel('Receipt (optional)').setInputFiles({ name: 'roof receipt.png', mimeType: 'image/png', buffer: PNG });
      await page.getByRole('button', { name: 'Save expense' }).click();
      await page.getByRole('cell', { name: vendor }).waitFor();
    }
    await page.getByRole('cell', { name: '$800.00' }).waitFor();
    await page.getByText('1 receipt', { exact: true }).waitFor();
    assert.equal(await page.getByText('Missing', { exact: true }).count(), 2, 'the two expenses over $75 without a receipt are flagged');
    await shot('05-expenses');
  });

  test('expense detail: attach a receipt, see its thumbnail, remove it, attach again', async () => {
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}/expenses?ym=2026-09`);
    await page.getByRole('link', { name: 'Costco' }).click();
    await page.getByText('No receipt attached').waitFor();
    await page.getByLabel('Attach a receipt').setInputFiles({ name: 'costco.png', mimeType: 'image/png', buffer: PNG });
    await page.getByText('Receipt attached').waitFor();
    await page.getByRole('link', { name: 'costco.png' }).waitFor();
    const img = page.locator('img[src*="/preview"]');
    await img.waitFor();
    assert.ok(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), 'thumbnail actually loads (CSP allows it)');
    await shot('05b-expense-receipt');
    // a non-receipt is refused with a clear message
    await page.getByLabel('Attach a receipt').setInputFiles({ name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script>') });
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Unsupported file/);
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByText('No receipt attached').waitFor();
    await page.getByLabel('Attach a receipt').setInputFiles({ name: 'costco-again.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('link', { name: 'costco-again.png' }).waitFor();
  });

  test('monthly close: exceptions block until acknowledged; finalize locks the month', async () => {
    await page.goto(`${base}/close?ym=2026-09`);
    await page.getByRole('button', { name: 'Generate review' }).click();
    await page.getByText(/not matched to a property/).waitFor();
    await page.getByText(/1 expense\(s\) of \$75\.00 or more have no receipt attached/).waitFor();
    await page.getByRole('cell', { name: '$4,000.00' }).first().waitFor();
    await shot('06-close-review');
    await page.getByRole('button', { name: 'Finalize September 2026' }).click();
    const confirm = page.getByRole('button', { name: 'Finalize and lock' });
    assert.equal(await confirm.isDisabled(), true, 'critical exception requires acknowledgement');
    await page.getByLabel(/I have reviewed these issues/).check();
    await confirm.click();
    await page.getByText(/Figures are locked/).waitFor();
    await page.getByRole('button', { name: 'Send all statements' }).waitFor();
    await shot('07-close-finalized');
    // locked month: adding an expense is rejected with a clear message
    await page.goto(`${base}/expenses?ym=2026-09`);
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByLabel('Vendor').fill('Too late');
    await page.getByLabel('Amount ($)').fill('10');
    await page.getByRole('button', { name: 'Save expense' }).click();
    assert.match(await page.getByRole('alert').innerText(), /FINALIZED/);
  });

  test('statement preview shows the full calculation and prints to PDF', async () => {
    await page.goto(`${base}/statements`);
    await page.getByRole('link', { name: /^STM-/ }).click();
    await page.getByText('OWNER NET PROCEEDS').waitFor();
    const doc = page.locator('.doc');
    const text = await doc.innerText();
    for (const expect of ['Owner Statement', 'September 2026', 'John Smith', '123 Main Street', 'Net Airbnb payout', '$6,000.00', 'Fix-It Roofing', 'Total property expenses', '$800.00',
      '20% × $6,000.00 = $1,200.00', '$1,200.00', '$4,000.00', 'YTD owner proceeds', 'not tax, legal, or investment advice']) assert.ok(text.includes(expect), `statement contains "${expect}"`);
    await shot('08-statement');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download PDF' }).click()]);
    const pdfPath = `${SHOTS}/downloaded-statement.pdf`;
    await dl.saveAs(pdfPath);
    assert.match(dl.suggestedFilename(), /^STM-202609-[0-9A-F]{8}\.pdf$/);
    assert.equal(readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');
    const pdfTxt = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
    for (const must of ['$4,000.00', '$1,200.00', '20% × $6,000.00 = $1,200.00', 'Fix-It Roofing', 'John Smith']) assert.ok(pdfTxt.includes(must), `downloaded PDF contains ${must}`);
    await page.pdf({ path: `${SHOTS}/statement.pdf`, format: 'Letter', printBackground: true });
    assert.ok(statSync(`${SHOTS}/statement.pdf`).size > 5_000, 'PDF rendered');
  });

  test('send → worker → status; owner opens the secure link without logging in', async () => {
    await page.getByRole('button', { name: 'Send to owner' }).click();
    await page.getByText(/Queued for delivery/).waitFor();
    const h = buildHandlers({ pool, files, email: emailProvider, whatsapp: waProvider, linkSecret: 'x'.repeat(40), baseUrl: base });
    while (await runOnce(pool, h)) { /* drain */ }
    assert.equal(sent.length, 1);
    await page.reload();
    await page.getByRole('cell', { name: 'Sent', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Resend to owner' }).waitFor();
    await page.getByText(/PDF archived \(SHA-256/).waitFor();

    const url = sent[0].text.match(/https?:\/\/\S+\/view\/\S+/)![0];
    const anon = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p2 = await anon.newPage();
    await p2.goto(url);
    await p2.getByText('OWNER NET PROCEEDS').waitFor();
    assert.ok((await p2.locator('.doc').innerText()).includes('$4,000.00'));
    assert.equal(await p2.getByRole('link', { name: 'Properties' }).count(), 0, 'no manager navigation on the owner page');
    await p2.screenshot({ path: `${SHOTS}/09-owner-view.png`, fullPage: true });
    const [odl] = await Promise.all([p2.waitForEvent('download'), p2.getByRole('link', { name: 'Download PDF' }).click()]);
    await odl.saveAs(`${SHOTS}/owner-statement.pdf`);
    assert.equal(readFileSync(`${SHOTS}/owner-statement.pdf`).subarray(0, 5).toString(), '%PDF-', 'owner can download the PDF without logging in');
    await p2.goto(url.slice(0, -3) + 'abc');
    await p2.getByText('Link unavailable').waitFor();
    await anon.close();
  });

  test('WhatsApp: enable it on the owner in the UI, send, see it in Communications, owner replies STOP and the UI reflects it', async () => {
    // enabling via the owner edit form (also covers the form submitting only its own fields)
    await page.goto(`${base}/owners`);
    await page.getByRole('link', { name: 'John Smith' }).first().click();
    await page.getByRole('button', { name: 'Edit owner' }).click();
    await page.getByLabel('WhatsApp number').fill('+15551230000');
    await page.getByLabel('WhatsApp notifications').check();
    await page.getByLabel('Owner has opted in to WhatsApp').check();
    await page.getByRole('button', { name: 'Save owner' }).click();
    await page.getByText('Owner updated').waitFor();
    await page.getByText('Enabled, opted in').waitFor();

    // resend the September statement: email AND WhatsApp are queued
    await page.goto(`${base}/statements`);
    await page.getByRole('link', { name: /^STM-/ }).click();
    await page.getByRole('button', { name: 'Resend to owner' }).click();
    await page.getByText(/Queued for delivery/).waitFor();
    const h = buildHandlers({ pool, files, email: emailProvider, whatsapp: waProvider, linkSecret: 'x'.repeat(40), baseUrl: base });
    while (await runOnce(pool, h)) { /* drain */ }
    assert.equal(sentWa.length, 1);
    assert.deepEqual([sentWa[0].to, sentWa[0].template], ['+15551230000', 'statement_ready']);
    assert.ok(!sentWa[0].params.some((p) => p.includes('$')), 'no dollar amount in the WhatsApp message');
    await page.goto(`${base}/communications`);
    await page.getByRole('cell', { name: '+15551230000' }).waitFor();
    await shot('10b-communications-whatsapp');

    // the owner replies STOP (signed Meta webhook)
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{ from: '15551230000', id: 'wamid.in1', type: 'text', text: { body: 'STOP' } }] } }] }] });
    const res = await fetch(`${base}/webhooks/whatsapp/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'e2e-app-secret').update(raw).digest('hex')}` }, body: raw });
    assert.deepEqual(await res.json(), { received: 1, applied: 0, optedOut: 1 });
    await page.goto(`${base}/owners`);
    await page.getByRole('link', { name: 'John Smith' }).first().click();
    await page.getByText('Opted out', { exact: true }).waitFor();
    await page.getByText(/replied STOP on/).waitFor();
    await shot('10c-owner-opted-out');
    // the statement can no longer go to WhatsApp, only email
    await page.goto(`${base}/integrations`);
    await page.getByText('Meta Cloud API').waitFor();
    await page.getByText('statement_ready', { exact: true }).waitFor();
    await shot('10d-integrations-whatsapp');
  });

  test('communications, annual report, dashboard, audit log', async () => {
    await page.goto(`${base}/communications`);
    await page.getByRole('cell', { name: 'john@example.com' }).first().waitFor();
    await shot('10-communications');
    await page.goto(`${base}/annual?year=2026`);
    await page.getByLabel('Owner').selectOption({ label: 'John Smith' });
    await page.getByText('Annual Owner Statement 2026').waitFor();
    const annual = await page.locator('.doc').innerText();
    assert.ok(annual.includes('$4,000.00') && annual.includes('September') && annual.includes('not a tax return'));
    await shot('11-annual');
    const [adl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download PDF' }).click()]);
    await adl.saveAs(`${SHOTS}/annual.pdf`);
    assert.ok(execFileSync('pdftotext', ['-layout', `${SHOTS}/annual.pdf`, '-'], { encoding: 'utf8' }).includes('$4,000.00'));
    await page.goto(`${base}/?ym=2026-09`);
    await page.getByText('Owner distributions').waitFor();
    await page.getByText('Needs attention').waitFor();
    await shot('12-dashboard');
    await page.goto(`${base}/audit`);
    await page.getByRole('button', { name: 'Verify log integrity' }).click();
    await page.getByText(/audit trail is intact/).waitFor();
    await shot('13-audit');
    await page.goto(`${base}/integrations`);
    await page.getByText('Airbnb CSV import').waitFor();
    await shot('14-integrations');
  });

  test('month-end: live checklist on the close page; reminder schedule, test send through the worker, personal opt-out', async () => {
    await page.goto(`${base}/close?ym=2026-09`);
    const cl = page.getByRole('list', { name: 'Month-end checklist' });
    await cl.getByText('Statements finalized').waitFor();
    await cl.getByText('Airbnb earnings imported').waitFor();
    await page.goto(`${base}/settings`);
    const card = page.locator('.card', { has: page.getByRole('heading', { name: /Month-end reminders/ }) });
    await card.getByText('Off', { exact: true }).waitFor();
    await card.getByLabel('Send month-end reminders').check();
    await card.getByRole('group', { name: 'Day of the next month' }).getByRole('button', { name: '3rd' }).click();
    await card.getByLabel('Time zone').selectOption('America/New_York');
    await card.getByRole('button', { name: 'Save schedule' }).click();
    await page.getByText('Reminder schedule saved').waitFor();
    await card.getByText('On', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '3rd' }).getAttribute('aria-pressed'), 'true');
    assert.ok(await card.getByRole('heading', { name: 'Next reminders' }).locator('..').locator('li').count() >= 1, 'upcoming reminders listed');
    await card.getByText('maria@example.com').waitFor(); // recipients
    const before = sent.length;
    await card.getByRole('button', { name: 'Send me a test' }).click();
    await page.getByText(/Test reminder queued for maria@example.com/).waitFor();
    const h = buildHandlers({ pool, files, email: emailProvider, whatsapp: waProvider, linkSecret: 'x'.repeat(40), baseUrl: base });
    while (await runOnce(pool, h)) { /* drain */ }
    const mail = sent.slice(before).find((m) => m.subject.startsWith('[Test]'));
    assert.ok(mail, 'test reminder emailed'); assert.deepEqual(mail.to, ['maria@example.com']);
    assert.match(mail.text, /\/close\?ym=\d{4}-\d{2}/);
    await page.reload();
    await card.getByRole('cell', { name: 'Test' }).waitFor();
    await card.getByText('1 recipient').waitFor();
    await shot('16-reminders');
    await page.getByLabel(/Email me month-end reminders/).uncheck();
    await page.getByText('Month-end reminders turned off for you').waitFor();
    await page.reload();
    assert.equal(await page.getByLabel(/Email me month-end reminders/).isChecked(), false);
    assert.equal(await card.getByText('maria@example.com').count(), 0, 'no longer a recipient');
  });

  test('recurring expenses: create, posted into this month automatically, skip next time, link from the expense', async () => {
    await page.goto(`${base}/recurring`);
    await page.getByText(/No recurring expenses yet/).waitFor();
    await page.getByRole('button', { name: 'Add recurring expense' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Vendor').fill('City Water');
    await dlg.getByLabel('Category').fill('Utilities');
    await dlg.getByLabel('Amount ($)').fill('64.20');
    await dlg.getByLabel('Repeats').selectOption({ label: 'Monthly' });
    await dlg.getByLabel('On day').selectOption({ label: '1st' });
    await dlg.getByRole('button', { name: 'Create' }).click();
    await page.getByText(/Recurring expense created\. 1 expense posted/).waitFor();
    await page.getByRole('heading', { name: 'Recurring expense' }).waitFor();
    await page.getByText('Monthly, on the 1st').waitFor();
    await shot('17-recurring-detail');
    // skip the next month, then undo
    const up = page.locator('.card', { has: page.getByRole('heading', { name: 'Upcoming' }) });
    await up.getByRole('button', { name: /^Skip / }).first().click();
    await page.getByText(/skipped$/).waitFor();
    await up.getByText('Skipped').waitFor();
    await up.getByRole('button', { name: 'Undo skip' }).click();
    await page.getByText(/will be posted$/).waitFor();
    // the posted expense is an ordinary expense in this month, linked back
    await page.getByRole('link', { name: 'View expense' }).click();
    await page.getByRole('link', { name: 'Posted from a recurring expense' }).waitFor();
    assert.ok((await page.locator('.card').first().innerText()).includes('$64.20'));
    const ym = new Date().toISOString().slice(0, 7);
    await page.goto(`${base}/expenses?ym=${ym}`);
    await page.getByRole('row', { name: /City Water/ }).getByText('Recurring').waitFor();
    await page.goto(`${base}/recurring`);
    await page.getByRole('row', { name: /City Water/ }).waitFor();
    await shot('18-recurring-list');
  });

  test('viewer role: read-only UI, no action buttons, API refuses writes', async () => {
    const vctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const vp = await vctx.newPage();
    await login(vp, 'vic@example.com');
    await vp.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await vp.goto(`${base}/owners`);
    await vp.getByRole('cell', { name: /John Smith/ }).first().waitFor();
    assert.equal(await vp.getByRole('button', { name: 'Add owner' }).count(), 0);
    assert.equal(await vp.getByRole('link', { name: 'Audit log' }).count(), 0);
    await vp.goto(`${base}/statements`); await vp.getByRole('link', { name: /^STM-/ }).click();
    await vp.getByText('OWNER NET PROCEEDS').waitFor();
    assert.equal(await vp.getByRole('button', { name: /Send to owner|Resend to owner/ }).count(), 0);
    await vp.goto(`${base}/close?ym=2026-09`);
    await vp.getByText(/Figures are locked/).waitFor();
    assert.equal(await vp.getByRole('button', { name: 'Send all statements' }).count(), 0);
    await vctx.close();
  });

  test('layout works at phone width and sign-out ends the session', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${base}/close?ym=2026-09`);
    await page.getByRole('heading', { name: /Close September 2026/ }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await shot('15-mobile-close');
    assert.equal(overflow, false, 'page itself must not scroll horizontally (tables scroll inside their cards)');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);
    await page.goto(`${base}/owners`);
    await page.waitForURL(/\/login/);
  });

  test('no JavaScript errors or CSP violations occurred during the whole session', () => {
    assert.deepEqual(problems, []);
  });
});
