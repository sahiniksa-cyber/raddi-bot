'use strict';

/**
 * Verify Salla's X-Salla-Signature header on incoming Partner-app webhooks.
 *
 * Salla appends a bare 64-char hex digest = HMAC-SHA256(rawBody, webhookSecret)
 * — with NO "sha256=" prefix (unlike Meta's X-Hub-Signature-256). We MUST hash
 * the exact raw request bytes, not re-serialized JSON, or the digest won't
 * match. Mirrors verifyInstagramSignature, minus the prefix.
 *
 * Docs: https://docs.salla.dev/421119m0 (Webhooks — Security Strategies).
 */

const crypto = require('node:crypto');

function verifySallaSignature(rawBody, header, secret) {
  if (!header || !secret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifySallaSignature };
