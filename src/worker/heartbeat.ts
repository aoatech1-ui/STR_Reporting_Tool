import type { Pool } from '../db/pool.ts';

/**
 * Records "this worker is alive" every few seconds on its own timer, so a long-running job cannot make a healthy worker look dead.
 * Timestamps use the database clock. Returns a stop function that removes the row (clean shutdown).
 */
export function startHeartbeat(pool: Pool, workerId: string, everyMs = 10_000): () => Promise<void> {
  const beat = () => pool.query(
    `INSERT INTO worker_heartbeats(worker_id) VALUES ($1) ON CONFLICT (worker_id) DO UPDATE SET last_seen = now()`, [workerId])
    .then(() => pool.query(`DELETE FROM worker_heartbeats WHERE last_seen < now() - interval '1 day'`))
    .catch((e) => console.error(`heartbeat failed: ${(e as Error).message}`));
  void beat();
  const t = setInterval(beat, everyMs);
  t.unref();
  return async () => { clearInterval(t); await pool.query('DELETE FROM worker_heartbeats WHERE worker_id=$1', [workerId]).catch(() => {}); };
}
