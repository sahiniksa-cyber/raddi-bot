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
  proto,
} = require('@whiskeysockets/baileys');

const db = require('../../db/client');
const { RETRY, TIMERS } = require('../../../lib/constants');
const { MessageIngestService } = require('./message-ingest.service');
const { enqueueCampaignSegmentation } = require('../../queues/campaign-queue');
const { isOriginalMessageStale } = require('../../../lib/message-staleness');
const { usePostgresBaileysAuthState, BaileysPostgresAuthState } = require('./baileys-postgres-auth');

// WhatsApp-reconnect backoff — SEPARATE from the shared RETRY.DELAYS_MS (which
// also drives process-restart in start-all). The first retry is ~1s so a normal
// drop reconnects almost immediately, then it escalates to protect against a
// reconnect storm (rapid reconnects trigger WhatsApp 440 / Bad MAC churn). Not
// sub-second on purpose: reconnecting before the old socket is closed server-side
// is exactly what causes a 440 conflict. Tunable via env (comma-separated ms).
const RECONNECT_DELAYS_MS = (process.env.WA_RECONNECT_DELAYS_MS
  ? process.env.WA_RECONNECT_DELAYS_MS.split(',').map(n => parseInt(n.trim(), 10)).filter(Number.isFinite)
  : null) || [1000, 2000, 5000, 12000, 20000, 40000, 60000];

// Raddi does not consume Baileys' `messaging-history.set` event, so downloading
// RECENT/FULL/ON_DEMAND history during a fresh pairing only adds a large sync
// burst at the most fragile point of the handshake. Keep the two bootstrap
// types needed for contact identity/LID mapping, and skip the unused payloads.
// Do not return false for every type: Baileys explicitly warns that doing so
// removes initial LID mappings and can make sessions unstable.
const ESSENTIAL_HISTORY_SYNC_TYPES = new Set([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
]);

function shouldSyncEssentialHistoryMessage({ syncType } = {}) {
  return ESSENTIAL_HISTORY_SYNC_TYPES.has(syncType);
}

// WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED.
// The passive heartbeat must treat ONLY explicit CLOSING/CLOSED as dead.
// `undefined`/`null` means this Baileys build doesn't expose `ws.readyState`
// — NOT a death signal. The old `readyState !== 1` test treated `undefined`
// as dead and forced a reconnect every heartbeat, causing a perpetual
// reconnect + history-resync loop on a perfectly healthy connection. Genuine
// deaths are caught by Baileys' own keep-alive (keepAliveIntervalMs), which
// emits a connection.update 'close' that triggers scheduleReconnect.
function isSocketDeadReadyState(readyState) {
  return readyState === 2 || readyState === 3;
}

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

// Extracts the WhatsApp id of the message being quoted (reply-to), wherever
// the contextInfo lives (extendedTextMessage for text replies, or directly on
// media parts). Used by the escalation bridge to map a team member's
// quote-reply back to the customer it answers.
function quotedStanzaIdFromBaileysMessage(message = {}) {
  for (const part of Object.values(message || {})) {
    const stanzaId = part?.contextInfo?.stanzaId;
    if (stanzaId) return String(stanzaId);
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
    quotedStanzaId: quotedStanzaIdFromBaileysMessage(msg.message || {}),
    deviceType: 'baileys',
  };
}

