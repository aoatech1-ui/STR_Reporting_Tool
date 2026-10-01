import { createPool } from '../db/pool.ts';
import { loadConfig } from '../server/config.ts';
import { buildHandlers } from './handlers.ts';
import { runWorker } from './queue.ts';

const cfg = loadConfig(process.env);
const pool = createPool(cfg.databaseUrl, 5);
const ac = new AbortController();
const stop = () => ac.abort();
process.on('SIGTERM', stop); process.on('SIGINT', stop);

for (const w of cfg.email?.warnings ?? []) console.warn(w);
console.log(`worker started (email: ${cfg.email?.id ?? 'none'})`);
await runWorker(pool, buildHandlers({ pool, email: cfg.email?.provider ?? null, whatsapp: null, linkSecret: cfg.app.linkSecret, baseUrl: cfg.app.baseUrl }), ac.signal);
await pool.end();
console.log('worker stopped');
