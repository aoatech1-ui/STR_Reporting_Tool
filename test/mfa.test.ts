import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, decryptSecret, deriveMfaKeys, encryptSecret, generateRecoveryCodes, hashRecoveryCode, hotp, looksLikeRecoveryCode, newTotpSecret, normalizeRecoveryCode, otpauthUri, totpAt, verifyTotp } from '../src/auth/mfa.ts';

test('base32 matches the RFC 4648 test vectors and round-trips', () => {
  for (const [plain, enc] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(base32Encode(Buffer.from(plain)), enc); assert.equal(base32Decode(enc).toString(), plain);
  }
  assert.equal(base32Decode('mzxw 6ytb-oi==').toString(), 'foobar', 'case, spaces, hyphens and padding are tolerated');
  assert.throws(() => base32Decode('MZXW1'), /Invalid base32/);
  const r = newTotpSecret(); assert.equal(r.length, 32); assert.equal(base32Decode(r).length, 20);
});

test('TOTP matches the RFC 6238 SHA-1 test vectors (6-digit truncations of the published 8-digit values)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: [number, string, string][] = [[59, '94287082', '287082'], [1111111109, '07081804', '081804'], [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'], [2000000000, '69279037', '279037'], [20000000000, '65353130', '353130']];
  for (const [t, eight, six] of vectors) { assert.equal(totpAt(secret, t, 8), eight, `T=${t} (8 digits)`); assert.equal(totpAt(secret, t), six, `T=${t} (6 digits)`); }
  assert.equal(hotp(Buffer.from('12345678901234567890'), 0), '755224', 'RFC 4226 HOTP vector, counter 0');
  assert.equal(hotp(Buffer.from('12345678901234567890'), 9), '520489', 'RFC 4226 HOTP vector, counter 9');
});

test('verification: ±1 step for clock drift, nothing wider; non-codes rejected; a step can be used once', () => {
  const s = newTotpSecret(), t = 1_800_000_000_000;
  const at = (offsetSteps: number) => totpAt(s, t / 1000 + offsetSteps * 30);
  const step = Math.floor(t / 1000 / 30);
  assert.equal(verifyTotp(s, at(0), t), step);
  assert.equal(verifyTotp(s, at(-1), t), step - 1); assert.equal(verifyTotp(s, at(1), t), step + 1);
  assert.equal(verifyTotp(s, at(-2), t), null); assert.equal(verifyTotp(s, at(2), t), null);
  assert.equal(verifyTotp(s, ` ${at(0).slice(0, 3)} ${at(0).slice(3)} `, t), step, 'spaces as shown by authenticator apps');
  for (const bad of ['', '12345', '1234567', 'abcdef', '12345a', '000000x']) assert.equal(verifyTotp(s, bad, t), null);
  assert.equal(verifyTotp(s, at(0), t, { lastStep: step }), null, 'same step cannot be replayed');
  assert.equal(verifyTotp(s, at(0), t, { lastStep: step - 1 }), step);
  assert.equal(verifyTotp(s, at(-1), t, { lastStep: step }), null, 'an older step cannot be used after a newer one');
  assert.equal(verifyTotp(newTotpSecret(), at(0), t), null, 'a different secret does not verify');
});

test('otpauth URI carries what authenticator apps need', () => {
  const u = new URL(otpauthUri('JBSWY3DPEHPK3PXP', 'maria@example.com', 'Manager LLC'));
  assert.equal(u.protocol, 'otpauth:'); assert.equal(u.hostname, 'totp'); assert.equal(decodeURIComponent(u.pathname), '/Manager LLC:maria@example.com');
  assert.deepEqual([u.searchParams.get('secret'), u.searchParams.get('issuer'), u.searchParams.get('digits'), u.searchParams.get('period'), u.searchParams.get('algorithm')], ['JBSWY3DPEHPK3PXP', 'Manager LLC', '6', '30', 'SHA1']);
});

test('secret encryption: round trip, random IV, bound to the user, tamper-evident, key-dependent', () => {
  const keys = deriveMfaKeys('k8Vq2mZp9XcR4tYb7NwLs3HdFj6GaE1uQ5oB0iTe'), other = deriveMfaKeys('another-key-another-key-another-key-xx');
  const s = newTotpSecret(), a = encryptSecret(s, 'user-1', keys), b = encryptSecret(s, 'user-1', keys);
  assert.notEqual(a, b); assert.ok(!a.includes(s));
  assert.equal(decryptSecret(a, 'user-1', keys), s);
  assert.throws(() => decryptSecret(a, 'user-2', keys), Error, 'ciphertext copied to another user fails');
  assert.throws(() => decryptSecret(a, 'user-1', other), Error, 'wrong key fails');
  const parts = a.split(':'); const flipped = Buffer.from(parts[3], 'base64'); flipped[0] ^= 1;
  assert.throws(() => decryptSecret([parts[0], parts[1], parts[2], flipped.toString('base64')].join(':'), 'user-1', keys), Error, 'tampering fails');
  assert.throws(() => decryptSecret('garbage', 'user-1', keys), /Unrecognised/);
  assert.throws(() => deriveMfaKeys('short'), /32 characters/);
  assert.ok(!keys.enc.equals(keys.mac), 'encryption and recovery-code keys are independent');
});

test('recovery codes: 10 distinct, unambiguous, normalised, keyed-hashed', () => {
  const keys = deriveMfaKeys('k8Vq2mZp9XcR4tYb7NwLs3HdFj6GaE1uQ5oB0iTe');
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  for (const c of codes) { assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/); assert.ok(looksLikeRecoveryCode(c)); }
  assert.equal(normalizeRecoveryCode(' abcde-fghjk '), 'ABCDEFGHJK');
  assert.equal(hashRecoveryCode('abcde-fghjk', keys), hashRecoveryCode('ABCDEFGHJK', keys), 'case and hyphen do not matter');
  assert.notEqual(hashRecoveryCode('ABCDE-FGHJK', keys), hashRecoveryCode('ABCDE-FGHJL', keys));
  assert.notEqual(hashRecoveryCode('ABCDE-FGHJK', keys), hashRecoveryCode('ABCDE-FGHJK', deriveMfaKeys('another-key-another-key-another-key-xx')), 'hash depends on the server key');
  assert.equal(looksLikeRecoveryCode('123456'), false); assert.equal(looksLikeRecoveryCode('ABCDE-FGHJ'), false);
});
