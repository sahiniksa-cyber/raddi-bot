'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');

const { findChrome, killChrome } = require('../../../lib/helpers');
const { RETRY, TIMERS } = require('../../../lib/constants');
const { MessageIngestService } = require('./message-ingest.service');

class EnterpriseWhatsAppConnectionManager extends EventEmitter {
  constructor({
    userId,
    dataDir,
    logger = console,
    ingestService = new MessageIngestService({ logger }),
    clientFactory = null,
  }) {
    super();
    if (!userId) throw new Error('userId is required');
    if (!dataDir) throw new Error('dataDir is required');

    this.userId = userId;
    this.dataDir = dataDir;
    this.sessionPath = path.join(dataDir, 'session');
    this.logger = logger;
    this.ingestService = ingestService;
    this.clientFactory = clientFactory;

    this.client = null;
    this.status = 'stopped';
    this.ready = false;
    this.phone = null;
    this.qr = null;
    this.qrVersion = 0;
    this.lastError = null;
    this.reconnectCount = 0;
    this.authFailureCount = 0;
    this.heartbeatFailures = 0;
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._qrWatchdogTimer = null;
    this._readyWatchdogTimer = null;
    this._launchTimer = null;
    this._running = false;
  }

  log(level, stage, message, meta) {
    const writer = this.logger?.[level] || this.logger?.log || console[level] || console.log;
    try {
      writer.call(this.logger, stage, message, meta);
    } catch (_) {
      console.log(`[${stage}] ${message}`);
    }
  }

  state() {
    return {
      status: this.status,
      ready: this.ready,
      phone: this.phone,
      qrVersion: this.qrVersion,
      error: this.lastError,
      reconnectCount: this.reconnectCount,
      authFailureCount: this.authFailureCount,
      heartbeatFailures: this.heartbeatFailures,
    };
  }

  emitState(stage) {
    this.emit('state_changed', { stage, ...this.state() });
  }

  setStatus(status, stage = status) {
    this.status = status;
    this.emitState(stage);
  }

