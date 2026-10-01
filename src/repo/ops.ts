import type { Db } from '../db/pool.ts';
export async function getJobStats(db: Db, orgId: string): Promise<Record<string, number>> {
  const r = await db.query(`SELECT status, count(*)::int AS n FROM jobs WHERE organization_id=$1 GROUP BY status`, [orgId]);
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
}
