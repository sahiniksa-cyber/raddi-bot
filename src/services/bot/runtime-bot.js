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
  }

  get client() {
    return this.connection.client;
  }

  get botRunning() {
    return this.connection.status !== 'stopped';
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
    return this;
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

  startBot() {
    return this.connection.start();
  }

  async stopBot() {
    await this.connection.stop();
  }

  async clearSession() {
    await this.connection.stop();
    try { fs.rmSync(path.join(this.dataDir, 'session'), { recursive: true, force: true }); } catch (_) {}
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