  createClient() {
    if (this.clientFactory) return this.clientFactory();

    fs.mkdirSync(this.sessionPath, { recursive: true });
    this.cleanupBrowserProcesses('before client launch');
    this.cleanupChromiumLocks();
    const chromePath = findChrome();
    this.log('info', 'boot', chromePath ? `Chrome found: ${chromePath}` : 'Chrome path not found; Puppeteer will try bundled/default browser');
    const puppeteer = {
      headless: true,
      protocolTimeout: parseInt(process.env.WA_PROTOCOL_TIMEOUT_MS || '120000', 10),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',
        '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
        '--window-size=1280,720',
      ],
    };
    if (chromePath) puppeteer.executablePath = chromePath;

    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer,
      webVersionCache: this.webVersionCache(),
      qrMaxRetries: parseInt(process.env.WA_QR_MAX_RETRIES || '25', 10),
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      authTimeoutMs: parseInt(process.env.WA_AUTH_TIMEOUT_MS || '90000', 10),
    });
  }

  webVersionCache() {
    const mode = (process.env.WA_WEB_VERSION_CACHE || 'remote').trim().toLowerCase();
    if (mode === 'local') {
      return {
        type: 'local',
        path: path.join(this.dataDir, '.waweb-cache'),
        strict: false,
      };
    }
    return {
      type: 'remote',
      remotePath: process.env.WA_WEB_VERSION_CACHE_REMOTE_PATH ||
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
      strict: false,
    };
  }

  start(retryCount = 0) {
    if (this._running) {
      this.log('info', 'boot', `start ignored: already ${this.status}`);
      return false;
    }

    clearTimeout(this._retryTimer);
    this.stopHeartbeat();
    this._running = true;
    this.ready = false;
    this.lastError = null;
    this.qr = null;
    this.setStatus('waiting_qr', 'start');
    this.log('info', 'boot', `starting WhatsApp client${retryCount > 0 ? ` retry=${retryCount + 1}` : ''}`);

    try {
      this.client = this.createClient();
      this.attachEvents(this.client, retryCount);
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this._running = false;
      this.log('error', 'boot', `client creation failed: ${err.message}`, err);
      this.emitState('client_creation_failed');
      return false;
    }

    this.startQrWatchdog(retryCount);
    this.startLaunchWatchdog(retryCount);
    this.client.initialize().catch((err) => {
      if (!this._running) return;
      this.log('warn', 'boot', `initialize failed: ${err.message}`);
      this.scheduleReconnect(retryCount, `initialize: ${err.message}`);
    });

    return true;
  }

  async stop() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._qrWatchdogTimer);
    clearTimeout(this._readyWatchdogTimer);
    clearTimeout(this._launchTimer);
    this.stopHeartbeat();
    this._running = false;
    this.ready = false;
    this.setStatus('stopped', 'stop');
    this.qr = null;

    const current = this.client;
    this.client = null;
    if (current) {
      await Promise.race([
        current.destroy(),
        new Promise(resolve => setTimeout(resolve, 6000)),
      ]).catch(() => {});
    }
  }

  scheduleReconnect(retryCount, reason) {
    if (!this._running) return;

    const retryIndex = Math.min(retryCount, RETRY.DELAYS_MS.length - 1);
    const delay = RETRY.DELAYS_MS[retryIndex] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);
    const current = this.client;

    this.reconnectCount++;
    this.ready = false;
    this.lastError = String(reason || 'unknown');
    this.client = null;
    this.stopHeartbeat();
    clearTimeout(this._qrWatchdogTimer);
    clearTimeout(this._readyWatchdogTimer);
    clearTimeout(this._launchTimer);
    this.log('warn', 'connection', `reconnect scheduled in ${Math.round(delay / 1000)}s: ${this.lastError}`);
    this.setStatus('reconnecting', 'reconnect');

    if (/QR watchdog|ready watchdog|initialize/i.test(String(reason || '')) && retryCount >= 1) {
      this.clearWebCache(`retry ${retryCount + 1}: ${reason}`);
    }
    if (/launch watchdog|profile appears to be in use|SingletonLock|Chromium has locked/i.test(String(reason || ''))) {
      this.cleanupBrowserProcesses(`reconnect: ${reason}`);
      this.cleanupChromiumLocks();
    }

    if (current) {
      Promise.race([
        current.destroy(),
        new Promise(resolve => setTimeout(resolve, 4000)),
      ]).catch(() => {});
    }

    this.emit('reconnecting', { delay, reason, reconnectCount: this.reconnectCount });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._running = false;
      this.start(retryCount + 1);
    }, delay);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  startQrWatchdog(retryCount) {
    clearTimeout(this._qrWatchdogTimer);
    const timeout = parseInt(process.env.WA_QR_WATCHDOG_TIMEOUT_MS || '90000', 10);
    this._qrWatchdogTimer = setTimeout(() => {
      if (!this._running || this.ready || this.qr) return;
      this.scheduleReconnect(retryCount, 'QR watchdog timeout');
    }, timeout);
    if (typeof this._qrWatchdogTimer.unref === 'function') this._qrWatchdogTimer.unref();
  }

  startLaunchWatchdog(retryCount) {
    clearTimeout(this._launchTimer);
    const timeout = parseInt(process.env.WA_LAUNCH_WATCHDOG_TIMEOUT_MS || '30000', 10);
    this._launchTimer = setTimeout(() => {
      if (!this._running || this.ready || this.qr || this.status !== 'waiting_qr') return;
      this.scheduleReconnect(retryCount, 'launch watchdog timeout before QR/loading');
    }, timeout);
    if (typeof this._launchTimer.unref === 'function') this._launchTimer.unref();
  }

  startReadyWatchdog(retryCount, stage) {
    if (this._readyWatchdogTimer) return;
    clearTimeout(this._readyWatchdogTimer);
    const timeout = parseInt(process.env.WA_READY_WATCHDOG_TIMEOUT_MS || '120000', 10);
    this._readyWatchdogTimer = setTimeout(() => {
      if (!this._running || this.ready) return;
      this.scheduleReconnect(retryCount, `ready watchdog timeout after ${stage}`);
    }, timeout);
    if (typeof this._readyWatchdogTimer.unref === 'function') this._readyWatchdogTimer.unref();
  }

  clearWebCache(reason) {
    try {
      fs.rmSync(path.join(this.dataDir, '.waweb-cache'), { recursive: true, force: true });
      this.log('warn', 'connection', `cleared WhatsApp web cache: ${reason}`);
    } catch (err) {
      this.log('warn', 'connection', `failed to clear WhatsApp web cache: ${err.message}`);
    }
  }

  cleanupChromiumLocks() {
    const lockNames = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
    let removed = 0;
    const scan = (dir, depth = 0) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
          continue;
        }
        if (!lockNames.has(entry.name)) continue;
        try {
          fs.rmSync(fullPath, { force: true });
          removed++;
        } catch (_) {}
      }
    };

    scan(this.sessionPath);
    if (removed > 0) {
      this.log('warn', 'boot', `removed ${removed} stale Chromium profile lock file(s)`);
    }
  }

  cleanupBrowserProcesses(reason) {
    const shouldKill = process.env.WA_KILL_CHROME_ON_START === 'true' ||
      (process.env.WA_KILL_CHROME_ON_START !== 'false' && process.env.NODE_ENV === 'production');
    if (!shouldKill) return;
    try {
      killChrome();
      this.log('warn', 'boot', `cleaned old Chromium processes: ${reason}`);
    } catch (err) {
      this.log('warn', 'boot', `failed to clean old Chromium processes: ${err.message}`);
    }
  }

  clearAuthCache(reason) {
    try {
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      fs.mkdirSync(this.sessionPath, { recursive: true });
      this.log('warn', 'auth', `cleared corrupted auth session: ${reason}`);
    } catch (err) {
      this.log('warn', 'auth', `failed to clear auth session: ${err.message}`);
    }
    try {
      this.clearWebCache(reason);
    } catch (_) {}
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      if (!this._running || !this.client || !this.ready) return;
      try {
        const state = await Promise.race([
          this.client.getState(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), 10000)),
        ]);
        if (state !== 'CONNECTED') {
          this.heartbeatFailures++;
          this.log('warn', 'heartbeat', `state=${state} failure=${this.heartbeatFailures}`);
          if (this.heartbeatFailures >= TIMERS.HEARTBEAT_FAIL_THRESHOLD) {
            this.scheduleReconnect(0, `heartbeat state=${state}`);
          }
        } else {
          this.heartbeatFailures = 0;
          this.emitState('heartbeat_ok');
        }
      } catch (err) {
        this.heartbeatFailures++;
        this.log('warn', 'heartbeat', `${err.message} failure=${this.heartbeatFailures}`);
        if (this.heartbeatFailures >= TIMERS.HEARTBEAT_FAIL_THRESHOLD) {
          this.scheduleReconnect(0, `heartbeat ${err.message}`);
        }
      }
    }, TIMERS.HEARTBEAT_INTERVAL_MS);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (!this._heartbeatTimer) return;
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  attachEvents(client, retryCount) {
    client.on('qr', (qr) => {
      if (!this._running) return;
      this.status = 'qr_ready';
      this.qr = qr;
      this.qrVersion++;
      this.lastError = null;
      this.authFailureCount = 0;
      clearTimeout(this._qrWatchdogTimer);
      clearTimeout(this._launchTimer);
      this.log('info', 'qr', `QR ready version=${this.qrVersion}`);
      this.emitState('qr');
      this.emit('qr', { qr, qrVersion: this.qrVersion });
    });

    client.on('loading_screen', (pct) => {
      if (!this._running) return;
      if (this.ready && this.status === 'connected') return;
      this.setStatus('connecting', 'loading');
      this.qr = null;
      clearTimeout(this._launchTimer);
      this.startReadyWatchdog(retryCount, `loading ${pct}%`);
      this.log('info', 'auth', `loading WhatsApp ${pct}%`);
    });

    client.on('authenticated', () => {
      if (!this._running) return;
      this.setStatus('connecting', 'authenticated');
      this.qr = null;
      this.authFailureCount = 0;
      this.startReadyWatchdog(retryCount, 'authenticated');
      this.log('info', 'auth', 'authenticated');
      this.emit('authenticated');
    });

    client.on('ready', () => {
      if (!this._running) return;
      this.ready = true;
      this.phone = client.info?.wid?.user || null;
      this.lastError = null;
      this.qr = null;
      this.authFailureCount = 0;
      this.heartbeatFailures = 0;
      clearTimeout(this._qrWatchdogTimer);
      clearTimeout(this._readyWatchdogTimer);
      clearTimeout(this._launchTimer);
      this.startHeartbeat();
      this.log('info', 'connection', `connected${this.phone ? ` phone=+${this.phone}` : ''}`);
      this.setStatus('connected', 'ready');
      this.emit('ready', this.state());
    });

    client.on('auth_failure', (message) => {
      this.ready = false;
      this.lastError = String(message || 'auth failure');
      this.authFailureCount++;
      this.log('error', 'auth', `auth failure: ${this.lastError}`);
      if (this.authFailureCount >= parseInt(process.env.WA_AUTH_FAILURES_BEFORE_CLEAR || '2', 10)) {
        this.clearAuthCache('repeated auth_failure');
        this.authFailureCount = 0;
      }
      this.setStatus('reconnecting', 'auth_failure');
      this.scheduleReconnect(retryCount, `auth_failure: ${message}`);
    });

    client.on('disconnected', (reason) => {
      if (!this._running) return;
      this.ready = false;
      this.setStatus('disconnected', 'disconnected');
      this.log('warn', 'connection', `disconnected: ${reason}`);
      this.emit('disconnected', reason);
      this.scheduleReconnect(0, `disconnected: ${reason}`);
    });

    client.on('change_state', (state) => {
      this.log('info', 'connection', `WhatsApp state: ${state}`);
      if (state === 'UNLAUNCHED' && this.ready) {
        this.scheduleReconnect(0, 'change_state: UNLAUNCHED');
      }
    });

    client.on('message', (msg) => {
      this.ingestService.ingestWhatsappMessage({ userId: this.userId, msg })
        .then(result => this.emit('message_ingested', result))
        .catch(err => {
          this.lastError = err.message;
          this.emit('message_ingest_error', err);
          this.logger.error?.('message', `ingest failed: ${err.message}`);
        });
    });
  }
}

module.exports = { EnterpriseWhatsAppConnectionManager };
