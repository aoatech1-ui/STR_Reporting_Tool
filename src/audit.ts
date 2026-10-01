import { createHash } from 'node:crypto';

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
    const body = JSON.stringify({ ...e, seq: this.entries.length + 1, prevHash });
    const stored = Object.freeze({ ...e, seq: this.entries.length + 1, prevHash, hash: createHash('sha256').update(body).digest('hex') });
    this.entries.push(stored);
    return stored;
  }
  all(): readonly StoredAudit[] { return this.entries; }
  verify(entries: readonly StoredAudit[] = this.entries): boolean {
    let prev = 'GENESIS';
    return entries.every((s) => {
      const { seq, prevHash, hash, ...e } = s;
      const body = JSON.stringify({ ...e, seq, prevHash });
      const ok = prevHash === prev && hash === createHash('sha256').update(body).digest('hex');
      prev = hash;
      return ok;
    });
  }
}
