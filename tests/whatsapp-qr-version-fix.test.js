'use strict';

// Regression guard for the WhatsApp linking root cause.
//
// On @whiskeysockets/baileys 7.0.0-rc13, fetchLatestBaileysVersion() returns a
// STALE bundled WA Web version ([2,3000,1035194821]) while claiming isLatest:true.
// WhatsApp rejects device linking under that version, so the phone shows
// "Invalid QR code" / "Check your connection" and pairing never completes
// (Baileys issue #2679). The fix is to resolve the socket version from
// fetchLatestWaWebVersion() instead, with a pinned known-good fallback.
//
// This test FAILS on the pre-fix code (which called fetchLatestBaileysVersion)
// and PASSES after the fix — locking it so a future edit cannot silently regress.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bcmRaw = fs.readFileSync(
  path.join(__dirname, '../src/services/whatsapp/baileys-connection-manager.js'),
  'utf8',
);
// Strip comments so we inspect executable code only (the fix's own comment
// intentionally names the old function and must not count as a call).
const bcmCode = bcmRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('socket version is resolved via fetchLatestWaWebVersion (not the stale fetcher)', () => {
  assert.ok(
    /fetchLatestWaWebVersion/.test(bcmCode),
    'connection manager must import/use fetchLatestWaWebVersion',
  );
  assert.ok(
    !/fetchLatestBaileysVersion/.test(bcmCode),
    'connection manager must NOT reference the stale fetchLatestBaileysVersion in executable code',
  );
});

test('a pinned known-good WA Web fallback exists for when the live fetch fails', () => {
  assert.ok(
    /fetchLatestWaWebVersion\s*\(\s*\)/.test(bcmCode),
    'the live WA Web version must be fetched',
  );
  assert.ok(
    /\[\s*2\s*,\s*3000\s*,\s*\d+\s*\]/.test(bcmCode),
    'a pinned [2,3000,xxxx] WA Web version must exist as a fallback',
  );
});

test('the connection manager still loads without error after the fix', () => {
  assert.doesNotThrow(() => {
    require('../src/services/whatsapp/baileys-connection-manager.js');
  });
});
