/**
 * Production readiness check. Reads the same environment as the server and worker.
 *   npm run preflight            # human-readable, exit code 1 if anything fails
 *   npm run preflight -- --json
 */
import { createPool, poolOptionsFromEnv } from '../db/pool.ts';
import { exitCode, runPreflight } from '../ops/preflight.ts';

const json = process.argv.includes('--json');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
const pool = createPool(url, 2, { ...poolOptionsFromEnv(process.env), connectionTimeoutMillis: 8000 });
try {
  const checks = await runPreflight(process.env, pool);
  if (json) console.log(JSON.stringify(checks, null, 2));
  else {
    const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
    for (const c of checks) console.log(`${icon[c.level]}  ${c.name.padEnd(16)} ${c.detail}`);
    const n = (l: string) => checks.filter((c) => c.level === l).length;
    console.log(`\n${n('pass')} passed, ${n('warn')} warning(s), ${n('fail')} failed`);
  }
  process.exitCode = exitCode(checks);
} finally { await pool.end(); }
