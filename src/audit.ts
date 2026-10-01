import { createHash } from 'node:crypto';

/** Key-sorted JSON so hashes survive a jsonb round trip (jsonb does not preserve key order). */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function chainHash(e: AuditEntry, seq: number, prevHash: string): string {
  return createHash('sha256').update(canonical({ ...e, seq, prevHash })).digest('hex');
}

export interface AuditEntry {
  userId: string; action: string; entityType: string; entityId: string;
  oldValue: unknown; newValue: unknown; at: string; meta?: { ip?: string; userAgent?: string };
}
export interface StoredAudit extends AuditEntry { seq: number; prevHash: string; hash: string }

/** Append-only, hash-chained log: any retroactive edit breaks verify(). Persist to an INSERT-only table. */
export class AuditLog {
  private entries: StoredAudit[] = [];
  append(e: AuditEntry): StoredAudit {
    const prevHash = this.entries.at(-1)?.hash ?? 'GENESIS';
    const seq = this.entries.length + 1;
    const stored = Object.freeze({ ...e, seq, prevHash, hash: chainHash(e, seq, prevHash) });
    this.entries.push(stored);
    return stored;
  }
  all(): readonly StoredAudit[] { return this.entries; }
  verify(entries: readonly StoredAudit[] = this.entries): boolean {
    let prev = 'GENESIS';
    return entries.every((s) => {
      const { seq, prevHash, hash, ...e } = s;
      const ok = prevHash === prev && hash === chainHash(e, seq, prevHash);
      prev = hash;
      return ok;
    });
  }
}
