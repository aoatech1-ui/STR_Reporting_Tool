import { randomUUID } from 'node:crypto';
import { createPool, withTx, type Pool } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createOrganization, createUser } from '../../src/repo/orgs.ts';
import { createOwner } from '../../src/repo/owners.ts';
import { createProperty, setCommissionRule } from '../../src/repo/properties.ts';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const skip = DB_URL ? false : 'TEST_DATABASE_URL not set (use npm run test:db)';

/** Fresh, isolated, fully migrated database per test file. */
export async function freshDb(): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const admin = createPool(DB_URL!, 1);
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(DB_URL!); u.pathname = `/${name}`;
  const pool = createPool(u.toString(), 5);
  await migrate(pool);
  return { pool, close: async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); } };
}

/** Org + manager + John Smith + 123 Main Street (20% of net payout from 2026-01-01). */
export async function seed(pool: Pool) {
  return withTx(pool, async (tx) => {
    const orgId = await createOrganization(tx, { legalName: 'Manager LLC', displayName: 'Manager LLC' });
    const userId = await createUser(tx, orgId, { name: 'Mgr', email: `m-${randomUUID()}@example.com`, role: 'MANAGER' });
    const ownerId = await createOwner(tx, orgId, userId, { legalName: 'John Smith', displayName: 'John Smith', email: 'john@example.com',
      whatsappPhone: '+15550001111', whatsappEnabled: true, whatsappOptIn: true });
    const propertyId = await createProperty(tx, orgId, userId, { name: '123 Main Street', ownerId, address: '123 Main Street', airbnbListingName: '123 Main Street' });
    await setCommissionRule(tx, orgId, userId, propertyId, { type: 'PERCENT_NET', rateBps: 2000, fixedCents: 0, includeCleaningFees: true, excludeTaxes: false, hybridBasis: 'NET', effectiveFrom: '2026-01-01' });
    return { orgId, userId, ownerId, propertyId };
  });
}

export const CSV = `Date,Type,Confirmation Code,Start Date,End Date,Listing,Currency,Amount,Service fee,Cleaning fee,Gross earnings,Occupancy taxes
09/05/2026,Reservation,HM1,09/01/2026,09/05/2026,123 Main Street,USD,"$4,850.00",150.00,100.00,5000.00,0.00
09/12/2026,Reservation,HM2,09/08/2026,09/12/2026,123 Main Street,USD,1150.00,50.00,0.00,1200.00,0.00
09/21/2026,Reservation,HM9,09/18/2026,09/20/2026,Mystery Cabin,USD,300.00,10.00,0.00,310.00,0.00
`;
