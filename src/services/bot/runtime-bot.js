'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const db = require('../../db/client');
const Logger = require('../../../lib/logger');
const AIClient = require('../../../lib/ai-client');
const { DEFAULT_CONFIG } = require('../../../lib/constants');
const { EnterpriseWhatsAppConnectionManager } = require('../whatsapp/connection-manager');
const { BaileysConnectionManager } = require('../whatsapp/baileys-connection-manager');
const { resolveWhatsappEngine } = require('./engine-config');
const {
  buildPersistSessionStateQuery,
  buildRuntimeAuthMetadata,
} = require('./session-state-persistence');

function isDirectoryUsable(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch (_) {
    return false;
  }
}

function copyDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function restoreWhatsappSession({ source, target, logger }) {
  if (!isDirectoryUsable(source)) return false;
  try {
    copyDirectory(source, target);
    logger?.info?.('boot', `restored WhatsApp session into runtime profile: ${target}`);
    return true;
  } catch (err) {
    logger?.warn?.('boot', `failed to restore persisted WhatsApp session: ${err.message}`);
    return false;
  }
}

function backupWhatsappSession({ source, target, logger, rootDir, userId }) {
  if (!isDirectoryUsable(source)) return false;
  try {
    copyDirectory(source, target);
    logger?.info?.('auth', `persisted WhatsApp session backup: ${target}`);
    return true;
  } catch (err) {
    if (err.code === 'ENOSPC') {
      cleanupRuntimeStorage(rootDir, userId);
      copyDirectory(source, target);
      logger?.info?.('auth', `persisted WhatsApp session backup after storage cleanup: ${target}`);
      return true;
    }
    logger?.warn?.('auth', `failed to persist WhatsApp session backup: ${err.message}`);
    return false;
  }
}

