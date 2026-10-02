/**
 * Data integrity verifier (read-only). Use after restoring a backup and on a schedule.
 *   npm run verify-data              # database + archived statement files
 *   npm run verify-data -- --deep    # also re-hash every receipt
 *   npm run verify-data -- --no-files
 * Exit code 1 if any violation is found.
 */
import { createPool, poolOptionsFromEnv } from '../db/pool.ts';
import { createFileStore } from '../files/store.ts';
import { verifyDataIntegrity } from '../ops/integrity.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
const pool = createPool(url, 2, { ...poolOptionsFromEnv(process.env), statement_timeout: 0 });
try {
  const r = await verifyDataIntegrity(pool, { files: process.argv.includes('--no-files') ? undefined : createFileStore(process.env), deep: process.argv.includes('--deep') });
  console.log(`checked ${r.checked.organizations} organization(s), ${r.checked.statements} statement(s), ${r.checked.files} file(s)`);
  for (const v of r.violations) console.log(`VIOLATION ${v.code}${v.ref ? ` [${v.ref}]` : ''}: ${v.message}`);
  console.log(r.violations.length ? `\n${r.violations.length} violation(s) found` : 'all invariants hold');
  process.exitCode = r.violations.length ? 1 : 0;
} finally { await pool.end(); }
