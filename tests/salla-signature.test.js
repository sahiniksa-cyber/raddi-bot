'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifySallaSignature } = require('../src/services/salla/salla-signature');

// Salla appends a bare 64-char hex HMAC-SHA256 (NO "sha256=" prefix).
const secret = 'WEBHOOK_SECRET';
const raw = Buffer.from(JSON.stringify({ event: 'app.store.authorize', merchant: 123 }));
const good = crypto.createHmac('sha256', secret).update(raw).digest('hex');

test('accepts a valid signature', () => {
  assert.strictEqual(verifySallaSignature(raw, good, secret), true);
});

test('rejects a tampered body', () => {
  assert.strictEqual(verifySallaSignature(Buffer.from('{}'), good, secret), false);
});

test('rejects wrong secret', () => {
  assert.strictEqual(verifySallaSignature(raw, good, 'WRONG'), false);
});

test('rejects the Meta-style sha256= prefix (Salla does not use it)', () => {
  assert.strictEqual(verifySallaSignature(raw, 'sha256=' + good, secret), false);
});

test('rejects missing header / secret / body', () => {
  assert.strictEqual(verifySallaSignature(raw, '', secret), false);
  assert.strictEqual(verifySallaSignature(raw, good, ''), false);
  assert.strictEqual(verifySallaSignature(null, good, secret), false);
});
