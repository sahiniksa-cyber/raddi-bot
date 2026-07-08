'use strict';

/**
 * Verify Meta's X-Hub-Signature-256 header on incoming Instagram webhooks.
 * Header form: "sha256=<hex>" where hex = HMAC-SHA256(rawBody, appSecret).
 * MUST hash the exact raw request bytes (not re-serialized JSON) or the
 * digest won't match. Mirrors verifyMoyasarSignature in billing.routes.js,
 * with the "sha256=" prefix Meta uses.
 */

const crypto = require('node:crypto');

function verifyInstagramSignature(rawBody, header, appSecret) {
  if (!header || !appSecret || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyInstagramSignature };
