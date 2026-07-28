'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const db = require('../../db/client');
const Logger = require('../../../lib/logger');
const AIClient = require('../../../lib/ai-client');
const { DEFAULT_CONFIG, MODEL_PRICES } = require('../../../lib/constants');
const { mergeApiKeys, resolveEffectiveApiKeys } = require('../config/api-keys-resolver');
const { getAllAdminApiKeys } = require('../admin/admin-api-keys');
const { getCustomerApiKeysFor } = require('../admin/customer-api-keys');
const { EnterpriseWhatsAppConnectionManager } = require('../whatsapp/connection-manager');
const { BaileysConnectionManager } = require('../whatsapp/baileys-connection-manager');
const {
  WhatsAppHistoryImportService,
  historyImportIdleMs,
  historyImportMaxMs,
} = require('../whatsapp/history-import.service');
const { sendUnlinkAlert } = require('../monitoring/unlink-alert');
const { resolveWhatsappEngine } = require('./engine-config');
const {
  buildPersistSessionStateQuery,
  buildRuntimeAuthMetadata,
} = require('./session-state-persistence');

// Decide whether a bot should AUTO-recover its WhatsApp connection on boot.
// Only a previously-LINKED session (hasSavedSession) auto-reconnects — it comes
// back with no QR. An unlinked bot left at desired_state='running' must NOT
// auto-open a pairing socket on every boot: many such sockets pairing at once
// are terminated by WhatsApp (428) and no scan can complete. Unlinked bots wait
// for an explicit Start (one fresh pairing socket — the state that links).
function shouldAutoRecoverSession({ desiredState, hasSavedSession, autoRecoverDisabled }) {
  return desiredState === 'running' && hasSavedSession === true && !autoRecoverDisabled;
}

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
  constructor(userId, { dataDir = process.env.DATA_DIR || process.cwd(), logger = null, database = db } = {}) {
    this.userId = userId;
    this.db = database;
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
    this._historyImportIdleTimer = null;
    this._historyImportMaxTimer = null;
    this._historyImportFinishing = null;
    this._historyImportConnection = null;
    // WhatsApp 440 (connectionReplaced) smart-recovery state. A single conflict
    // recovers fast; repeated conflicts within a short window escalate the delay
    // so we don't fight a persistent duplicate-device session in a tight loop.
    this._connConflictCount = 0;
    this._lastConflictAt = 0;
    this._connConflictRecoveryUntil = 0;
    this.lastPersistedSession = null;
    this._persistQueue = Promise.resolve();
    this.instanceId = process.env.RAILWAY_REPLICA_ID ||
      `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    this.totalChatsHandled = 0;
    this.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {} };
    this.historyImport = new WhatsAppHistoryImportService({
      database: this.db,
      userId: this.userId,
      logger: this.logger,
    });

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
      ? path.join(process.env.WA_RUNTIME_SESSION_DIR || path.join(os.tmpdir(), 'jwab-wa-sessions'), userId)
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
      database: this.db,
      historyImportService: this.historyImport,
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
      if (this.whatsappEngine === 'whatsapp-web') this.scheduleWhatsappSessionBackup('ready');
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
    this.connection.on('logged_out', () => {
      // Device was unlinked — fire the instant owner alert (best-effort,
      // never blocks the disconnect handling).
      sendUnlinkAlert({ userId: this.userId, phone: this.connection.phone }).catch(() => {});
    });
    this.connection.on('connection_conflict', () => {
      if (this.sessionDesiredState !== 'running') return;
      // Stop renewing the lease for a connection that's actually stopped, and
      // release it so a competing instance can take over immediately instead of
      // waiting the full lease TTL.
      clearInterval(this._leaseRenewTimer);
      this._leaseRenewTimer = null;
      this.releaseConnectionLease().catch((err) => {
        this.logger.warn('connection', `440: failed to release lease: ${err.message}`);
      });

      // Smart recovery backoff. A 440 (connectionReplaced) usually means the
      // owner opened the same number on another linked device. A lone conflict
      // should recover in seconds; conflicts that keep firing within a short
      // window escalate the delay so we don't loop against a persistent
      // duplicate session. The old fixed delay (leaseTtlMs + 5s ≈ 125s) made
      // every conflict a 2-minute outage even for a one-off device switch.
      const now = Date.now();
      const resetMs = parseInt(process.env.WA_CONN_CONFLICT_RESET_MS || '180000', 10);
      if (now - (this._lastConflictAt || 0) > resetMs) this._connConflictCount = 0;
      this._lastConflictAt = now;
      this._connConflictCount++;
      const retryMs = this.connloopRecoveryDelayMs(this._connConflictCount);
      this._connConflictRecoveryUntil = now + retryMs;

      clearTimeout(this._autoRecoverTimer);
      this._autoRecoverTimer = setTimeout(() => {
        this._autoRecoverTimer = null;
        if (this.sessionDesiredState === 'running' && this.connection.status === 'stopped') {
          this.logger.info('connection', `440 auto-recovery (attempt ${this._connConflictCount}): re-acquiring WhatsApp lease`);
          this.startBot('440_recovery').catch((err) => {
            this.logger.warn('connection', `440 auto-recovery failed: ${err.message}`);
          });
        }
      }, retryMs);
      if (typeof this._autoRecoverTimer.unref === 'function') this._autoRecoverTimer.unref();
    });
  }

  createHistoryImportConnection(importId) {
    if (!importId) throw new Error('importId is required');
    const currentImportId = this._historyImportConnection?._historyImport?.importId || null;
    if (currentImportId === importId) return this._historyImportConnection;
    if (this._historyImportConnection) {
      throw new Error('Another WhatsApp history import connection is already active');
    }

    const connection = new BaileysConnectionManager({
      userId: this.userId,
      dataDir: path.join(this.dataDir, 'history-import-runtime'),
      logger: this.logger,
      database: this.db,
      historyImportService: this.historyImport,
    });
    connection.setHistoryImportMode({
      enabled: true,
      importId,
      service: this.historyImport,
    });
    connection.on('ready', () => {
      this.historyImport.markConnected(importId)
        .then((row) => {
          if (row) this.scheduleHistoryImportTimers(importId, row);
        })
        .catch((err) => {
          this.logger.warn('history_import', `failed to mark temporary import device connected: ${err.message}`);
        });
    });
    connection.on('history_import_activity', ({ importId: eventImportId } = {}) => {
      if (eventImportId === importId && this._historyImportConnection === connection) {
        this.scheduleHistoryImportIdleTimer(importId);
      }
    });
    connection.on('history_import_complete', ({ importId: eventImportId } = {}) => {
      if (eventImportId !== importId) return;
      this.autoFinishHistoryImport(importId, 'whatsapp_complete').catch((err) => {
        this.logger.warn('history_import', `automatic completion failed: ${err.message}`);
      });
    });
    this._historyImportConnection = connection;
    return connection;
  }

  get client() {
    return this.connection.client;
  }

  // Live view of the underlying Baileys socket so the outgoing worker's
  // isSocketOpen() guard can inspect ws.readyState. Reading at call time
  // (not capturing) means it never pins a dead socket across reconnects.
  // whatsapp-web.js engine has no sock — getter returns undefined and the
  // guard falls through to "open", same as before.
  get sock() {
    return this.connection?.sock;
  }

  get historyImportAppState() {
    const connection = this._historyImportConnection;
    if (!connection) return null;
    const state = connection.state();
    return {
      status: state.status,
      qrString: connection.qr,
      qrVersion: state.qrVersion,
      phone: state.phone,
      error: state.error,
      ready: Boolean(state.ready),
      reconnectCount: state.reconnectCount || 0,
      statusAgeMs: state.statusAgeMs || 0,
      historyImportMode: Boolean(state.historyImportMode),
      readOnly: true,
    };
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
      ready: !!state.ready,
      reconnectCount: state.reconnectCount || 0,
      authFailureCount: state.authFailureCount || 0,
      heartbeatFailures: state.heartbeatFailures || 0,
      statusAgeMs: state.statusAgeMs || 0,
      lastProbeState: state.lastProbeState || null,
      historyImportMode: Boolean(state.historyImportMode),
      readOnly: Boolean(state.readOnly),
      desiredState: this.sessionDesiredState,
      whatsappEngine: this.whatsappEngine,
      activeChats: 0,
      totalChatsHandled: this.totalChatsHandled,
      queue: {},
      logs: this.logger.all(),
    };
  }

  async load(deps = {}) {
    const loadBotConfig = deps.loadBotConfig || (async (uid) => {
      const result = await db.query('SELECT config FROM bot_configs WHERE user_id = $1', [uid]);
      return { ...DEFAULT_CONFIG, ...(result.rows[0]?.config || {}) };
    });
    this._loadAdminKeys = deps.loadAdminKeys || getAllAdminApiKeys;
    this._saveBotConfig = deps.saveBotConfig || null;
    const doLoadSessionState = deps.loadSessionState || (() => this.loadSessionState());

    const customer = await loadBotConfig(this.userId);
    this.config = { ...DEFAULT_CONFIG, ...customer };
    this.ai.updateConfig(this.config);
    await doLoadSessionState();
    return this;
  }

  async resolveConfig() {
    const admin = await (this._loadAdminKeys || getAllAdminApiKeys)();
    return mergeApiKeys(this.config, admin);
  }

  async loadSessionState() {
    const [result, activeHistoryImport] = await Promise.all([
      this.db.query(
      `INSERT INTO whatsapp_sessions (user_id, status, session_path, desired_state, auth_state)
       VALUES ($1, 'stopped', $2, 'stopped', '{}'::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET session_path = EXCLUDED.session_path
       RETURNING desired_state, status, updated_at,
                 (auth_state->'baileys'->'creds'->'me'->>'id') IS NOT NULL AS has_session`,
      [this.userId, this.sessionStoragePath],
      ),
      this.db.query(
        `SELECT id, started_at, connected_at, last_event_at FROM whatsapp_history_imports
         WHERE user_id = $1 AND status IN ('starting','running')
         ORDER BY created_at DESC LIMIT 1`,
        [this.userId],
      ),
    ]);

    const activeImport = activeHistoryImport.rows[0] || null;
    const activeImportId = activeImport?.id || null;
    if (activeImportId && this.whatsappEngine === 'baileys') {
      this.createHistoryImportConnection(activeImportId);
      this.scheduleHistoryImportTimers(activeImportId, activeImport);
    }

    const row = result.rows[0] || {};
    this.lastPersistedSession = row;
    this.sessionDesiredState = row.desired_state || 'stopped';
    const hasSavedSession = row.has_session === true;
    // Only AUTO-recover a bot that was previously LINKED (has saved creds): it
    // reconnects from its stored session with no QR. An UNLINKED bot whose
    // desired_state is still 'running' must NOT auto-start into an endless
    // QR-pairing loop on every boot — when many such bots pair at once WhatsApp
    // terminates the concurrent pre-pairing sockets (code 428) so nobody can
    // complete a scan (proven: an isolated single fresh socket links fine).
    // Unlinked bots wait for the owner to press Start, which opens ONE fresh
    // pairing socket — the state that links reliably.
    if (this.sessionDesiredState === 'running' && !hasSavedSession) {
      this.logger.info('boot', 'skipping auto-recover for an unlinked session; awaiting manual start (prevents concurrent QR pairing storms)');
    }
    if (shouldAutoRecoverSession({
      desiredState: this.sessionDesiredState,
      hasSavedSession,
      autoRecoverDisabled: process.env.WA_AUTO_RECOVER === 'false',
    })) {
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
    if (activeImportId && this._historyImportConnection) {
      const started = await this._historyImportConnection.start(0);
      if (!started) {
        this.logger.warn('history_import', 'failed to restore the temporary history import connection');
      }
    }
  }

  persistSessionState({ desiredState = this.sessionDesiredState, state = this.connection.state() } = {}) {
    const next = this._persistQueue
      .catch(() => {})
      .then(() => this._persistSessionStateNow({ desiredState, state }));
    this._persistQueue = next;
    return next;
  }

  async _persistSessionStateNow({ desiredState = this.sessionDesiredState, state = this.connection.state() } = {}) {
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
    // 45s (was 120s): shorter TTL means a crash-killed container's stale lease
    // frees up faster for automatic recovery. Renewal runs at TTL/3 (~15s).
    return parseInt(process.env.WA_CONNECTION_LEASE_MS || '45000', 10);
  }

  leaseExpiresAt() {
    return new Date(Date.now() + this.leaseTtlMs());
  }

  // Escalating recovery delay for repeated WhatsApp 440 conflicts. count=1 →
  // base (8s), then doubles each consecutive conflict up to a cap (120s).
  connloopRecoveryDelayMs(count) {
    const base = parseInt(process.env.WA_CONN_CONFLICT_BASE_MS || '8000', 10);
    const cap = parseInt(process.env.WA_CONN_CONFLICT_MAX_MS || '120000', 10);
    const n = Math.max(1, Number(count) || 1);
    return Math.min(base * 2 ** (n - 1), cap);
  }

  // True while we are intentionally backing off after a 440 conflict. The
  // outgoing worker checks this so it does not force an immediate reconnect and
  // defeat the backoff (which would create a tight reconnect loop).
  isInConnConflictBackoff() {
    return Date.now() < (this._connConflictRecoveryUntil || 0);
  }

  async acquireConnectionLease(reason = 'start', { force = false } = {}) {
    // force=true claims the lease unconditionally. Used for operator-initiated
    // starts (the dashboard button / restart): the deployment is single-replica,
    // so any lease still pointing at a different instanceId belongs to a DEAD
    // previous container — waiting out its 120s TTL is exactly the "press start,
    // nothing happens for two minutes" bug. If a displaced instance were somehow
    // still alive, its _renewLeaseOnce detects the lost lease and stands down.
    const ownerGuard = force
      ? ''
      : `AND (
           connection_owner IS NULL
           OR connection_owner = $2
           OR connection_lease_expires_at IS NULL
           OR connection_lease_expires_at < NOW()
         )`;
    const result = await this.db.query(
      `UPDATE whatsapp_sessions
       SET connection_owner = $2,
           connection_lease_expires_at = $3,
           desired_state = 'running',
           last_error = NULL
       WHERE user_id = $1
         ${ownerGuard}
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
      this._renewLeaseOnce().catch((err) => this.logger.warn('connection', `failed to renew WhatsApp lease: ${err.message}`));
    }, interval);
    if (typeof this._leaseRenewTimer.unref === 'function') this._leaseRenewTimer.unref();
  }

  // One lease-renewal tick. CRITICAL: if the UPDATE matches 0 rows, another
  // instance has taken ownership of this session (e.g. a new Railway replica
  // after a redeploy). Continuing to run our Baileys socket against the same
  // credentials triggers a WhatsApp 440 on the live connection. So on lease
  // loss we stop our local connection and stop renewing — desired_state in the
  // DB is untouched, so the owning instance keeps the session alive.
  async _renewLeaseOnce() {
    const result = await this.db.query(
      `UPDATE whatsapp_sessions
       SET connection_lease_expires_at = $3
       WHERE user_id = $1 AND connection_owner = $2`,
      [this.userId, this.instanceId, this.leaseExpiresAt()],
    );
    if (result && Number(result.rowCount) === 0) {
      this.logger.warn('connection', 'WhatsApp lease lost to another instance — stopping local connection to avoid a 440 conflict');
      clearInterval(this._leaseRenewTimer);
      this._leaseRenewTimer = null;
      try { await this.connection.stop(); } catch (_) {}
    }
  }

  async releaseConnectionLease() {
    clearInterval(this._leaseRenewTimer);
    this._leaseRenewTimer = null;
    await this.db.query(
      `UPDATE whatsapp_sessions
       SET connection_owner = NULL,
           connection_lease_expires_at = NULL
       WHERE user_id = $1 AND connection_owner = $2`,
      [this.userId, this.instanceId],
    );
  }

  // Used on process shutdown (e.g. Railway redeploy): close the live WhatsApp
  // socket so the next replica doesn't collide with our session (440), and free
  // the DB lease. Does NOT change desired_state, so the next replica
  // auto-recovers the session.
  async releaseForShutdown() {
    try { await this._historyImportConnection?.stop(); } catch (_) {}
    try { await this.connection.stop(); } catch (_) {}
    await this.releaseConnectionLease();
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
    if (this._saveBotConfig) {
      await this._saveBotConfig(this.userId, this.config);
    } else {
      await db.query(
        `INSERT INTO bot_configs (user_id, config, source)
         VALUES ($1, $2::jsonb, 'src-server')
         ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, source = EXCLUDED.source`,
        [this.userId, JSON.stringify(this.config)],
      );
    }
    this.ai.updateConfig(this.config);
  }

  async startBot(source = 'manual') {
    const staleWaitingQrMs = parseInt(process.env.WA_STALE_WAITING_QR_RESTART_MS || '45000', 10);
    const updatedAt = this.lastPersistedSession?.updated_at ? new Date(this.lastPersistedSession.updated_at).getTime() : 0;
    const staleStatuses = new Set(['waiting_qr', 'connecting']);
    const manualStart = source === 'manual';
    if (manualStart && staleStatuses.has(this.connection.status) && !this.connection.qr && updatedAt && Date.now() - updatedAt > staleWaitingQrMs) {
      this.logger.warn('boot', `stale ${this.connection.status} detected; forcing WhatsApp restart`);
      return this.restartBot();
    }
    this.sessionDesiredState = 'running';
    // Operator-initiated starts steal the lease so the button always works
    // immediately (single-replica → any other owner is a dead container).
    // Automatic starts (auto_recover / outgoing) stay polite.
    const operatorInitiated = manualStart || source === 'restart' || source.includes('manual') || source.includes('restart');
    if (!(await this.acquireConnectionLease(source, { force: operatorInitiated }))) return false;
    this.persistSessionState({ desiredState: 'running' }).catch((err) => {
      this.logger.warn('connection', `failed to persist start intent: ${err.message}`);
    });
    this.logger.info('boot', `start requested (${source})`);
    return this.connection.start();
  }

  async stopBot() {
    const activeHistoryImportId = this._historyImportConnection?._historyImport?.importId || null;
    this.sessionDesiredState = 'stopped';
    this.clearHistoryImportTimers();
    clearTimeout(this._autoRecoverTimer);
    this._autoRecoverTimer = null;
    this.stopWhatsappSessionBackup();
    if (activeHistoryImportId) {
      await this._historyImportConnection.closeHistoryImportDevice(activeHistoryImportId);
      this._historyImportConnection = null;
    }
    await this.connection.stop();
    if (activeHistoryImportId) {
      await this.historyImport.finishImport(activeHistoryImportId);
    }
    await this.persistSessionState({ desiredState: 'stopped' });
    await this.releaseConnectionLease();
  }

  async restartBot() {
    this.sessionDesiredState = 'running';
    this.stopWhatsappSessionBackup();
    await this.connection.stop();
    if (!(await this.acquireConnectionLease('restart', { force: true }))) return false;
    await this.persistSessionState({ desiredState: 'running', state: { ...this.connection.state(), status: 'restarting' } });
    this.logger.info('boot', 'force restarting WhatsApp connection');
    return this.connection.start(0);
  }

  lockHistoryImportSending() {
    this.connection.setHistoryImportSendLock?.(true);
  }

  unlockHistoryImportSending() {
    this.connection.setHistoryImportSendLock?.(false);
  }

  clearHistoryImportTimers() {
    clearTimeout(this._historyImportIdleTimer);
    clearTimeout(this._historyImportMaxTimer);
    this._historyImportIdleTimer = null;
    this._historyImportMaxTimer = null;
  }

  scheduleHistoryImportIdleTimer(importId, referenceAt = Date.now()) {
    clearTimeout(this._historyImportIdleTimer);
    const reference = new Date(referenceAt || Date.now()).getTime();
    const elapsed = Number.isFinite(reference) ? Math.max(0, Date.now() - reference) : 0;
    const delay = Math.max(0, historyImportIdleMs() - elapsed);
    this._historyImportIdleTimer = setTimeout(() => {
      this._historyImportIdleTimer = null;
      this.autoFinishHistoryImport(importId, 'idle_timeout').catch((err) => {
        this.logger.warn('history_import', `idle timeout completion failed: ${err.message}`);
      });
    }, delay);
    if (typeof this._historyImportIdleTimer.unref === 'function') this._historyImportIdleTimer.unref();
  }

  scheduleHistoryImportTimers(importId, {
    started_at: startedAt,
    connected_at: connectedAt,
    last_event_at: lastEventAt,
  } = {}) {
    this.clearHistoryImportTimers();
    const started = new Date(startedAt || Date.now()).getTime();
    const elapsed = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
    const maxDelay = Math.max(0, historyImportMaxMs() - elapsed);
    this._historyImportMaxTimer = setTimeout(() => {
      this._historyImportMaxTimer = null;
      this.autoFinishHistoryImport(importId, 'maximum_duration').catch((err) => {
        this.logger.warn('history_import', `maximum duration completion failed: ${err.message}`);
      });
    }, maxDelay);
    if (typeof this._historyImportMaxTimer.unref === 'function') this._historyImportMaxTimer.unref();
    const idleReference = lastEventAt || connectedAt;
    if (idleReference) this.scheduleHistoryImportIdleTimer(importId, idleReference);
  }

  async autoFinishHistoryImport(importId, reason) {
    if (this._historyImportFinishing) return this._historyImportFinishing;
    if (this._historyImportConnection?._historyImport?.importId !== importId) return null;
    this._historyImportFinishing = this.finishHistoryImport(importId, { reason })
      .finally(() => { this._historyImportFinishing = null; });
    return this._historyImportFinishing;
  }

  async startHistoryImport(importId) {
    if (this.whatsappEngine !== 'baileys') {
      const error = new Error('WhatsApp history import requires the Baileys connection');
      error.statusCode = 400;
      error.code = 'HISTORY_IMPORT_ENGINE_UNSUPPORTED';
      throw error;
    }

    const historyConnection = this.createHistoryImportConnection(importId);
    try {
      const runningImport = await this.historyImport.markRunning(importId);
      const started = await historyConnection.start(0);
      if (!started) throw new Error('WhatsApp history import connection did not start');
      this.scheduleHistoryImportTimers(importId, runningImport);
      return this.historyImport.latestStatus();
    } catch (error) {
      this.clearHistoryImportTimers();
      await historyConnection.closeHistoryImportDevice(importId).catch(() => {});
      if (this._historyImportConnection === historyConnection) this._historyImportConnection = null;
      await this.historyImport.failImport(importId, error).catch(() => {});
      throw error;
    }
  }

  async finishHistoryImport(importId, { reason = 'manual' } = {}) {
    const historyConnection = this._historyImportConnection;
    if (historyConnection?._historyImport?.importId !== importId) {
      const error = new Error('This WhatsApp history import is not active on the current connection');
      error.statusCode = 409;
      error.code = 'HISTORY_IMPORT_NOT_ACTIVE';
      throw error;
    }
    this.clearHistoryImportTimers();
    try {
      await historyConnection.closeHistoryImportDevice(importId);
    } catch (err) {
      this.logger.warn('history_import', `temporary device cleanup failed; finishing import anyway: ${err.message}`);
      await historyConnection.stop().catch(() => {});
    }
    try {
      return await this.historyImport.finishImport(importId, { reason });
    } finally {
      if (this._historyImportConnection === historyConnection) this._historyImportConnection = null;
      this.unlockHistoryImportSending();
    }
  }

  async clearSession() {
    const activeHistoryImportId = this._historyImportConnection?._historyImport?.importId || null;
    this.sessionDesiredState = 'stopped';
    this.clearHistoryImportTimers();
    this.stopWhatsappSessionBackup();
    if (activeHistoryImportId) {
      await this._historyImportConnection.closeHistoryImportDevice(activeHistoryImportId);
      this._historyImportConnection = null;
    }
    await this.connection.stop();
    if (activeHistoryImportId) {
      await this.historyImport.failImport(activeHistoryImportId, 'WhatsApp session cleared during import').catch(() => {});
    }
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

  async buildAIClient() {
    const merged = await this.resolveConfig();
    this.ai.updateConfig(merged);
    return this.ai.buildClient();
  }

  buildSystemPrompt(history, opts) {
    return this.ai.buildSystemPrompt(history, opts);
  }

  async getAIReply(history, opts) {
    const merged = await this.resolveConfig();
    this.ai.updateConfig(merged);
    return this.ai.getReply(history, opts);
  }

  async reviewReplyBeforeSend(input) {
    const merged = await this.resolveConfig();
    this.ai.updateConfig(merged);
    return this.ai.reviewBeforeSend(input);
  }

  recordUsage(model, inputTokens, outputTokens) {
    this.costsData.totalCalls++;
    this.costsData.totalInputTokens += inputTokens || 0;
    this.costsData.totalOutputTokens += outputTokens || 0;
    if (!this.costsData.byModel[model]) this.costsData.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0 };
    this.costsData.byModel[model].calls++;
    this.costsData.byModel[model].inputTokens += inputTokens || 0;
    this.costsData.byModel[model].outputTokens += outputTokens || 0;

    // Persist to DB for accurate cross-process counting
    if (db.isConfigured() && this.userId) {
      const prices = MODEL_PRICES[model] || { in: 0.5, out: 1.5 };
      const costUsd = ((inputTokens * prices.in) + (outputTokens * prices.out)) / 1_000_000;
      db.query(
        'INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4, $5)',
        [this.userId, model, inputTokens || 0, outputTokens || 0, costUsd],
      ).catch(() => {});
    }
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
  const engine = resolveWhatsappEngine(process.env);
  const removeLegacyWhatsappWebData = engine !== 'whatsapp-web';

  const scanUserDir = (userDir) => {
    removeTargets.push(path.join(userDir, 'baileys-session'));
    removeTargets.push(path.join(userDir, '.waweb-cache'));
    removeTargets.push(path.join(userDir, '.wwebjs_cache'));
    removeTargets.push(path.join(userDir, '.wwebjs_auth'));
    if (removeLegacyWhatsappWebData) removeTargets.push(path.join(userDir, 'session'));
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
    const tmpRoot = path.join(os.tmpdir(), 'jwab-wa-sessions');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (_) {}
}

async function resolveConfigForAI(userId, deps = {}) {
  const loadBotConfig = deps.loadBotConfig || (async (uid) => {
    const result = await db.query('SELECT config FROM bot_configs WHERE user_id = $1', [uid]);
    return { ...DEFAULT_CONFIG, ...(result.rows[0]?.config || {}) };
  });
  const loadAdminKeys = deps.loadAdminKeys || getAllAdminApiKeys;
  const loadCustomerKeys = deps.loadCustomerKeys
    || ((uid) => getCustomerApiKeysFor(uid).catch(() => ({})));
  const [customer, admin, customerKeys] = await Promise.all([
    loadBotConfig(userId),
    loadAdminKeys(),
    loadCustomerKeys(userId),
  ]);
  return resolveEffectiveApiKeys({
    userId,
    customerConfig: customer,
    adminKeys: admin,
    customerKeys,
  });
}

module.exports = { RuntimeBot, cleanupRuntimeStorage, resolveConfigForAI, shouldAutoRecoverSession };
