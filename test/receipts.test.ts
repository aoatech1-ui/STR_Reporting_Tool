import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFilename, sniffReceiptType } from '../src/services/receipts.ts';
import { RECEIPT_THRESHOLD_CENTS } from '../src/accounting/exceptions.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);

test('receipt type is decided from the bytes, and only safe types are accepted', () => {
  assert.deepEqual(sniffReceiptType(Buffer.from('%PDF-1.7\n...')), { contentType: 'application/pdf', ext: 'pdf' });
  assert.deepEqual(sniffReceiptType(PNG), { contentType: 'image/png', ext: 'png' });
  assert.deepEqual(sniffReceiptType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { contentType: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffReceiptType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), { contentType: 'image/webp', ext: 'webp' });
  for (const bad of [Buffer.alloc(0), Buffer.from('%PDF'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html><script>alert(1)</script>'), Buffer.from('MZ\x90\x00'),
    Buffer.from('GIF89a......'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]), Buffer.from('#!/bin/sh\nrm -rf /')]) assert.equal(sniffReceiptType(bad), null);
});

test('filenames are display-only and sanitized', () => {
  assert.equal(cleanFilename('../../etc/passwd', 'pdf'), 'passwd');
  assert.equal(cleanFilename('C:\\Users\\me\\receipt (1).jpg', 'jpg'), 'receipt (1).jpg');
  assert.equal(cleanFilename('a"b<c>d|e?.png', 'png'), 'abcde.png');
  assert.equal(cleanFilename('line\nbreak\u0000.pdf', 'pdf'), 'linebreak.pdf');
  assert.equal(cleanFilename('', 'png'), 'receipt.png');
  assert.equal(cleanFilename('..', 'png'), 'receipt.png');
  assert.equal(cleanFilename(undefined, 'pdf'), 'receipt.pdf');
  assert.equal(cleanFilename('x'.repeat(500) + '.pdf', 'pdf').length, 120);
});

test('receipt threshold is $75', () => { assert.equal(RECEIPT_THRESHOLD_CENTS, 7500); });
