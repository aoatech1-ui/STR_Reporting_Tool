import type { Pool } from '../db/pool.ts';
import { scheduleDueReminders } from '../services/reminders.ts';
import { postDueRecurringExpenses } from '../services/recurring.ts';

/**
 * Time-based work, checked once a minute: month-end reminders and recurring expenses.
 * Safe with several workers: each reminder and each recurring occurrence can only be created once (unique rows).
 */
export function startScheduler(pool: Pool, everyMs = 60_000): () => Promise<void> {
  let inflight: Promise<unknown> = Promise.resolve(), stopped = false;
  const tick = () => {
    if (stopped) return;
    inflight = (async () => {
      await scheduleDueReminders(pool).catch((e) => console.error(`reminder scheduler: ${(e as Error).message}`));
      await postDueRecurringExpenses(pool).catch((e) => console.error(`recurring expenses: ${(e as Error).message}`));
    })();
  };
  tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  return async () => { stopped = true; clearInterval(t); await inflight; };
}
