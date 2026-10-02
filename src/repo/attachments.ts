import type { Db, Tx } from '../db/pool.ts';

export interface AttachmentRow { id: string; storageKey: string; filename: string; contentType: string; sizeBytes: number; sha256: string; createdAt: string }
const map = (x: any): AttachmentRow => ({ id: x.id, storageKey: x.storage_key, filename: x.filename, contentType: x.content_type, sizeBytes: x.size_bytes, sha256: x.sha256, createdAt: new Date(x.created_at).toISOString() });

export async function insertAttachment(tx: Tx, orgId: string, userId: string | null, a: { id?: string; storageKey: string; filename: string; contentType: string; sizeBytes: number; sha256: string }): Promise<string> {
  const r = await tx.query(
    `INSERT INTO attachments(id, organization_id, storage_key, filename, content_type, size_bytes, sha256, created_by) VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [a.id ?? null, orgId, a.storageKey, a.filename, a.contentType, a.sizeBytes, a.sha256, userId]);
  return r.rows[0].id;
}
export async function getAttachment(db: Db, orgId: string, id: string): Promise<AttachmentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query('SELECT * FROM attachments WHERE id=$1 AND organization_id=$2', [id, orgId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export { map as mapAttachment };
