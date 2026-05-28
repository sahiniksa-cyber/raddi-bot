#!/usr/bin/env node
'use strict';

/**
 * One-off migration: encrypt every admin_api_keys row that is still stored
 * in plaintext (`api_key_format = 'plaintext'`) using the AES-256-GCM key
 * configured in SECRETS_KEY.
 *
 * Usage:
 *   SECRETS_KEY=<base64-32-bytes> node scripts/encrypt-existing-api-keys.js
 *
 * Safe to run multiple times — rows that are already encrypted are skipped.
 */

require('dotenv').config({ quiet: true });

const db = require('../src/db/client');
const { encrypt, isEncryptionAvailable } = require('../src/services/security/secrets');

async function main() {
  if (!isEncryptionAvailable()) {
    console.error('SECRETS_KEY is not configured. Run `node scripts/generate-secrets-key.js`.');
    process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT provider, api_key
       FROM admin_api_keys
      WHERE COALESCE(api_key_format, 'plaintext') = 'plaintext'
        AND api_key IS NOT NULL
        AND api_key <> ''`,
  );

  if (rows.length === 0) {
    console.log('[encrypt-existing-api-keys] nothing to do — no plaintext rows.');
    await db.close();
    return;
  }

  console.log(`[encrypt-existing-api-keys] encrypting ${rows.length} row(s)...`);
  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      const enc = encrypt(row.api_key);
      if (!enc) throw new Error('encrypt() returned null');
      await db.query(
        `UPDATE admin_api_keys
            SET api_key            = '',
                api_key_encrypted  = $2,
                api_key_iv         = $3,
                api_key_tag        = $4,
                api_key_format     = 'aes-256-gcm',
                updated_at         = NOW()
          WHERE provider = $1`,
        [row.provider, enc.ciphertext, enc.iv, enc.tag],
      );
      ok++;
      console.log(`  - ${row.provider}: encrypted`);
    } catch (err) {
      fail++;
      console.error(`  - ${row.provider}: FAILED — ${err.message}`);
    }
  }

  console.log(`[encrypt-existing-api-keys] done. ok=${ok} fail=${fail}`);
  await db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
