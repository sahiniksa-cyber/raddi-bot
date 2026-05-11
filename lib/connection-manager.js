/**
 * lib/connection-manager.js — WhatsApp Connection Lifecycle
 *
 * مسؤوليات:
 *   1. إنشاء WhatsApp Client مع إعدادات Puppeteer الصحيحة
 *   2. إدارة دورة حياة الاتصال (start → QR → auth → ready → disconnect)
 *   3. Exponential Backoff مع Jitter لإعادة المحاولة
 *   4. تنسيق مع Heartbeat للمراقبة المستمرة
 *   5. إدارة عمليات Chrome (kill, cleanup)
 *
 * لا يعرف شيئاً عن الرسائل أو AI — يركز فقط على الاتصال
 *
 * Usage:
 *   const cm = new ConnectionManager({ logger, heartbeat, sessionPath, dataDir });
 *   cm.on('ready', (client) => { ... });
 *   cm.on('message', (msg) => { ... });
 *   cm.start();
 */
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs   = require('fs');
const { findChrome, killChrome } = require('./helpers');
const { RETRY, TIMERS } = require('./constants');

class ConnectionManager {
  /**
   * @param {object} opts
   * @param {import('./logger')} opts.logger
   * @param {import('./heartbeat')} opts.heartbeat
   * @param {string} opts.sessionPath — مسار حفظ الجلسة
   * @param {string} opts.dataDir — مسار البيانات العام
   * @param {Function} opts.isOtherBotRunning — () => boolean
   */
  constructor({ logger, heartbeat, sessionPath, dataDir, isOtherBotRunning }) {
    this.logger = logger;
    this.heartbeat = heartbeat;
    this.sessionPath = sessionPath;
    this.dataDir = dataDir;
    this.isOtherBotRunning = isOtherBotRunning || (() => false);

    // ── State ──
    this.client = null;
    this.running = false;
    this.ready = false;

    /** @type {'stopped'|'waiting_qr'|'qr_ready'|'connecting'|'connected'|'error'} */
    this.status = 'stopped';
    this.phone = null;
    this.qrString = null;
    this.qrVersion = 0;
    this.error = null;

    // ── Timers ──
    this._retryTimer = null;

    // ── Callbacks ──
    this._onMessage = null;
    this._onMessageCreate = null;
    this._onReady = null;
    this._onDisconnect = null;
    this._onQr = null;
  }

  // ── Event Registration ──────────────────────────────────────────────
  on(event, fn) {
    switch (event) {
      case 'message':        this._onMessage = fn; break;
      case 'message_create': this._onMessageCreate = fn; break;
      case 'ready':          this._onReady = fn; break;
      case 'disconnected':   this._onDisconnect = fn; break;
      case 'qr':             this._onQr = fn; break;
    }
  }

