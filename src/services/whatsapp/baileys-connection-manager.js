'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pino = require('pino');
const {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeWASocket,
} = require('@whiskeysockets/baileys');

const db = require('../../db/client');
const { RETRY, TIMERS } = require('../../../lib/constants');
const { MessageIngestService } = require('./message-ingest.service');
const { usePostgresBaileysAuthState, BaileysPostgresAuthState } = require('./baileys-postgres-auth');

function textFromBaileysMessage(message = {}) {
  return String(
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    '',
  ).trim();
}

function normalizeOutboundJid(target) {
  const raw = String(target || '').trim();
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us') || raw.endsWith('@lid')) return raw;
  const clean = raw.replace('@c.us', '').replace(/[^\d]/g, '');
  return clean ? `${clean}@s.whatsapp.net` : raw;
}

function toWhatsappWebMessage(msg) {
  const remoteJid = msg.key?.remoteJid || null;
  return {
    id: { _serialized: msg.key?.id || null, id: msg.key?.id || null },
    from: remoteJid,
    to: msg.key?.participant || null,
    author: msg.key?.participant || null,
    fromMe: !!msg.key?.fromMe,
    body: textFromBaileysMessage(msg.message || {}),
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : null,
    type: Object.keys(msg.message || {})[0] || 'unknown',
    hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage || msg.message?.audioMessage),
    deviceType: 'baileys',
  };
}