class RuntimeBot {
  constructor(userId, { dataDir = process.env.DATA_DIR || process.cwd(), logger = null } = {}) {
    this.userId = userId;
    this.rootDir = dataDir;
    this.dataDir = path.join(dataDir, 'data', userId);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (err) {
      if (err.code === 'ENOSPC') {
        cleanupRuntimeStorage(dataDir, userId);
        fs.mkdirSync(this.dataDir, { recursive: true });
      } else {
        throw err;
      }
    }

    this.logger = logger || new Logger(userId);
    this.config = { ...DEFAULT_CONFIG };
    this.sessionDesiredState = 'stopped';
    this._autoRecoverTimer = null;
    this._leaseRenewTimer = null;
    this._sessionBackupTimer = null;
    this.lastPersistedSession = null;
    this.instanceId = process.env.RAILWAY_REPLICA_ID ||
      `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    this.totalChatsHandled = 0;
    this.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {} };

    this.ai = new AIClient(this.config, this.logger, {
      record: (model, inputTokens, outputTokens) => this.recordUsage(model, inputTokens, outputTokens),
    });

    const engine = resolveWhatsappEngine(process.env);
    const ConnectionManager = engine === 'baileys'
      ? BaileysConnectionManager
      : EnterpriseWhatsAppConnectionManager;
    this.whatsappEngine = engine;
    this.persistentSessionPath = engine === 'whatsapp-web'
      ? path.join(this.dataDir, 'session')
      : null;
    const connectionDataDir = engine === 'whatsapp-web'
      ? path.join(process.env.WA_RUNTIME_SESSION_DIR || path.join(os.tmpdir(), 'raddi-wa-sessions'), userId)
      : this.dataDir;
    try {
      fs.mkdirSync(connectionDataDir, { recursive: true });
    } catch (err) {
      if (err.code === 'ENOSPC') {
        cleanupRuntimeStorage(dataDir, userId);
        fs.mkdirSync(connectionDataDir, { recursive: true });
      } else {
        throw err;
      }
    }

    if (engine === 'whatsapp-web') {
      this.runtimeSessionPath = path.join(connectionDataDir, 'session');
      restoreWhatsappSession({
        source: this.persistentSessionPath,
        target: this.runtimeSessionPath,
        logger: this.logger,
      });
    }

    this.connection = new ConnectionManager({
      userId,
      dataDir: connectionDataDir,
      logger: this.logger,
    });
    this.sessionStoragePath = this.persistentSessionPath || this.connection.sessionPath;

    this.connection.on('message_ingested', () => {
      this.totalChatsHandled++;
    });
    this.connection.on('state_changed', (state) => {
      this.persistSessionState({ state }).catch((err) => {
        this.logger.warn('connection', `failed to persist WhatsApp state: ${err.message}`);
      });
    });
    this.connection.on('ready', () => {
      if (this.whatsappEngine !== 'whatsapp-web') return;
      this.scheduleWhatsappSessionBackup('ready');
    });
    this.connection.on('auth_cleared', ({ reason } = {}) => {
      if (this.whatsappEngine !== 'whatsapp-web') return;
      try {
        fs.rmSync(this.persistentSessionPath, { recursive: true, force: true });
        this.logger.warn('auth', `removed persisted WhatsApp session backup: ${reason || 'auth cleared'}`);
      } catch (err) {
        this.logger.warn('auth', `failed to remove persisted WhatsApp backup: ${err.message}`);
      }
    });
  }

  get client() {
    return this.connection.client;
  }

  get botRunning() {
    return !['stopped', 'error'].includes(this.connection.status);
  }

  get appState() {
    const state = this.connection.state();
    return {
      status: state.status,
      qrString: this.connection.qr,
      qrVersion: state.qrVersion,
      phone: state.phone,
      error: state.error,
      activeChats: 0,
      totalChatsHandled: this.totalChatsHandled,
      queue: {},
      logs: this.logger.all(),
    };
  }

  async load() {
    const result = await db.query('SELECT config FROM bot_configs WHERE user_id = $1', [this.userId]);
    this.config = { ...DEFAULT_CONFIG, ...(result.rows[0]?.config || {}) };
    this.ai.updateConfig(this.config);
    await this.loadSessionState();
    return this;
  }

  async loadSessionState() {
    const result = await db.query(
      `INSERT INTO whatsapp_sessions (user_id, status, session_path, desired_state, auth_state)
       VALUES ($1, 'stopped', $2, 'stopped', '{}'::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET session_path = EXCLUDED.session_path
       RETURNING desired_state, status, updated_at`,
      [this.userId, this.sessionStoragePath],
    );

    const row = result.rows[0] || {};
    this.lastPersistedSession = row;
    this.sessionDesiredState = row.desired_state || 'stopped';
    if (this.sessionDesiredState === 'running' && process.env.WA_AUTO_RECOVER !== 'false') {
      clearTimeout(this._autoRecoverTimer);
      this._autoRecoverTimer = setTimeout(() => {
        if (this.connection.status === 'stopped') {
          this.logger.info('boot', 'auto recovering WhatsApp session after server restart');
          this.startBot('auto_recover').catch((err) => {
            this.logger.warn('boot', `auto recover failed: ${err.message}`);
          });
        }
      }, parseInt(process.env.WA_AUTO_RECOVER_DELAY_MS || '2500', 10));
      if (typeof this._autoRecoverTimer.unref === 'function') this._autoRecoverTimer.unref();
    }
  }

  async persistSessionState({ desiredState = this.sessionDesiredState, state = this.connection.state() } = {}) {
    this.sessionDesiredState = desiredState;
    const status = state.status || this.connection.status || 'stopped';
    const nowFields = {
      lastQr: status === 'qr_ready',
      lastConnected: status === 'connected',
      lastDisconnected: ['disconnected', 'reconnecting', 'error'].includes(status),
    };

    const query = buildPersistSessionStateQuery({
      userId: this.userId,
      phone: state.phone || this.connection.phone || null,
      status,
      sessionPath: this.sessionStoragePath,
      desiredState,
      runtimeAuthState: buildRuntimeAuthMetadata(state),
      nowFields,
      lastError: state.error || null,
      reconnectCount: state.reconnectCount || 0,
    });
    const result = await db.query(query.text, query.values);
    this.lastPersistedSession = result.rows[0] || this.lastPersistedSession;
  }

  leaseTtlMs() {
    return parseInt(process.env.WA_CONNECTION_LEASE_MS || '120000', 10);
  }

  leaseExpiresAt() {
    return new Date(Date.now() + this.leaseTtlMs());
  }

  async acquireConnectionLease(reason = 'start') {
    const result = await db.query(
      `UPDATE whatsapp_sessions
       SET connection_owner = $2,
           connection_lease_expires_at = $3,
           desired_state = 'running',
           last_error = NULL
       WHERE user_id = $1
         AND (
           connection_owner IS NULL
           OR connection_owner = $2
           OR connection_lease_expires_at IS NULL
           OR connection_lease_expires_at < NOW()
         )
       RETURNING connection_owner, connection_lease_expires_at`,
      [this.userId, this.instanceId, this.leaseExpiresAt()],
    );

    if (!result.rows[0]) {
      this.logger.warn('boot', `WhatsApp lease is held by another instance; postponing ${reason}`);
      this.scheduleLeaseRetry(reason);
      return false;
    }

    this.startLeaseRenewal();
    return true;
  }

  startLeaseRenewal() {
    clearInterval(this._leaseRenewTimer);
    const interval = Math.max(10000, Math.floor(this.leaseTtlMs() / 3));
    this._leaseRenewTimer = setInterval(() => {
      db.query(
        `UPDATE whatsapp_sessions
         SET connection_lease_expires_at = $3
         WHERE user_id = $1 AND connection_owner = $2`,
        [this.userId, this.instanceId, this.leaseExpiresAt()],
      ).catch((err) => this.logger.warn('connection', `failed to renew WhatsApp lease: ${err.message}`));
    }, interval);
    if (typeof this._leaseRenewTimer.unref === 'function') this._leaseRenewTimer.unref();
  }

  async releaseConnectionLease() {
    clearInterval(this._leaseRenewTimer);
    this._leaseRenewTimer = null;
    await db.query(
      `UPDATE whatsapp_sessions
       SET connection_owner = NULL,
           connection_lease_expires_at = NULL
       WHERE user_id = $1 AND connection_owner = $2`,
      [this.userId, this.instanceId],
    );
  }

  scheduleLeaseRetry(reason) {
    clearTimeout(this._autoRecoverTimer);
    const delay = parseInt(process.env.WA_LEASE_RETRY_MS || '10000', 10);
    this._autoRecoverTimer = setTimeout(() => {
      if (this.sessionDesiredState === 'running' && this.connection.status === 'stopped') {
        this.startBot(`lease_retry:${reason}`).catch((err) => {
          this.logger.warn('boot', `lease retry failed: ${err.message}`);
        });
      }
    }, delay);
    if (typeof this._autoRecoverTimer.unref === 'function') this._autoRecoverTimer.unref();
  }

  async saveConfig() {
    await db.query(
      `INSERT INTO bot_configs (user_id, config, source)
       VALUES ($1, $2::jsonb, 'src-server')
       ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, source = EXCLUDED.source`,
      [this.userId, JSON.stringify(this.config)],
    );
    this.ai.updateConfig(this.config);
  }

  async startBot(source = 'manual') {
    const staleWaitingQrMs = parseInt(process.env.WA_STALE_WAITING_QR_RESTART_MS || '45000', 10);
    const updatedAt = this.lastPersistedSession?.updated_at ? new Date(this.lastPersistedSession.updated_at).getTime() : 0;
    const staleStatuses = new Set(['waiting_qr', 'connecting', 'reconnecting', 'disconnected']);
    if (staleStatuses.has(this.connection.status) && !this.connection.qr && updatedAt && Date.now() - updatedAt > staleWaitingQrMs) {
      this.logger.warn('boot', `stale ${this.connection.status} detected; forcing WhatsApp restart`);
      this.restartBot().catch((err) => this.logger.error('boot', `forced restart failed: ${err.message}`));
      return false;
    }
    this.sessionDesiredState = 'running';
    if (!(await this.acquireConnectionLease(source))) return false;
    this.persistSessionState({ desiredState: 'running' }).catch((err) => {
      this.logger.warn('connection', `failed to persist start intent: ${err.message}`);
    });
    this.logger.info('boot', `start requested (${source})`);
    return this.connection.start();
  }

  async stopBot() {
    this.sessionDesiredState = 'stopped';
    this.stopWhatsappSessionBackup();
    await this.connection.stop();
    await this.persistSessionState({ desiredState: 'stopped' });
    await this.releaseConnectionLease();
  }

  async restartBot() {
    this.sessionDesiredState = 'running';
    this.stopWhatsappSessionBackup();
    await this.connection.stop();
    if (!(await this.acquireConnectionLease('restart'))) return false;
    await this.persistSessionState({ desiredState: 'running', state: { ...this.connection.state(), status: 'restarting' } });
    this.logger.info('boot', 'force restarting WhatsApp connection');
    return this.connection.start(0);
  }

  async clearSession() {
    this.sessionDesiredState = 'stopped';
    this.stopWhatsappSessionBackup();
    await this.connection.stop();
    try { await this.connection.clearAuthCache?.('manual clear-session'); } catch (_) {}
    try { fs.rmSync(this.persistentSessionPath, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(this.runtimeSessionPath, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(this.dataDir, 'session'), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(this.dataDir, 'baileys-session'), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(this.dataDir, '.waweb-cache'), { recursive: true, force: true }); } catch (_) {}
    await this.persistSessionState({
      desiredState: 'stopped',
      state: { status: 'stopped', ready: false, phone: null, error: null, qrVersion: 0, reconnectCount: 0, authFailureCount: 0 },
    });
    await this.releaseConnectionLease();
  }

  log(message) {
    this.logger.log(message);
  }

  buildAIClient() {
    return this.ai.buildClient();
  }

  buildSystemPrompt(history, opts) {
    return this.ai.buildSystemPrompt(history, opts);
  }

  async getAIReply(history, opts) {
    return this.ai.getReply(history, opts);
  }

  recordUsage(model, inputTokens, outputTokens) {
    this.costsData.totalCalls++;
    this.costsData.totalInputTokens += inputTokens || 0;
    this.costsData.totalOutputTokens += outputTokens || 0;
    if (!this.costsData.byModel[model]) this.costsData.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0 };
    this.costsData.byModel[model].calls++;
    this.costsData.byModel[model].inputTokens += inputTokens || 0;
    this.costsData.byModel[model].outputTokens += outputTokens || 0;
  }

  scheduleWhatsappSessionBackup(reason = 'connected') {
    this.stopWhatsappSessionBackup();
    const delay = parseInt(process.env.WA_SESSION_BACKUP_DELAY_MS || '30000', 10);
    this._sessionBackupTimer = setTimeout(() => {
      this._sessionBackupTimer = null;
      if (this.connection.status !== 'connected' || !this.connection.ready) return;
      backupWhatsappSession({
        source: this.connection.sessionPath,
        target: this.persistentSessionPath,
        logger: this.logger,
        rootDir: this.rootDir,
        userId: this.userId,
      });
      const interval = parseInt(process.env.WA_SESSION_BACKUP_INTERVAL_MS || '120000', 10);
      this._sessionBackupTimer = setTimeout(() => this.scheduleWhatsappSessionBackup('interval'), interval);
      if (typeof this._sessionBackupTimer.unref === 'function') this._sessionBackupTimer.unref();
    }, delay);
    if (typeof this._sessionBackupTimer.unref === 'function') this._sessionBackupTimer.unref();
    this.logger.info('auth', `scheduled WhatsApp session backup after ${Math.round(delay / 1000)}s (${reason})`);
  }

  stopWhatsappSessionBackup() {
    clearTimeout(this._sessionBackupTimer);
    this._sessionBackupTimer = null;
  }
}

function cleanupRuntimeStorage(rootDir, currentUserId = '') {
  const usersRoot = path.join(rootDir, 'data');
  const removeTargets = [];

  const scanUserDir = (userDir) => {
    removeTargets.push(path.join(userDir, 'baileys-session'));
    removeTargets.push(path.join(userDir, '.waweb-cache'));
  };

  try {
    if (currentUserId) scanUserDir(path.join(usersRoot, currentUserId));
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanUserDir(path.join(usersRoot, entry.name));
    }
  } catch (_) {}

  for (const target of [...new Set(removeTargets)]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
  }

  try {
    const tmpRoot = path.join(os.tmpdir(), 'raddi-wa-sessions');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (_) {}
}

module.exports = { RuntimeBot, cleanupRuntimeStorage };
