import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/** scrypt with parameters embedded in the hash, so cost can be raised later without breaking existing hashes. */
export interface ScryptCost { N: number; r: number; p: number }
export const DEFAULT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 }; // OWASP-recommended minimum
const KEYLEN = 64;

const derive = (pw: string, salt: Buffer, c: ScryptCost): Promise<Buffer> =>
  new Promise((res, rej) => scryptCb(pw.normalize('NFKC'), salt, KEYLEN, { N: c.N, r: c.r, p: c.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(pw, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Returns a problem description, or null if acceptable. Length over composition rules (NIST 800-63B). */
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 256) return 'Password is too long';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) return 'Password must not contain your email name';
  if (/^(.)\1+$/.test(pw)) return 'Password is too repetitive';
  return null;
}
