import { randomUUID } from 'node:crypto';
import type { Db, Pool } from '../db/pool.ts';

export interface Job { id: string; orgId: string | null; type: string; payload: any; attempts: number; maxAttempts: number }
export interface JobContext { workerId: string; attempt: number; isLastAttempt: boolean }
/** Handlers must be idempotent: delivery is at-least-once. Throw to retry; throw an error with `retryable === false` to give up at once. */
export interface Handler {
  run(job: Job, ctx: JobContext): Promise<void>;
  /** Called after a failed attempt that will be retried. */
  onRetry?(job: Job, error: Error): Promise<void>;
  /** Called once when the job will not be retried (permanent error or attempts exhausted). */
  onGiveUp?(job: Job, error: Error): Promise<void>;
}

export const STALE_LOCK_MS = 5 * 60_000;
/** 30s, 1m, 2m, 4m … capped at 1h. */
export const defaultBackoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));

/** Pass a Tx to enqueue atomically with business writes (the outbox pattern). dedupeKey makes enqueue idempotent. */
export async function enqueue(db: Db, j: { orgId?: string; type: string; payload: unknown; runAt?: Date; maxAttempts?: number; dedupeKey?: string }): Promise<string | null> {
  const r = await db.query(
    `INSERT INTO jobs(organization_id, type, payload, run_at, max_attempts, dedupe_key) VALUES ($1,$2,$3,COALESCE($4, now()),$5,$6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [j.orgId ?? null, j.type, JSON.stringify(j.payload), j.runAt ?? null, j.maxAttempts ?? 6, j.dedupeKey ?? null]);
  return r.rows[0]?.id ?? null;
}

/** Atomically leases one due job (also reclaims jobs whose worker died mid-run). Safe with many concurrent workers. */
export async function claim(pool: Pool, workerId: string, types: string[], now: Date | null, staleMs = STALE_LOCK_MS): Promise<Job | null> {
  // `now` is null in production: all scheduling compares against the database clock, so app/DB clock skew cannot matter.
  const r = await pool.query(
    `UPDATE jobs SET status='RUNNING', locked_at=COALESCE($3::timestamptz, now()), locked_by=$1, attempts=attempts+1
     WHERE id = (SELECT id FROM jobs WHERE type = ANY($2::text[]) AND ((status='QUEUED' AND run_at <= COALESCE($3::timestamptz, now())) OR (status='RUNNING' AND locked_at < COALESCE($3::timestamptz, now()) - make_interval(secs => $4)))
                 ORDER BY run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, organization_id, type, payload, attempts, max_attempts`, [workerId, types, now, staleMs / 1000]);
  const x = r.rows[0];
  return x ? { id: x.id, orgId: x.organization_id, type: x.type, payload: x.payload, attempts: x.attempts, maxAttempts: x.max_attempts } : null;
}

export interface RunOptions { workerId?: string; /** Test clock. Omit in production to use the database clock. */ now?: () => Date; backoffSeconds?: (attempt: number) => number; staleMs?: number }

/** Claims and runs at most one job. Returns false when nothing was due. */
export async function runOnce(pool: Pool, handlers: Record<string, Handler>, o: RunOptions = {}): Promise<boolean> {
  const workerId = o.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const at = () => o.now?.() ?? null;
  const job = await claim(pool, workerId, Object.keys(handlers), at(), o.staleMs);
  if (!job) return false;
  const h = handlers[job.type];
  const owned = `id=$1 AND status='RUNNING' AND locked_by=$2`; // never touch a job another worker has since reclaimed
  const giveUp = async (err: Error) => {
    await pool.query(`UPDATE jobs SET status='FAILED', last_error=$3, finished_at=COALESCE($4::timestamptz, now()) WHERE ${owned}`, [job.id, workerId, err.message.slice(0, 500), at()]);
    await h.onGiveUp?.(job, err);
  };
  if (job.attempts > job.maxAttempts) { await giveUp(new Error('Exceeded max attempts (worker crashed repeatedly)')); return true; }
  try {
    await h.run(job, { workerId, attempt: job.attempts, isLastAttempt: job.attempts >= job.maxAttempts });
    await pool.query(`UPDATE jobs SET status='DONE', finished_at=COALESCE($3::timestamptz, now()), last_error=NULL WHERE ${owned}`, [job.id, workerId, at()]);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const retryable = (err as { retryable?: boolean }).retryable !== false;
    if (!retryable || job.attempts >= job.maxAttempts) await giveUp(err);
    else {
      const delay = (o.backoffSeconds ?? defaultBackoffSeconds)(job.attempts);
      await pool.query(`UPDATE jobs SET status='QUEUED', run_at=COALESCE($3::timestamptz, now()) + make_interval(secs => $5), last_error=$4, locked_at=NULL, locked_by=NULL WHERE ${owned}`,
        [job.id, workerId, at(), err.message.slice(0, 500), delay]);
      await h.onRetry?.(job, err);
    }
  }
  return true;
}

/** Polling loop. Stops when the signal aborts, after finishing the job in flight. */
export async function runWorker(pool: Pool, handlers: Record<string, Handler>, signal: AbortSignal, o: RunOptions & { pollMs?: number } = {}): Promise<void> {
  const workerId = o.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  while (!signal.aborted) {
    let worked = false;
    try { worked = await runOnce(pool, handlers, { ...o, workerId }); }
    catch (e) { console.error(`worker ${workerId}: ${(e as Error).message}`); }
    if (!worked) await new Promise<void>((res) => { const t = setTimeout(res, o.pollMs ?? 2000); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
  }
}

