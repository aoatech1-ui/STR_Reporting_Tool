import { chainHash, type AuditEntry } from '../audit.ts';
import type { Db, Tx } from '../db/pool.ts';

const iso = (d: Date | string) => new Date(d).toISOString();

/** Appends to the org's hash chain. Must run inside a transaction: the advisory lock serialises writers per org. */
export async function appendAudit(tx: Tx, orgId: string, e: Omit<AuditEntry, 'at'> & { at?: string }): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${orgId}`]);
  const last = await tx.query<{ hash: string; n: number }>(
    `SELECT (SELECT hash FROM audit_logs WHERE organization_id = $1 ORDER BY id DESC LIMIT 1) AS hash,
            (SELECT count(*) FROM audit_logs WHERE organization_id = $1) AS n`, [orgId]);
  const prevHash = last.rows[0].hash ?? 'GENESIS';
  const entry: AuditEntry = { ...e, at: iso(e.at ?? new Date()), oldValue: e.oldValue ?? null, newValue: e.newValue ?? null };
  const hash = chainHash(entry, last.rows[0].n + 1, prevHash);
  await tx.query(
    `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id, old_value, new_value, ip, user_agent, prev_hash, hash, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [orgId, entry.userId, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.oldValue), JSON.stringify(entry.newValue),
      entry.meta?.ip ?? null, entry.meta?.userAgent ?? null, prevHash, hash, entry.at]);
}

export interface AuditRow { id: number; userId: string | null; action: string; entityType: string; entityId: string; oldValue: unknown; newValue: unknown; at: string }

export async function listAudit(db: Db, orgId: string, f: { entityType?: string; entityId?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const r = await db.query(
    `SELECT id, user_id, action, entity_type, entity_id, old_value, new_value, at FROM audit_logs
     WHERE organization_id = $1 AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR entity_id = $3)
     ORDER BY id DESC LIMIT $4`, [orgId, f.entityType ?? null, f.entityId ?? null, f.limit ?? 200]);
  return r.rows.map((x) => ({ id: x.id, userId: x.user_id, action: x.action, entityType: x.entity_type, entityId: x.entity_id,
    oldValue: x.old_value, newValue: x.new_value, at: iso(x.at) }));
}

/** Recomputes the whole chain for an org; returns the id of the first broken row, or null if intact. */
export async function verifyAuditChain(db: Db, orgId: string): Promise<number | null> {
  const r = await db.query(
    `SELECT id, user_id, action, entity_type, entity_id, old_value, new_value, ip, user_agent, prev_hash, hash, at
     FROM audit_logs WHERE organization_id = $1 ORDER BY id`, [orgId]);
  let prev = 'GENESIS', seq = 0;
  for (const x of r.rows) {
    seq++;
    const meta = x.ip || x.user_agent ? { ip: x.ip ?? undefined, userAgent: x.user_agent ?? undefined } : undefined;
    const e: AuditEntry = { userId: x.user_id, action: x.action, entityType: x.entity_type, entityId: x.entity_id,
      oldValue: x.old_value, newValue: x.new_value, at: iso(x.at), ...(meta ? { meta } : {}) };
    if (x.prev_hash !== prev || x.hash !== chainHash(e, seq, prev)) return x.id;
    prev = x.hash;
  }
  return null;
}
