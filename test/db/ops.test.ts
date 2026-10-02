import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { migrate, pendingMigrations } from '../../src/db/migrate.ts';
import { buildApp } from '../../src/server/app.ts';
import { startHeartbeat } from '../../src/worker/heartbeat.ts';
import { getWorkerStatus } from '../../src/repo/ops.ts';
import { exitCode, runPreflight, type Check } from '../../src/ops/preflight.ts';
import type { FileStore } from '../../src/files/store.ts';
import { addUser, Client, testConfig } from './httpkit.ts';
import { DB_URL, freshDb, seed, skip, tmpStore } from './helper.ts';
import { randomUUID } from 'node:crypto';

const STRONG = 'k8Vq2mZp9XcR4tYb7NwLs3HdFj6GaE1uQ5oB0iTe';
const env = (o: Record<string, string> = {}) => ({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', BASE_URL: 'https://app.example.com', LINK_SECRET: STRONG, TRUST_PROXY: 'true', ...o });
const find = (cs: Check[], name: string) => cs.filter((c) => c.name === name);
const level = (cs: Check[], name: string) => find(cs, name).map((c) => c.level);

describe('operations: migrations guard, worker heartbeat, preflight', { skip }, () => {
  let pool: Pool, close: () => Promise<void>;
  before(async () => { ({ pool, close } = await freshDb()); });
  after(async () => { await close(); });

  test('pendingMigrations: none after migrate; everything on an empty database; picks up a new file', async () => {
    assert.deepEqual(await pendingMigrations(pool), []);
    const admin = createPool(DB_URL!, 1); const name = `t_${randomUUID().replace(/-/g, '')}`; await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(DB_URL!); u.pathname = `/${name}`; const empty = createPool(u.toString(), 1);
    try {
      const all = await pendingMigrations(empty);
      assert.ok(all.length >= 5 && all[0] === '001_init.sql', all.join());
      const dir = mkdtempSync(join(tmpdir(), 'mig-')); writeFileSync(join(dir, '999_future.sql'), 'SELECT 1;');
      assert.deepEqual(await pendingMigrations(pool, dir), ['999_future.sql']);
      await migrate(empty);
      assert.deepEqual(await pendingMigrations(empty), []);
    } finally { await empty.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
  });

  test('heartbeat: appears while running, disappears on clean stop, stale rows are not counted', async () => {
    assert.deepEqual(await getWorkerStatus(pool), { active: 0, lastSeenSecondsAgo: null });
    const stop = startHeartbeat(pool, 'w-test', 50);
    await new Promise((r) => setTimeout(r, 200));
    const s = await getWorkerStatus(pool);
    assert.equal(s.active, 1); assert.ok(s.lastSeenSecondsAgo! <= 2);
    await stop();
    assert.equal((await getWorkerStatus(pool)).active, 0);
    await pool.query(`INSERT INTO worker_heartbeats(worker_id, last_seen) VALUES ('dead', now() - interval '5 minutes')`);
    const st = await getWorkerStatus(pool);
    assert.equal(st.active, 0); assert.ok(st.lastSeenSecondsAgo! >= 299, 'reports how long ago it was seen');
    const stop2 = startHeartbeat(pool, 'w2', 5000); await new Promise((r) => setTimeout(r, 100)); await stop2();
    await pool.query(`UPDATE worker_heartbeats SET last_seen = now() - interval '2 days' WHERE worker_id='dead'`);
    const stop3 = startHeartbeat(pool, 'w3', 5000); await new Promise((r) => setTimeout(r, 150)); await stop3();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_id='dead'`)).rows[0].n, 0, 'rows older than a day are cleaned up');
  });

  test('settings endpoint reports worker health to administrators and managers, not viewers', async () => {
    const o = await seed(pool);
    await addUser(pool, o.orgId, 'ADMIN', 'admin@ops.test'); await addUser(pool, o.orgId, 'VIEWER', 'viewer@ops.test'); await addUser(pool, o.orgId, 'MANAGER', 'mgr@ops.test');
    const app: FastifyInstance = await buildApp({ pool, config: testConfig(), email: null, files: tmpStore() });
    try {
      const admin = await new Client(app).login('admin@ops.test'), viewer = await new Client(app).login('viewer@ops.test');
      assert.deepEqual((await admin.get('/api/settings/email')).json().worker.active, 0);
      const stop = startHeartbeat(pool, 'w-api', 5000); await new Promise((r) => setTimeout(r, 150));
      assert.equal((await admin.get('/api/settings/email')).json().worker.active, 1);
      await stop();
      assert.equal((await viewer.get('/api/settings/email')).statusCode, 403);
      assert.equal((await (await new Client(app).login('mgr@ops.test')).get('/api/settings/email')).statusCode, 200, 'managers can see integration health');
    } finally { await app.close(); }
  });

  test('preflight on a healthy deployment passes (with the expected advisory warnings)', async () => {
    const o = await seed(pool); void o;
    await addUser(pool, o.orgId, 'ADMIN', 'a@pf.test');
    const stop = startHeartbeat(pool, 'w-pf', 5000); await new Promise((r) => setTimeout(r, 150));
    const cs = await runPreflight(env(), pool, { files: tmpStore() });
    await stop();
    for (const n of ['configuration', 'link secret', 'public URL', 'reverse proxy', 'database', 'clock', 'migrations', 'extensions', 'administrator', 'audit log', 'worker']) assert.deepEqual(level(cs, n), ['pass'], `${n}: ${JSON.stringify(find(cs, n))}`);
    assert.deepEqual(level(cs, 'email'), ['warn'], 'no email provider configured');
    assert.equal(exitCode(cs), 0);
    assert.match(find(cs, 'database')[0].detail, /PostgreSQL 1\d/);
  });

  test('preflight flags every failure mode', async () => {
    const files = tmpStore();
    // bad configuration
    let cs = await runPreflight({ DATABASE_URL: 'x' }, pool, { files });
    assert.deepEqual(level(cs, 'configuration'), ['fail']); assert.equal(exitCode(cs), 1);
    cs = await runPreflight(env({ LINK_SECRET: 'a'.repeat(40) }), pool, { files });
    assert.deepEqual(level(cs, 'link secret'), ['fail']);
    cs = await runPreflight(env({ BASE_URL: 'http://localhost:3000' }), pool, { files });
    assert.deepEqual(level(cs, 'public URL'), ['warn']);
    cs = await runPreflight(env({ TRUST_PROXY: 'false' }), pool, { files });
    assert.deepEqual(level(cs, 'reverse proxy'), ['warn']);
    cs = await runPreflight(env({ DATABASE_URL: 'postgres://u:p@db.prod.example.com/x' }), pool, { files });
    assert.deepEqual(level(cs, 'database TLS'), ['warn']);
    cs = await runPreflight(env({ DATABASE_URL: 'postgres://u:p@db.prod.example.com/x', DB_SSL: 'true' }), pool, { files });
    assert.deepEqual(level(cs, 'database TLS'), []);

    // file storage that cannot be used
    const broken: FileStore = { kind: 's3', async put() { throw new Error('AccessDenied'); }, async get() { return null; }, async delete() {} };
    cs = await runPreflight(env(), pool, { files: broken });
    assert.deepEqual(level(cs, 'file storage'), ['fail']); assert.match(find(cs, 'file storage')[0].detail, /AccessDenied/);
    const lossy: FileStore = { kind: 's3', async put() {}, async get() { return Buffer.from('other'); }, async delete() {} };
    assert.match((await runPreflight(env(), pool, { files: lossy })).find((c) => c.name === 'file storage')!.detail, /could not read it back/);
    assert.deepEqual(level(await runPreflight(env(), pool, { files }), 'file storage'), ['warn'], 'local disk is flagged: needs a persistent volume');

    // email provider that cannot log in
    cs = await runPreflight(env({ EMAIL_PROVIDER: 'custom', EMAIL_FROM: 'a@b.co', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'u', SMTP_PASS: 'p' }), pool, { files });
    assert.ok(level(cs, 'email').includes('fail'));
    cs = await runPreflight(env({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co', RESEND_API_KEY: 'k' }), pool, { files });
    assert.deepEqual(level(cs, 'email'), ['pass']); assert.deepEqual(level(cs, 'email webhooks'), ['warn']);
    cs = await runPreflight(env({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co', RESEND_API_KEY: 'k', EMAIL_WEBHOOK_SECRET: 'whsec_x' }), pool, { files });
    assert.deepEqual(level(cs, 'email webhooks'), []);
    cs = await runPreflight(env({ EMAIL_PROVIDER: 'gmail', EMAIL_FROM: 'a@gmail.com', SMTP_USER: 'other@gmail.com', SMTP_PASS: 'p' }), pool, { files });
    assert.ok(find(cs, 'email').some((c) => /rewrites or rejects/.test(c.detail)), 'provider warnings are surfaced');

    // worker down with work waiting
    const o = await seed(pool);
    await pool.query(`INSERT INTO jobs(organization_id, type, payload, run_at) VALUES ($1,'send_delivery','{}', now() - interval '20 minutes')`, [o.orgId]);
    await pool.query(`INSERT INTO jobs(organization_id, type, payload, status) VALUES ($1,'send_delivery','{}','FAILED')`, [o.orgId]);
    cs = await runPreflight(env(), pool, { files });
    assert.deepEqual(level(cs, 'worker'), ['warn']); assert.ok(level(cs, 'jobs').includes('fail') && level(cs, 'jobs').includes('warn'));
    await pool.query('DELETE FROM jobs');
  });

  test('preflight detects pending migrations, a missing administrator, and a tampered audit log', async () => {
    const { pool: p2, close: c2 } = await freshDb();
    try {
      let cs = await runPreflight(env(), p2, { files: tmpStore() });
      assert.deepEqual(level(cs, 'administrator'), ['fail']); assert.match(find(cs, 'administrator')[0].detail, /create-admin/);
      await p2.query(`DELETE FROM schema_migrations WHERE name='005_worker_heartbeats.sql'`);
      cs = await runPreflight(env(), p2, { files: tmpStore() });
      assert.deepEqual(level(cs, 'migrations'), ['fail']); assert.match(find(cs, 'migrations')[0].detail, /005_worker_heartbeats/);
      await p2.query(`INSERT INTO schema_migrations(name) VALUES ('005_worker_heartbeats.sql')`);

      const o = await seed(p2); await addUser(p2, o.orgId, 'ADMIN', 'ok@pf2.test');
      assert.deepEqual(level(await runPreflight(env(), p2, { files: tmpStore() }), 'administrator'), ['pass']);
      await p2.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_no_update');
      await p2.query(`UPDATE audit_logs SET new_value='{"forged":1}' WHERE id=(SELECT min(id) FROM audit_logs WHERE organization_id=$1)`, [o.orgId]);
      cs = await runPreflight(env(), p2, { files: tmpStore() });
      assert.deepEqual(level(cs, 'audit log'), ['fail']); assert.equal(exitCode(cs), 1);
    } finally { await c2(); }
  });
});
