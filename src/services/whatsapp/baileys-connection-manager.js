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

// Same default and env var as openai-media-analysis.js — keep them in sync so an operator
// only needs to tune one knob to allow larger inbound media end-to-end.
const MEDIA_DOWNLOAD_MAX_BYTES = parseInt(process.env.MEDIA_ANALYSIS_MAX_BYTES || `${8 * 1024 * 1024}`, 10);

function detectMediaPart(message = {}) {
  if (message.imageMessage) return { kind: 'image', part: message.imageMessage, type: 'image' };
  if (message.videoMessage) return { kind: 'video', part: message.videoMessage, type: 'video' };
  if (message.audioMessage) return { kind: message.audioMessage.ptt ? 'ptt' : 'audio', part: message.audioMessage, type: 'audio' };
  if (message.documentMessage) return { kind: 'document', part: message.documentMessage, type: 'document' };
  if (message.stickerMessage) return { kind: 'sticker', part: message.stickerMessage, type: 'sticker' };
  return null;
}

async function downloadBaileysMedia(rawMessage, logger) {
  const message = rawMessage?.message || {};
  const detected = detectMediaPart(message);
  if (!detected) return null;
  const sizeBytes = Number(detected.part?.fileLength?.toNumber?.() || detected.part?.fileLength || 0);
  if (sizeBytes && sizeBytes > MEDIA_DOWNLOAD_MAX_BYTES) {
    logger?.warn?.('media', `skipped media too large (${sizeBytes} bytes)`);
    return { kind: detected.kind, mimeType: detected.part?.mimetype || '', data: '', caption: String(detected.part?.caption || '').trim(), sizeBytes, skipped: 'too_large' };
  }
  try {
    const buffer = await downloadMediaMessage(rawMessage, 'buffer', {}, { logger });
    if (!buffer?.length) return null;
    return {
      kind: detected.kind,
      mimeType: detected.part?.mimetype || '',
      data: buffer.toString('base64'),
      caption: String(detected.part?.caption || '').trim(),
      sizeBytes: buffer.length,
    };
  } catch (err) {
    logger?.warn?.('media', `failed to download Baileys media: ${err.message}`);
    return { kind: detected.kind, mimeType: detected.part?.mimetype || '', data: '', caption: String(detected.part?.caption || '').trim(), error: err.message };
  }
}

function normalizeOutboundJid(target) {
  const raw = String(target || '').trim();
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us') || raw.endsWith('@lid')) return raw;
  const clean = raw.replace('@c.us', '').replace(/[^\d]/g, '');
  return clean ? `${clean}@s.whatsapp.net` : raw;
}

function extractPhoneNumber(key) {
  if (!key || typeof key !== 'object') return null;
  const candidates = [key.senderPn, key.participantPn, key.remoteJid];
  for (const value of candidates) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    if (raw.endsWith('@lid')) continue;
    if (raw.endsWith('@g.us')) continue;
    if (raw === 'status@broadcast' || raw.endsWith('@broadcast')) continue;
    const digits = raw.replace(/@.*$/, '').replace(/[^\d]/g, '');
    if (digits) return digits;
  }
  return null;
}

function toWhatsappWebMessage(msg) {
  const remoteJid = msg.key?.remoteJid || null;
  return {
    id: { _serialized: msg.key?.id || null, id: msg.key?.id || null },
    from: remoteJid,
    to: msg.key?.participant || null,
    author: msg.key?.participant || null,
    fromMe: !!msg.key?.fromMe,
    phoneNumber: extractPhoneNumber(msg.key),
    body: textFromBaileysMessage(msg.message || {}),
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : null,
    type: Object.keys(msg.message || {})[0] || 'unknown',
    hasMedia: !!detectMediaPart(msg.message || {}),
    deviceType: 'baileys',
  };
}

