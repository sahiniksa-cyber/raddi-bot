'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pino = require('pino');
const {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
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

function mediaKindFromBaileysMessage(message = {}) {
  if (message.imageMessage) return 'image';
  if (message.audioMessage) return 'audio';
  return null;
}

function mediaMetaFromBaileysMessage(message = {}) {
  const kind = mediaKindFromBaileysMessage(message);
  if (!kind) return null;
  const node = kind === 'image' ? message.imageMessage : message.audioMessage;
  return {
    kind,
    mimeType: node?.mimetype || (kind === 'image' ? 'image/jpeg' : 'audio/ogg'),
    caption: node?.caption || '',
  };
}

function normalizeOutboundJid(target) {
  const raw = String(target || '').trim();
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us') || raw.endsWith('@lid')) return raw;
  const clean = raw.replace('@c.us', '').replace(/[^\d]/g, '');
  return clean ? `${clean}@s.whatsapp.net` : raw;
}

function toWhatsappWebMessage(msg) {
  const remoteJid = msg.key?.remoteJid || null;
  const mediaMeta = mediaMetaFromBaileysMessage(msg.message || {});
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
    media: mediaMeta,
    deviceType: 'baileys',
  };
}

function timestampToMs(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function startupGraceMs() {
  return parseInt(process.env.WA_ACCEPT_MESSAGES_GRACE_MS || '1000', 10);
}

function startupBulkGuardMs() {
  return parseInt(process.env.WA_STARTUP_BULK_GUARD_MS || '30000', 10);
}

function startupBulkSenderLimit() {
  return parseInt(process.env.WA_STARTUP_BULK_SENDER_LIMIT || '5', 10);
}

function requireProviderTimestamp() {
  return process.env.WA_REQUIRE_MESSAGE_TIMESTAMP !== 'false';
}

function isCustomerJid(jid) {
  const value = String(jid || '');
  return value &&
    value !== 'status@broadcast' &&
    !value.includes('@g.us');
}

class BaileysConnectionManager extends EventEmitter {
  constructor({
    userId,
    dataDir,
    logger = console,
    ingestService = new MessageIngestService({ logger }),
    database = db,
    mediaDownloader = downloadMediaMessage,
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
    this.mediaDownloader = mediaDownloader;

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
    this._socketGeneration = 0;
    this.acceptMessagesAfterMs = Date.now() - startupGraceMs();
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
    this.acceptMessagesAfterMs = Date.now() - startupGraceMs();
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
      const socketGeneration = ++this._socketGeneration;
      this.client = {
        sendMessage: async (target, text) => sock.sendMessage(normalizeOutboundJid(target), { text: String(text || '') }),
        getState: async () => (this.ready ? 'CONNECTED' : this.status.toUpperCase()),
      };

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update, retryCount, socketGeneration).catch((err) => {
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
    this._socketGeneration++;
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

  scheduleReconnect(retryCount, reason, socketGeneration = this._socketGeneration) {
    if (!this._running) return;
    if (socketGeneration !== this._socketGeneration) {
      this.log('info', 'connection', `ignored stale reconnect request: ${String(reason || 'unknown')}`);
      return;
    }
    if (this._retryTimer) {
      this.lastError = String(reason || this.lastError || 'unknown');
      this.log('warn', 'connection', `Baileys reconnect already scheduled; ignoring duplicate close: ${this.lastError}`);
      return;
    }
    const retryIndex = Math.min(retryCount, RETRY.DELAYS_MS.length - 1);
    const delay = RETRY.DELAYS_MS[retryIndex] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);
    this.reconnectCount++;
    this.ready = false;
    this.qr = null;
    this.lastError = String(reason || 'unknown');
    this.stopHeartbeat();
    this.setStatus('reconnecting', 'reconnect');
    this.log('warn', 'connection', `Baileys reconnect scheduled in ${Math.round(delay / 1000)}s: ${this.lastError}`);
    const sock = this.sock;
    this.sock = null;
    this.client = null;
    try { sock?.end?.(new Error('reconnect')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (socketGeneration !== this._socketGeneration) return;
      if (this.ready || this.status === 'connected') return;
      this._running = false;
      this.start(retryCount + 1).catch((err) => {
        this.log('error', 'connection', `Baileys reconnect failed: ${err.message}`, err);
      });
    }, delay);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  async handleConnectionUpdate(update, retryCount, socketGeneration = this._socketGeneration) {
    if (!this._running) return;
    if (socketGeneration !== this._socketGeneration) {
      this.log('info', 'connection', `ignored stale Baileys update generation=${socketGeneration} current=${this._socketGeneration}`);
      return;
    }

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
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this.ready = true;
      this.lastProbeState = 'CONNECTED';
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
      const reasonName = DisconnectReason[statusCode] || 'unknown';
      const rawMessage = update.lastDisconnect?.error?.message || 'closed';
      const message = `${rawMessage} (code=${statusCode || 'unknown'} reason=${reasonName})`;
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
      this.scheduleReconnect(retryCount, message, socketGeneration);
    }
  }

  async attachMedia(message, msg) {
    if (!msg.hasMedia || !msg.media) return msg;
    try {
      const buffer = await this.mediaDownloader(message, 'buffer', {}, { logger: pino({ level: 'silent' }) });
      if (buffer?.length) {
        msg.media = {
          ...msg.media,
          data: Buffer.from(buffer).toString('base64'),
          sizeBytes: buffer.length,
        };
      }
    } catch (err) {
      this.log('warn', 'message', `failed to download Baileys media ${msg.id?.id || 'unknown'}: ${err.message}`);
      msg.media = { ...msg.media, downloadError: err.message };
    }
    return msg;
  }

  async handleMessages(event) {
    if (!this._running || !Array.isArray(event?.messages)) return;
    if (event.type && event.type !== 'notify') {
      this.log('info', 'message', `ignored Baileys ${event.type} message batch`);
      return;
    }
    if (this.shouldBlockStartupBulkBatch(event.messages)) {
      this.log('warn', 'message', `blocked startup bulk notify batch messages=${event.messages.length}`);
      return;
    }
    for (const message of event.messages) {
      const msg = toWhatsappWebMessage(message);
      const messageTimeMs = timestampToMs(msg.timestamp);
      if (!messageTimeMs && requireProviderTimestamp()) {
        this.log('info', 'message', `ignored Baileys message without timestamp ${msg.id?.id || 'unknown'}`);
        continue;
      }
      if (messageTimeMs && messageTimeMs < this.acceptMessagesAfterMs) {
        this.log('info', 'message', `ignored stale Baileys message ${msg.id?.id || 'unknown'}`);
        continue;
      }
      const enriched = await this.attachMedia(message, msg);
      this.ingestService.ingestWhatsappMessage({ userId: this.userId, msg: enriched, source: 'baileys' })
        .then(result => this.emit('message_ingested', result))
        .catch(err => {
          this.lastError = err.message;
          this.emit('message_ingest_error', err);
          this.logger.error?.('message', `Baileys ingest failed: ${err.message}`);
        });
    }
  }

  shouldBlockStartupBulkBatch(messages = []) {
    const guardMs = startupBulkGuardMs();
    const limit = startupBulkSenderLimit();
    if (guardMs <= 0 || limit <= 0) return false;
    if (Date.now() - this.acceptMessagesAfterMs > guardMs) return false;

    const senders = new Set();
    for (const message of messages) {
      if (message?.key?.fromMe) continue;
      const jid = message?.key?.remoteJid;
      if (isCustomerJid(jid)) senders.add(jid);
      if (senders.size >= limit) return true;
    }
    return false;
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

module.exports = { BaileysConnectionManager, normalizeOutboundJid, timestampToMs };
