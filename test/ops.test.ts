import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolOptionsFromEnv } from '../src/db/pool.ts';
import { weakSecret } from '../src/ops/preflight.ts';

test('weak LINK_SECRET detection', () => {
  assert.match(weakSecret('short')!, /shorter/);
  assert.match(weakSecret('a'.repeat(40))!, /variety/);
  assert.match(weakSecret('change-me-please-change-me-please-xx9')!, /placeholder|variety/);
  assert.match(weakSecret('this-is-my-secret-value-for-links-123456')!, /placeholder/);
  assert.equal(weakSecret('k8Vq2mZp9XcR4tYb7NwLs3HdFj6GaE1uQ5oB0iTe'), null);
});

test('pool options from env: TLS modes, pool size, statement timeout', () => {
  const d = poolOptionsFromEnv({});
  assert.deepEqual([d.max, d.ssl, d.statement_timeout], [10, undefined, 30000]);
  assert.deepEqual(poolOptionsFromEnv({ DB_SSL: 'true' }).ssl, { rejectUnauthorized: true });
  assert.deepEqual(poolOptionsFromEnv({ DB_SSL: 'no-verify' }).ssl, { rejectUnauthorized: false });
  const ca = join(mkdtempSync(join(tmpdir(), 'ca-')), 'ca.pem'); writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
  assert.deepEqual(poolOptionsFromEnv({ DB_SSL: 'true', DB_SSL_CA_FILE: ca }).ssl, { rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n' });
  assert.equal(poolOptionsFromEnv({ DB_POOL_MAX: '25', DB_STATEMENT_TIMEOUT_MS: '5000' }).max, 25);
  assert.equal(poolOptionsFromEnv({ DB_POOL_MAX: '25', DB_STATEMENT_TIMEOUT_MS: '5000' }).statement_timeout, 5000);
  assert.equal(poolOptionsFromEnv({ DB_SSL: 'false' }).ssl, undefined);
});
