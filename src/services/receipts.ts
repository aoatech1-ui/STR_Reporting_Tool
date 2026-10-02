import { createHash, randomUUID } from 'node:crypto';
import { withTx, type Pool } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import type { FileStore } from '../files/store.ts';
import { getAttachment, insertAttachment } from '../repo/attachments.ts';
import { getExpense } from '../repo/expenses.ts';
import { linkReceipt, listReceipts, unlinkReceipt } from '../repo/receipts.ts';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_RECEIPTS_PER_EXPENSE = 10;

/** Identifies the file by its bytes, never by the client-supplied type or extension. Only PDFs and common raster images are accepted (no SVG/HTML). */
export function sniffReceiptType(b: Buffer): { contentType: string; ext: string } | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf', ext: 'pdf' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { contentType: 'image/webp', ext: 'webp' };
  return null;
}

/** Display name only; the stored key never contains it. */
export function cleanFilename(raw: string | undefined, fallbackExt: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `receipt.${fallbackExt}`;
}

export async function uploadReceipt(pool: Pool, files: FileStore, orgId: string, userId: string, expenseId: string, rawFilename: string | undefined, bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new UserError('No file received', 400);
  if (bytes.length > MAX_RECEIPT_BYTES) throw new UserError('Receipt is larger than 10 MB', 413);
  const type = sniffReceiptType(bytes);
  if (!type) throw new UserError('Unsupported file. Attach a PDF, PNG, JPEG or WebP image.', 415);
  const expense = await getExpense(pool, orgId, expenseId);
  if (!expense) throw new UserError('Expense not found');
  const existing = await listReceipts(pool, orgId, expenseId);
  if (existing.length >= MAX_RECEIPTS_PER_EXPENSE) throw new UserError(`An expense can have at most ${MAX_RECEIPTS_PER_EXPENSE} receipts`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (existing.some((r) => r.sha256 === sha256)) throw new UserError('This file is already attached to the expense', 409);

  const id = randomUUID(), storageKey = `${orgId}/receipts/${id}.${type.ext}`, filename = cleanFilename(rawFilename, type.ext);
  await files.put(storageKey, bytes, type.contentType);
  try {
    await withTx(pool, async (tx) => {
      await insertAttachment(tx, orgId, userId, { id, storageKey, filename, contentType: type.contentType, sizeBytes: bytes.length, sha256 });
      await linkReceipt(tx, orgId, userId, expenseId, { id, filename, sha256 });
    });
  } catch (e) { await files.delete(storageKey).catch(() => {}); throw e; }
  return { id, filename, contentType: type.contentType, sizeBytes: bytes.length, sha256 };
}

export async function deleteReceipt(pool: Pool, files: FileStore, orgId: string, userId: string, attachmentId: string): Promise<void> {
  const key = await withTx(pool, (tx) => unlinkReceipt(tx, orgId, userId, attachmentId));
  await files.delete(key).catch(() => {}); // a leftover blob is harmless; the record and audit entry are authoritative
}

/** Bytes of a stored receipt, verified against the hash recorded at upload. */
export async function readReceipt(pool: Pool, files: FileStore, orgId: string, attachmentId: string) {
  const att = await getAttachment(pool, orgId, attachmentId);
  if (!att) throw new UserError('Receipt not found');
  const bytes = await files.get(att.storageKey);
  if (!bytes) throw new UserError('Receipt file is missing from storage', 410);
  if (createHash('sha256').update(bytes).digest('hex') !== att.sha256) throw new UserError('Receipt file failed its integrity check', 500);
  return { att, bytes };
}
