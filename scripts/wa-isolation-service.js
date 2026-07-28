'use strict';
/*
 * ISOLATED WhatsApp new-device pairing probe — TEMPORARY diagnostic service.
 *
 * Purpose: decide whether fresh QR pairing fails because of the PLATFORM
 * (long-running / hammered sessions, dashboard QR mismatch, lifecycle) or
 * because of the NUMBER / WhatsApp (account-level block on new device links).
 *
 * Hard isolation — this file imports NONE of the platform:
 *   - no PostgreSQL, no Redis, no BullMQ, no RuntimeBot, no workers, no AI,
 *     no campaigns, no send gateway, no platform services.
 *   - ONE Baileys socket, FRESH empty auth in a unique temp dir.
 *   - the live WA Web version from fetchLatestWaWebVersion() ONLY — if that
 *     fetch fails the probe STOPS and shows an error (never a guessed version).
 *
 * It serves the CURRENT live QR of that exact socket at GET / so the merchant
 * scans the real thing (no dashboard in between). Every pairing event is logged
 * (never the raw QR / keys / full numbers).
 *
 * Delete this service after the test.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ts = () => new Date().toISOString();
const events = []; // in-memory, redacted, for the web page
function record(line) {
  const entry = `${ts()} ${line}`;
  console.log('[wa-iso]', entry);
  events.push(entry);
  if (events.length > 200) events.shift();
}
const fp = (s) => (s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10) : 'none');
const redactId = (id) => {
  if (!id) return null;
  const s = String(id);
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`;
};

const stateView = {
  status: 'starting',
  waVersion: null,
  qrDataUrl: null,
  qrVersion: 0,
  qrIssuedAt: null,
  phone: null,
  lastClose: null,
  fatal: null,
};

let authDir = null;
let socketGeneration = 0;

async function startSocket() {
  const gen = ++socketGeneration;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    version: stateView.waVersion,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', async () => {
    record(`EVENT creds.update BEGIN gen=${gen}`);
    try {
      await saveCreds();
      record(`EVENT creds.update SAVED gen=${gen} registered=${!!state.creds?.registered} hasMe=${!!state.creds?.me?.id} me=${redactId(state.creds?.me?.id)}`);
    } catch (e) {
      record(`EVENT creds.update SAVE-FAILED gen=${gen}: ${e.message}`);
    }
  });

  sock.ev.on('connection.update', async (u) => {
    const code = u.lastDisconnect?.error?.output?.statusCode;
    const reason = code != null ? `${code} (${DisconnectReason[code] || '?'})` : '-';
    if (u.qr) {
      stateView.status = 'qr_ready';
      stateView.qrVersion += 1;
      stateView.qrIssuedAt = Date.now();
      stateView.qrDataUrl = await QRCode.toDataURL(u.qr, { width: 600, margin: 4, errorCorrectionLevel: 'M' });
      record(`EVENT qr_ready qrVersion=${stateView.qrVersion} gen=${gen} fp=${fp(u.qr)}`);
    }
    if (typeof u.connection === 'string' || u.isNewLogin) {
      const ageMs = stateView.qrIssuedAt ? Date.now() - stateView.qrIssuedAt : null;
      record(`EVENT connection.update conn=${u.connection || '-'} isNewLogin=${!!u.isNewLogin} gen=${gen} closeCode=${reason}${ageMs != null ? ` qrAgeMs=${ageMs}` : ''}`);
    }
    if (u.connection === 'open') {
      stateView.status = 'connected';
      stateView.phone = redactId(sock.user?.id);
      record(`*** CONNECTED gen=${gen} phone=${stateView.phone} — FRESH PAIRING SUCCEEDED ***`);
    }
    if (u.connection === 'close') {
      stateView.status = 'reconnecting';
      stateView.lastClose = reason;
      record(`*** CLOSED gen=${gen} code=${reason} ***`);
      // Keep a fresh live QR available: if we have not paired yet, rebuild the
      // socket quickly (mirrors the production 428 fix). One socket at a time.
      if (!state.creds?.registered) {
        setTimeout(() => { startSocket().catch((e) => record(`restart failed: ${e.message}`)); }, 1500);
      }
    }
  });
}

async function main() {
  authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-iso-'));
  record(`temp auth dir: ${authDir}`);
  try {
    const { version } = await fetchLatestWaWebVersion();
    if (!Array.isArray(version) || version.length !== 3) throw new Error('invalid version shape');
    stateView.waVersion = version;
    record(`WA Web version (live): ${version.join('.')}`);
  } catch (e) {
    stateView.status = 'fatal';
    stateView.fatal = `fetchLatestWaWebVersion failed: ${e.message}`;
    record(stateView.fatal + ' — STOPPING (no guessed version)');
  }

  http.createServer(async (req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<meta http-equiv="refresh" content="3"><title>WA isolation probe</title>`
      + `<style>body{font-family:system-ui;text-align:center;background:#0b0f14;color:#e6edf3;padding:16px}`
      + `img{width:min(90vw,420px);height:auto;background:#fff;padding:12px;border-radius:12px}`
      + `pre{text-align:left;max-width:640px;margin:12px auto;font-size:11px;white-space:pre-wrap;background:#111820;padding:10px;border-radius:8px;max-height:240px;overflow:auto}</style></head><body>`
      + `<h2>اختبار عزل الربط — status: ${stateView.status}</h2>`
      + (stateView.fatal ? `<h3 style="color:#ff6b6b">${stateView.fatal}</h3>` : '')
      + (stateView.status === 'connected' ? `<h1 style="color:#3fb950">✅ CONNECTED — ${stateView.phone}</h1>` : '')
      + (stateView.qrDataUrl && stateView.status !== 'connected' ? `<p>امسح خلال ٢٠ ثانية · WA ${stateView.waVersion?.join('.') || '?'} · qrV ${stateView.qrVersion}</p><img src="${stateView.qrDataUrl}">` : '')
      + `<pre>${events.slice(-30).join('\n')}</pre></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }).listen(PORT, () => record(`isolation probe listening on :${PORT}`));

  if (stateView.waVersion) await startSocket();
}

main().catch((e) => { console.error('[wa-iso] fatal', e); process.exit(1); });
