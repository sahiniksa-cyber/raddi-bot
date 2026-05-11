'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');

const { findChrome } = require('../../../lib/helpers');
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
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._running = false;
  }

  state() {
    return {
      status: this.status,
      ready: this.ready,
      phone: this.phone,
      qrVersion: this.qrVersion,
      error: this.lastError,
      reconnectCount: this.reconnectCount,
    };
  }

  createClient() {
    if (this.clientFactory) return this.clientFactory();

    fs.mkdirSync(this.sessionPath, { recursive: true });
    const chromePath = findChrome();
    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-hang-monitor',
        '--window-size=1280,720',
      ],
    };
    if (chromePath) puppeteer.executablePath = chromePath;

    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer,
      webVersionCache: {
        type: 'local',
        path: path.join(this.dataDir, '.waweb-cache'),
        strict: false,
      },
      qrMaxRetries: 0,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      authTimeoutMs: 60000,
    });
  }

  start(retryCount = 0) {
    if (this._running) return false;

    clearTimeout(this._retryTimer);
    this.stopHeartbeat();
    this._running = true;
    this.ready = false;
    this.status = 'connecting';
    this.lastError = null;
    this.client = this.createClient();
    this.attachEvents(this.client, retryCount);

    this.client.initialize().catch((err) => {
      if (!this._running) return;
      this.scheduleReconnect(retryCount, `initialize: ${err.message}`);
    });

    return true;
  }

  async stop() {
    clearTimeout(this._retryTimer);
    this.stopHeartbeat();
    this._running = false;
    this.ready = false;
    this.status = 'stopped';
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
    this.status = 'reconnecting';
    this.lastError = String(reason || 'unknown');
    this.client = null;
    this.stopHeartbeat();

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
          this.scheduleReconnect(0, `heartbeat state=${state}`);
        }
      } catch (err) {
        this.scheduleReconnect(0, `heartbeat ${err.message}`);
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
      this.emit('qr', { qr, qrVersion: this.qrVersion });
    });

    client.on('authenticated', () => {
      if (!this._running) return;
      this.status = 'authenticated';
      this.qr = null;
      this.emit('authenticated');
    });

    client.on('ready', () => {
      if (!this._running) return;
      this.ready = true;
      this.status = 'connected';
      this.phone = client.info?.wid?.user || null;
      this.lastError = null;
      this.qr = null;
      this.startHeartbeat();
      this.emit('ready', this.state());
    });

    client.on('auth_failure', (message) => {
      this.ready = false;
      this.status = 'auth_failure';
      this.lastError = String(message || 'auth failure');
      this.scheduleReconnect(retryCount, `auth_failure: ${message}`);
    });

    client.on('disconnected', (reason) => {
      if (!this._running) return;
      this.ready = false;
      this.status = 'disconnected';
      this.emit('disconnected', reason);
      this.scheduleReconnect(0, `disconnected: ${reason}`);
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
