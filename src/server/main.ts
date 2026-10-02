import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { createPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { createFileStore } from '../files/store.ts';

const cfg = loadConfig(process.env);
const pool = createPool(cfg.databaseUrl);
if (process.env.MIGRATE_ON_START === 'true') console.log('migrations applied:', await migrate(pool));
const files = createFileStore(process.env);
const app = await buildApp({ pool, config: cfg.app, email: cfg.email, files, logger: true });
if (files.kind === 'local') app.log.warn(`Files are stored on this server's disk (${process.env.FILE_STORE_DIR || './data/files'}). Mount a persistent volume and back it up, or set FILE_STORE=s3.`);
for (const w of cfg.email?.warnings ?? []) app.log.warn(w);
if (!cfg.email) app.log.warn('EMAIL_PROVIDER is not set: statements cannot be emailed');
if (!cfg.app.webhook.token && !cfg.app.webhook.signingSecret) app.log.warn('No email webhook secret configured: delivery status callbacks will be rejected');

const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
await app.listen({ port: cfg.port, host: cfg.host });
