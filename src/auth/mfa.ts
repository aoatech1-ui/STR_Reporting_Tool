import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// ---------- Base32 (RFC 4648, no padding) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------- TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) ----------
export const TOTP_PERIOD = 30, TOTP_DIGITS = 6;
export const newTotpSecret = () => base32Encode(randomBytes(20)); // 160 bits, the size RFC 4226 recommends

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
export const totpAt = (secretB32: string, unixSeconds: number, digits = TOTP_DIGITS) => hotp(base32Decode(secretB32), Math.floor(unixSeconds / TOTP_PERIOD), digits);

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Checks a 6-digit code against the current step and ±`window` steps (clock drift). Returns the matching time step or null.
 * Every candidate is compared in constant time. `lastStep` makes a code single-use: only a strictly later step is accepted.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, opts: { window?: number; lastStep?: number | null } = {}): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32), now = Math.floor(nowMs / 1000 / TOTP_PERIOD), w = opts.window ?? 1;
  let hit: number | null = null;
  for (let step = now - w; step <= now + w; step++) if (safeEq(hotp(secret, step), c) && hit === null) hit = step; // no early exit: constant work
  if (hit === null) return null;
  return opts.lastStep != null && hit <= opts.lastStep ? null : hit;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ---------- Keys: one master secret, two independent derived keys ----------
export interface MfaKeys { enc: Buffer; mac: Buffer }
export function deriveMfaKeys(master: string): MfaKeys {
  if (master.length < 32) throw new Error('MFA_ENCRYPTION_KEY must be at least 32 characters');
  const ikm = Buffer.from(master, 'utf8'), salt = Buffer.from('str-owner-accounting/mfa/v1');
  return { enc: Buffer.from(hkdfSync('sha256', ikm, salt, 'secret-encryption', 32)), mac: Buffer.from(hkdfSync('sha256', ikm, salt, 'recovery-code-hmac', 32)) };
}

/** AES-256-GCM. The user id is authenticated data, so a ciphertext copied onto another user's row fails to decrypt. */
export function encryptSecret(plain: string, userId: string, keys: MfaKeys): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keys.enc, iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decryptSecret(blob: string, userId: string, keys: MfaKeys): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
  const d = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(userId)); d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---------- Recovery codes: 10 characters from a 32-symbol alphabet = 50 bits each, shown as XXXXX-XXXXX ----------
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
export const RECOVERY_CODE_COUNT = 10;
export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => { const s = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(32)]).join(''); return `${s.slice(0, 5)}-${s.slice(5)}`; });
}
export const normalizeRecoveryCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const looksLikeRecoveryCode = (s: string) => /^[A-HJ-NP-Z2-9]{10}$/.test(normalizeRecoveryCode(s));
/** Keyed hash: a database leak alone is not enough to brute-force the codes offline. */
export const hashRecoveryCode = (code: string, keys: MfaKeys) => createHmac('sha256', keys.mac).update(normalizeRecoveryCode(code)).digest('hex');
