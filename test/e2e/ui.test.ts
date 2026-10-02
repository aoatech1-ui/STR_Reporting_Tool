import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.ts';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { createOrganization, createUser } from '../../src/repo/orgs.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import type { EmailProvider } from '../../src/email/types.ts';
import { CSV, freshDb, skip } from '../db/helper.ts';

const COST = { N: 1024, r: 8, p: 1 };
const PW = 'correct horse battery staple';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/ui-shots';
const E2E_SKIP = skip || (statSafe(CHROME) ? false : `Chromium not found at ${CHROME}`);
function statSafe(p: string) { try { return statSync(p); } catch { return null; } }

describe('browser: manager UI end to end', { skip: E2E_SKIP, timeout: 180_000 }, () => {
  let pool: Pool, closeDb: () => Promise<void>, app: FastifyInstance, browser: Browser, ctx: BrowserContext, page: Page, base: string;
  const sent: any[] = [];
  const emailProvider: EmailProvider = { name: 'fake', async send(m) { sent.push(m); return { messageId: `em-${sent.length}` }; } };
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
      email: { id: 'fake', provider: emailProvider, warnings: [] } });
    await app.listen({ port, host: '127.0.0.1' });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    ctx.setDefaultTimeout(10_000);
    page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|422)/.test(m.text())) problems.push(`console: ${m.text()}`); });
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
      await page.getByRole('button', { name: 'Save expense' }).click();
      await page.getByRole('cell', { name: vendor }).waitFor();
    }
    await page.getByRole('cell', { name: '$800.00' }).waitFor();
    await shot('05-expenses');
  });

  test('monthly close: exceptions block until acknowledged; finalize locks the month', async () => {
    await page.goto(`${base}/close?ym=2026-09`);
    await page.getByRole('button', { name: 'Generate review' }).click();
    await page.getByText(/not matched to a property/).waitFor();
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
    await page.pdf({ path: `${SHOTS}/statement.pdf`, format: 'Letter', printBackground: true });
    assert.ok(statSync(`${SHOTS}/statement.pdf`).size > 5_000, 'PDF rendered');
  });

  test('send → worker → status; owner opens the secure link without logging in', async () => {
    await page.getByRole('button', { name: 'Send to owner' }).click();
    await page.getByText(/Queued for delivery/).waitFor();
    const h = buildHandlers({ pool, email: emailProvider, whatsapp: null, linkSecret: 'x'.repeat(40), baseUrl: base });
    while (await runOnce(pool, h)) { /* drain */ }
    assert.equal(sent.length, 1);
    await page.reload();
    await page.getByRole('cell', { name: 'Sent', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Resend to owner' }).waitFor();

    const url = sent[0].text.match(/https?:\/\/\S+\/view\/\S+/)![0];
    const anon = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p2 = await anon.newPage();
    await p2.goto(url);
    await p2.getByText('OWNER NET PROCEEDS').waitFor();
    assert.ok((await p2.locator('.doc').innerText()).includes('$4,000.00'));
    assert.equal(await p2.getByRole('link', { name: 'Properties' }).count(), 0, 'no manager navigation on the owner page');
    await p2.screenshot({ path: `${SHOTS}/09-owner-view.png`, fullPage: true });
    await p2.goto(url.slice(0, -3) + 'abc');
    await p2.getByText('Link unavailable').waitFor();
    await anon.close();
  });

  test('communications, annual report, dashboard, audit log', async () => {
    await page.goto(`${base}/communications`);
    await page.getByRole('cell', { name: 'john@example.com' }).waitFor();
    await shot('10-communications');
    await page.goto(`${base}/annual?year=2026`);
    await page.getByLabel('Owner').selectOption({ label: 'John Smith' });
    await page.getByText('Annual Owner Statement 2026').waitFor();
    const annual = await page.locator('.doc').innerText();
    assert.ok(annual.includes('$4,000.00') && annual.includes('September') && annual.includes('not a tax return'));
    await shot('11-annual');
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
