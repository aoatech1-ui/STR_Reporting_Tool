import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, passwordProblem, verifyPassword } from '../src/auth/password.ts';
import { GRANTS, can, type Permission, type Role } from '../src/auth/permissions.ts';

const LOW = { N: 1024, r: 8, p: 1 };

test('password hashes are salted, verify, and carry their own cost parameters', async () => {
  const a = await hashPassword('correct horse battery', LOW), b = await hashPassword('correct horse battery', LOW);
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$1024\$8\$1\$/);
  assert.ok(await verifyPassword('correct horse battery', a));
  assert.ok(!(await verifyPassword('Correct horse battery', a)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
  assert.ok(!a.includes('correct horse'));
});

test('password policy: length, reuse of email name, repetition', () => {
  assert.match(passwordProblem('short')!, /12/);
  assert.match(passwordProblem('johnsmith-2026-xyz', 'johnsmith@example.com')!, /email/);
  assert.match(passwordProblem('aaaaaaaaaaaaaa')!, /repetitive/);
  assert.equal(passwordProblem('a fine long passphrase here', 'me@example.com'), null);
});

test('permission matrix', () => {
  const expected: Record<Role, Permission[]> = {
    ADMIN: ['read', 'owners:write', 'properties:write', 'commission:write', 'expenses:write', 'import:write', 'period:review', 'period:finalize', 'statements:send', 'audit:read', 'users:manage', 'settings:view'],
    MANAGER: ['read', 'owners:write', 'properties:write', 'commission:write', 'expenses:write', 'import:write', 'period:review', 'period:finalize', 'statements:send', 'audit:read', 'settings:view'],
    ACCOUNTANT: ['read', 'expenses:write', 'import:write', 'period:review', 'audit:read'],
    VIEWER: ['read'],
  };
  for (const role of Object.keys(expected) as Role[]) assert.deepEqual([...GRANTS[role]].sort(), [...expected[role]].sort(), role);
  assert.ok(!can('ACCOUNTANT', 'period:finalize') && !can('ACCOUNTANT', 'statements:send') && !can('VIEWER', 'expenses:write'));
  assert.ok(!can('MANAGER', 'users:manage'));
  assert.ok(!can('NOPE' as Role, 'read'));
});
