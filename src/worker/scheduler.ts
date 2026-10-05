import type { Pool } from '../db/pool.ts';
import { scheduleDueReminders } from '../services/reminders.ts';

/** Checks for due month-end reminders once a minute. Safe with several workers: each reminder can only be created once. */
export function startReminderScheduler(pool: Pool, everyMs = 60_000): () => Promise<void> {
  let inflight: Promise<unknown> = Promise.resolve(), stopped = false;
  const tick = () => {
    if (stopped) return;
    inflight = scheduleDueReminders(pool).catch((e) => console.error(`reminder scheduler: ${(e as Error).message}`));
  };
  tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  return async () => { stopped = true; clearInterval(t); await inflight; };
}
