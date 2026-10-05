import { createPool, poolOptionsFromEnv } from '../db/pool.ts';
import { loadConfig } from '../server/config.ts';
import { createFileStore } from '../files/store.ts';
import { buildHandlers } from './handlers.ts';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { startHeartbeat } from './heartbeat.ts';
import { startScheduler } from './scheduler.ts';
import { runWorker } from './queue.ts';

const cfg = loadConfig(process.env);
const pool = createPool(cfg.databaseUrl, undefined, { ...poolOptionsFromEnv(process.env), max: Number(process.env.DB_POOL_MAX) || 5 });
const workerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
const ac = new AbortController();
const stop = () => ac.abort();
process.on('SIGTERM', stop); process.on('SIGINT', stop);

for (const w of cfg.email?.warnings ?? []) console.warn(w);
console.log(`worker started (email: ${cfg.email?.id ?? 'none'}, whatsapp: ${cfg.whatsapp?.id ?? 'none'})`);
const stopHeartbeat = startHeartbeat(pool, workerId);
const stopScheduler = startScheduler(pool);
await runWorker(pool, buildHandlers({ pool, files: createFileStore(process.env), email: cfg.email?.provider ?? null, whatsapp: cfg.whatsapp?.provider ?? null, whatsappIncludeSummary: cfg.whatsapp?.includeSummary, linkSecret: cfg.app.linkSecret, baseUrl: cfg.app.baseUrl }), ac.signal, { workerId });
await stopScheduler();
await stopHeartbeat();
await pool.end();
console.log('worker stopped');