function timestampToMs(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function createDefaultIngestService(logger) {
  return new MessageIngestService({ logger, campaignSegmentation: enqueueCampaignSegmentation });
}

class BaileysConnectionManager extends EventEmitter {
  constructor({
    userId,
    dataDir,
    logger = console,
    ingestService = createDefaultIngestService(logger),
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
    this.lastDisconnect = null;
    this._pairingStartedAt = null;
    this._running = false;
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._qrWatchdogTimer = null;
    this._qrStuckTimer = null;
    this._version = null;
    this._socketGeneration = 0;
    this._authFlush = null;
    this._authStore = null;
    this.startupTime = Date.now();
    this._hasEverConnected = false;
    this._stableTimer = null;
    this._effectiveRetryCount = 0;
    this.acceptMessagesAfterMs = this.computeAcceptMessagesAfterMs();
  }

  // DEPRECATED — kept only so nothing that referenced it breaks. The acceptance
  // cutoff is now a SLIDING check via the shared message-staleness policy
  // (isOriginalMessageStale), evaluated per message at receive time. The old
  // frozen-at-startup field caused hours-old re-delivered messages to be
  // accepted on a long-running process (production incident 2026-06-12).
  computeAcceptMessagesAfterMs() {
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
      lastDisconnect: this.lastDisconnect,
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
      const { state, saveCreds, flush, store } = await usePostgresBaileysAuthState({ db: this.db, userId: this.userId });
      this._authFlush = flush || null;
      this._authStore = store || null;
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
        shouldSyncHistoryMessage: shouldSyncEssentialHistoryMessage,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        // Connection stability: send a WebSocket keep-alive ping on an interval
        // so the socket doesn't die silently behind Railway's proxy (the main
        // cause of "اتصل ثم فجأة وقف"). Give the initial handshake a generous
        // timeout and a small retry delay so transient blips self-heal instead
        // of dropping the link.
        keepAliveIntervalMs: parseInt(process.env.WA_KEEPALIVE_INTERVAL_MS || '20000', 10),
        connectTimeoutMs: parseInt(process.env.WA_CONNECT_TIMEOUT_MS || '60000', 10),
        retryRequestDelayMs: parseInt(process.env.WA_RETRY_REQUEST_DELAY_MS || '350', 10),
        // QR lifetime. Baileys defaults to 60s for the FIRST qr but only 20s for
        // every subsequent rotation, then emits 408 "QR refs attempts ended" once
        // the refs run out — a ~20s scan window per rotation is too tight for a
        // merchant to unlock the phone, open WhatsApp and scan, producing an
        // "Invalid QR code" / reconnect loop (reconnect_count climbing into the
        // dozens). Pin every QR (first AND subsequent) to a generous window so
        // the displayed code stays valid long enough to scan. Env-tunable.
        qrTimeout: parseInt(process.env.WA_QR_TIMEOUT_MS || '60000', 10),
        // Retry-receipt handler: when a peer fails to decrypt one of our sent
        // replies, WhatsApp asks us to re-encrypt and resend. Without this
        // callback Baileys returns undefined → peer rebuilds its Signal session
        // → every in-flight message on the OLD session decrypts to "Bad MAC".
        // Looking up by whatsapp_message_id (set by the outgoing worker after a
        // successful send) returns the original text so the peer's retry
        // succeeds and the session stays healthy.
        getMessage: (key) => this.getStoredMessage(key),
      });

      this.sock = sock;
      const socketGeneration = ++this._socketGeneration;
      // Each start() builds a fresh `client` wrapper closed over the new
      // `sock` const, and atomically replaces `this.client`. Callers that
      // re-read `bot.client` on every send always target the live socket.
      // Callers that capture `bot.client` into a local before a reconnect
      // will throw "socket closed" — but the outgoing worker re-reads
      // `bot.client` per job, so that's the safe pattern.
      // sendMessage returns the Baileys WAMessage so callers can record
      // key.id (used by getMessage on retry receipts to short-circuit the
      // "Bad MAC" cascade).
      this.client = {
        sendMessage: async (target, content) => sock.sendMessage(
          normalizeOutboundJid(target),
          content && typeof content === 'object' && !Buffer.isBuffer(content)
            ? content
            : { text: String(content || '') },
        ),
        sendPresenceUpdate: async (state, target) => sock.sendPresenceUpdate(state, normalizeOutboundJid(target)),
        getState: async () => (this.ready ? 'CONNECTED' : this.status.toUpperCase()),
      };

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update, retryCount, socketGeneration).catch((err) => {
          this.lastError = err.message;
          this.log('error', 'connection', `Baileys connection update failed: ${err.message}`, err);
        });
      });
      // Guard against ghost messages from an old socket after reconnect.
      // handleConnectionUpdate already checks _socketGeneration; without the same
      // check here, messages emitted by a dying socket would be ingested by the
      // new socket's pipeline → AI generates a reply, then the live socket
      // generates a second reply for the same key.id → duplicate-in-one-second.
      sock.ev.on('messages.upsert', (event) => {
        if (socketGeneration !== this._socketGeneration) {
          this.log('info', 'message', `dropped messages.upsert from generation=${socketGeneration} current=${this._socketGeneration}`);
          return;
        }
        // Pass the captured generation INTO handleMessages so the loop can
        // also bail out per-message if a reconnect happens while we iterate.
        this.handleMessages(event, socketGeneration);
      });
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
    clearTimeout(this._qrStuckTimer);
    clearTimeout(this._stableTimer);
    this.stopHeartbeat();
    this._retryTimer = null;
    this._qrWatchdogTimer = null;
    this._qrStuckTimer = null;
    this._stableTimer = null;
    this._running = false;
    this._socketGeneration++;
    this.ready = false;
    this.qr = null;
    this.setStatus('stopped', 'stop');

    const sock = this.sock;
    this.sock = null;
    this.client = null;
    try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
    try { sock?.end?.(new Error('stopped')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}

    // Flush any queued signal-key writes so a redeploy doesn't lose the latest
    // ratchet step (which would cause "Bad MAC" on the next inbound message).
    const flush = this._authFlush;
    this._authFlush = null;
    if (flush) { try { await flush(); } catch (_) {} }
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

  startQrStuckWatchdog(retryCount, socketGeneration) {
    clearTimeout(this._qrStuckTimer);
    const timeout = parseInt(process.env.WA_QR_STUCK_TIMEOUT_MS || '300000', 10);
    this._qrStuckTimer = setTimeout(() => {
      this._qrStuckTimer = null;
      if (!this._running || this.ready) return;
      if (socketGeneration !== this._socketGeneration) return;
      this.log('warn', 'qr', `Baileys QR un-scanned for ${Math.round(timeout / 1000)}s; restarting`);
      this.scheduleReconnect(retryCount, 'qr stuck unscanned', socketGeneration);
    }, timeout);
    if (typeof this._qrStuckTimer.unref === 'function') this._qrStuckTimer.unref();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._running || !this.ready) return;
      // Passive observer — sendPresenceUpdate would mark the account online and
      // undo markOnlineOnConnect:false. readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED.
      const readyState = this.sock?.ws?.readyState;
      if (isSocketDeadReadyState(readyState)) {
        this.heartbeatFailures++;
        this.log('warn', 'heartbeat', `socket readyState=${readyState} failures=${this.heartbeatFailures}`);
        if (this.heartbeatFailures >= TIMERS.HEARTBEAT_FAIL_THRESHOLD) {
          this.scheduleReconnect(0, `heartbeat socket dead readyState=${readyState}`);
        }
        return;
      }
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
    const retryIndex = Math.min(this._effectiveRetryCount - 1, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[retryIndex] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);
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
    try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
    try { sock?.end?.(new Error('reconnect')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
    // Capture the auth flush BEFORE the socket teardown above replaces it on
    // the next start(). Awaiting it inside the timer ensures the latest
    // ratchet step from the dying socket is durably on disk before we open a
    // new socket — otherwise a key write still in the debounce timer would be
    // dropped on the floor, leaving us out of sync with the peer and
    // producing "Bad MAC" on the very next inbound message.
    const flushBeforeReconnect = this._authFlush;
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (socketGeneration !== this._socketGeneration) return;
      if (this.ready || this.status === 'connected') return;
      if (flushBeforeReconnect) { try { await flushBeforeReconnect(); } catch (_) {} }
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
      this.startQrStuckWatchdog(retryCount, socketGeneration);
    }

    if (update.isNewLogin) {
      this._pairingStartedAt = new Date().toISOString();
    }

    if (update.connection === 'connecting') {
      if (this.status !== 'qr_ready') this.setStatus('connecting', 'connecting');
      this.lastProbeState = 'CONNECTING';
    }

    if (update.connection === 'open') {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      clearTimeout(this._qrStuckTimer);
      this._qrStuckTimer = null;
      this.ready = true;
      this._hasEverConnected = true;
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
      const stableMs = parseInt(process.env.WA_STABLE_RESET_MS || '12000', 10);
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
      const authCreds = this._authStore?.cache?.creds || null;
      const authKeys = this._authStore?.cache?.keys || null;
      this.lastDisconnect = {
        at: new Date().toISOString(),
        statusCode: statusCode || null,
        reason: reasonName,
        message: String(rawMessage).slice(0, 500),
        pairingStartedAt: this._pairingStartedAt,
        auth: {
          registered: !!authCreds?.registered,
          hasMe: !!authCreds?.me?.id,
          keyCategories: authKeys ? Object.keys(authKeys).length : 0,
        },
      };
      // A successful QR scan makes Baileys close the pre-pairing socket with
      // restartRequired (515). QR rotations may already have increased the
      // reconnect backoff, but carrying that delay into this required restart
      // leaves the phone waiting long enough for WhatsApp to remove the device.
      // Restart from the first retry slot so the authenticated socket comes up
      // immediately without changing auth state or the other close paths.
      if (statusCode === DisconnectReason.restartRequired) {
        this.lastError = technicalMessage;
        this._effectiveRetryCount = 0;
        this.log('info', 'connection', 'Baileys pairing restart required; resetting QR backoff for immediate reconnect');
        this.emit('disconnected', technicalMessage);
        this.scheduleReconnect(0, technicalMessage, socketGeneration);
        return;
      }
      if (statusCode === DisconnectReason.loggedOut) {
        this.lastError = technicalMessage;
        this.authFailureCount++;
        await this.clearAuthCache('Baileys logged out');
        this.setStatus('stopped', 'logged_out');
        this._running = false;
        this._socketGeneration++;
        const sock = this.sock;
        this.sock = null;
        this.client = null;
        try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { sock?.end?.(new Error('logged_out')); } catch (_) {}
        try { sock?.ws?.close?.(); } catch (_) {}
        // A loggedOut is the ONE disconnect that never self-heals (the device
        // was unlinked) — emit a dedicated event so the owner gets an instant
        // "re-link now" alert instead of waiting for the health monitor.
        this.emit('logged_out', technicalMessage);
        this.emit('disconnected', technicalMessage);
        return;
      }
      if (statusCode === DisconnectReason.connectionReplaced) {
        this.lastError = 'تعارض اتصال (440): فيه نسخة ثانية متصلة بنفس الرقم. افتح واتساب على جوالك ← الأجهزة المرتبطة، واحذف أي جلسة غير معروفة، ثم اضغط "تشغيل البوت" مرة أخرى.';
        this.authFailureCount++;
        this.setStatus('stopped', 'connection_conflict');
        this._running = false;
        this._socketGeneration++;
        const sock = this.sock;
        this.sock = null;
        this.client = null;
        try { sock?.ev?.removeAllListeners?.(); } catch (_) {}
        try { sock?.end?.(new Error('connection_replaced')); } catch (_) {}
        try { sock?.ws?.close?.(); } catch (_) {}
        this.emit('disconnected', this.lastError);
        this.emit('connection_conflict', { reason: technicalMessage, message: this.lastError });
        return;
      }
      this.lastError = technicalMessage;
      this.emit('disconnected', technicalMessage);
      this.scheduleReconnect(this._effectiveRetryCount, technicalMessage, socketGeneration);
    }
  }

  // Baileys retry-receipt callback. The peer's WhatsApp couldn't decrypt one
  // of our sent replies and is asking the server to ask us to resend. Returning
  // the original text lets the lib re-encrypt and resend. Returning undefined
  // is safe (Baileys falls back to a placeholder), but unreliable — undefined
  // is the path that produces the "Closing open session in favor of incoming
  // prekey bundle" + Bad MAC cascade.
  async getStoredMessage(key) {
    const id = key?.id ? String(key.id) : '';
    if (!id) return undefined;
    try {
      const result = await this.db.query(
        `SELECT content FROM messages
         WHERE user_id = $1 AND whatsapp_message_id = $2
         LIMIT 1`,
        [this.userId, id],
      );
      const text = result?.rows?.[0]?.content;
      return text ? { conversation: String(text) } : undefined;
    } catch (err) {
      this.log('warn', 'getMessage', `lookup failed for ${id}: ${err.message}`);
      return undefined;
    }
  }

  handleMessages(event, socketGeneration = this._socketGeneration) {
    if (!this._running || !Array.isArray(event?.messages)) return;
    // Non-'notify' batches ('append') are device-sync / history. We must NOT
    // replay synced/backlog CUSTOMER messages (that would re-answer old chats),
    // but we MUST still process the owner's OWN replies that arrive this way:
    // when the owner answers a customer from their phone, WhatsApp syncs that
    // send to this linked device as an 'append'/fromMe message — and that is
    // exactly what triggers the 30-minute owner-pause (escalated_until). The old
    // code dropped the whole batch, so owner-pause NEVER fired for phone replies
    // (only for dashboard sends, which write the pause directly).
    const ownerSyncOnly = Boolean(event.type && event.type !== 'notify');
    if (ownerSyncOnly) {
      this.log('info', 'message', `Baileys ${event.type} batch — honoring fromMe (owner) messages only`);
    }

    const candidates = [];
    const distinctSenders = new Set();
    for (const message of event.messages) {
      const msg = toWhatsappWebMessage(message);
      // In a sync/backlog batch, only the owner's own (fromMe) replies are
      // honored; synced customer/history messages are ignored to avoid
      // re-answering old conversations.
      if (ownerSyncOnly && !msg.fromMe) continue;
      // LAYER 1 of the staleness guard: SLIDING cutoff relative to NOW (not a
      // frozen-at-startup field). Any message whose ORIGINAL WhatsApp send-time
      // is older than the policy (default 30 min) is dropped the instant it
      // arrives — this is what stops re-delivered/backlog messages from old
      // conversations surfacing after a reconnect.
      if (isOriginalMessageStale(msg.timestamp)) {
        this.log('info', 'message', `ignored stale Baileys message ${msg.id?.id || 'unknown'} (original ts older than policy)`);
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
      // Per-message generation check: a reconnect mid-batch invalidates the
      // rest. The listener-level guard only catches events that arrive AFTER
      // the increment; this catches events that were already mid-loop when
      // _socketGeneration was bumped by stop()/scheduleReconnect.
      if (socketGeneration !== this._socketGeneration) {
        this.log('info', 'message', `aborted message loop mid-batch: generation rolled from ${socketGeneration} to ${this._socketGeneration}`);
        return;
      }
      this.processInboundBaileysMessage(raw, msg).catch(err => {
        this.lastError = err.message;
        this.emit('message_ingest_error', err);
        this.logger.error?.('message', `Baileys ingest failed: ${err.message}`);
      });
    }
  }

  shouldDropStartupBulkBatch(candidates, distinctSenders) {
    // Only protect the first-ever connection of this process — bursts after a
    // reconnect are legitimate customer messages, not WhatsApp server backfill.
    // provider_message_id uniqueness already prevents duplicate ingest.
    if (this._hasEverConnected) return false;
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
      if (this._authStore) {
        // Dispose the LIVE store FIRST so the dying socket's pending debounce
        // timer and any late set()/saveCreds can no longer write — then clear()
        // wipes the DB and cannot be clobbered. clear()'s persist() is NOT
        // guarded by disposed, so the wipe still runs, and the writeQueue chain
        // makes it the LAST write even if a persist was already in flight.
        this._authStore.dispose();
        await this._authStore.clear();
        this._authStore = null;
      } else {
        const store = new BaileysPostgresAuthState({ db: this.db, userId: this.userId });
        await store.clear();
      }
      this.log('warn', 'auth', `cleared Baileys auth session: ${reason}`);
    } catch (err) {
      this.log('warn', 'auth', `failed to clear Baileys auth session: ${err.message}`);
    }
  }
}

module.exports = {
  BaileysConnectionManager,
  normalizeOutboundJid,
  extractPhoneNumber,
  toWhatsappWebMessage,
  quotedStanzaIdFromBaileysMessage,
  isSocketDeadReadyState,
  shouldSyncEssentialHistoryMessage,
};
