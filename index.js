/**
 * جواب — بوت واتساب ذكي لخدمة العملاء
 *
 * Modular Architecture v2.0
 * ─────────────────────────
 * lib/logger.js            → سجل أحداث مُهيكل
 * lib/constants.js          → ثوابت وأسعار
 * lib/helpers.js            → أدوات مشتركة (sleep, findChrome, fetchURL...)
 * lib/error-handler.js      → حماية عامة (uncaughtException/unhandledRejection/SIGTERM)
 * lib/heartbeat.js          → مراقب الاتصال (نبض + watchdog + فحص ما بعد الاتصال)
 * lib/message-queue.js      → طابور رسائل منفصل (enqueue فوري ← معالجة خلفية)
 * lib/connection-manager.js → دورة حياة الاتصال + Exponential Backoff
 * lib/ai-client.js          → مزود الذكاء الاصطناعي (Gemini/Claude/GPT/OpenRouter)
 * lib/store-scanner.js      → فحص المتاجر (سلة/زد/شوبيفاي)
 */
'use strict';

// ─── Core Modules ────────────────────────────────────────────────────
const QRCode     = require('qrcode');
const express    = require('express');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const { v4: uuidv4 } = require('uuid');
const rateLimit  = require('express-rate-limit');
let nodemailer; try { nodemailer = require('nodemailer'); } catch (_) {}
let FileStore;  try { FileStore = require('session-file-store')(session); } catch (_) {}

// ─── Project Modules ─────────────────────────────────────────────────
const Logger            = require('./lib/logger');
const { OWNER_PAUSE_MS, DEFAULT_CONFIG, DELAY_PRESETS, TIMERS } = require('./lib/constants');
const { sleep, killChrome, findChrome, isPrivateUrl, fetchURL } = require('./lib/helpers');
const errorHandler      = require('./lib/error-handler');
const Heartbeat         = require('./lib/heartbeat');
const MessageQueue      = require('./lib/message-queue');
const ConnectionManager = require('./lib/connection-manager');
const AIClient          = require('./lib/ai-client');
const storeScanner      = require('./lib/store-scanner');

// ─── DATA PERSISTENCE ─────────────────────────────────────────────────
const _onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);

function canUseDataDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

const DATA_DIR = (() => {
  if (process.env.DATA_DIR && canUseDataDir(process.env.DATA_DIR)) return path.resolve(process.env.DATA_DIR);
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH && canUseDataDir(process.env.RAILWAY_VOLUME_MOUNT_PATH)) {
    const p = path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH);
    console.log(`✅ Railway Volume detected: ${p}`);
    return p;
  }
  try { fs.accessSync('/data', fs.constants.W_OK); if (_onRailway) console.log('✅ تم اكتشاف Volume على /data تلقائياً'); return '/data'; } catch (_) {}
  return __dirname;
})();

function migrateRuntimeData(targetDir) {
  if (targetDir === __dirname) return;
  for (const name of ['users.json', '.session-secret']) {
    const source = path.join(__dirname, name);
    const target = path.join(targetDir, name);
    try {
      if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
    } catch (e) {
      console.warn(`⚠️ تعذر ترحيل ${name}: ${e.message}`);
    }
  }

  const targetUserRoot = path.join(targetDir, 'data');
  try { fs.mkdirSync(targetUserRoot, { recursive: true }); } catch (_) {}

  // Previous Railway setups often mounted ./data as /app/data. Preserve those sessions.
  try {
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const source = path.join(targetDir, entry.name);
      const target = path.join(targetUserRoot, entry.name);
      if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true });
    }
  } catch (_) {}

  try {
    const legacyRoot = path.join(__dirname, 'data');
    if (path.resolve(legacyRoot) !== path.resolve(targetUserRoot) && fs.existsSync(legacyRoot)) {
      for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
        const source = path.join(legacyRoot, entry.name);
        const target = path.join(targetUserRoot, entry.name);
        if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true });
      }
    }
  } catch (_) {}
}

migrateRuntimeData(DATA_DIR);

const storageStatus = {
  path: DATA_DIR,
  persistent: DATA_DIR !== __dirname,
  onRailway: _onRailway,
  railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
  sessionRoot: path.join(DATA_DIR, 'data'),
  usersPath: path.join(DATA_DIR, 'users.json'),
  warning: (_onRailway && DATA_DIR === __dirname)
    ? 'البيانات تُحفظ داخل الـ container. كل deploy يمسح الجلسة وتحتاج لإعادة مسح الباركود. الحل: أضف Volume على /data في Railway.'
    : null,
};

if (DATA_DIR === __dirname) {
  if (_onRailway) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════');
    console.error('❌  تحذير حرج: لا يوجد Volume على Railway!');
    console.error('   كل بيانات المستخدمين (حسابات، إعدادات، جلسة الواتساب)');
    console.error('   ستُمحى عند كل deployment أو إعادة تشغيل.');
    console.error('   الحل: في Railway → Service → Settings → Volumes');
    console.error('         أضف Volume بـ Mount path = /data');
    console.error('══════════════════════════════════════════════════════════');
    console.error('');
  } else {
    console.warn('⚠️  DATA_DIR غير مضبوط — البيانات ستُحفظ داخل مجلد التطبيق (للتطوير فقط)');
  }
} else {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  console.log(`✅ DATA_DIR = ${DATA_DIR}`);
}

// ─── STARTUP CHROME CHECK ─────────────────────────────────────────────
{ const _cp = findChrome(); if (_cp) console.log(`✅ Chromium: ${_cp}`); else console.error('❌ Chromium غير موجود!'); }

// ─── USERS ────────────────────────────────────────────────────────────
const USERS_PATH = path.join(DATA_DIR, 'users.json');
function loadUsers()  { try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch (_) { return { users: [] }; } }
function saveUsers(d) { fs.writeFileSync(USERS_PATH, JSON.stringify(d, null, 2), 'utf8'); }
function findUser(e)  { return loadUsers().users.find(u => u.email.toLowerCase() === e.toLowerCase()); }

// ══════════════════════════════════════════════════════════════════════
// ██  USER BOT — Slim Coordinator
// ══════════════════════════════════════════════════════════════════════
class UserBot {
  constructor(userId) {
    this.userId = userId;
    this.dataDir = path.join(DATA_DIR, 'data', userId);
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.configPath  = path.join(this.dataDir, 'config.json');
    this.costsPath   = path.join(this.dataDir, 'costs.json');
    this.convPath    = path.join(this.dataDir, 'conversations.json');
    this.sessionPath = path.join(this.dataDir, 'session');

    // ── State ──
    this.conversations    = new Map();
    this.testConversations = new Map();
    this.ownerPausedChats = new Map();
    this.botReplyingTo    = new Set();
    this.lastReplyByChat  = new Map();
    this.totalChatsHandled = 0;
    this.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {}, resetAt: new Date().toISOString() };

