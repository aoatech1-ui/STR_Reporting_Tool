import type { Db } from '../db/pool.ts';
export async function getJobStats(db: Db, orgId: string): Promise<Record<string, number>> {
  const r = await db.query(`SELECT status, count(*)::int AS n FROM jobs WHERE organization_id=$1 GROUP BY status`, [orgId]);
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
}

export const WORKER_STALE_SECONDS = 60;

/** Workers seen within the last minute. Not tenant data: only counts and an age. */
export async function getWorkerStatus(db: Db): Promise<{ active: number; lastSeenSecondsAgo: number | null }> {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE last_seen > now() - make_interval(secs => $1))::int AS active,
            floor(extract(epoch FROM now() - max(last_seen)))::int AS age FROM worker_heartbeats`, [WORKER_STALE_SECONDS]);
  return { active: r.rows[0].active, lastSeenSecondsAgo: r.rows[0].age };
}
