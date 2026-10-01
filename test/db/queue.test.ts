import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '../../src/db/pool.ts';
import { claim, defaultBackoffSeconds, enqueue, runOnce, type Handler } from '../../src/worker/queue.ts';
import { freshDb, skip } from './helper.ts';

describe('job queue', { skip }, () => {
  let pool: Pool, close: () => Promise<void>;
  before(async () => { ({ pool, close } = await freshDb()); });
  after(async () => { await close(); });
  const reset = () => pool.query('DELETE FROM jobs');
  const status = async () => (await pool.query('SELECT status, attempts, last_error FROM jobs ORDER BY created_at')).rows;

  test('backoff doubles and caps at one hour', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 20].map(defaultBackoffSeconds), [30, 60, 120, 240, 480, 3600]);
  });

  test('dedupe key makes enqueue idempotent', async () => {
    await reset();
    assert.ok(await enqueue(pool, { type: 't', payload: {}, dedupeKey: 'k1' }));
    assert.equal(await enqueue(pool, { type: 't', payload: {}, dedupeKey: 'k1' }), null);
    assert.equal((await status()).length, 1);
  });

  test('runs due jobs in order, ignores future jobs and unregistered types', async () => {
    await reset();
    const seen: number[] = [];
    const h: Handler = { async run(j) { seen.push(j.payload.n); } };
    await enqueue(pool, { type: 't', payload: { n: 2 }, runAt: new Date(Date.now() - 1000) });
    await enqueue(pool, { type: 't', payload: { n: 1 }, runAt: new Date(Date.now() - 5000) });
    await enqueue(pool, { type: 't', payload: { n: 3 }, runAt: new Date(Date.now() + 3600_000) });
    await enqueue(pool, { type: 'other', payload: { n: 4 } });
    while (await runOnce(pool, { t: h })) { /* drain */ }
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual((await status()).map((r) => r.status).sort(), ['DONE', 'DONE', 'QUEUED', 'QUEUED']);
  });

  test('concurrent workers never run the same job twice', async () => {
    await reset();
    for (let i = 0; i < 30; i++) await enqueue(pool, { type: 't', payload: { i } });
    const ran: number[] = [];
    const h: Handler = { async run(j) { ran.push(j.payload.i); await new Promise((r) => setTimeout(r, 5)); } };
    await Promise.all(Array.from({ length: 6 }, async () => { while (await runOnce(pool, { t: h })) { /* drain */ } }));
    assert.equal(ran.length, 30);
    assert.equal(new Set(ran).size, 30);
  });

  test('non-retryable error gives up at once; retryable retries then gives up; onGiveUp called once', async () => {
    await reset();
    const gave: string[] = [];
    const h: Handler = { async run(j) { throw Object.assign(new Error(j.payload.msg), { retryable: j.payload.retryable }); }, async onGiveUp(_j, e) { gave.push(e.message); } };
    await enqueue(pool, { type: 't', payload: { msg: 'perm', retryable: false } });
    await enqueue(pool, { type: 't', payload: { msg: 'flaky', retryable: true }, maxAttempts: 3 });
    for (let i = 0; i < 10; i++) await runOnce(pool, { t: h }, { backoffSeconds: () => 0 });
    assert.deepEqual(gave.sort(), ['flaky', 'perm']);
    const rows = await status();
    assert.ok(rows.every((r) => r.status === 'FAILED'));
    assert.deepEqual(rows.map((r) => r.attempts).sort(), [1, 3]);
  });

  test('a job whose worker died is reclaimed after the lease expires, but not before', async () => {
    await reset();
    await enqueue(pool, { type: 't', payload: {} });
    const t0 = new Date(Date.now() + 1000); // a moment after the job's run_at (DB now() has µs precision)
    const first = await claim(pool, 'dead-worker', ['t'], t0);
    assert.equal(first?.attempts, 1);
    assert.equal(await claim(pool, 'w2', ['t'], new Date(t0.getTime() + 60_000), 300_000), null, 'lease still valid');
    const again = await claim(pool, 'w2', ['t'], new Date(t0.getTime() + 301_000), 300_000);
    assert.equal(again?.attempts, 2);
  });

  test('a repeatedly crashing job is eventually failed instead of looping forever', async () => {
    await reset();
    await enqueue(pool, { type: 't', payload: {}, maxAttempts: 2 });
    let t = Date.now() + 1000; let called = 0;
    const h: Handler = { async run() { called++; }, async onGiveUp() { called += 100; } };
    for (let i = 0; i < 2; i++) { await claim(pool, 'crashy', ['t'], new Date(t)); t += 400_000; } // two crashed leases
    await runOnce(pool, { t: h }, { now: () => new Date(t) });
    assert.equal((await status())[0].status, 'FAILED');
    assert.equal(called, 100, 'handler body did not run; onGiveUp did');
  });

  test('a stale worker cannot overwrite a job another worker reclaimed', async () => {
    await reset();
    await enqueue(pool, { type: 't', payload: {} });
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow: Handler = { async run() { await gate; } };
    const p = runOnce(pool, { t: slow }, { workerId: 'slow' });
    await new Promise((r) => setTimeout(r, 50));
    await pool.query(`UPDATE jobs SET locked_by='someone-else'`); // lease taken over
    release(); await p;
    assert.equal((await status())[0].status, 'RUNNING', 'finish by the old owner was ignored');
  });
});
