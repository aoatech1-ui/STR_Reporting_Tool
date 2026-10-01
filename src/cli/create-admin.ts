/**
 * Bootstraps the first organization + administrator (there is no public sign-up).
 *   DATABASE_URL=… ADMIN_PASSWORD=… node src/cli/create-admin.ts --org "Manager LLC" --email me@example.com --name "Me"
 * Add --org-id <uuid> to add an admin to an existing organization instead. Password comes from ADMIN_PASSWORD, else stdin.
 */
import { parseArgs } from 'node:util';
import { createPool, withTx } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { createOrganization, createUser } from '../repo/orgs.ts';

const { values: a } = parseArgs({ options: { org: { type: 'string' }, 'org-id': { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } } });
if (!a.email || !a.name || (!a.org && !a['org-id'])) { console.error('Usage: create-admin --org "<legal name>" | --org-id <uuid>  --email <addr> --name "<name>"'); process.exit(2); }
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
let password = process.env.ADMIN_PASSWORD;
if (!password) { password = ''; for await (const chunk of process.stdin) password += chunk; password = password.replace(/\r?\n$/, ''); }

const pool = createPool(url, 2);
try {
  await migrate(pool);
  const id = await withTx(pool, async (tx) => {
    const orgId = a['org-id'] ?? (await createOrganization(tx, { legalName: a.org!, displayName: a.org! }));
    return createUser(tx, orgId, { name: a.name!, email: a.email!, role: 'ADMIN', password });
  });
  console.log(`Created administrator ${a.email} (${id})`);
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await pool.end(); }
