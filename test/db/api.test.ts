import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { GRANTS, can, type Role } from '../../src/auth/permissions.ts';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { buildApp } from '../../src/server/app.ts';
import type { AppConfig } from '../../src/server/config.ts';
import { createOrganization, createUser } from '../../src/repo/orgs.ts';
import { buildHandlers } from '../../src/worker/handlers.ts';
import { runOnce } from '../../src/worker/queue.ts';
import type { EmailProvider } from '../../src/email/types.ts';
import { CSV, freshDb, skip, tmpStore } from './helper.ts';

const COST = { N: 1024, r: 8, p: 1 };
const PW = 'correct horse battery staple';
const clock = { t: Date.parse('2026-10-02T10:00:00Z') };
const now = () => new Date(clock.t);
const config = (o: Partial<AppConfig> = {}): AppConfig => ({ baseUrl: 'https://app.test', linkSecret: 'x'.repeat(40), cookieSecure: true, trustProxy: false,
  allowedOrigins: ['https://app.test'], loginRateLimit: 1000, webhook: { token: 'hook-token' }, scryptCost: COST, ...o });

class Client {
  cookie = ''; csrf = '';
  app: FastifyInstance;
  constructor(app: FastifyInstance) { this.app = app; }
  async call(method: string, url: string, body?: unknown, o: { csrf?: string | null; origin?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(this.cookie ? { cookie: this.cookie } : {}), ...(o.headers ?? {}) };
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (o.origin) headers.origin = o.origin;
    return this.app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b?: unknown, o?: Parameters<Client['call']>[3]) => this.call('POST', u, b ?? {}, o);
  async login(email: string, password = PW) {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    if (r.statusCode === 200) { this.cookie = `sid=${r.cookies[0].value}`; this.csrf = r.json().csrfToken; }
    return r;
  }
}

