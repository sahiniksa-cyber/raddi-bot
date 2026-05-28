'use strict';

/**
 * AES-256-GCM secrets module for at-rest encryption of sensitive values
 * (e.g. admin API keys). The key is loaded from SECRETS_KEY (base64-encoded
 * 32 bytes). In production the key is required. In dev/test it is optional —
 * when absent, encryption helpers return null so callers can fall back to
 * plaintext storage.
 */

const crypto = require('crypto');

function getKey() {
  const v = process.env.SECRETS_KEY;
  if (!v) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECRETS_KEY env required in production');
    }
    return null; // dev fallback => skip encryption
  }
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== 32) {
    throw new Error('SECRETS_KEY must be base64-encoded 32 bytes');
  }
  return buf;
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) return null; // dev: caller should fall back to plaintext storage
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt({ ciphertext, iv, tag }) {
  const key = getKey();
  if (!key) throw new Error('SECRETS_KEY not configured');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isEncryptionAvailable() {
  try {
    return Boolean(getKey());
  } catch (_) {
    return false;
  }
}

module.exports = { encrypt, decrypt, isEncryptionAvailable };
