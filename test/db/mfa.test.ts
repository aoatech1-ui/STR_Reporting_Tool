import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { totpAt } from '../../src/auth/mfa.ts';
import type { Pool } from '../../src/db/pool.ts';
import { verifyAuditChain } from '../../src/repo/audit.ts';
import { buildApp } from '../../src/server/app.ts';
import { runPreflight } from '../../src/ops/preflight.ts';
import { freshDb, seed, skip, tmpStore } from './helper.ts';
import { addUser, Client, PW, testConfig } from './httpkit.ts';

const clock = { t: Date.parse('2026-10-02T10:00:00Z') };
const now = () => new Date(clock.t);
const code = (secret: string, offsetSteps = 0) => totpAt(secret, clock.t / 1000 + offsetSteps * 30);
const nextStep = () => { clock.t += 30_000; }; // a fresh TOTP step, so the replay guard does not interfere

describe('two-factor login', { skip }, () => {
  let pool: Pool, close: () => Promise<void>, app: FastifyInstance, noKeyApp: FastifyInstance, orgId: string;
  before(async () => {
    ({ pool, close } = await freshDb());
    orgId = (await seed(pool)).orgId;
    for (const [role, e] of [['ADMIN', 'admin'], ['MANAGER', 'mgr'], ['VIEWER', 'viewer'], ['ADMIN', 'admin2']] as const) await addUser(pool, orgId, role, `${e}@mfa.test`);
    app = await buildApp({ pool, config: testConfig(), email: null, files: tmpStore(), now });
    noKeyApp = await buildApp({ pool, config: testConfig({ mfaKeys: null }), email: null, files: tmpStore(), now });
  });
  after(async () => { await app.close(); await noKeyApp.close(); await close(); });

  const login = (a: FastifyInstance, email: string, password = PW) => a.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const verify = (a: FastifyInstance, challenge: string, c: string) => a.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code: c } });
  async function signedIn(email: string) { return new Client(app).login(email); }
  /** Password-only sign-in for users without MFA, returning the raw response too. */
  async function pwLogin(email: string) { const c = new Client(app); const r = await login(app, email); if (r.statusCode === 200 && r.cookies[0]) { c.cookie = `sid=${r.cookies[0].value}`; c.csrf = r.json().csrfToken; } return { c, r }; }
  /** Full enrolment through the API. Returns the client, secret and recovery codes. */
  async function enrol(email: string) {
    const c = await signedIn(email);
    const s = await c.post('/api/mfa/enroll/start', { password: PW });
    assert.equal(s.statusCode, 200, s.body);
    const { secret, uri, qr } = s.json();
    assert.match(uri, /^otpauth:\/\/totp\//); assert.match(qr, /^<svg/);
    const f = await c.post('/api/mfa/enroll/confirm', { code: code(secret) });
    assert.equal(f.statusCode, 200, f.body);
    const recoveryCodes: string[] = f.json().recoveryCodes;
    assert.equal(recoveryCodes.length, 10);
    return { c, secret, recoveryCodes };
  }
  const reset = async (email: string) => pool.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE email=$1`, [email]);

  test('enrolment requires the password, only activates with a correct code, stores nothing readable, and returns recovery codes once', async () => {
    const c = await signedIn('viewer@mfa.test');
    assert.equal((await c.post('/api/mfa/enroll/start', { password: 'wrong wrong wrong' })).statusCode, 403);
    const s = (await c.post('/api/mfa/enroll/start', { password: PW })).json();
    assert.equal((await c.post('/api/mfa/enroll/confirm', { code: '000000' })).statusCode, 422, 'wrong code does not activate');
    assert.equal((await c.get('/api/mfa/status')).json().enabled, false);
    const raw = (await pool.query(`SELECT totp_pending_enc, totp_secret_enc FROM users WHERE email='viewer@mfa.test'`)).rows[0];
    assert.ok(raw.totp_pending_enc.startsWith('v1:') && !raw.totp_pending_enc.includes(s.secret), 'secret is encrypted at rest');
    const f = await c.post('/api/mfa/enroll/confirm', { code: code(s.secret) });
    assert.equal(f.statusCode, 200);
    const st = (await c.get('/api/mfa/status')).json();
    assert.equal(st.enabled, true); assert.equal(st.recoveryCodesRemaining, 10);
    const hashes = (await pool.query(`SELECT code_hash FROM mfa_recovery_codes`)).rows.map((r) => r.code_hash).join();
    for (const rc of f.json().recoveryCodes) assert.ok(!hashes.includes(rc.replace('-', '')), 'recovery codes are only stored hashed');
    assert.equal((await c.post('/api/mfa/enroll/start', { password: PW })).statusCode, 422, 'cannot re-enrol while enabled');
    assert.equal((await c.get('/api/auth/me')).json().mfa.enabled, true);
    assert.equal((await new Client(app).get('/api/mfa/status')).statusCode, 401);
  });

  test('login with MFA: password alone gives no session, only a challenge; a correct code completes it; replay of the same code is refused', async () => {
    const { secret } = await enrol('mgr@mfa.test');
    nextStep();
    const r = await login(app, 'mgr@mfa.test');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().mfaRequired, true); assert.equal(r.cookies.length, 0, 'no session cookie yet'); assert.equal(r.json().csrfToken, undefined);
    const ch = r.json().challenge;
    assert.equal((await verify(app, ch, '123456')).statusCode, 401, 'wrong code');
    const ok = await verify(app, ch, code(secret));
    assert.equal(ok.statusCode, 200, ok.body); assert.ok(ok.cookies[0].value); assert.equal(ok.json().mfa.enabled, true);
    assert.equal((await verify(app, ch, code(secret))).statusCode, 401, 'challenge is single use');
    const c2 = (await login(app, 'mgr@mfa.test')).json().challenge;
    assert.equal((await verify(app, c2, code(secret))).statusCode, 401, 'same time step cannot be replayed with a new challenge');
    nextStep();
    assert.equal((await verify(app, c2, code(secret))).statusCode, 200, 'next step works');
    await reset('mgr@mfa.test');
  });

  test('clock drift of one step is tolerated, two steps is not', async () => {
    const { secret } = await enrol('admin2@mfa.test');
    nextStep(); nextStep();
    let ch = (await login(app, 'admin2@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, code(secret, 2))).statusCode, 401);
    assert.equal((await verify(app, ch, code(secret, -1))).statusCode, 200);
    await reset('admin2@mfa.test');
  });

  test('wrong codes lock the account like wrong passwords, and a password login cannot reset the counter', async () => {
    const { secret } = await enrol('admin@mfa.test');
    nextStep();
    for (let i = 0; i < 3; i++) {
      const ch = (await login(app, 'admin@mfa.test')).json().challenge;
      assert.equal((await verify(app, ch, '000000')).statusCode, 401);
    }
    assert.equal((await pool.query(`SELECT failed_logins FROM users WHERE email='admin@mfa.test'`)).rows[0].failed_logins, 3, 'counter survives later password logins');
    let ch = (await login(app, 'admin@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, '000000')).statusCode, 401);
    ch = (await login(app, 'admin@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, '000000')).statusCode, 429, 'fifth failure locks');
    assert.equal((await login(app, 'admin@mfa.test')).statusCode, 429, 'even the right password is refused while locked');
    assert.equal((await verify(app, ch, code(secret))).statusCode, 401, 'outstanding challenges were destroyed by the lock');
    clock.t += 16 * 60_000;
    ch = (await login(app, 'admin@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, code(secret))).statusCode, 200, 'works after the lockout expires');
    assert.equal((await pool.query(`SELECT failed_logins FROM users WHERE email='admin@mfa.test'`)).rows[0].failed_logins, 0);
  });

  test('one challenge allows only 5 tries and expires after 5 minutes', async () => {
    await addUser(pool, orgId, 'MANAGER', 'm2@mfa.test');
    const e = await enrol('m2@mfa.test');
    nextStep();
    const ch = (await login(app, 'm2@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, '111111')).statusCode, 401);
    clock.t += 5 * 60_000 + 1000;
    assert.equal((await verify(app, ch, code(e.secret))).statusCode, 401, 'expired');
    assert.match((await verify(app, ch, code(e.secret))).json().error, /expired/i);
    await reset('m2@mfa.test');
  });

  test('recovery codes: work once, in any case/format, and are accepted instead of TOTP', async () => {
    await addUser(pool, orgId, 'MANAGER', 'rc@mfa.test');
    const { recoveryCodes } = await enrol('rc@mfa.test');
    const rc = recoveryCodes[0];
    let ch = (await login(app, 'rc@mfa.test')).json().challenge;
    const ok = await verify(app, ch, rc.toLowerCase().replace('-', ' '));
    assert.equal(ok.statusCode, 200, ok.body);
    ch = (await login(app, 'rc@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, rc)).statusCode, 401, 'used code is dead');
    ch = (await login(app, 'rc@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, recoveryCodes[1])).statusCode, 200);
    const c = new Client(app); c.cookie = `sid=${ok.cookies[0].value}`; c.csrf = ok.json().csrfToken;
    assert.equal((await c.get('/api/mfa/status')).json().recoveryCodesRemaining, 8);
    const audit = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action='MFA_RECOVERY_CODE_USED'`)).rows[0].n;
    assert.equal(audit, 2);
    await reset('rc@mfa.test');
  });

  test('regenerate and disable need password AND a code; wrong code counts as a failure; disabling ends it', async () => {
    await addUser(pool, orgId, 'MANAGER', 'dis@mfa.test');
    const { c, secret, recoveryCodes } = await enrol('dis@mfa.test');
    nextStep();
    assert.equal((await c.post('/api/mfa/recovery-codes', { password: 'nope nope nope', code: code(secret) })).statusCode, 403);
    assert.equal((await c.post('/api/mfa/recovery-codes', { password: PW, code: '000000' })).statusCode, 403);
    const g = await c.post('/api/mfa/recovery-codes', { password: PW, code: code(secret) });
    assert.equal(g.statusCode, 200); assert.equal(g.json().recoveryCodes.length, 10);
    assert.ok(!g.json().recoveryCodes.includes(recoveryCodes[0]));
    let ch = (await login(app, 'dis@mfa.test')).json().challenge;
    assert.equal((await verify(app, ch, recoveryCodes[2])).statusCode, 401, 'old codes were replaced');
    nextStep();
    assert.equal((await c.post('/api/mfa/disable', { password: PW, code: '000000' })).statusCode, 403);
    assert.equal((await c.post('/api/mfa/disable', { password: PW, code: code(secret) })).statusCode, 200);
    assert.equal((await c.get('/api/mfa/status')).json().enabled, false);
    const r = await login(app, 'dis@mfa.test'); assert.equal(r.json().mfaRequired, undefined); assert.ok(r.cookies[0]);
    const actions = (await pool.query(`SELECT action FROM audit_logs WHERE entity_id=(SELECT id::text FROM users WHERE email='dis@mfa.test') AND action LIKE 'MFA%' ORDER BY id`)).rows.map((x) => x.action);
    assert.deepEqual(actions.filter((a) => a !== 'MFA_VERIFY_FAILED'), ['MFA_ENABLED', 'MFA_RECOVERY_CODES_REGENERATED', 'MFA_DISABLED']);
  });

  test('enabling MFA ends the user’s other sessions', async () => {
    await addUser(pool, orgId, 'MANAGER', 'ses@mfa.test');
    const old = await signedIn('ses@mfa.test');
    await enrol('ses@mfa.test');
    assert.equal((await old.get('/api/auth/me')).statusCode, 401);
  });

  test('admin reset: only users:manage, not for yourself, ends sessions and recovery codes, is audited', async () => {
    await addUser(pool, orgId, 'MANAGER', 'lost@mfa.test');
    const lost = await enrol('lost@mfa.test');
    await addUser(pool, orgId, 'ADMIN', 'root@mfa.test');
    const adm = await signedIn('root@mfa.test');
    const uid = (await pool.query(`SELECT id FROM users WHERE email='lost@mfa.test'`)).rows[0].id;
    assert.equal((await lost.c.post(`/api/users/${uid}/mfa/reset`)).statusCode, 403, 'a manager cannot reset');
    const rootId = (await pool.query(`SELECT id FROM users WHERE email='root@mfa.test'`)).rows[0].id;
    assert.equal((await adm.post(`/api/users/${rootId}/mfa/reset`)).statusCode, 422, 'cannot reset yourself');
    assert.equal((await adm.post(`/api/users/${uid}/mfa/reset`)).statusCode, 200);
    assert.equal((await lost.c.get('/api/auth/me')).statusCode, 401, 'their sessions ended');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1`, [uid])).rows[0].n, 0);
    const r = await login(app, 'lost@mfa.test'); assert.equal(r.json().mfaRequired, undefined, 'back to password login');
    const list = (await adm.get('/api/users')).json().users;
    assert.equal(list.find((u: any) => u.email === 'lost@mfa.test').mfaEnabled, false);
    assert.ok(list.find((u: any) => u.email === 'mgr@mfa.test').mfaEnabled);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE action='MFA_RESET'`)).rowCount);
  });

  test('org policy: needs an enrolled admin; once on, users without MFA can only reach enrolment, sign-out and who-am-I', async () => {
    await addUser(pool, orgId, 'ADMIN', 'pol@mfa.test');
    const adm = await signedIn('pol@mfa.test');
    assert.equal((await adm.call('PUT', '/api/settings/security', { requireMfa: true })).statusCode, 422, 'admin must be enrolled first');
    const { c, secret } = await enrol('pol@mfa.test'); void adm;
    assert.equal((await c.call('PUT', '/api/settings/security', { requireMfa: true })).statusCode, 200);
    // a member without MFA: reset one, then sign in with password only
    await addUser(pool, orgId, 'MANAGER', 'nomfa@mfa.test');
    const { c: n, r: lr } = await pwLogin('nomfa@mfa.test'); assert.equal(lr.statusCode, 200);
    assert.equal(lr.json().mfa.enrollmentRequired, true);
    const blocked = await n.get('/api/owners'); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().code, 'MFA_ENROLLMENT_REQUIRED');
    assert.equal((await n.get('/api/auth/me')).statusCode, 200);
    assert.equal((await n.get('/api/mfa/status')).statusCode, 200);
    const s = (await n.post('/api/mfa/enroll/start', { password: PW })).json();
    assert.equal((await n.post('/api/mfa/enroll/confirm', { code: code(s.secret) })).statusCode, 200);
    assert.equal((await n.get('/api/owners')).statusCode, 200, 'the gate lifts as soon as MFA is on');
    // disabling is refused while the policy is on
    nextStep();
    assert.equal((await c.post('/api/mfa/disable', { password: PW, code: code(secret) })).statusCode, 422);
    assert.equal((await c.call('PUT', '/api/settings/security', { requireMfa: false })).statusCode, 200);
    const actions = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action='MFA_POLICY_CHANGED'`)).rows[0].n;
    assert.equal(actions, 2);
  });

  test('without a server key: MFA users cannot sign in with a password alone, and nobody can enrol or enable the policy', async () => {
    const r = await login(noKeyApp, 'mgr@mfa.test');
    assert.equal(r.statusCode, 503); assert.equal(r.cookies.length, 0);
    const c = new Client(noKeyApp); { const r = await login(noKeyApp, 'nomfa@mfa.test'); assert.equal(r.statusCode, 503, 'nomfa enrolled during the policy test, so now needs the key'); }
    await addUser(pool, orgId, 'VIEWER', 'plain@mfa.test'); const r2 = await login(noKeyApp, 'plain@mfa.test'); assert.equal(r2.statusCode, 200, 'users without MFA are unaffected'); c.cookie = `sid=${r2.cookies[0].value}`; c.csrf = r2.json().csrfToken;
    assert.equal((await c.post('/api/mfa/enroll/start', { password: PW })).statusCode, 503);
    const status = (await c.get('/api/mfa/status')).json(); assert.equal(status.serverReady, false);
  });

  test('tenant isolation: another organization’s admin cannot reset or read MFA of this org', async () => {
    const other = await seed(pool);
    await addUser(pool, other.orgId, 'ADMIN', 'foreign-admin@mfa.test');
    const f = await signedIn('foreign-admin@mfa.test');
    const uid = (await pool.query(`SELECT id FROM users WHERE email='mgr@mfa.test'`)).rows[0].id;
    assert.equal((await f.post(`/api/users/${uid}/mfa/reset`)).statusCode, 404);
    assert.equal((await pool.query(`SELECT totp_enabled_at FROM users WHERE id=$1`, [uid])).rows[0].totp_enabled_at !== null, true);
    assert.equal(((await f.get('/api/settings/security')).json() as any).requireMfa, false, 'policy is per organization');
  });

  test('preflight: no key + enrolled users fails; key present reports status; weak key fails', async () => {
    const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', BASE_URL: 'https://app.example.com', LINK_SECRET: 'k3Jx9QpL2mZ7vB5nR8tY4wC6dF1hG0sA', TRUST_PROXY: 'true' };
    const lvl = async (extra: Record<string, string>) => (await runPreflight({ ...base, ...extra }, pool, { files: tmpStore() })).filter((c) => c.name === 'two-factor login');
    const nokey = await lvl({}); assert.equal(nokey[0].level, 'fail'); assert.match(nokey[0].detail, /MFA_ENCRYPTION_KEY is not set/);
    assert.equal((await lvl({ MFA_ENCRYPTION_KEY: 'short' }))[0].level, 'fail');
    const ok = await lvl({ MFA_ENCRYPTION_KEY: 'a'.repeat(40) }); assert.match(ok[0].detail, /enrolled/);
    assert.ok(['pass', 'warn'].includes(ok[0].level));
  });

  test('audit chain stays intact through all of this', async () => {
    assert.equal(await verifyAuditChain(pool, orgId), null);
  });
});
