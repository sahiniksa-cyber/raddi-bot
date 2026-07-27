'use strict';

// Regression guard for the WhatsApp linking QR DISPLAY path.
//
// Symptoms this locks down: the phone showed "Invalid QR code" / "Check your
// connection and try again". One class of cause is a corrupted QR image — the
// bytes the phone decodes differ from the raw ref Baileys emitted (double
// encoding, charset mangling of +/=, truncation, whitespace, or a stale image
// served after qrVersion advanced). These tests render the QR through the REAL
// controller, decode the produced PNG back to a string, and assert it equals the
// raw payload byte-for-byte. They FAIL if any transform is introduced between
// connection.qr and the pixels on screen.
//
// NOTE: a green result here proves the DISPLAY path is faithful. It does NOT by
// itself prove linking works end-to-end (socket/version/session) — that requires
// a live scan. See the linking success-criteria in the incident report.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const QRCode = require('qrcode');

const { createBotController } = require('../src/controllers/bot.controller');
const bcmSourceRaw = require('fs').readFileSync(
  require('path').join(__dirname, '../src/services/whatsapp/baileys-connection-manager.js'),
  'utf8',
);
// Strip block and line comments so the version-regression assertions inspect
// executable code only — the explanatory comment intentionally names the old
// function, and must not be mistaken for a real call.
const bcmCode = bcmSourceRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// A realistic Baileys pairing ref: multi-segment, base64 payloads containing the
// exact characters naive encoding corrupts (+ / =), comma separators, ~220 chars.
// This is also the DENSE case: if the controller's width/ECC settings can't be
// decoded at this length, that is itself a real finding.
const RAW_QR = [
  '2@9Qx1Zk3+aBcD/efGhIjKlMnOpQrStUvWxYz0123456789+/aB==',
  'kQwErTyUiOpAsDfGhJkLzXcVbNm+/1234567890abcdefGHIJ==',
  'ZxCvBnMaSdFgHjKlPoIuYtReWq+/0987654321zyxwvutsRQ==',
  'PlMkNjBhVgCfXdZsAqWeRtYuIo+/1122334455667788990A==',
].join(',');

function createResponse() {
  return {
    code: 200,
    body: null,
    headers: {},
    status(code) { this.code = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(body) { this.body = body; return this; },
    end() { return this; },
    json(body) { this.body = body; return this; },
  };
}

function botWith(appState) {
  return { config: { autoReplyEnabled: true }, appState, totalChatsHandled: 0 };
}

function decodePngToQrString(buffer) {
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded ? decoded.data : null;
}

test('QR round-trip: the controller image decodes back to the raw ref exactly', async () => {
  const controller = createBotController({
    getUserBot: () => botWith({ status: 'qr_ready', qrString: RAW_QR, qrVersion: 7, logs: [] }),
  });
  const res = createResponse();
  await controller.qrImage({ session: { userId: 'u1' } }, res);

  assert.ok(Buffer.isBuffer(res.body), 'qrImage must return a PNG buffer');
  const decoded = decodePngToQrString(res.body);
  assert.equal(
    decoded,
    RAW_QR,
    'decoded QR must equal the raw payload byte-for-byte (no double-encoding, charset mangling, or truncation)',
  );
});

test('QR round-trip: a realistic-length ref is still decodable at the controllers width/ECC', async () => {
  // Guards against a display setting (too small / too high ECC → too dense) that
  // renders a code the phone cannot read even though the content is correct.
  const buf = await QRCode.toBuffer(RAW_QR, {
    width: 512, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'H',
  });
  assert.equal(decodePngToQrString(buf), RAW_QR, 'the QR settings must produce a decodable image at real ref length');
});

test('/api/qr returns the raw ref unmodified and a matching qrVersion', async () => {
  const controller = createBotController({
    getUserBot: () => botWith({ status: 'qr_ready', qrString: RAW_QR, qrVersion: 7, logs: [] }),
  });
  const res = createResponse();
  await controller.qr({ session: { userId: 'u1' } }, res);
  assert.equal(res.body.qr, RAW_QR, 'the raw ref must not be transformed on the wire');
  assert.equal(res.body.qrVersion, 7);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
});

test('qrVersion is consistent between /api/status and /api/qr for the same live QR', async () => {
  const bot = botWith({ status: 'qr_ready', qrString: RAW_QR, qrVersion: 11, logs: [] });
  const controller = createBotController({ getUserBot: () => bot });

  const statusRes = createResponse();
  controller.status({ session: { userId: 'u1' } }, statusRes);
  const qrRes = createResponse();
  await controller.qr({ session: { userId: 'u1' } }, qrRes);

  assert.equal(statusRes.body.qrVersion, qrRes.body.qrVersion, 'status and qr must report the same generation');
  assert.equal(statusRes.body.qrString, undefined, 'status must NOT leak the raw ref');
});

test('the controller always serves the CURRENT qr, never a stale one', async () => {
  const bot = botWith({ status: 'qr_ready', qrString: RAW_QR, qrVersion: 1, logs: [] });
  const controller = createBotController({ getUserBot: () => bot });

  const first = createResponse();
  await controller.qrImage({ session: { userId: 'u1' } }, first);
  assert.equal(decodePngToQrString(first.body), RAW_QR);

  // QR rotates: the socket emits a new ref and bumps the version.
  const NEXT_QR = RAW_QR.replace('2@9Qx1', '2@7Zk9');
  bot.appState.qrString = NEXT_QR;
  bot.appState.qrVersion = 2;

  const second = createResponse();
  await controller.qrImage({ session: { userId: 'u1' } }, second);
  assert.equal(
    decodePngToQrString(second.body),
    NEXT_QR,
    'after a rotation the image must reflect the NEW ref, not the previous one',
  );
});

test('regression: the socket must use fetchLatestWaWebVersion, not the stale fetchLatestBaileysVersion', () => {
  // Root cause of "Invalid QR code": on baileys 7.0.0-rc13, fetchLatestBaileysVersion()
  // returns a stale WA Web version that WhatsApp rejects at link time (issue #2679).
  // Lock the socket to the correct fetcher so a future edit can't silently regress.
  assert.ok(
    /fetchLatestWaWebVersion/.test(bcmCode),
    'connection manager must import/use fetchLatestWaWebVersion',
  );
  assert.ok(
    !/fetchLatestBaileysVersion/.test(bcmCode),
    'connection manager must NOT reference the stale fetchLatestBaileysVersion in executable code',
  );
});
