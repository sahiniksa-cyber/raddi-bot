'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../../db/client');
const Logger = require('../../../lib/logger');
const AIClient = require('../../../lib/ai-client');
const { DEFAULT_CONFIG } = require('../../../lib/constants');
const { EnterpriseWhatsAppConnectionManager } = require('../whatsapp/connection-manager');

class RuntimeBot {
  constructor(userId, { dataDir = process.env.DATA_DIR || process.cwd(), logger = null } = {}) {
    this.userId = userId;
    this.rootDir = dataDir;
    this.dataDir = path.join(dataDir, 'data', userId);
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.logger = logger || new Logger(userId);
    this.config = { ...DEFAULT_CONFIG };
    this.sessionDesiredState = 'stopped';
    this._autoRecoverTimer = null;
    this.lastPersistedSession = null;
    this.totalChatsHandled = 0;
    this.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {} };

    this.ai = new AIClient(this.config, this.logger, {
      record: (model, inputTokens, outputTokens) => this.recordUsage(model, inputTokens, outputTokens),
    });

    this.connection = new EnterpriseWhatsAppConnectionManager({
      userId,
      dataDir: this.dataDir,
      logger: this.logger,
    });

    this.connection.on('message_ingested', () => {
      this.totalChatsHandled++;
    });
    this.connection.on('state_changed', (state) => {
      this.persistSessionState({ state }).catch((err) => {
        this.logger.warn('connection', `failed to persist WhatsApp state: ${err.message}`);
      });
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
      [this.userId, this.connection.sessionPath],
    );

    const row = result.rows[0] || {};
    this.lastPersistedSession = row;
    this.sessionDesiredState = row.desired_state || 'stopped';
    if (this.sessionDesiredState === 'running' && process.env.WA_AUTO_RECOVER !== 'false') {
      clearTimeout(this._autoRecoverTimer);
      this._autoRecoverTimer = setTimeout(() => {
        if (this.connection.status === 'stopped') {
          this.logger.info('boot', 'auto recovering WhatsApp session after server restart');
          this.startBot('auto_recover');
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

    const result = await db.query(
      `INSERT INTO whatsapp_sessions (
         user_id, phone, status, session_path, desired_state, auth_state,
         last_qr_at, last_connected_at, last_disconnected_at, last_error, reconnect_count
       )
       VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         CASE WHEN $7 THEN NOW() ELSE NULL END,
         CASE WHEN $8 THEN NOW() ELSE NULL END,
         CASE WHEN $9 THEN NOW() ELSE NULL END,
         $10, $11
       )
       ON CONFLICT (user_id) DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, whatsapp_sessions.phone),
         status = EXCLUDED.status,
         session_path = EXCLUDED.session_path,
         desired_state = EXCLUDED.desired_state,
         auth_state = EXCLUDED.auth_state,
         last_qr_at = CASE WHEN $7 THEN NOW() ELSE whatsapp_sessions.last_qr_at END,
         last_connected_at = CASE WHEN $8 THEN NOW() ELSE whatsapp_sessions.last_connected_at END,
         last_disconnected_at = CASE WHEN $9 THEN NOW() ELSE whatsapp_sessions.last_disconnected_at END,
         last_error = EXCLUDED.last_error,
         reconnect_count = EXCLUDED.reconnect_count
       RETURNING desired_state, status, updated_at`,
      [
        this.userId,
        state.phone || this.connection.phone || null,
        status,
        this.connection.sessionPath,
        desiredState,
        JSON.stringify({
          ready: !!state.ready,
          qrVersion: state.qrVersion || 0,
          authFailureCount: state.authFailureCount || 0,
          heartbeatFailures: state.heartbeatFailures || 0,
          updatedAt: new Date().toISOString(),
        }),
        nowFields.lastQr,
        nowFields.lastConnected,
        nowFields.lastDisconnected,
        state.error || null,
        state.reconnectCount || 0,
      ],
    );
    this.lastPersistedSession = result.rows[0] || this.lastPersistedSession;
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

  startBot(source = 'manual') {
    const staleWaitingQrMs = parseInt(process.env.WA_STALE_WAITING_QR_RESTART_MS || '45000', 10);
    const updatedAt = this.lastPersistedSession?.updated_at ? new Date(this.lastPersistedSession.updated_at).getTime() : 0;
    const staleStatuses = new Set(['waiting_qr', 'connecting', 'reconnecting', 'disconnected']);
    if (staleStatuses.has(this.connection.status) && !this.connection.qr && updatedAt && Date.now() - updatedAt > staleWaitingQrMs) {
      this.logger.warn('boot', `stale ${this.connection.status} detected; forcing WhatsApp restart`);
      this.restartBot().catch((err) => this.logger.error('boot', `forced restart failed: ${err.message}`));
      return false;
    }
    this.sessionDesiredState = 'running';
    this.persistSessionState({ desiredState: 'running' }).catch((err) => {
      this.logger.warn('connection', `failed to persist start intent: ${err.message}`);
    });
    this.logger.info('boot', `start requested (${source})`);
    return this.connection.start();
  }

  async stopBot() {
    this.sessionDesiredState = 'stopped';
    await this.connection.stop();
    await this.persistSessionState({ desiredState: 'stopped' });
  }

  async restartBot() {
    this.sessionDesiredState = 'running';
    await this.connection.stop();
    await this.persistSessionState({ desiredState: 'running', state: { ...this.connection.state(), status: 'restarting' } });
    this.logger.info('boot', 'force restarting WhatsApp connection');
    return this.connection.start(0);
  }

  async clearSession() {
    this.sessionDesiredState = 'stopped';
    await this.connection.stop();
    try { fs.rmSync(path.join(this.dataDir, 'session'), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(this.dataDir, '.waweb-cache'), { recursive: true, force: true }); } catch (_) {}
    await this.persistSessionState({
      desiredState: 'stopped',
      state: { status: 'stopped', ready: false, phone: null, error: null, qrVersion: 0, reconnectCount: 0, authFailureCount: 0 },
    });
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
}

module.exports = { RuntimeBot };