function timestampToMs(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1_000_000_000_000 ? value : value * 1000;
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
    this._socketGeneration = 0;
    this.startupTime = Date.now();
    this._stableTimer = null;
    this._effectiveRetryCount = 0;
    this.acceptMessagesAfterMs = this.computeAcceptMessagesAfterMs();
    this._acceptWindowInitialized = true;
  }

  computeAcceptMessagesAfterMs() {
    // Default 30 minutes (was 60s). This widens the inbound acceptance window so we
    // don't silently drop messages received while the bot was briefly disconnected.
    // dedup is handled by provider_message_id, so a longer window cannot cause duplicates.
    return Date.now() - parseInt(process.env.WA_ACCEPT_MESSAGES_GRACE_MS || '1800000', 10);
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
    this.startupTime = Date.now();
    // acceptMessagesAfterMs is set once at construction time. Resetting it on every
    // reconnect would invalidate the grace window we already paid for and could drop
    // messages that arrived during the brief disconnect.
    if (retryCount === 0 && !this._acceptWindowInitialized) {
      this.acceptMessagesAfterMs = this.computeAcceptMessagesAfterMs();
      this._acceptWindowInitialized = true;
    }
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
    clearTimeout(this._stableTimer);
    this.stopHeartbeat();
    this._retryTimer = null;
    this._qrWatchdogTimer = null;
    this._stableTimer = null;
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
    this._effectiveRetryCount = Math.max(this._effectiveRetryCount, retryCount) + 1;
    const retryIndex = Math.min(this._effectiveRetryCount - 1, RETRY.DELAYS_MS.length - 1);
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

      clearTimeout(this._stableTimer);
      const stableMs = parseInt(process.env.WA_STABLE_RESET_MS || '20000', 10);
      this._stableTimer = setTimeout(() => {
        if (this.ready && this._socketGeneration === socketGeneration) {
          this._effectiveRetryCount = 0;
          this.log('info', 'connection', `Baileys connection stable for ${Math.round(stableMs / 1000)}s, backoff reset`);
        }
      }, stableMs);
      if (typeof this._stableTimer.unref === 'function') this._stableTimer.unref();
    }

    if (update.connection === 'close') {
      this.ready = false;
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const reasonName = DisconnectReason[statusCode] || 'unknown';
      const rawMessage = update.lastDisconnect?.error?.message || 'closed';
      const technicalMessage = `${rawMessage} (code=${statusCode || 'unknown'} reason=${reasonName})`;
      if (statusCode === DisconnectReason.loggedOut) {
        this.lastError = technicalMessage;
        this.authFailureCount++;
        await this.clearAuthCache('Baileys logged out');
        this.setStatus('stopped', 'logged_out');
        this._running = false;
        this.emit('disconnected', technicalMessage);
        return;
      }
      if (statusCode === DisconnectReason.connectionReplaced) {
        this.lastError = 'تعارض اتصال (440): فيه نسخة ثانية متصلة بنفس الرقم. افتح واتساب على جوالك ← الأجهزة المرتبطة، واحذف أي جلسة غير معروفة، ثم اضغط "تشغيل البوت" مرة أخرى.';
        this.authFailureCount++;
        this.setStatus('stopped', 'connection_conflict');
        this._running = false;
        this.emit('disconnected', this.lastError);
        this.emit('connection_conflict', { reason: technicalMessage, message: this.lastError });
        return;
      }
      this.lastError = technicalMessage;
      this.emit('disconnected', technicalMessage);
      this.scheduleReconnect(this._effectiveRetryCount, technicalMessage, socketGeneration);
    }
  }

  handleMessages(event) {
    if (!this._running || !Array.isArray(event?.messages)) return;
    if (event.type && event.type !== 'notify') {
      this.log('info', 'message', `ignored Baileys ${event.type} message batch`);
      return;
    }

    const candidates = [];
    const distinctSenders = new Set();
    for (const message of event.messages) {
      const msg = toWhatsappWebMessage(message);
      const messageTimeMs = timestampToMs(msg.timestamp);
      if (messageTimeMs && messageTimeMs < this.acceptMessagesAfterMs) {
        this.log('info', 'message', `ignored stale Baileys message ${msg.id?.id || 'unknown'}`);
        continue;
      }
      candidates.push({ raw: message, msg });
      if (msg.from) distinctSenders.add(msg.from);
    }

    if (this.shouldDropStartupBulkBatch(candidates, distinctSenders)) {
      this.log('warn', 'message', `dropped startup bulk batch: ${candidates.length} messages from ${distinctSenders.size} senders within ${Math.round((Date.now() - this.startupTime) / 1000)}s of boot`);
      return;
    }

    for (const { raw, msg } of candidates) {
      this.processInboundBaileysMessage(raw, msg).catch(err => {
        this.lastError = err.message;
        this.emit('message_ingest_error', err);
        this.logger.error?.('message', `Baileys ingest failed: ${err.message}`);
      });
    }
  }

  shouldDropStartupBulkBatch(candidates, distinctSenders) {
    const windowMs = parseInt(process.env.WA_STARTUP_BULK_WINDOW_MS || '30000', 10);
    if (Date.now() - this.startupTime > windowMs) return false;
    const minMessages = parseInt(process.env.WA_STARTUP_BULK_MIN_MESSAGES || '6', 10);
    const minSenders = parseInt(process.env.WA_STARTUP_BULK_MIN_SENDERS || '5', 10);
    return candidates.length >= minMessages && distinctSenders.size >= minSenders;
  }

  async processInboundBaileysMessage(rawMessage, msg) {
    if (msg.hasMedia) {
      try {
        const media = await downloadBaileysMedia(rawMessage, this.logger);
        if (media) msg.media = media;
      } catch (err) {
        this.log('warn', 'message', `media download error: ${err.message}`);
      }
    }
    const result = await this.ingestService.ingestWhatsappMessage({ userId: this.userId, msg, source: 'baileys' });
    this.emit('message_ingested', result);
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

module.exports = { BaileysConnectionManager, normalizeOutboundJid, extractPhoneNumber, toWhatsappWebMessage };
