import pg from 'pg';

const safeNumber = (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) && Number.isInteger(n)) throw new Error(`Integer ${v} exceeds safe range`);
  return n;
};
pg.types.setTypeParser(20, safeNumber);     // bigint (cents, counts)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (sum() of bigint)
pg.types.setTypeParser(1082, (v) => v);     // date stays 'YYYY-MM-DD', never a timezone-shifted Date

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that can run a query: a Pool (reads) or a Tx (writes). */
export interface Db { query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> }

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle pooled connection can be dropped by the server (restart, failover). Without a handler Node treats it as fatal.
  pool.on('error', (e) => console.error(`pg pool: idle client error: ${e.message}`));
  return pool;
}

/** Runs fn in one transaction; commits on success, rolls back on any error. All financial writes go through this. */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
