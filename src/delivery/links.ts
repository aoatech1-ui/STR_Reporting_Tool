import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed, expiring, non-guessable link token: <statementId>.<expiresMs>.<hmac>. */
export function signLink(statementId: string, secret: string, expiresAtMs: number): string {
  const body = `${statementId}.${expiresAtMs}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyLink(token: string, secret: string, nowMs: number): { ok: true; statementId: string } | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [id, exp, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!/^\d+$/.test(exp) || Number(exp) < nowMs) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, statementId: id };
}