class BaileysConnectionManager extends EventEmitter {
  constructor({
    userId,
    dataDir,
    logger = console,
    ingestService = new MessageIngestService({ logger }),
    database = db,
  }) {
    super();
    if (!userId) throw new Error('userId is required');
    if (!dataDir) throw new Error('dataDir is required');

    this.userId = userId;
    this.dataDir = dataDir;
    this.sessionPath = path.join(dataDir, 'baileys-session');
    this.logger = logger;
    this.ingestService = ingestService;
    this.db = database;

    this.sock = null;
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
    this.statusSince = Date.now();
    this.lastProbeState = null;
    this._running = false;
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._qrWatchdogTimer = null;
    this._version = null;
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
      statusAgeMs: Date.now() - this.statusSince,
      lastProbeState: this.lastProbeState,
    };
  }

  emitState(stage) {
    this.emit('state_changed', { stage, ...this.state() });
  }

  setStatus(status, stage = status) {
    if (this.status !== status) this.statusSince = Date.now();
    this.status = status;
    this.emitState(stage);
  }

  async start(retryCount = 0) {
    if (this._running) {
      this.log('info', 'boot', `start ignored: already ${this.status}`);
      return false;
    }

    this._running = true;
    this.ready = false;
    this.lastError = null;
    this.qr = null;
    this.setStatus('waiting_qr', 'start');
    this.log('info', 'boot', `starting Baileys WhatsApp socket${retryCount > 0 ? ` retry=${retryCount + 1}` : ''}`);

    try {
      const { state, saveCreds } = await usePostgresBaileysAuthState({ db: this.db, userId: this.userId });
      if (!this._version) {
        const { version } = await fetchLatestBaileysVersion();
        this._version = version;
      }

      const sock = makeWASocket({
        auth: state,
        version: this._version,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
      });

      this.sock = sock;
      this.client = {
        sendMessage: async (target, text) => sock.sendMessage(normalizeOutboundJid(target), { text: String(text || '') }),
        getState: async () => (this.ready ? 'CONNECTED' : this.status.toUpperCase()),
      };

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update, retryCount).catch((err) => {
          this.lastError = err.message;
          this.log('error', 'connection', `Baileys connection update failed: ${err.message}`, err);
        });
      });
      sock.ev.on('messages.upsert', (event) => this.handleMessages(event));
      this.startQrWatchdog(retryCount);
      return true;
    } catch (err) {
      this.lastError = err.message;
      this._running = false;
      this.setStatus('error', 'start_failed');
      this.log('error', 'boot', `Baileys start failed: ${err.message}`, err);
      return false;
    }
  }

  async stop() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._qrWatchdogTimer);
    this.stopHeartbeat();
    this._retryTimer = null;
    this._qrWatchdogTimer = null;
    this._running = false;
    this.ready = false;
    this.qr = null;
    this.setStatus('stopped', 'stop');

    const sock = this.sock;
    this.sock = null;
    this.client = null;
    try { sock?.end?.(new Error('stopped')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
  }

  startQrWatchdog(retryCount) {
    clearTimeout(this._qrWatchdogTimer);
    const timeout = parseInt(process.env.WA_QR_WATCHDOG_TIMEOUT_MS || '90000', 10);
    this._qrWatchdogTimer = setTimeout(() => {
      this._qrWatchdogTimer = null;
      if (!this._running || this.ready || this.qr) return;
      this.scheduleReconnect(retryCount, 'Baileys QR watchdog timeout');
    }, timeout);
    if (typeof this._qrWatchdogTimer.unref === 'function') this._qrWatchdogTimer.unref();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._running || !this.ready) return;
      this.heartbeatFailures = 0;
      this.emitState('heartbeat_ok');
    }, TIMERS.HEARTBEAT_INTERVAL_MS);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (!this._heartbeatTimer) return;
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  scheduleReconnect(retryCount, reason) {
    if (!this._running) return;
    const retryIndex = Math.min(retryCount, RETRY.DELAYS_MS.length - 1);
    const delay = RETRY.DELAYS_MS[retryIndex] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);
    this.reconnectCount++;
    this.ready = false;
    this.qr = null;
    this.lastError = String(reason || 'unknown');
    this.stopHeartbeat();
    this.setStatus('reconnecting', 'reconnect');
    this.log('warn', 'connection', `Baileys reconnect scheduled in ${Math.round(delay / 1000)}s: ${this.lastError}`);
    try { this.sock?.end?.(new Error('reconnect')); } catch (_) {}
    try { this.sock?.ws?.close?.(); } catch (_) {}
    this.sock = null;
    this.client = null;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._running = false;
      this.start(retryCount + 1).catch((err) => {
        this.log('error', 'connection', `Baileys reconnect failed: ${err.message}`, err);
      });
    }, delay);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  async handleConnectionUpdate(update, retryCount) {
    if (!this._running) return;

    if (update.qr) {
      this.qr = update.qr;
      this.qrVersion++;
      this.lastError = null;
      this.authFailureCount = 0;
      clearTimeout(this._qrWatchdogTimer);
      this._qrWatchdogTimer = null;
      this.log('info', 'qr', `Baileys QR ready version=${this.qrVersion}`);
      this.setStatus('qr_ready', 'qr');
      this.emit('qr', { qr: this.qr, qrVersion: this.qrVersion });
    }

    if (update.connection === 'connecting') {
      if (this.status !== 'qr_ready') this.setStatus('connecting', 'connecting');
      this.lastProbeState = 'CONNECTING';
    }

    if (update.connection === 'open') {
      this.ready = true;
      this.phone = jidNormalizedUser(this.sock?.user?.id || '').split('@')[0].split(':')[0] || this.phone;
      this.qr = null;
      this.lastError = null;
      this.heartbeatFailures = 0;
      this.log('info', 'connection', `Baileys connected${this.phone ? ` phone=+${this.phone}` : ''}`);
      this.startHeartbeat();
      this.setStatus('connected', 'open');
      this.emit('ready', this.state());
    }

    if (update.connection === 'close') {
      this.ready = false;
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const message = update.lastDisconnect?.error?.message || `closed status=${statusCode || 'unknown'}`;
      this.lastError = message;
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        this.authFailureCount++;
        await this.clearAuthCache('Baileys logged out');
        this.setStatus('stopped', 'logged_out');
        this._running = false;
        this.emit('disconnected', message);
        return;
      }
      this.emit('disconnected', message);
      this.scheduleReconnect(retryCount, message);
    }
  }

  handleMessages(event) {
    if (!this._running || !Array.isArray(event?.messages)) return;
    for (const message of event.messages) {
      const msg = toWhatsappWebMessage(message);
      this.ingestService.ingestWhatsappMessage({ userId: this.userId, msg, source: 'baileys' })
        .then(result => this.emit('message_ingested', result))
        .catch(err => {
          this.lastError = err.message;
          this.emit('message_ingest_error', err);
          this.logger.error?.('message', `Baileys ingest failed: ${err.message}`);
        });
    }
  }

  clearWebCache(reason) {
    this.log('info', 'connection', `Baileys has no browser cache to clear: ${reason}`);
  }

  async clearAuthCache(reason) {
    try {
      const store = new BaileysPostgresAuthState({ db: this.db, userId: this.userId });
      await store.clear();
      this.log('warn', 'auth', `cleared Baileys auth session: ${reason}`);
    } catch (err) {
      this.log('warn', 'auth', `failed to clear Baileys auth session: ${err.message}`);
    }
  }
}

module.exports = { BaileysConnectionManager, normalizeOutboundJid };
