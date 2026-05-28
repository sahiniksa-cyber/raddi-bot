'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Set a stable test key BEFORE requiring the module.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SECRETS_KEY = TEST_KEY;

const { encrypt, decrypt, isEncryptionAvailable } = require('../src/services/security/secrets');

test('isEncryptionAvailable returns true when SECRETS_KEY is set', () => {
  assert.equal(isEncryptionAvailable(), true);
});

test('encrypt/decrypt roundtrip preserves the plaintext', () => {
  const plaintext = 'sk-test-1234567890abcdefghij';
  const enc = encrypt(plaintext);
  assert.ok(enc.ciphertext);
  assert.ok(enc.iv);
  assert.ok(enc.tag);
  assert.notEqual(enc.ciphertext, plaintext, 'ciphertext is not equal to plaintext');
  const dec = decrypt(enc);
  assert.equal(dec, plaintext);
});

test('decrypt throws on tampered ciphertext', () => {
  const enc = encrypt('hello-world');
  // flip one byte of ciphertext
  const buf = Buffer.from(enc.ciphertext, 'base64');
  buf[0] ^= 0xff;
  enc.ciphertext = buf.toString('base64');
  assert.throws(() => decrypt(enc));
});

test('decrypt throws on tampered tag', () => {
  const enc = encrypt('hello-world');
  const buf = Buffer.from(enc.tag, 'base64');
  buf[0] ^= 0xff;
  enc.tag = buf.toString('base64');
  assert.throws(() => decrypt(enc));
});

test('SECRETS_KEY must be 32 bytes when decoded from base64', () => {
  const prev = process.env.SECRETS_KEY;
  // Require a fresh module so getKey() re-evaluates env.
  delete require.cache[require.resolve('../src/services/security/secrets')];
  process.env.SECRETS_KEY = Buffer.alloc(16).toString('base64'); // wrong length
  const mod = require('../src/services/security/secrets');
  assert.throws(() => mod.encrypt('x'), /SECRETS_KEY must be base64-encoded 32 bytes/);
  // restore
  process.env.SECRETS_KEY = prev;
  delete require.cache[require.resolve('../src/services/security/secrets')];
});

test('encrypt uses a fresh IV every call', () => {
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('crypto sanity: random IV length is 12 bytes (GCM standard)', () => {
  const enc = encrypt('x');
  assert.equal(Buffer.from(enc.iv, 'base64').length, 12);
  // tag is 16 bytes (128 bits)
  assert.equal(Buffer.from(enc.tag, 'base64').length, 16);
  // sanity: ensure module is not accidentally falling back to plaintext
  assert.notEqual(enc.ciphertext, Buffer.from('x', 'utf8').toString('base64'));
  // unused but exercise crypto import to silence linter
  void crypto;
});
