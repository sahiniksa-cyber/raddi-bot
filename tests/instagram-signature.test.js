'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyInstagramSignature } = require('../src/services/instagram/instagram-signature');

const secret = 'APP_SECRET';
const raw = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));
const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

test('accepts a valid signature', () => {
  assert.strictEqual(verifyInstagramSignature(raw, good, secret), true);
});

test('rejects a tampered body', () => {
  assert.strictEqual(verifyInstagramSignature(Buffer.from('{}'), good, secret), false);
});

test('rejects wrong secret', () => {
  assert.strictEqual(verifyInstagramSignature(raw, good, 'WRONG'), false);
});

test('rejects missing header / secret / body', () => {
  assert.strictEqual(verifyInstagramSignature(raw, '', secret), false);
  assert.strictEqual(verifyInstagramSignature(raw, good, ''), false);
  assert.strictEqual(verifyInstagramSignature(null, good, secret), false);
});
