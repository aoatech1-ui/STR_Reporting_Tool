import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withTx, type Pool } from './pool.ts';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../db/migrations');

/** Applies pending db/migrations/*.sql in filename order, each in its own transaction. Idempotent. */
export async function migrate(pool: Pool, dir = DIR): Promise<string[]> {
  const applied: string[] = [];
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await withTx(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(727274)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await tx.query(readFileSync(join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  const pool = createPool(url);
  migrate(pool).then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'Up to date')).finally(() => pool.end());
}
