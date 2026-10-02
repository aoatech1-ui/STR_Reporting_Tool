import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeKey, createFileStore, LocalDiskStore, S3Store } from '../src/files/store.ts';

test('local store: round trip, overwrite, missing = null, delete is idempotent, files are private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-'));
  const s = new LocalDiskStore(root);
  await s.put('org1/receipts/a.pdf', Buffer.from('one'), 'application/pdf');
  assert.equal((await s.get('org1/receipts/a.pdf'))!.toString(), 'one');
  await s.put('org1/receipts/a.pdf', Buffer.from('two'), 'application/pdf');
  assert.equal((await s.get('org1/receipts/a.pdf'))!.toString(), 'two');
  assert.equal(await s.get('org1/receipts/nope.pdf'), null);
  await s.delete('org1/receipts/a.pdf'); await s.delete('org1/receipts/a.pdf');
  assert.equal(await s.get('org1/receipts/a.pdf'), null);
  assert.deepEqual(readdirSync(root), ['org1']);
});

test('storage keys cannot escape the root or hide', async () => {
  for (const bad of ['../x', 'a/../../etc/passwd', '/etc/passwd', 'a//b', '.hidden', 'a/b/', '', 'a b', 'a\\b', 'x'.repeat(400), 'a/..\u0000/b']) assert.throws(() => assertSafeKey(bad), /Unsafe storage key/, JSON.stringify(bad.slice(0, 20)));
  assert.doesNotThrow(() => assertSafeKey('1f2e3d4c-aaaa-bbbb-cccc-1234567890ab/receipts/9f.pdf'));
  const s = new LocalDiskStore(mkdtempSync(join(tmpdir(), 'fs-')));
  await assert.rejects(() => s.put('../escape.txt', Buffer.from('x'), 'text/plain'), /Unsafe/);
  await assert.rejects(() => s.get('../../etc/passwd'), /Unsafe/);
});

/** Minimal path-style S3 server: PUT/GET/DELETE /bucket/key. Records request headers so we can check signing. */
async function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>(); const seen: http.IncomingHttpHeaders[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(req.headers); const key = decodeURIComponent((req.url ?? '').split('?')[0]);
      if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) }); res.writeHead(200, { etag: '"x"' }); return res.end(); }
      if (req.method === 'GET') { const o = objects.get(key); if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code><Message>nope</Message></Error>'); } res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length }); return res.end(o.body); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(405); res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { objects, seen, url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('S3 store: signed PUT/GET/DELETE against an S3-compatible endpoint, binary-safe, 404 = null, prefix applied', async () => {
  const s3 = await fakeS3();
  try {
    const store = new S3Store({ bucket: 'bkt', region: 'us-east-1', endpoint: s3.url, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', prefix: 'prod' });
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
    await store.put('org/receipts/r1.pdf', bytes, 'application/pdf');
    assert.ok(s3.objects.has('/bkt/prod/org/receipts/r1.pdf'), [...s3.objects.keys()].join());
    assert.equal(s3.objects.get('/bkt/prod/org/receipts/r1.pdf')!.type, 'application/pdf');
    assert.ok(String(s3.seen[0].authorization).startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/'), 'requests are SigV4-signed');
    assert.ok(!String(s3.seen[0].authorization).includes('secret'));
    assert.ok((await store.get('org/receipts/r1.pdf'))!.equals(bytes));
    assert.equal(await store.get('org/receipts/missing.pdf'), null);
    await store.delete('org/receipts/r1.pdf');
    assert.equal(await store.get('org/receipts/r1.pdf'), null);
    await assert.rejects(() => store.put('../evil', bytes, 'x'), /Unsafe/);
  } finally { await s3.close(); }
});

test('factory: local default, s3 needs its settings, unknown kinds rejected', () => {
  assert.equal(createFileStore({}).kind, 'local');
  assert.equal(createFileStore({ FILE_STORE: 'local', FILE_STORE_DIR: '/tmp/x' }).kind, 'local');
  assert.throws(() => createFileStore({ FILE_STORE: 's3' }), /S3_BUCKET/);
  assert.throws(() => createFileStore({ FILE_STORE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a' }), /S3_SECRET_ACCESS_KEY/);
  assert.equal(createFileStore({ FILE_STORE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com' }).kind, 's3');
  assert.throws(() => createFileStore({ FILE_STORE: 'ftp' }), /Unknown FILE_STORE/);
});