describe('HTTP API', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, app: FastifyInstance;
  const sent: any[] = [];
  const emailProvider: EmailProvider = { name: 'fake', async send(m) { sent.push(m); return { messageId: `em-${sent.length}` }; } };
  const orgA: Record<string, string> = {}, orgB: Record<string, string> = {};
  const as = async (email: string) => { const c = new Client(app); const r = await c.login(email); assert.equal(r.statusCode, 200, `login ${email}`); return c; };
  const files = tmpStore();
  const runWorker = async () => { const h = buildHandlers({ pool, files, email: emailProvider, whatsapp: null, linkSecret: 'x'.repeat(40), baseUrl: 'https://app.test', now: () => clock.t }); while (await runOnce(pool, h)) { /* drain */ } };

  before(async () => {
    ({ pool, close } = await freshDb());
    for (const [org, tag, ids] of [['Manager LLC', 'a', orgA], ['Other LLC', 'b', orgB]] as const) {
      await withTx(pool, async (tx) => {
        ids.orgId = await createOrganization(tx, { legalName: org, displayName: org });
        for (const role of ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
          ids[role] = `${role.toLowerCase()}-${tag}@example.com`;
          await createUser(tx, ids.orgId, { name: role, email: ids[role], role, password: PW }, COST);
        }
      });
    }
    app = await buildApp({ pool, config: config(), email: { id: 'brevo', provider: emailProvider, warnings: [] }, files, now });
  });
  after(async () => { await app.close(); await close(); });

  test('health is public; everything else needs a session', async () => {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    for (const url of ['/api/owners', '/api/dashboard', '/api/audit', '/api/users', '/api/auth/me']) assert.equal((await app.inject(url)).statusCode, 401, url);
    assert.equal((await app.inject({ method: 'GET', url: '/api/owners', headers: { cookie: 'sid=forged' } })).statusCode, 401);
  });

  test('login: cookie flags, generic failure message, no user enumeration, security headers', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ' ADMIN-A@Example.com ', password: PW } });
    assert.equal(ok.statusCode, 200);
    const ck = ok.cookies[0] as any;
    assert.deepEqual([ck.name, ck.httpOnly, ck.secure, String(ck.sameSite).toLowerCase(), ck.path], ['sid', true, true, 'strict', '/']);
    assert.ok(!('passwordHash' in ok.json().user) && ok.json().csrfToken.length >= 40);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.match(String(ok.headers['strict-transport-security']), /max-age/);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'viewer-a@example.com', password: 'nope-nope-nope' } });
    const ghost = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'nope-nope-nope' } });
    assert.deepEqual([wrong.statusCode, ghost.statusCode], [401, 401]);
    assert.equal(wrong.json().error, ghost.json().error);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x', password: PW, extra: 1 } })).statusCode, 400);
  });

  test('lockout after 5 failures (even with the right password), then recovers when the lock expires', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) assert.equal((await c.login('viewer-b@example.com', 'wrong-wrong-wrong')).statusCode, 401);
    assert.equal((await c.login('viewer-b@example.com', PW)).statusCode, 429);
    clock.t += 16 * 60_000;
    assert.equal((await c.login('viewer-b@example.com', PW)).statusCode, 200);
  });

  test('CSRF token and Origin are enforced on every mutating request', async () => {
    const c = await as('manager-a@example.com');
    const body = { legalName: 'CSRF Test', displayName: 'CSRF Test' };
    assert.equal((await c.call('POST', '/api/owners', body, { csrf: null })).statusCode, 403);
    assert.equal((await c.call('POST', '/api/owners', body, { csrf: 'wrong' })).statusCode, 403);
    assert.equal((await c.call('POST', '/api/owners', body, { origin: 'https://evil.test' })).statusCode, 403);
    assert.equal((await c.call('POST', '/api/owners', body, { origin: 'https://app.test' })).statusCode, 201);
    assert.equal((await c.get('/api/owners')).statusCode, 200, 'GET needs no token');
    const other = await as('manager-b@example.com');
    assert.equal((await c.call('POST', '/api/owners', { ...body, displayName: 'x' }, { csrf: other.csrf })).statusCode, 403, "another session's token is useless");
  });

  test('role matrix: every endpoint refuses exactly the roles lacking its permission', async () => {
    const probes: [string, string, unknown, Parameters<typeof can>[1]][] = [
      ['GET', '/api/owners', undefined, 'read'], ['POST', '/api/owners', { legalName: 'R', displayName: 'R' }, 'owners:write'],
      ['POST', '/api/expenses', {}, 'expenses:write'], ['POST', '/api/imports/preview', {}, 'import:write'],
      ['POST', '/api/periods/2026-01/generate', {}, 'period:review'], ['POST', '/api/periods/2026-01/finalize', {}, 'period:finalize'],
      ['POST', '/api/statements/00000000-0000-4000-8000-000000000000/send', {}, 'statements:send'], ['GET', '/api/audit', undefined, 'audit:read'],
      ['GET', '/api/users', undefined, 'users:manage'], ['POST', '/api/properties', {}, 'properties:write'],
      ['POST', '/api/properties/00000000-0000-4000-8000-000000000000/commission-rules', {}, 'commission:write'], ['GET', '/api/settings/email', undefined, 'users:manage'],
    ];
    for (const role of ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
      const c = await as(`${role.toLowerCase()}-a@example.com`);
      for (const [m, url, body, perm] of probes) {
        const r = await c.call(m, url, body);
        if (can(role, perm)) assert.ok(r.statusCode !== 403 && r.statusCode !== 401, `${role} ${m} ${url} should pass the guard, got ${r.statusCode}`);
        else assert.equal(r.statusCode, 403, `${role} ${m} ${url}`);
      }
    }
    assert.ok(GRANTS.ADMIN.size > GRANTS.MANAGER.size);
  });

  test('input validation: strict schemas, ids, integer cents, formats', async () => {
    const c = await as('manager-a@example.com');
    const bad = async (url: string, body: unknown) => { const r = await c.post(url, body); assert.equal(r.statusCode, 400, url + JSON.stringify(body)); return r.json(); };
    assert.ok((await bad('/api/owners', { legalName: 'x', displayName: 'x', isAdmin: true })).issues.length);
    await bad('/api/owners', { legalName: '', displayName: 'x' });
    await bad('/api/expenses', { propertyId: 'not-a-uuid', date: '2026-09-01', vendor: 'v', category: 'c', amountCents: 100 });
    await bad('/api/expenses', { propertyId: '00000000-0000-4000-8000-000000000000', date: '09/01/2026', vendor: 'v', category: 'c', amountCents: 100 });
    await bad('/api/expenses', { propertyId: '00000000-0000-4000-8000-000000000000', date: '2026-09-01', vendor: 'v', category: 'c', amountCents: 10.5 });
    assert.equal((await c.get('/api/expenses?ym=2026-13')).statusCode, 400);
    assert.equal((await c.get('/api/owners/not-a-uuid')).statusCode, 400);
    assert.equal((await c.post('/api/imports/confirm', { filename: 'a.csv', csv: 'x', confirmed: false })).statusCode, 400, 'confirmation is mandatory');
    const r = await c.post('/api/owners', { legalName: 'Bad', displayName: 'Bad', email: 'not-an-email' });
    assert.equal(r.statusCode, 422); assert.match(r.json().error, /Invalid email/);
    assert.equal((await c.post('/api/owners', { legalName: 'Bad', displayName: 'Bad', whatsappPhone: '5551234' })).statusCode, 422);
  });

  test('FULL FLOW over HTTP: setup → import → expenses → close → export → send → public link → webhook', async () => {
    const mgr = await as('manager-a@example.com'), acct = await as('accountant-a@example.com'), viewer = await as('viewer-a@example.com');

    const owner = (await mgr.post('/api/owners', { legalName: 'John Smith', displayName: 'John Smith', email: 'john@example.com' })).json().id;
    const prop = (await mgr.post('/api/properties', { name: '123 Main Street', ownerId: owner, airbnbListingName: '123 Main Street' })).json().id;
    assert.equal((await mgr.post(`/api/properties/${prop}/commission-rules`, { type: 'PERCENT_NET', rateBps: 2000, effectiveFrom: '2026-01-01' })).statusCode, 201);
    assert.equal((await mgr.get(`/api/properties/${prop}`)).json().commissionRules[0].rateBps, 2000);

    const prev = (await acct.post('/api/imports/preview', { filename: 'sep.csv', csv: CSV })).json();
    assert.deepEqual([prev.summary.READY, prev.summary.UNMATCHED_PROPERTY], [2, 1]);
    assert.equal((await mgr.get('/api/dashboard?ym=2026-09')).json().month.revenueCents, 0, 'preview wrote nothing');
    const imp = (await acct.post('/api/imports/confirm', { filename: 'sep.csv', csv: CSV, confirmed: true })).json();
    assert.deepEqual([imp.imported, imp.skipped], [2, 1]);
    assert.equal((await acct.post('/api/imports/confirm', { filename: 'sep.csv', csv: CSV, confirmed: true })).json().imported, 0);

    for (const [v, cat, cents] of [['Fix-It', 'Repairs', 50000], ['Costco', 'Supplies', 10000], ['HVAC', 'Maintenance', 20000]] as const) {
      assert.equal((await acct.post('/api/expenses', { propertyId: prop, date: '2026-09-10', vendor: v, category: cat, amountCents: cents })).statusCode, 201);
    }
    assert.equal((await viewer.get('/api/expenses?ym=2026-09')).json().expenses.length, 3);

    const gen = (await acct.post('/api/periods/2026-09/generate')).json();
    assert.equal(gen.period.status, 'REVIEW');
    assert.ok(gen.exceptions.some((e: any) => e.code === 'UNMATCHED_REVENUE'));
    assert.equal(gen.statements[0].ownerProceedsCents, 400000);
    assert.deepEqual(gen.statements[0].derivation.at(-1), '= owner net proceeds $4,000.00');

    const blocked = await mgr.post('/api/periods/2026-09/finalize', {});
    assert.equal(blocked.statusCode, 422); assert.match(blocked.json().error, /critical exception/);
    const fin = await mgr.post('/api/periods/2026-09/finalize', { acknowledgeCritical: true });
    assert.equal(fin.statusCode, 200); assert.equal(fin.json().period.status, 'FINALIZED');

    const late = await acct.post('/api/expenses', { propertyId: prop, date: '2026-09-20', vendor: 'Late', category: 'Other', amountCents: 100 });
    assert.equal(late.statusCode, 422); assert.match(late.json().error, /FINALIZED/);
    assert.equal((await mgr.post('/api/periods/2026-09/generate')).statusCode, 422);

    const list = (await viewer.get('/api/statements?ym=2026-09')).json().statements;
    assert.equal(list.length, 1); assert.equal(list[0].ownerProceedsCents, 400000);
    const sid = list[0].id;
    const detail = (await viewer.get(`/api/statements/${sid}`)).json();
    assert.equal(detail.statement.detail.commission.explanation, '20% × $6,000.00 = $1,200.00');

    const csv = await viewer.get('/api/exports/monthly-statements.csv?ym=2026-09');
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /statements-2026-09\.csv/);
    assert.match(csv.body, /2026-09,John Smith,123 Main Street,6200\.00,200\.00,0\.00,6000\.00,800\.00,1200\.00,4000\.00/);
    assert.match((await viewer.get('/api/exports/commissions.csv?ym=2026-09')).body, /1200\.00/);
    assert.equal((await viewer.get('/api/exports/annual.csv?year=2026&ownerId=' + owner)).body.trim().split('\r\n').at(-1), 'Total,6200.00,200.00,800.00,1200.00,4000.00');

    assert.equal((await acct.post(`/api/statements/${sid}/send`)).statusCode, 403);
    assert.equal((await viewer.post(`/api/statements/${sid}/send`)).statusCode, 403);
    const q = await mgr.post(`/api/statements/${sid}/send`);
    assert.equal(q.statusCode, 202); assert.equal(q.json().deliveryIds.length, 1);
    assert.equal(sent.length, 0, 'request path never calls the email provider');
    assert.equal((await mgr.post(`/api/statements/${sid}/send`)).json().deliveryIds.length, 0, 'no duplicate');
    await runWorker();
    assert.equal(sent.length, 1);
    const dl = (await mgr.get(`/api/statements/${sid}`)).json().deliveries;
    assert.deepEqual(dl.map((d: any) => d.status), ['SENT']);

    const token = sent[0].text.match(/\/view\/(\S+)/)[1];
    const pub = await app.inject(`/s/${token}`);
    assert.equal(pub.statusCode, 200);
    assert.equal(pub.json().statement.ownerProceedsCents, 400000);
    assert.match(pub.json().disclaimer, /not tax, legal, or investment advice/);
    assert.equal(pub.headers['x-robots-tag'], 'noindex');
    assert.match((await app.inject(`/s/${token}/csv`)).body, /4000\.00/);
    assert.equal((await app.inject(`/s/${token.slice(0, -2)}xx`)).statusCode, 404, 'tampered');
    assert.equal((await app.inject(`/s/${sid}`)).statusCode, 404, 'bare id is not a credential');
    clock.t += 8 * 24 * 3600_000;
    assert.equal((await app.inject(`/s/${token}`)).statusCode, 404, 'expired after 7 days');
    clock.t -= 8 * 24 * 3600_000;
    const views = (await (await as('admin-a@example.com')).get(`/api/audit?entityId=${sid}`)).json().entries;
    assert.ok(views.some((e: any) => e.action === 'STATEMENT_VIEWED' && e.userId === null));

    const hook = (provider: string, token: string | null, body: unknown) => app.inject({ method: 'POST', url: `/webhooks/email/${provider}${token ? `?token=${token}` : ''}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    assert.equal((await hook('brevo', null, { event: 'delivered', 'message-id': '<em-1>' })).statusCode, 401);
    assert.equal((await hook('brevo', 'wrong', { event: 'delivered', 'message-id': '<em-1>' })).statusCode, 401);
    assert.equal((await hook('resend', 'hook-token', {})).statusCode, 404, 'only the configured provider');
    const ok = await hook('brevo', 'hook-token', { event: 'delivered', 'message-id': '<em-1>' });
    assert.deepEqual(ok.json(), { received: 1, applied: 1 });
    assert.equal((await mgr.get(`/api/statements/${sid}`)).json().deliveries[0].status, 'DELIVERED');

    const audit = (await (await as('admin-a@example.com')).get('/api/audit?limit=500')).json().entries.map((e: any) => e.action);
    for (const a of ['OWNER_CREATED', 'PROPERTY_CREATED', 'COMMISSION_CHANGED', 'REVENUE_IMPORTED', 'EXPENSE_CREATED', 'STATEMENTS_GENERATED', 'PERIOD_FINALIZED', 'STATEMENT_FINALIZED', 'STATEMENT_SEND_QUEUED', 'STATEMENT_SENT', 'LOGIN_SUCCEEDED']) assert.ok(audit.includes(a), a);
    assert.deepEqual((await (await as('admin-a@example.com')).get('/api/audit/verify')).json(), { intact: true, firstBrokenId: null });
    const dash = (await mgr.get('/api/dashboard?ym=2026-09')).json();
    assert.deepEqual([dash.month.revenueCents, dash.month.commissionsCents, dash.month.ownerDistributionsCents, dash.unmatchedTransactions, dash.failedDeliveries], [600000, 120000, 400000, 1, 0]);
    Object.assign(orgA, { owner, prop, sid });
  });

  test('UI endpoints: revenue, imports, deliveries, annual, statement detail/CSV, property edit, permissions on login', async () => {
    const mgr = await as('manager-a@example.com'), viewer = await as('viewer-a@example.com');
    const { owner, prop, sid } = orgA;
    const me = (await mgr.get('/api/auth/me')).json();
    assert.ok(me.permissions.includes('period:finalize') && !me.permissions.includes('users:manage'));
    assert.deepEqual((await viewer.get('/api/auth/me')).json().permissions, ['read']);

    const rev = (await viewer.get(`/api/revenue?ym=2026-09&propertyId=${prop}`)).json();
    assert.equal(rev.rows.length, 2);
    assert.deepEqual([rev.totals.grossBookingCents, rev.totals.platformFeeCents, rev.totals.netPayoutCents], [620000, 20000, 600000]);
    assert.equal(rev.rows[0].propertyName, '123 Main Street');
    assert.equal((await viewer.get('/api/revenue?ym=2026-10')).json().rows.length, 0);
    assert.equal((await viewer.get('/api/revenue?ym=bad')).statusCode, 400);

    const imports = (await viewer.get('/api/imports')).json().batches;
    assert.ok(imports.length >= 1);
    assert.deepEqual([imports[imports.length - 1].filename, imports[imports.length - 1].imported], ['sep.csv', 2]);
    assert.equal(imports.reduce((a: number, b: any) => a + b.unmatched, 0), 1, 'unmatched Mystery Cabin row is still open');

    const dels = (await viewer.get('/api/deliveries')).json().deliveries;
    assert.equal(dels.length, 1);
    assert.deepEqual([dels[0].status, dels[0].ownerName, dels[0].recipient, dels[0].month], ['DELIVERED', 'John Smith', 'john@example.com', 9]);
    assert.equal((await viewer.get('/api/deliveries?status=FAILED')).json().deliveries.length, 0);

    const annual = (await viewer.get(`/api/annual?year=2026&ownerId=${owner}`)).json();
    assert.equal(annual.report.totals.ownerProceedsCents, 400000);
    assert.equal(annual.report.months[8].commissionCents, 120000);
    assert.deepEqual(annual.report.expenseCategories.map((c: any) => c.category).sort(), ['Maintenance', 'Repairs', 'Supplies']);
    assert.match(annual.report.disclaimer, /not a tax return/);
    assert.equal(annual.organization.displayName, 'Manager LLC');
    assert.equal((await viewer.get(`/api/annual?year=2026&ownerId=00000000-0000-4000-8000-000000000000`)).statusCode, 404);

    const d = (await viewer.get(`/api/statements/${sid}`)).json();
    assert.equal(d.ytd.ownerProceedsCents, 400000);
    assert.deepEqual([d.property.name, d.owner.displayName, d.organization.displayName], ['123 Main Street', 'John Smith', 'Manager LLC']);
    assert.match(d.disclaimer, /not tax, legal, or investment advice/);
    const csv = await viewer.get(`/api/statements/${sid}/csv`);
    assert.match(csv.body, /4000\.00/); assert.match(String(csv.headers['content-disposition']), /STM-202609-/);

    assert.equal((await viewer.call('PATCH', `/api/properties/${prop}`, { notes: 'x' })).statusCode, 403);
    assert.equal((await mgr.call('PATCH', `/api/properties/${prop}`, { notes: 'Gate code 1234', active: true, extra: 1 })).statusCode, 400, 'strict');
    assert.equal((await mgr.call('PATCH', `/api/properties/${prop}`, { notes: 'Gate code 1234' })).statusCode, 200);
    assert.equal((await mgr.get(`/api/properties/${prop}`)).json().property.notes, 'Gate code 1234');

    const exp = (await viewer.get('/api/expenses?ym=2026-09')).json();
    assert.deepEqual(exp.totals, { chargedCents: 80000, ownerPaidCents: 0 });
    const per = (await viewer.get('/api/periods/2026-09')).json();
    assert.deepEqual([per.totals.netPayoutCents, per.totals.expensesCents, per.totals.commissionCents, per.totals.ownerProceedsCents], [600000, 80000, 120000, 400000]);
    const audit = (await (await as('admin-a@example.com')).get('/api/audit?entityType=expense&limit=5')).json().entries;
    assert.ok(audit.every((e: any) => typeof e.userName === 'string'));
  });

  test('UI serving: SPA shell for browser routes, strict CSP for API, UI CSP for pages, owner link route', async () => {
    const dir = (await import('node:fs')).mkdtempSync('/tmp/webdir-');
    const fs = await import('node:fs');
    fs.mkdirSync(`${dir}/assets`); fs.writeFileSync(`${dir}/index.html`, '<!doctype html><title>SPA</title>'); fs.writeFileSync(`${dir}/assets/app-abc.js`, 'console.log(1)');
    const ui = await buildApp({ pool, config: config(), email: null, now, webDir: dir });
    const html = { accept: 'text/html' };
    const page = await ui.inject({ method: 'GET', url: '/owners', headers: html });
    assert.equal(page.statusCode, 200); assert.match(page.body, /SPA/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await ui.inject({ method: 'GET', url: '/view/some.token.here', headers: html })).statusCode, 200, 'owner link route serves the SPA');
    const asset = await ui.inject('/assets/app-abc.js');
    assert.equal(asset.statusCode, 200); assert.match(String(asset.headers['cache-control']), /immutable/);
    const api = await ui.inject('/api/owners');
    assert.equal(api.statusCode, 401); assert.equal(api.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal((await ui.inject({ method: 'GET', url: '/api/nope', headers: html })).statusCode, 404, 'API paths never get the SPA shell');
    assert.equal((await ui.inject({ method: 'GET', url: '/s/nope', headers: html })).statusCode, 404);
    assert.equal((await ui.inject({ method: 'GET', url: '/missing.js' })).statusCode, 404, 'non-HTML requests get a JSON 404');
    await ui.close(); fs.rmSync(dir, { recursive: true });
  });

  test('tenant isolation: org B sees none of org A over HTTP', async () => {
    const b = await as('admin-b@example.com');
    const { owner, prop, sid } = orgA;
    for (const url of [`/api/owners/${owner}`, `/api/properties/${prop}`, `/api/statements/${sid}`]) assert.equal((await b.get(url)).statusCode, 404, url);
    assert.equal((await b.get('/api/owners')).json().owners.length, 0);
    assert.equal((await b.get('/api/statements')).json().statements.length, 0);
    assert.equal((await b.get('/api/exports/monthly-statements.csv?ym=2026-09')).statusCode, 404);
    assert.equal((await b.post(`/api/statements/${sid}/send`)).statusCode, 404);
    assert.equal((await b.post('/api/expenses', { propertyId: prop, date: '2026-10-01', vendor: 'x', category: 'Other', amountCents: 100 })).statusCode, 404);
    assert.equal((await b.post(`/api/properties/${prop}/commission-rules`, { type: 'FIXED', rateBps: 0, fixedCents: 100, effectiveFrom: '2026-12-01' })).statusCode, 404);
    assert.equal((await b.get('/api/audit')).json().entries.some((e: any) => e.entityId === sid), false);
    assert.equal((await b.get('/api/users')).json().users.every((u: any) => u.email.endsWith('-b@example.com')), true);
  });

  test('user management: deactivation and role change take effect immediately; last-admin and self-lockout guards', async () => {
    const admin = await as('admin-a@example.com'), acct = await as('accountant-a@example.com');
    const users = (await admin.get('/api/users')).json().users;
    const id = (e: string) => users.find((u: any) => u.email === e).id;
    assert.equal((await acct.get('/api/audit')).statusCode, 200);
    assert.equal((await admin.call('PATCH', `/api/users/${id('accountant-a@example.com')}`, { role: 'VIEWER' })).statusCode, 200);
    assert.equal((await acct.get('/api/audit')).statusCode, 403, 'demotion applies to the live session');
    assert.equal((await admin.call('PATCH', `/api/users/${id('accountant-a@example.com')}`, { active: false })).statusCode, 200);
    assert.equal((await acct.get('/api/owners')).statusCode, 401, 'deactivation ends the session');
    assert.equal((await new Client(app).login('accountant-a@example.com')).statusCode, 401);
    assert.equal((await admin.call('PATCH', `/api/users/${id('admin-a@example.com')}`, { active: false })).statusCode, 422, 'cannot deactivate yourself');
    const mgr = await as('manager-a@example.com');
    assert.equal((await admin.call('PATCH', `/api/users/${id('manager-a@example.com')}`, { role: 'ADMIN' })).statusCode, 200);
    assert.equal((await mgr.get('/api/users')).statusCode, 200);
    assert.equal((await admin.post('/api/users', { name: 'Dup', email: 'viewer-a@example.com', role: 'VIEWER', password: PW })).statusCode, 409);
    assert.equal((await admin.post('/api/users', { name: 'Weak', email: 'weak@example.com', role: 'VIEWER', password: 'short' })).statusCode, 422);
    assert.equal((await admin.post('/api/users', { name: 'New', email: 'new@example.com', role: 'VIEWER', password: PW })).statusCode, 201);
  });

  test('password change: needs current password, enforces policy, revokes other sessions', async () => {
    const one = await as('viewer-a@example.com'), two = await as('viewer-a@example.com');
    assert.equal((await one.post('/api/auth/change-password', { currentPassword: 'wrong-wrong-wrong', newPassword: 'another long passphrase' })).statusCode, 403);
    assert.equal((await one.post('/api/auth/change-password', { currentPassword: PW, newPassword: 'short' })).statusCode, 422);
    assert.equal((await one.post('/api/auth/change-password', { currentPassword: PW, newPassword: 'another long passphrase' })).statusCode, 200);
    assert.equal((await one.get('/api/auth/me')).statusCode, 200, 'current session survives');
    assert.equal((await two.get('/api/auth/me')).statusCode, 401, 'other sessions revoked');
    assert.equal((await new Client(app).login('viewer-a@example.com', PW)).statusCode, 401);
    assert.equal((await new Client(app).login('viewer-a@example.com', 'another long passphrase')).statusCode, 200);
  });

  test('logout and idle timeout invalidate the session server-side', async () => {
    const c = await as('manager-b@example.com'); const cookie = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).statusCode, 200);
    const replay = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(replay.statusCode, 401, 'old cookie is dead even if the client kept it');
    const d = await as('manager-b@example.com');
    clock.t += 2 * 3600_000 + 1000;
    assert.equal((await d.get('/api/auth/me')).statusCode, 401, 'idle > 2h');
  });

  test('login is rate limited per client', async () => {
    const limited = await buildApp({ pool, config: config({ loginRateLimit: 3 }), email: null, now });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'whatever-whatever' } })).statusCode);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    await limited.close();
  });

  test('errors never leak internals; unknown routes 404; send without an email provider is a clear 503', async () => {
    const noEmail = await buildApp({ pool, config: config(), email: null, now });
    const c = new Client(noEmail);
    assert.equal((await c.login('manager-a@example.com')).statusCode, 200);
    const r = await c.post(`/api/statements/${orgA.sid}/send`);
    assert.equal(r.statusCode, 503); assert.match(r.json().error, /No email provider/);
    assert.equal((await c.get('/api/does-not-exist')).statusCode, 404);
    assert.equal((await noEmail.inject({ method: 'POST', url: '/webhooks/email/brevo?token=hook-token', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode, 404);
    await noEmail.close();
  });
});