    // ── Core modules used during startup ──
    this.logger = new Logger(userId);

    // ── Config ──
    this.config = this._loadConfig();
    this._loadCosts();
    this._loadConversations();

    // ── Runtime modules ──
    this.heartbeat = new Heartbeat(this.logger);

    this.queue = new MessageQueue(this.logger);
    this.queue.onProcess((sender, msg, meta) => this._processMessage(sender, msg, meta));

    this.costTracker = {
      record: (model, inTok, outTok) => this._recordUsage(model, inTok, outTok),
    };

    this.ai = new AIClient(this.config, this.logger, this.costTracker);

    this.connection = new ConnectionManager({
      logger: this.logger,
      heartbeat: this.heartbeat,
      sessionPath: this.sessionPath,
      dataDir: DATA_DIR,
      isOtherBotRunning: () => [...userBots.values()].some(b => b !== this && b.botRunning),
    });

    // ── Wire connection events ──
    this.connection.on('message', (msg) => this._onMessage(msg));
    this.connection.on('message_create', (msg) => this._onMessageCreate(msg));
    this.connection.on('disconnected', (reason) => {
      this.logger.warn('connection', `connection dropped; keeping ${this.queue.stats().pending} queued messages for retry (${reason || 'unknown'})`);
    });
    this.connection.on('ready', () => {});
  }

  // ════════════════════════════════════════════════════════════════════
  // Proxy properties (backward-compat for Express routes)
  // ════════════════════════════════════════════════════════════════════
  get client()     { return this.connection.client; }
  get botRunning() { return this.connection.running; }
  get botReady()   { return this.connection.ready; }
  get lastAIDebug(){ return this.ai.lastDebug; }

  get appState() {
    const cs = this.connection.getState();
    return {
      status: cs.status,
      qrString: cs.qrString,
      qrVersion: cs.qrVersion,
      phone: cs.phone,
      error: cs.error,
      activeChats: this.conversations.size,
      queue: this.queue.stats(),
      logs: this.logger.all(),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Config
  // ════════════════════════════════════════════════════════════════════
  _loadConfig() {
    try { if (fs.existsSync(this.configPath)) return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (_) {}
    return { ...DEFAULT_CONFIG };
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    this.ai.updateConfig(this.config);
  }

  // ════════════════════════════════════════════════════════════════════
  // Logging (backward-compat shortcut)
  // ════════════════════════════════════════════════════════════════════
  log(msg) { this.logger.log(msg); }

  // ════════════════════════════════════════════════════════════════════
  // Costs
  // ════════════════════════════════════════════════════════════════════
  _loadCosts() { try { if (fs.existsSync(this.costsPath)) this.costsData = JSON.parse(fs.readFileSync(this.costsPath, 'utf8')); } catch (_) {} }
  _saveCosts() { try { fs.writeFileSync(this.costsPath, JSON.stringify(this.costsData), 'utf8'); } catch (_) {} }

  _recordUsage(model, inputTokens, outputTokens) {
    const { MODEL_PRICES } = require('./lib/constants');
    const price = MODEL_PRICES[model] || { in: 0.50, out: 1.50 };
    const cost = (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
    this.costsData.totalCalls++;
    this.costsData.totalInputTokens  += inputTokens;
    this.costsData.totalOutputTokens += outputTokens;
    this.costsData.totalCostUSD = (this.costsData.totalCostUSD || 0) + cost;
    if (!this.costsData.byModel[model]) this.costsData.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    this.costsData.byModel[model].calls++;
    this.costsData.byModel[model].inputTokens  += inputTokens;
    this.costsData.byModel[model].outputTokens += outputTokens;
    this.costsData.byModel[model].costUSD = (this.costsData.byModel[model].costUSD || 0) + cost;
    this._saveCosts();
  }

  // ════════════════════════════════════════════════════════════════════
  // Conversations
  // ════════════════════════════════════════════════════════════════════
  _loadConversations() {
    try {
      if (!fs.existsSync(this.convPath)) return;
      const data = JSON.parse(fs.readFileSync(this.convPath, 'utf8'));
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        if (v.lastAt > cutoff && Array.isArray(v.msgs) && v.msgs.length > 0) { this.conversations.set(k, v.msgs); count++; }
      }
      if (count > 0) this.logger?.info('system', `📚 تم تحميل ${count} محادثة`);
    } catch (e) {
      const message = 'تعذر تحميل المحادثات: ' + e.message;
      if (this.logger) this.logger.warn('system', message);
      else console.warn(message);
    }
  }

  saveConversations() {
    try {
      const obj = {};
      for (const [k, v] of this.conversations) obj[k] = { msgs: v, lastAt: Date.now() };
      fs.writeFileSync(this.convPath, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════════
  // Owner Pause
  // ════════════════════════════════════════════════════════════════════
  pauseChat(sender, reason = 'owner_replied') {
    this.ownerPausedChats.set(sender, { pausedAt: Date.now(), reason });
    this.logger.info('message', `⏸ ${sender.replace('@c.us', '').replace('@lid', '')} — البوت موقوف (رد المالك)`);
  }

  isChatPaused(sender) {
    const p = this.ownerPausedChats.get(sender);
    if (!p) return false;
    if (Date.now() - p.pausedAt > OWNER_PAUSE_MS) { this.ownerPausedChats.delete(sender); return false; }
    return true;
  }

  // ════════════════════════════════════════════════════════════════════
  // Reply Delay & Human-Like Reply
  // ════════════════════════════════════════════════════════════════════
  _randomDelay() {
    const preset = this.config.replyDelayPreset || '1min';
    if (this.config.replyDelayMin != null && this.config.replyDelayMax != null && !this.config.replyDelayPreset) {
      const min = Math.max(0, parseInt(this.config.replyDelayMin));
      const max = Math.max(min, parseInt(this.config.replyDelayMax));
      return Math.floor(Math.random() * (max - min + 1) + min);
    }
    const [min, max] = DELAY_PRESETS[preset] || DELAY_PRESETS['30s'];
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  async _humanLikeReply(msg, text) {
    const delaySec = this._randomDelay();
    this.logger.info('message', `⏳ سيرد بعد ${delaySec} ثانية...`);

    try {
      const chat = await Promise.race([
        msg.getChat(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getChat timeout')), 5000)),
      ]);
      if (delaySec > 0) await chat.sendStateTyping().catch(() => {});
      if (delaySec > 0) await sleep(delaySec * 1000);
      await chat.clearState().catch(() => {});
    } catch (_) {
      if (delaySec > 0) await sleep(delaySec * 1000);
    }

    if (!this.client || !this.botRunning) throw new Error('العميل غير متصل بعد التأخير');

    this.botReplyingTo.add(msg.from);
    try {
      if (!this.client || !this.botRunning) throw new Error('العميل غير متصل');
      await Promise.race([
        this.client.sendMessage(msg.from, text),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
      ]);
      this.logger.info('message', `✅ أُرسلت إلى ${msg.from.replace('@c.us', '').replace('@lid', '')}`);
    } finally {
      setTimeout(() => this.botReplyingTo.delete(msg.from), 5000);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Keywords
  // ════════════════════════════════════════════════════════════════════
  _checkKeywords(text) {
    const lower = text.toLowerCase();
    for (const [kw, reply] of Object.entries(this.config.autoReplyKeywords || {}))
      if (lower.includes(kw.toLowerCase())) return reply;
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  // Escalation: Forward to Contact
  // ════════════════════════════════════════════════════════════════════
  async _forwardToContact(contactName, summary, customerPhone, recentHistory = []) {
    const contacts = this.config.escalationContacts || [];
    const contact = contacts.find(c => c.name.trim() === contactName.trim());
    if (!contact || !contact.phone) {
      this.logger.warn('escalation', 'جهة التحويل غير موجودة: ' + contactName);
      return false;
    }

    const cleanPhone = contact.phone.replace(/\+/g, '').replace(/[\s\-()]/g, '');
    const targetId = cleanPhone + '@c.us';
    const customerNum = customerPhone.replace('@c.us', '').replace('@lid', '');

    let forwardMsg = `📨 *تحويل من عميل*\n\n`;
    forwardMsg += `👤 رقم العميل: wa.me/${customerNum}\n`;
    if (contact.role) forwardMsg += `📋 القسم: ${contact.role}\n`;
    forwardMsg += `💬 الملخص: ${summary}\n`;
    if (recentHistory.length > 0) {
      forwardMsg += `\n📜 آخر الرسائل:\n`;
      for (const m of recentHistory.slice(-6)) {
        const label = m.role === 'user' ? '👤 العميل' : '🤖 البوت';
        forwardMsg += `${label}: ${m.content.substring(0, 120)}\n`;
      }
    }

    try {
      await this.client.sendMessage(targetId, forwardMsg);
      this.logger.info('escalation', `📨 تحويل ${customerNum} → ${contact.name} (${cleanPhone})`);
      return true;
    } catch (e) {
      this.logger.error('escalation', `فشل التحويل إلى ${contact.name}: ${e.message}`);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Message Events → Queue
  // ════════════════════════════════════════════════════════════════════
  _onMessage(msg) {
    if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.includes('@g.us')) return;
    const text = msg.body?.trim();
    if (!text) return;

    // Auto-fix stale status
    if (this.connection.status !== 'connected' && this.client?.info?.wid?.user) {
      this.connection.status = 'connected';
      this.connection.ready = true;
      this.connection.phone = this.client.info.wid.user;
      this.logger.info('connection', '✅ تم التأكد: البوت متصل ويستقبل الرسائل');
    }

    const sender = msg.from;
    if (this.isChatPaused(sender)) {
      this.logger.info('message', `⏸ ${sender.replace('@c.us', '').replace('@lid', '')} — المالك يرد`);
      return;
    }

    this.logger.info('message', '📨 ' + sender.replace('@c.us', '').replace('@lid', '') + ': ' + text.substring(0, 60));

    // ██ Enqueue — instant, non-blocking ██
    this.queue.enqueue(sender, msg, { text });
  }

  _onMessageCreate(msg) {
    if (msg.fromMe && !msg.to?.includes('@g.us') && msg.to !== 'status@broadcast') {
      if (!this.botReplyingTo.has(msg.to)) {
        this.pauseChat(msg.to, 'owner_replied');
      }
    }
  }

  _isTransientWhatsAppError(err) {
    const msg = String(err?.message || err || '');
    return /غير متصل|sendMessage timeout|getChat timeout|Protocol|Execution context|Target closed|Session closed|Navigation|timeout|disconnected|not connected/i.test(msg);
  }

  _canRetryMessage() {
    return this.connection.status !== 'stopped';
  }

  // ════════════════════════════════════════════════════════════════════
  // Message Processing (runs in background via queue)
  // ════════════════════════════════════════════════════════════════════
  async _processMessage(sender, msg, meta) {
    const text = meta.text || msg.body?.trim();
    if (!text) return;

    try {
      // ── Keywords ──
      const kw = this._checkKeywords(text);
      if (kw) {
        if (!this.conversations.has(sender)) this.conversations.set(sender, []);
        await this._humanLikeReply(msg, kw);
        const h = this.conversations.get(sender);
        h.push({ role: 'user', content: text });
        h.push({ role: 'assistant', content: kw });
        this.lastReplyByChat.set(sender, kw);
        this.saveConversations();
        return;
      }

      // ── First message + welcome ──
      const isFirstMsg = !this.conversations.has(sender);
      if (isFirstMsg) {
        this.conversations.set(sender, []);
        const welcomeMode = this.config.welcomeMode || 'inline';
        if (welcomeMode === 'separate' && this.config.welcomeMessage?.trim()) {
          await this._humanLikeReply(msg, this.config.welcomeMessage);
          this.conversations.get(sender).push({ role: 'assistant', content: this.config.welcomeMessage });
          await sleep(500);
        }
      }

      // ── Build history ──
      const history = this.conversations.get(sender);
      const memSize = Math.max(2, parseInt(this.config.memoryMessages) || 50);
      const workingHistory = [...history, { role: 'user', content: text }];
      if (workingHistory.length > memSize) workingHistory.splice(0, workingHistory.length - memSize);

      // ── AI Reply ──
      let reply = (await this.ai.getReply(workingHistory, { isFirstMsg }) || '').trim();

      if (!reply) {
        this.logger.warn('ai', 'الـ AI رد بنص فارغ — لن يُرسل شيء');
        return;
      }

      // ── Escalation tag ──
      const forwardMatch = reply.match(/\[تحويل:([^|\]]+)\|([^\]]+)\]/);
      if (forwardMatch) {
        const [fullTag, contactName, summary] = forwardMatch;
        reply = reply.replace(fullTag, '').trim();
        this._forwardToContact(contactName.trim(), summary.trim(), sender, workingHistory).catch(() => {});
      }

      // ── Anti-repetition ──
      const lastReply = this.lastReplyByChat.get(sender);
      if (lastReply && lastReply === reply) {
        this.logger.warn('ai', 'الـ AI أعاد نفس الرد — تجاهل');
        return;
      }

      // ── Send ──
      await this._humanLikeReply(msg, reply);
      workingHistory.push({ role: 'assistant', content: reply });
      this.conversations.set(sender, workingHistory);
      this.lastReplyByChat.set(sender, reply);
      this.totalChatsHandled++;
      this.saveConversations();
      this.logger.info('message', `💬 الذاكرة: ${workingHistory.length}/${memSize} رسالة`);
      this.logger.info('message', '✅ رد: ' + reply.substring(0, 70));
    } catch (err) {
      this.logger.error('message', 'خطأ في الرد على ' + sender.replace('@c.us', '').replace('@lid', '') + ': ' + err.message);
      if (this._canRetryMessage() && this._isTransientWhatsAppError(err)) {
        const scheduled = this.queue.retryLater(sender, msg, meta, err.message);
        if (scheduled) return;
      }
      const fallback = this.config.errorMessage?.trim();
      if (fallback) {
        try { await this._humanLikeReply(msg, fallback); } catch (_) {}
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Bot Control (delegates to ConnectionManager)
  // ════════════════════════════════════════════════════════════════════
  startBot(retryCount = 0) {
    if (this.botRunning) {
      this.logger.info('boot', `start requested while ${this.connection.status}; keeping existing session`);
      return false;
    }
    this.ownerPausedChats.clear();
    this.botReplyingTo.clear();
    this.queue.clear();
    this.connection.start(retryCount);
    return true;
  }

  async stopBot() {
    this.queue.clear();
    await this.connection.stop();
  }

  async clearSession() {
    this.queue.clear();
    await this.connection.clearSession();
  }

  // Backward-compat getters
  // (some test routes access these directly)
  checkKeywords(text) { return this._checkKeywords(text); }

  // buildAIClient / buildSystemPrompt / getAIReply — proxy to AIClient
  buildAIClient()           { return this.ai.buildClient(); }
  buildSystemPrompt(h, o)   { return this.ai.buildSystemPrompt(h, o); }
  async getAIReply(h, o)    { return this.ai.getReply(h, o); }
  recordUsage(m, i, o)      { return this._recordUsage(m, i, o); }

  // randomDelay proxy for test
  randomDelay() { return this._randomDelay(); }
  async humanLikeReply(m, t) { return this._humanLikeReply(m, t); }

  // forwardToContact proxy
  async forwardToContact(name, summary, phone, hist) { return this._forwardToContact(name, summary, phone, hist); }
}

// ─── EMAIL VERIFICATION & PASSWORD RESET ─────────────────────────────
const pendingVerifications = new Map();
const pendingResets        = new Map();

function createMailTransport() {
  if (!nodemailer) return null;
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host, port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', auth: { user, pass },
  });
}

async function sendVerificationEmail(email, name, code) {
  const transport = createMailTransport();
  if (!transport) {
    console.log(`📧 [DEV] رمز التحقق لـ ${email}: ${code} (SMTP غير مضبوط)`);
    return { ok: true, dev: true };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from: `"جواب" <${from}>`, to: email,
      subject: `${code} — رمز التحقق من جواب`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#0a0e1a;color:#e2e8f0;border-radius:16px">
        <h2 style="color:#25d366;margin-bottom:6px">جواب 🤖</h2>
        <p style="color:#94a3b8;margin-bottom:20px">مرحباً ${name}،</p>
        <p style="margin-bottom:16px">رمز التحقق من حسابك:</p>
        <div style="background:#1e293b;border:2px solid #25d366;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
          <span style="font-size:38px;font-weight:900;letter-spacing:10px;color:#25d366;font-family:monospace">${code}</span>
        </div>
        <p style="color:#64748b;font-size:13px">صالح لمدة 10 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.</p>
      </div>`,
    });
    return { ok: true };
  } catch (e) {
    console.error('❌ فشل إرسال البريد:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── BOT REGISTRY ────────────────────────────────────────────────────
const userBots = new Map();
function getUserBot(userId) {
  if (!userBots.has(userId)) userBots.set(userId, new UserBot(userId));
  return userBots.get(userId);
}

// ─── INSTALL GLOBAL ERROR HANDLERS ──────────────────────────────────
errorHandler.install({
  onCleanup: async () => {
    for (const bot of userBots.values()) {
      if (bot.botRunning) {
        try { await Promise.race([bot.stopBot(), new Promise(r => setTimeout(r, 4000))]); } catch (_) {}
      }
    }
  },
});

// ══════════════════════════════════════════════════════════════════════
// ██  EXPRESS APP
// ══════════════════════════════════════════════════════════════════════
const app = express();
app.set('trust proxy', 1);

const SESSION_SECRET = (() => {
  const f = path.join(DATA_DIR, '.session-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) {
    const s = uuidv4() + uuidv4();
    fs.writeFileSync(f, s, 'utf8');
    return s;
  }
})();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const SESSION_TTL_DEFAULT  = 7  * 24 * 60 * 60 * 1000;
const SESSION_TTL_REMEMBER = 30 * 24 * 60 * 60 * 1000;

const sessionConfig = {
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: SESSION_TTL_DEFAULT, httpOnly: true, sameSite: 'strict' },
};
if (FileStore) {
  const sessDir = path.join(DATA_DIR, 'sessions');
  try { fs.mkdirSync(sessDir, { recursive: true }); } catch (_) {}
  sessionConfig.store = new FileStore({ path: sessDir, ttl: SESSION_TTL_REMEMBER / 1000, retries: 1, logFn: () => {} });
}
app.use(session(sessionConfig));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { success: false, message: 'كثير محاولات — انتظر 15 دقيقة' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 60,  message: { success: false, message: 'كثير طلبات — انتظر دقيقة' } });

app.use(bodyParser.json({ limit: '2mb' }));

// ─── PUBLIC ENDPOINTS ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/storage-status', (req, res) => res.json(storageStatus));
app.use('/fonts', express.static(path.join(__dirname, 'dashboard/fonts')));
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard/login.html'));
});

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'غير مصرح', redirect: '/login' });
  res.redirect('/login');
}

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard/index.html')));

// ─── AUTH ROUTES ─────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.json({ success: false, message: 'جميع الحقول مطلوبة' });
    if (password.length < 8) return res.json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    const emailLower = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) return res.json({ success: false, message: 'صيغة الإيميل غير صحيحة' });
    const data = loadUsers();
    if (data.users.find(u => u.email.toLowerCase() === emailLower))
      return res.json({ success: false, message: 'هذا الإيميل مسجّل مسبقاً' });
    const hash = await bcrypt.hash(password, 12);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const pendingUser = { id: uuidv4(), name: name.trim(), email: emailLower, password: hash, createdAt: new Date().toISOString(), role: data.users.length === 0 ? 'admin' : 'user' };
    pendingVerifications.set(emailLower, { code, user: pendingUser, expiresAt: Date.now() + 10 * 60 * 1000 });
    const mailResult = await sendVerificationEmail(emailLower, name.trim(), code);
    if (mailResult.dev) {
      const data2 = loadUsers(); data2.users.push(pendingUser); saveUsers(data2);
      pendingVerifications.delete(emailLower);
      getUserBot(pendingUser.id).saveConfig();
      req.session.userId = pendingUser.id; req.session.userName = pendingUser.name;
      console.log(`👤 حساب جديد (بدون SMTP): ${name} (${emailLower})`);
      return res.json({ success: true, verified: true, name: pendingUser.name, role: pendingUser.role });
    }
    if (!mailResult.ok) return res.json({ success: false, message: 'تعذّر إرسال رمز التحقق: ' + mailResult.error });
    res.json({ success: true, verified: false, email: emailLower, message: 'تم إرسال رمز التحقق إلى إيميلك' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ success: false, message: 'أدخل الإيميل والرمز' });
    const emailLower = email.toLowerCase().trim();
    const pending = pendingVerifications.get(emailLower);
    if (!pending) return res.json({ success: false, message: 'لا يوجد طلب تسجيل — أعد التسجيل' });
    if (Date.now() > pending.expiresAt) { pendingVerifications.delete(emailLower); return res.json({ success: false, message: 'انتهت صلاحية الرمز' }); }
    if (code.trim() !== pending.code) return res.json({ success: false, message: 'الرمز غير صحيح' });
    const data = loadUsers();
    if (data.users.find(u => u.email === emailLower)) { pendingVerifications.delete(emailLower); return res.json({ success: false, message: 'مسجّل مسبقاً' }); }
    data.users.push(pending.user); saveUsers(data);
    pendingVerifications.delete(emailLower);
    getUserBot(pending.user.id).saveConfig();
    req.session.userId = pending.user.id; req.session.userName = pending.user.name;
    res.json({ success: true, name: pending.user.name, role: pending.user.role });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/resend-code', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false, message: 'أدخل الإيميل' });
    const emailLower = email.toLowerCase().trim();
    const pending = pendingVerifications.get(emailLower);
    if (!pending) return res.json({ success: false, message: 'أعد التسجيل' });
    const newCode = String(Math.floor(100000 + Math.random() * 900000));
    pending.code = newCode; pending.expiresAt = Date.now() + 10 * 60 * 1000;
    await sendVerificationEmail(emailLower, pending.user.name, newCode);
    res.json({ success: true, message: 'تم إرسال رمز جديد' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'أدخل الإيميل وكلمة المرور' });
    const user = findUser(email);
    if (!user) return res.json({ success: false, message: 'الإيميل أو كلمة المرور غير صحيحة' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.json({ success: false, message: 'الإيميل أو كلمة المرور غير صحيحة' });
    req.session.userId = user.id; req.session.userName = user.name;
    if (rememberMe) req.session.cookie.maxAge = SESSION_TTL_REMEMBER;
    getUserBot(user.id).log(`🔓 دخول: ${user.name}`);
    res.json({ success: true, name: user.name, role: user.role });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  const user = loadUsers().users.find(u => u.id === req.session.userId);
  res.json({ loggedIn: true, name: req.session.userName, email: user?.email || '', role: user?.role || 'user' });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false, message: 'أدخل الإيميل' });
    const user = findUser(email);
    if (!user) return res.json({ success: false, message: 'هذا الإيميل غير مسجل لدينا' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pendingResets.set(email.toLowerCase().trim(), { code, expiresAt: Date.now() + 10 * 60 * 1000 });
    const result = await sendVerificationEmail(email, user.name, code);
    if (result.dev) console.log(`🔑 [DEV] رمز إعادة التعيين لـ ${email}: ${code}`);
    res.json({ success: true, dev: !!result.dev, devCode: result.dev ? code : undefined });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.json({ success: false, message: 'جميع الحقول مطلوبة' });
    if (newPassword.length < 8) return res.json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    const emailLower = email.toLowerCase().trim();
    const pending = pendingResets.get(emailLower);
    if (!pending || pending.code !== String(code).trim() || Date.now() > pending.expiresAt)
      return res.json({ success: false, message: 'الرمز غير صحيح أو انتهت صلاحيته' });
    const data = loadUsers();
    const idx = data.users.findIndex(u => u.email.toLowerCase() === emailLower);
    if (idx === -1) return res.json({ success: false, message: 'المستخدم غير موجود' });
    data.users[idx].password = await bcrypt.hash(newPassword, 12);
    saveUsers(data); pendingResets.delete(emailLower);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Rate limit + auth on all other API routes
app.use('/api', apiLimiter, requireAuth);

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.json({ success: false, message: 'جميع الحقول مطلوبة' });
    if (newPassword.length < 8) return res.json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    const data = loadUsers();
    const idx = data.users.findIndex(u => u.id === req.session.userId);
    if (idx === -1) return res.json({ success: false, message: 'المستخدم غير موجود' });
    const ok = await bcrypt.compare(currentPassword, data.users[idx].password);
    if (!ok) return res.json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    data.users[idx].password = await bcrypt.hash(newPassword, 12);
    saveUsers(data);
    getUserBot(req.session.userId).log('🔑 تم تغيير كلمة المرور');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── BOT STATUS ROUTES ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const bot = getUserBot(req.session.userId);
  const state = bot.appState;
  const { qrString, ...rest } = state;
  const logCount = rest.status === 'error' ? 20 : 8;
  res.json({ ...rest, totalChatsHandled: bot.totalChatsHandled, logs: state.logs.slice(0, logCount) });
});

app.get('/api/debug-last', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json(bot.lastAIDebug || { message: 'لا يوجد استدعاء AI بعد' });
});

app.get('/api/qr-image', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  if (!bot.appState.qrString) return res.status(404).end();
  try {
    const buf = await QRCode.toBuffer(bot.appState.qrString, { width: 512, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'H' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=25');
    res.send(buf);
  } catch (e) { res.status(500).end(); }
});

app.get('/api/qr', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json({ qr: bot.appState.qrString || null });
});

// ─── CONFIG ROUTES ───────────────────────────────────────────────────
app.get('/api/config', (req, res) => { res.json(getUserBot(req.session.userId).config); });

app.post('/api/config', (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const incoming = req.body || {};
    const merged = { ...bot.config, ...incoming };
    if (!incoming.openaiApiKey?.trim() && bot.config.openaiApiKey?.trim()) merged.openaiApiKey = bot.config.openaiApiKey;
    if (!incoming.openrouterApiKey?.trim() && bot.config.openrouterApiKey?.trim()) merged.openrouterApiKey = bot.config.openrouterApiKey;
    if (!incoming.googleApiKey?.trim() && bot.config.googleApiKey?.trim()) merged.googleApiKey = bot.config.googleApiKey;
    if (!incoming.anthropicApiKey?.trim() && bot.config.anthropicApiKey?.trim()) merged.anthropicApiKey = bot.config.anthropicApiKey;
    bot.config = merged;
    bot.saveConfig();
    bot.log('✅ إعدادات محفوظة');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'فشل الحفظ: ' + e.message }); }
});

// ─── BOT CONTROL ─────────────────────────────────────────────────────
app.post('/api/clear', (req, res) => {
  const bot = getUserBot(req.session.userId);
  bot.conversations.clear();
  bot.saveConversations();
  res.json({ success: true });
});

app.post('/api/bot/start', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const started = bot.startBot();
  res.json({ success: true, started, status: bot.appState.status });
});

app.post('/api/bot/stop', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  try {
    await Promise.race([
      bot.stopBot(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('stop timeout')), 8000)),
    ]);
    res.json({ success: true, status: bot.appState.status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, status: bot.appState.status });
  }
});

app.post('/api/bot/clear-session', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  try {
    await bot.clearSession();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── SEND DIRECT MESSAGE ────────────────────────────────────────────
app.post('/api/send-message', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const { phone, message } = req.body;
  if (!phone || !message?.trim()) return res.status(400).json({ success: false, message: 'الرقم والرسالة مطلوبان' });
  if (!bot.botRunning || !bot.client || bot.appState.status !== 'connected')
    return res.json({ success: false, message: 'البوت غير متصل' });
  try {
    const cleanPhone = phone.replace(/\+/g, '').replace(/[\s\-()]/g, '');
    await Promise.race([
      bot.client.sendMessage(cleanPhone + '@c.us', message.trim()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sendMessage timeout (30s)')), TIMERS.SEND_MESSAGE_TIMEOUT_MS)),
    ]);
    bot.log(`📤 رسالة مباشرة إلى ${cleanPhone}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── TOKEN TEST ──────────────────────────────────────────────────────
app.post('/api/test-token', async (req, res) => {
  const { type, token, managerToken } = req.body;
  if (!token || token.length < 10) return res.json({ success: false, message: 'التوكن قصير جداً' });
  try {
    if (type === 'salla') {
      const sallaHeaders = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/json' };
      const endpoints = ['https://api.salla.dev/admin/v2/store/info','https://api.salla.dev/admin/v2/products?per_page=1','https://api.salla.dev/admin/v2/categories?per_page=1'];
      let lastStatus = 0, storeName = '';
      for (const ep of endpoints) {
        try {
          const { body, status } = await fetchURL(ep, sallaHeaders);
          lastStatus = status;
          if (status === 200) {
            try { storeName = JSON.parse(body)?.data?.name || ''; } catch (_) {}
            return res.json({ success: true, message: 'توكن سلة صحيح ✓', storeName });
          }
        } catch (_) {}
      }
      let hint = '';
      if (lastStatus === 401) hint = '\nتأكد من التوكن من لوحة سلة → المطورون → Personal Access Tokens';
      if (lastStatus === 403) hint = '\nالتوكن لا يملك صلاحية كافية';
      return res.json({ success: false, message: `فشل التحقق (HTTP ${lastStatus})${hint}` });
    }
    if (type === 'zid') {
      const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
      if (managerToken) headers['X-Manager-Token'] = managerToken;
      const { status } = await fetchURL('https://api.zid.sa/v1/managers/account/profile', headers);
      if (status === 200) return res.json({ success: true, message: 'توكن زد صحيح ✓' });
      return res.json({ success: false, message: 'توكن زد غير صحيح (HTTP ' + status + ')' });
    }
    res.status(400).json({ success: false, message: 'نوع غير معروف' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────
app.post('/api/health-check', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const checks = [];
  const add = (name, ok, msg, hint) => checks.push({ name, ok, msg, hint });

  add('اسم المتجر', !!bot.config.storeName, bot.config.storeName || 'غير محدد', 'أضف اسم متجرك');
  add('رسالة الترحيب', !!(bot.config.welcomeMessage?.trim()), bot.config.welcomeMessage ? '"' + bot.config.welcomeMessage.substring(0, 40) + '..."' : 'فارغة', 'أضف رسالة ترحيب');

  const model = bot.config.model || 'google/gemini-2.0-flash';
  let keyName, apiKey;
  if (model.startsWith('google/') || model.startsWith('gemini')) {
    const direct = bot.config.googleApiKey?.trim();
    if (direct?.length > 10) { keyName = 'Google AI'; apiKey = direct; }
    else { keyName = 'OpenRouter (Gemini)'; apiKey = bot.config.openrouterApiKey; }
  } else if (model.startsWith('anthropic/') || model.startsWith('claude')) {
    const direct = bot.config.anthropicApiKey?.trim();
    if (direct?.length > 10) { keyName = 'Anthropic'; apiKey = direct; }
    else { keyName = 'OpenRouter (Claude)'; apiKey = bot.config.openrouterApiKey; }
  } else if (!model.includes('/') || model.startsWith('openai/')) {
    const direct = bot.config.openaiApiKey?.trim();
    if (direct?.length > 20) { keyName = 'OpenAI'; apiKey = direct; }
    else { keyName = 'OpenRouter (GPT)'; apiKey = bot.config.openrouterApiKey; }
  } else {
    keyName = 'OpenRouter'; apiKey = bot.config.openrouterApiKey;
  }
  add('مفتاح ' + keyName, !!(apiKey && apiKey.length > 10), apiKey ? 'موجود (' + apiKey.substring(0, 8) + '...)' : 'غير موجود', 'أضف المفتاح');

  if (apiKey && apiKey.length > 10) {
    try {
      const { openai, model: usedModel } = bot.buildAIClient();
      const t0 = Date.now();
      const test = await openai.chat.completions.create({ model: usedModel, max_tokens: 8, messages: [{ role: 'user', content: 'قل: مرحبا' }] });
      const ms = Date.now() - t0;
      const ok = !!test.choices?.[0]?.message?.content;
      add('النموذج: ' + model, ok, ok ? 'يعمل (' + ms + 'ms)' : 'لم يرد', '');
    } catch (e) { add('النموذج: ' + model, false, e.message.substring(0, 80), 'تأكد من المفتاح'); }
  } else { add('النموذج: ' + model, false, 'لا يمكن الفحص', ''); }

  let waOk = false, waMsg = '', waHint = '';
  if (bot.appState.status === 'stopped') { waMsg = 'متوقف'; waHint = 'اضغط تشغيل'; }
  else if (bot.appState.status === 'qr_ready') { waMsg = 'في انتظار الباركود'; }
  else if (bot.appState.status === 'connected' && bot.client) {
    try {
      const state = await bot.client.getState().catch(() => null);
      const info = bot.client.info;
      if (state === 'CONNECTED' && info?.wid?.user) { waOk = true; waMsg = `✅ متصل (+${info.wid.user}) — ${state}`; }
      else if (state) { waMsg = `⚠️ حالة: ${state}`; waHint = 'أعد التشغيل'; }
      else { waMsg = 'متصل (لم يتحقق)'; waOk = true; }
    } catch (e) { waMsg = `خطأ: ${e.message.substring(0, 60)}`; waHint = 'أعد التشغيل'; }
  } else { waMsg = bot.appState.status || 'غير معروف'; }
  add('الواتس أب', waOk, waMsg, waHint);

  add('تعليمات البوت', !!(bot.config.botInstructions?.trim()), bot.config.botInstructions ? bot.config.botInstructions.length + ' حرف' : 'فارغة', '');
  const prodCount = bot.config.products?.length || 0;
  add('المنتجات', prodCount > 0, prodCount + ' منتج', prodCount === 0 ? 'أضف منتجات' : '');
  const delayOk = ['30s','1min','1.5min'].includes(bot.config.replyDelayPreset);
  add('تأخير الرد', delayOk, bot.config.replyDelayPreset || 'غير محدد', !delayOk ? 'اختر تأخير مناسب' : '');

  res.json({ success: true, checks });
});

// ─── TEST CHAT ───────────────────────────────────────────────────────
app.post('/api/test-chat', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { message, sessionId, reset } = req.body;
    const sid = sessionId || 'default';
    if (reset) { bot.testConversations.delete(sid); return res.json({ success: true, reset: true }); }
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'رسالة فارغة' });

    const isFirst = !bot.testConversations.has(sid);
    if (isFirst) bot.testConversations.set(sid, []);
    const hist = bot.testConversations.get(sid);

    const kw = bot.checkKeywords(message);
    if (kw) {
      hist.push({ role: 'user', content: message });
      hist.push({ role: 'assistant', content: kw });
      return res.json({ success: true, reply: kw, source: 'keyword', historyLength: hist.length });
    }

    const welcomeMode = bot.config.welcomeMode || 'inline';
    let welcomeShown = false;
    if (isFirst && welcomeMode === 'separate' && bot.config.welcomeMessage?.trim()) {
      hist.push({ role: 'assistant', content: bot.config.welcomeMessage });
      welcomeShown = true;
    }

    hist.push({ role: 'user', content: message });
    const memSize = Math.max(2, parseInt(bot.config.memoryMessages) || 50);
    if (hist.length > memSize) hist.splice(0, hist.length - memSize);

    const reply = await bot.getAIReply(hist, { isFirstMsg: isFirst, maxRetries: 0 });
    hist.push({ role: 'assistant', content: reply });
    res.json({ success: true, reply, source: 'ai', historyLength: hist.length, welcomeShown });
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota'))
      return res.status(200).json({ success: false, message: '⏳ وصلت لحد الطلبات — انتظر دقيقة' });
    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized'))
      return res.status(200).json({ success: false, message: '🔑 المفتاح غير صحيح' });
    if (msg.includes('مفتاح API') || msg.includes('أضف مفتاح'))
      return res.status(200).json({ success: false, message: '🔑 ' + msg });
    if (msg.includes('403'))
      return res.status(200).json({ success: false, message: '🚫 الوصول مرفوض' });
    res.status(200).json({ success: false, message: msg });
  }
});

// ─── LEARN STYLE ─────────────────────────────────────────────────────
app.post('/api/learn-style', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const allReplies = [];
    for (const [, msgs] of bot.conversations) {
      for (const m of msgs) if (m.role === 'assistant' && m.content?.trim().length > 8) allReplies.push(m.content.trim());
    }
    if (allReplies.length < 5) {
      try {
        const data = JSON.parse(fs.readFileSync(bot.convPath, 'utf8'));
        for (const v of Object.values(data)) if (Array.isArray(v.msgs)) for (const m of v.msgs) if (m.role === 'assistant' && m.content?.trim().length > 8) allReplies.push(m.content.trim());
      } catch (_) {}
    }
    if (allReplies.length < 5) return res.json({ success: false, message: `محادثات غير كافية (${allReplies.length} رد)` });

    const sample = allReplies.slice(-80);
    bot.log(`🎓 تحليل الأسلوب من ${sample.length} رد...`);
    const { openai, model } = bot.buildAIClient();
    const result = await openai.chat.completions.create({
      model, max_tokens: 1400, temperature: 0.3,
      messages: [
        { role: 'system', content: 'أنت خبير في تحليل أسلوب الكتابة. حلل هذه الردود واستخرج تعليمات دقيقة للبوت ليكتب بنفس الأسلوب. اشمل: طريقة الترحيب، العبارات المتكررة، طول الردود، الإيموجي، النبرة واللهجة.' },
        { role: 'user', content: `${sample.length} رد. حلل:\n\n${sample.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')}` }
      ]
    });
    const instructions = result.choices[0]?.message?.content?.trim();
    if (!instructions) return res.json({ success: false, message: 'فشل التحليل' });
    bot.log(`✅ تم تحليل الأسلوب`);
    res.json({ success: true, instructions, sampledCount: sample.length });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ENHANCE TEXT ────────────────────────────────────────────────────
app.post('/api/enhance-text', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { text, type, storeName } = req.body;
    if (!text || text.trim().length < 3) return res.status(400).json({ success: false, message: 'النص قصير' });
    const { openai, model } = bot.buildAIClient();
    const prompts = {
      welcome: `حسّن رسالة الترحيب لمتجر "${storeName || 'المتجر'}". لا AI لا بوت. لغة عامية سعودية خفيفة. قصيرة ومباشرة. أعد الرسالة المحسّنة فقط:`,
      instructions: `حوّل التعليمات إلى System Prompt احترافي. ابدأ بـ "أنت موظف خدمة عملاء..." مع أقسام واضحة وأمثلة. أعد الناتج فقط:`,
      reply: `حسّن الرد ليبدو طبيعياً كإنسان على واتساب. أزل Markdown. عامية طبيعية. أعد المحسّن فقط:`,
      general: `حسّن النص ليبدو طبيعياً وبشرياً. بدون Markdown. أعد المحسّن فقط:`,
    };
    const result = await openai.chat.completions.create({
      model, max_tokens: 600, temperature: 0.8,
      messages: [{ role: 'system', content: prompts[type] || prompts.general }, { role: 'user', content: text }],
    });
    const enhanced = result.choices[0].message.content.trim().replace(/^["'`]|["'`]$/g, '');
    res.json({ success: true, text: enhanced });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── SCAN STORE ──────────────────────────────────────────────────────
app.post('/api/scan-store', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const { url, sallaToken, zidToken, zidManagerToken } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ success: false, message: 'رابط غير صحيح' });
  if (isPrivateUrl(url)) return res.status(400).json({ success: false, message: 'رابط غير مسموح' });
  try {
    const result = await storeScanner.scanStore(url, { sallaToken, zidToken, zidManagerToken, logger: bot.logger });
    res.json({ success: true, ...result });
  } catch (e) {
    bot.log('❌ فشل فحص المتجر: ' + e.message);
    res.status(500).json({ success: false, message: 'تعذر الوصول: ' + e.message });
  }
});

// ─── PAUSED CHATS ────────────────────────────────────────────────────
app.get('/api/paused-chats', (req, res) => {
  const bot = getUserBot(req.session.userId);
  const list = [];
  for (const [sender, data] of bot.ownerPausedChats) {
    if (Date.now() - data.pausedAt < OWNER_PAUSE_MS) {
      list.push({ sender: sender.replace('@c.us', '').replace('@lid', ''), pausedAt: data.pausedAt, remainingMin: Math.round((OWNER_PAUSE_MS - (Date.now() - data.pausedAt)) / 60000) });
    }
  }
  res.json({ success: true, paused: list });
});

app.post('/api/paused-chats/resume', (req, res) => {
  const bot = getUserBot(req.session.userId);
  const { sender } = req.body;
  if (sender) { bot.ownerPausedChats.delete(sender + '@c.us'); bot.ownerPausedChats.delete(sender + '@lid'); bot.ownerPausedChats.delete(sender); }
  else { bot.ownerPausedChats.clear(); }
  res.json({ success: true });
});

// ─── COSTS ───────────────────────────────────────────────────────────
app.get('/api/costs', (req, res) => { res.json(getUserBot(req.session.userId).costsData); });

app.post('/api/costs/reset', (req, res) => {
  const bot = getUserBot(req.session.userId);
  bot.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {}, resetAt: new Date().toISOString() };
  bot._saveCosts();
  res.json({ success: true });
});

// ─── TRAIN ANALYZE ───────────────────────────────────────────────────
app.post('/api/train-analyze', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { answers } = req.body;
    if (!answers || answers.length < 10) return res.status(400).json({ success: false, message: 'يجب الإجابة على 10 أسئلة على الأقل' });
    const { openai, model } = bot.buildAIClient();
    const qa = answers.map((a, i) => `س${i + 1}: ${a.q}\nج${i + 1}: ${a.a}`).join('\n\n');
    const result = await openai.chat.completions.create({
      model, max_tokens: 1600, temperature: 0.3,
      messages: [
        { role: 'system', content: 'أنت خبير في كتابة تعليمات بوتات واتساب. بناءً على إجابات صاحب المتجر، اكتب تعليمات شاملة. ابدأ بـ "أنت موظف خدمة عملاء في متجر...". نظّم في أقسام.' },
        { role: 'user', content: `إجابات صاحب المتجر:\n\n${qa}` }
      ]
    });
    const instructions = result.choices[0]?.message?.content?.trim();
    if (result.usage) bot.recordUsage(model, result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0);
    if (!instructions) return res.json({ success: false, message: 'فشل التحليل' });
    bot.log(`✅ دربني: تم إنشاء البرومنت من ${answers.length} إجابة`);
    res.json({ success: true, instructions });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// ██  SERVER START
// ══════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🌐 جواب — لوحة التحكم: http://localhost:' + PORT));
console.log('🚀 جواب جاهز — اضغط "تشغيل البوت" للبدء');

// ─── AUTO-FIX CONNECTING STATUS ──────────────────────────────────────
setInterval(async () => {
  for (const bot of userBots.values()) {
    if (!bot.botRunning || !bot.client) continue;
    try {
      const state = await Promise.race([
        bot.client.getState(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
      ]).catch(() => null);

      if (state === 'CONNECTED') {
        if (bot.connection.status !== 'connected') bot.log('✅ تصحيح getState → متصل');
        bot.connection.status = 'connected';
        bot.connection.phone = bot.client.info?.wid?.user || bot.connection.phone;
        bot.connection.ready = true;
        bot.connection.error = null;
        continue;
      }

      if (bot.connection.status === 'connected' && state && state !== 'CONNECTED') {
        bot.connection.ready = false;
        bot.connection.status = 'connecting';
        bot.connection.error = 'WhatsApp state mismatch: ' + (state || 'unknown');
        bot.log('⚠️ الحالة كانت متصل لكن WhatsApp ليس CONNECTED — إعادة تهيئة');
        if (typeof bot.connection._scheduleRetry === 'function') {
          bot.connection._scheduleRetry(0, 'auto-fix state mismatch: ' + (state || 'unknown'));
        }
      }
    } catch (_) {
      // ConnectionManager heartbeat owns recovery; this interval only corrects stale UI state.
    }
  }
}, TIMERS.AUTO_FIX_INTERVAL_MS);
