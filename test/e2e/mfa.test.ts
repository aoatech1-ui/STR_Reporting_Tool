import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { deriveMfaKeys, totpAt } from '../../src/auth/mfa.ts';
import { buildApp } from '../../src/server/app.ts';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { createOrganization, createUser } from '../../src/repo/orgs.ts';
import { freshDb, skip, tmpStore } from '../db/helper.ts';

const COST = { N: 1024, r: 8, p: 1 };
const PW = 'correct horse battery staple';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/ui-shots';
const E2E_SKIP = skip || (statSafe(CHROME) ? false : `Chromium not found at ${CHROME}`);
function statSafe(p: string) { try { return statSync(p); } catch { return null; } }
const nowCode = (secret: string, offsetSteps = 0) => totpAt(secret, Date.now() / 1000 + offsetSteps * 30);

describe('browser: two-factor login', { skip: E2E_SKIP, timeout: 120_000 }, () => {
  let pool: Pool, closeDb: () => Promise<void>, app: FastifyInstance, browser: Browser, ctx: BrowserContext, page: Page, base: string;
  const problems: string[] = [];

  before(async () => {
    ({ pool, close: closeDb } = await freshDb());
    await withTx(pool, async (tx) => {
      const org = await createOrganization(tx, { legalName: 'Sec LLC', displayName: 'Sec LLC' });
      await createUser(tx, org, { name: 'Ada Admin', email: 'ada@example.com', role: 'ADMIN', password: PW }, COST);
      await createUser(tx, org, { name: 'Mo Manager', email: 'mo@example.com', role: 'MANAGER', password: PW }, COST);
    });
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    app = await buildApp({ pool, config: { baseUrl: base, linkSecret: 'x'.repeat(40), cookieSecure: false, trustProxy: false, allowedOrigins: [base], loginRateLimit: 1000, webhook: {}, scryptCost: COST,
      mfaKeys: deriveMfaKeys('e2e-mfa-master-key-0123456789abcdefghij') }, email: null, files: tmpStore() });
    await app.listen({ port, host: '127.0.0.1' });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    ctx.setDefaultTimeout(10_000);
    page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|415|422)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  });
  after(async () => { await browser?.close(); await app?.close(); await closeDb?.(); });

  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const signIn = async (p: Page, email: string) => { await p.goto(`${base}/login`); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click(); };
  let secret = '', recovery: string[] = [];

  test('enable two-factor: password, QR + key, code, recovery codes shown once', async () => {
    await signIn(page, 'ada@example.com');
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByRole('link', { name: 'Security' }).click();
    await page.getByRole('heading', { name: 'Turn on two-factor login' }).waitFor();
    await page.getByLabel('Confirm your password').fill('wrong wrong wrong');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('alert').getByText(/Password is incorrect/).waitFor();
    await page.getByLabel('Confirm your password').fill(PW);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('img', { name: /QR code/ }).waitFor();
    assert.ok(await page.locator('.qr svg').count(), 'QR code is rendered');
    secret = (await page.getByTestId('totp-secret').innerText()).trim();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await shot('20-mfa-setup');
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await page.getByRole('alert').getByText(/Invalid verification code/).waitFor();
    await page.getByLabel('6-digit code').fill(nowCode(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
    recovery = await page.locator('.recovery-codes code').allInnerTexts();
    assert.equal(recovery.length, 10);
    await shot('21-mfa-recovery');
    assert.equal(await page.getByRole('button', { name: 'Done' }).isDisabled(), true, 'must acknowledge before continuing');
    await page.getByLabel('I have saved these codes').check();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByText('Two-factor login').first().waitFor();
    await page.getByText('10 unused').waitFor();
    await page.reload();
    assert.equal(await page.locator('.recovery-codes').count(), 0, 'codes are not shown again');
  });

  test('sign out, then sign in needs the code; wrong code is rejected; recovery code works once', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);
    await signIn(page, 'ada@example.com');
    await page.getByLabel('Authentication code').waitFor();
    assert.equal(await page.getByLabel('Authentication code').getAttribute('autocomplete'), 'one-time-code');
    await shot('22-mfa-login');
    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.getByRole('alert').getByText(/Invalid verification code/).waitFor();
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(recovery[0]);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.getByRole('heading', { name: 'Security' }).waitFor(); // back to the page they were on
    // same recovery code again fails
    await page.getByRole('button', { name: 'Sign out' }).click(); await page.waitForURL(/\/login/);
    await signIn(page, 'ada@example.com');
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(recovery[0]);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.getByRole('alert').getByText(/Invalid verification code/).waitFor();
    // authenticator code (next step so the replay guard does not apply: the step used at enrolment is spent)
    await page.getByRole('button', { name: 'Use my authenticator app instead' }).click();
    await page.getByLabel('Authentication code').fill(nowCode(secret, 1));
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.getByRole('heading', { name: 'Security' }).waitFor(); // back to the page they were on
  });

  test('administrator requires two-factor for everyone; a user without it is held on the Security page until enrolled', async () => {
    await page.goto(`${base}/security`);
    await page.getByRole('heading', { name: 'Organization policy' }).waitFor();
    await page.getByRole('button', { name: 'Require for everyone' }).click();
    await page.getByText('Required for everyone').waitFor();
    await page.goto(`${base}/settings`);
    await page.getByText('Mo Manager').waitFor();
    await shot('23-users-2fa');
    const row = page.getByRole('row', { name: /Ada Admin/ });
    await row.getByText('2FA', { exact: true }).waitFor();
    // Mo has no 2FA: signing in lands on the enrolment page, and nothing else is reachable
    const mctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const mp = await mctx.newPage();
    await signIn(mp, 'mo@example.com');
    await mp.waitForURL(/\/security$/);
    await mp.getByText(/organization requires two-factor login/i).first().waitFor();
    assert.equal(await mp.getByRole('link', { name: 'Owners' }).count(), 0, 'navigation is reduced to Security');
    await mp.goto(`${base}/owners`);
    await mp.waitForURL(/\/security$/);
    await mp.getByLabel('Confirm your password').fill(PW);
    await mp.getByRole('button', { name: 'Continue' }).click();
    const mSecret = (await mp.getByTestId('totp-secret').innerText()).trim();
    await mp.getByLabel('6-digit code').fill(nowCode(mSecret));
    await mp.getByRole('button', { name: 'Turn on' }).click();
    await mp.getByLabel('I have saved these codes').check();
    await mp.getByRole('button', { name: 'Done' }).click();
    await mp.getByRole('link', { name: 'Owners' }).waitFor();
    await mp.goto(`${base}/owners`);
    await mp.getByRole('heading', { name: 'Owners' }).waitFor();
    await mctx.close();
    // admin can reset Mo's 2FA
    await page.goto(`${base}/settings`);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('row', { name: /Mo Manager/ }).getByRole('button', { name: 'Reset 2FA' }).click();
    await page.getByText('Two-factor login reset').waitFor();
    await page.getByRole('row', { name: /Mo Manager/ }).getByText('No 2FA').waitFor();
  });

  test('turning it off requires password and code (the button is hidden while the policy is on)', async () => {
    await page.goto(`${base}/security`);
    await page.getByRole('button', { name: 'Make optional' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Turn off' }).count(), 0, 'cannot turn off while required');
    await page.getByRole('button', { name: 'Make optional' }).click();
    await page.getByText('Optional', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Turn off' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Password').fill(PW);
    await dlg.getByLabel('Authenticator or recovery code').fill(recovery[1]);
    await dlg.getByRole('button', { name: 'Turn off' }).click();
    await page.getByText('Two-factor login turned off').waitFor();
    await page.getByRole('heading', { name: 'Turn on two-factor login' }).waitFor();
  });

  test('no JavaScript errors or CSP violations occurred', () => { assert.deepEqual(problems, []); });
});