  // ── Client Creation ─────────────────────────────────────────────────
  _createClient() {
    const chromePath = findChrome();
    this.logger.info('boot', chromePath ? `🌐 Chrome: ${chromePath}` : '⚠️ Chrome: مسار غير معروف');

    const puppeteerCfg = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--disable-gpu', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--disable-translate',
        '--metrics-recording-only', '--safebrowsing-disable-auto-update',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling', '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-software-rasterizer', '--ignore-certificate-errors',
        '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
        '--window-size=1280,720',
      ],
    };
    if (chromePath) puppeteerCfg.executablePath = chromePath;

    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: puppeteerCfg,
      webVersionCache: {
        type: 'local',
        path: path.join(this.dataDir, '.waweb-cache'),
      },
      qrMaxRetries: 10,
      takeoverOnConflict: true,
    });
  }

  // ── Start ───────────────────────────────────────────────────────────
  start(retryCount = 0) {
    // Clean up pending timers
    clearTimeout(this._retryTimer);
    this.heartbeat.destroy();

    if (this.running) {
      this.logger.info('boot', `start ignored — already ${this.status}`);
      return;
    }

    this.running = true;
    this.ready = false;
    this.status = 'waiting_qr';
    this.error = null;
    this.qrString = null;
    this.logger.info('boot', `🚀 جاري تشغيل البوت${retryCount > 0 ? ` (محاولة ${retryCount + 1})` : ''}...`);

    // Kill stale Chrome (only if no other bot is alive)
    if (!this.isOtherBotRunning()) {
      try { killChrome(); } catch (_) {}
    }

    // After 2 failed retries — wipe possibly corrupted cache
    if (retryCount >= 2) {
      try {
        const cachePath = path.join(this.dataDir, '.waweb-cache');
        if (fs.existsSync(cachePath)) {
          fs.rmSync(cachePath, { recursive: true, force: true });
          this.logger.info('boot', '🗑 تم مسح cache التالف (تنظيف عميق)');
        }
      } catch (_) {}
    }

    this.client = this._createClient();
    this._attachEvents(this.client, retryCount);

    // ── Watchdog ──
    this.heartbeat.startWatchdog(
      () => !this.running || this.status === 'qr_ready' || this.status === 'connected',
      (reason) => this._scheduleRetry(retryCount, reason),
    );

    this.client.initialize().catch(err => {
      if (!this.running) return;
      this.logger.warn('boot', 'فشل initialize: ' + err.message.substring(0, 120));
      this._scheduleRetry(retryCount, err.message);
    });
  }

  // ── Schedule Retry (Exponential Backoff with Jitter) ────────────────
  _scheduleRetry(retryCount, reason) {
    this.heartbeat.destroy();
    if (!this.running) return;

    const retryIndex = Math.min(retryCount, RETRY.DELAYS_MS.length - 1);
    const delay = RETRY.DELAYS_MS[retryIndex] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);

    // Tear down failed client
    const failedClient = this.client;
    this.running = false;
    this.ready = false;
    this.client = null;
    if (failedClient) {
      Promise.race([failedClient.destroy(), new Promise(r => setTimeout(r, 4000))]).catch(() => {});
    }

    // Kill Chrome
    if (!this.isOtherBotRunning()) {
      try { killChrome(); } catch (_) {}
    }

    this.status = 'connecting';
    this.error = `Reconnecting automatically: ${String(reason).substring(0, 120)}`;
    this.logger.info('connection', `retry ${retryCount + 1} in ${(delay / 1000).toFixed(1)}s (${String(reason).substring(0, 70)})`);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      if (!this.running) this.start(retryCount + 1);
    }, delay);
  }

  // ── Stop ─────────────────────────────────────────────────────────────
  async stop() {
    clearTimeout(this._retryTimer);
    this.heartbeat.destroy();

    if (!this.running) {
      this.status = 'stopped';
      this.qrString = null;
      return;
    }

    this.running = false;
    this.ready = false;
    this.status = 'stopped';
    this.phone = null;
    this.qrString = null;
    this.logger.info('connection', '🛑 تم إيقاف البوت');

    if (this.client) {
      try {
        await Promise.race([this.client.destroy(), new Promise(r => setTimeout(r, 6000))]);
      } catch (_) {}
      this.client = null;
    }
  }

  // ── Clear Session ───────────────────────────────────────────────────
  async clearSession() {
    if (this.running) {
      try { await Promise.race([this.stop(), new Promise(r => setTimeout(r, 5000))]); } catch (_) {}
    }
    try { fs.rmSync(this.sessionPath, { recursive: true, force: true }); } catch (e) {
      this.logger.warn('auth', 'تعذر حذف مجلد الجلسة: ' + e.message);
    }
    try {
      const cachePath = path.join(this.dataDir, '.waweb-cache');
      if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });
    } catch (_) {}
    this.qrString = null;
    this.qrVersion = 0;
    this.error = null;
    this.status = 'stopped';
    this.logger.info('auth', '🗑 تم مسح جلسة الواتساب — ستحتاج لمسح الباركود من جديد');
  }

  // ── Attach WhatsApp Events ──────────────────────────────────────────
  _attachEvents(c, retryCount) {
    const qrcodeTerminal = require('qrcode-terminal');

    c.on('qr', (qr) => {
      if (!this.running) return;
      this.heartbeat.clearWatchdog(); // QR fired — responsive
      this.logger.info('qr', '📱 ظهر الباركود!');
      qrcodeTerminal.generate(qr, { small: true });
      this.qrString = qr;
      this.qrVersion = (this.qrVersion || 0) + 1;
      this.status = 'qr_ready';
      this.error = null;
      if (this._onQr) this._onQr(qr);
    });

    c.on('loading_screen', (pct) => {
      if (!this.running) return;
      if (this.ready && this.status === 'connected') {
        this.logger.info('connection', '🔄 مزامنة في الخلفية ' + pct + '% (متصل)');
        return;
      }
      this.status = 'connecting';
      this.qrString = null;
      this.logger.info('auth', '⏳ ' + pct + '%');
    });

    c.on('authenticated', () => {
      if (!this.running) return;
      if (this.ready && this.status === 'connected') return;
      this.status = 'connecting';
      this.qrString = null;
      this.logger.info('auth', '🔐 تم التحقق');
    });

    c.on('ready', () => {
      if (!this.running) return;
      this.heartbeat.clearWatchdog();
      this.ready = true;
      this.status = 'connected';
      this.phone = c.info?.wid?.user || null;
      this.qrString = null;
      this.error = null;
      this.logger.info('connection', '✅ متصل! رقم: +' + this.phone);

      // ── Post-ready health probe → then start heartbeat ──
      this.heartbeat.scheduleHealthProbe(
        () => this.client.getState(),
        () => {
          // Probe passed → start continuous heartbeat
          this.heartbeat.startHeartbeat(
            () => this.client.getState(),
            (reason) => this._scheduleRetry(0, reason),
          );
        },
        (reason) => this._scheduleRetry(0, reason),
      );

      if (this._onReady) this._onReady(c);
    });

    c.on('auth_failure', (m) => {
      this.ready = false;
      this.status = 'connecting';
      this.error = 'Auth failure: ' + m;
      this.logger.error('auth', 'Auth failure — preserving LocalAuth files and reconnecting');
      this._scheduleRetry(retryCount, 'auth_failure: ' + m);
    });

    c.on('disconnected', (r) => {
      if (!this.running) return;
      this.ready = false;
      this.heartbeat.stopHeartbeat();
      this.logger.warn('connection', '⚠️ انقطع (' + r + ') — إعادة الاتصال تلقائياً...');
      if (this._onDisconnect) this._onDisconnect(r);
      this._scheduleRetry(0, 'disconnected: ' + r);
    });

    c.on('change_state', (state) => {
      this.logger.info('connection', '🔄 حالة WhatsApp: ' + state);
      if (state === 'CONFLICT') {
        this.logger.warn('connection', '⚠️ تعارض: WhatsApp مفتوح على جهاز آخر');
      }
      if (state === 'UNLAUNCHED' && this.ready) {
        this.logger.warn('connection', '⚠️ الجلسة فُقدت (UNLAUNCHED) — إعادة التشغيل');
        this.heartbeat.stopHeartbeat();
        this._scheduleRetry(0, 'change_state: UNLAUNCHED');
      }
    });

    c.on('message', (msg) => {
      if (this._onMessage) this._onMessage(msg);
    });

    c.on('message_create', (msg) => {
      if (this._onMessageCreate) this._onMessageCreate(msg);
    });
  }

  // ── State Snapshot (for API) ────────────────────────────────────────
  getState() {
    return {
      status: this.status,
      phone: this.phone,
      qrString: this.qrString,
      qrVersion: this.qrVersion,
      error: this.error,
    };
  }
}

module.exports = ConnectionManager;
