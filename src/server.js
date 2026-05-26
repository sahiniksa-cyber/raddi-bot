'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const db = require('./db/client');
const redis = require('./queues/redis');
const { migrate } = require('./db/migrations/init');
const { PostgresSessionStore } = require('./db/session-store');
const { createAuthRoutes } = require('./routes/auth.routes');
const { createAdminRoutes } = require('./routes/admin.routes');
const { createBillingRoutes } = require('./routes/billing.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createHealthRoutes } = require('./routes/health.routes');
const { createQueueRoutes } = require('./routes/queue.routes');
const { RuntimeBot, cleanupRuntimeStorage } = require('./services/bot/runtime-bot');
const { createBillingAccessGate, createBillingApiGate } = require('./middleware/billing-access');
const { getBillingSettings } = require('./services/billing/billing-settings');
const { organizeProductsForConfig } = require('./services/products/product-import');
const { findAutoReply } = require('./services/bot/platform-features');
const { createOutgoingWhatsappWorker } = require('./workers/outgoing-whatsapp-worker');
const { recoverQueuedAiReplyJobs } = require('./workers/ai-recovery');
const { getQueues } = require('./queues/message-queue');
const { HealthMonitor, setActiveMonitor } = require('./services/monitoring/health-monitor');
const { createAlertDispatcher } = require('./services/monitoring/alerts');
const { createMailer } = require('./services/notify/mailer');
const storeScanner = require('../lib/store-scanner');

function resolveDataDir() {
  const configured = (process.env.DATA_DIR || '').trim();
  const railwayVolume = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  if (railwayVolume && (!configured || configured === './' || configured === '.')) return path.resolve(railwayVolume);
  return path.resolve(configured || railwayVolume || process.cwd());
}

const DATA_DIR = resolveDataDir();
const PORT = process.env.PORT || 3000;
const botCache = new Map();
const AI_RECOVERY_INTERVAL_MS = parseInt(process.env.AI_RECOVERY_INTERVAL_MS || '60000', 10);

function ensureDatabaseConfigured() {
  if (!db.isConfigured()) throw new Error('DATABASE_URL is required for src server');
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
  const secret = require('crypto').randomBytes(48).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, secret, 'utf8');
  return secret;
}

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'غير مصرح', redirect: '/login' });
  return res.redirect('/login');
}

function isPrivateUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    return false;
  } catch (_) {
    return true;
  }
}

async function getUserBot(userId) {
  if (!botCache.has(userId)) {
    const bot = new RuntimeBot(userId, { dataDir: DATA_DIR });
    await bot.load();
    botCache.set(userId, bot);
  }
  return botCache.get(userId);
}

let _ownerBotUserId = null;
async function resolveOwnerBot() {
  try {
    if (!_ownerBotUserId) {
      _ownerBotUserId = (process.env.OWNER_ALERT_USER_ID || '').trim() || null;
      if (!_ownerBotUserId && db.isConfigured()) {
        const result = await db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
        _ownerBotUserId = result.rows[0]?.id || null;
      }
    }
    if (!_ownerBotUserId) return null;
    return await getUserBot(_ownerBotUserId);
  } catch (_) {
    return null;
  }
}

function createStartupApp(state = {}) {
  const app = express();
  app.set('trust proxy', 1);

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      ready: !!state.ready,
      phase: state.phase || 'starting',
      migration: state.migration || null,
      migrationError: state.migrationError || null,
      ts: Date.now(),
    });
  });

  app.use((req, res, next) => {
    if (state.app) return state.app(req, res, next);
    return res.status(503).json({
      success: false,
      message: 'الخادم يجهز، حاول بعد لحظات',
      ready: false,
      phase: state.phase || 'starting',
    });
  });

  return app;
}

function createApp() {
  ensureDatabaseConfigured();

  const app = express();
  const billingSettings = getBillingSettings();
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(bodyParser.json({ limit: '2mb' }));

  const sessionConfig = {
    name: 'jwab.sid',
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new PostgresSessionStore(),
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: process.env.COOKIE_SAME_SITE || 'lax',
      secure: process.env.COOKIE_SECURE === 'true'
        ? true
        : process.env.COOKIE_SECURE === 'false'
          ? false
          : process.env.NODE_ENV === 'production',
    },
  };
  app.use(session(sessionConfig));

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { success: false, message: 'كثير طلبات' } });
  app.use('/api', apiLimiter);
  app.use('/fonts', express.static(path.join(process.cwd(), 'dashboard/fonts')));

  const routeDeps = {
    dashboardDir: path.join(process.cwd(), 'dashboard'),
    requireAuth,
    billingSettings,
    storageStatus: {
      path: DATA_DIR,
      persistent: DATA_DIR !== process.cwd(),
      sessionRoot: path.join(DATA_DIR, 'data'),
      usersPath: 'postgresql',
      warning: null,
    },
  };
  app.use(createHealthRoutes(routeDeps));
  app.use(createAuthRoutes(routeDeps));
  app.use(createAdminRoutes(routeDeps));
  app.use(createBillingRoutes(routeDeps));
  app.get('/billing', requireAuth, (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'billing.html')));
  app.get('/', requireAuth, createBillingAccessGate({ settings: billingSettings }), (req, res, next) => next());
  app.use(createDashboardRoutes(routeDeps));
  app.use('/api', createBillingApiGate({ settings: billingSettings }));
  app.use(createQueueRoutes(routeDeps));

  const wrapBotController = require('./controllers/bot.controller').createBotController({ getUserBot: syncBotLookup, database: db });
  const configControllerModule = require('./controllers/config.controller');
  const wrapConfigController = configControllerModule.createConfigController({ getUserBot: syncBotLookup });
  const { mergeConfigForSave } = configControllerModule;
  const wrapConversationsController = require('./controllers/conversations.controller').createConversationsController({ database: db });

  app.get('/api/status', requireAuth, asyncRoute(async (req, res) => wrapBotController.status(req, res)));
  app.get('/api/qr', requireAuth, asyncRoute(async (req, res) => wrapBotController.qr(req, res)));
  app.get('/api/qr-image', requireAuth, asyncRoute(async (req, res) => wrapBotController.qrImage(req, res)));
  app.post('/api/bot/start', requireAuth, asyncRoute(async (req, res) => wrapBotController.start(req, res)));
  app.post('/api/bot/stop', requireAuth, asyncRoute(async (req, res) => wrapBotController.stop(req, res)));
  app.post('/api/bot/restart', requireAuth, asyncRoute(async (req, res) => wrapBotController.restart(req, res)));
  app.post('/api/bot/clear-session', requireAuth, asyncRoute(async (req, res) => wrapBotController.clearSession(req, res)));
  app.post('/api/send-message', requireAuth, asyncRoute(async (req, res) => wrapBotController.sendMessage(req, res)));
  app.get('/api/config', requireAuth, asyncRoute(async (req, res) => wrapConfigController.getConfig(req, res)));
  app.get('/api/conversations', requireAuth, asyncRoute(async (req, res) => wrapConversationsController.list(req, res)));
  app.post('/api/config', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const incoming = req.body || {};
    const isAdmin = req.session?.isAdmin === true;
    const merged = mergeConfigForSave({ existing: bot.config, incoming, isAdmin });
    bot.config = merged;
    await bot.saveConfig();
    res.json({ success: true });
  }));
  app.post('/api/products/import', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const incoming = req.body || {};
    const organized = organizeProductsForConfig(bot.config, incoming.products || []);
    bot.config = {
      ...bot.config,
      products: organized.products,
      storeName: incoming.storeName || bot.config.storeName,
      storeDescription: incoming.storeDescription || incoming.storeDesc || bot.config.storeDescription,
    };
    await bot.saveConfig();
    res.json({ success: true, products: bot.config.products, productCount: bot.config.products.length });
  }));
  app.post('/api/clear', requireAuth, asyncRoute(async (req, res) => {
    await db.query('DELETE FROM conversations WHERE user_id = $1', [req.session.userId]);
    res.json({ success: true });
  }));

  app.get('/api/costs', requireAuth, asyncRoute(async (req, res) => {
    const userId = req.session.userId;
    // Read reset timestamp from bot's in-memory state
    const bot = await getUserBot(userId);
    const resetAt = bot._costsResetAt || null;

    // Query persistent AI usage from DB
    let query = 'SELECT model, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens, SUM(cost_usd)::float AS cost_usd, COUNT(*)::int AS calls FROM ai_usage WHERE user_id = $1';
    const params = [userId];
    if (resetAt) {
      query += ' AND created_at > $2';
      params.push(resetAt);
    }
    query += ' GROUP BY model';
    const result = await db.query(query, params);

    let totalCalls = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCostUSD = 0;
    const byModel = {};
    for (const row of result.rows) {
      totalCalls += row.calls;
      totalInputTokens += row.input_tokens;
      totalOutputTokens += row.output_tokens;
      totalCostUSD += row.cost_usd;
      byModel[row.model] = { calls: row.calls, inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUSD: row.cost_usd };
    }
    res.json({ totalCalls, totalInputTokens, totalOutputTokens, totalCostUSD, byModel, resetAt });
  }));
  app.post('/api/costs/reset', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    bot._costsResetAt = new Date().toISOString();
    res.json({ success: true });
  }));
  app.get('/api/paused-chats', requireAuth, (req, res) => res.json({ success: true, paused: [] }));
  app.post('/api/paused-chats/resume', requireAuth, (req, res) => res.json({ success: true }));
  app.post('/api/test-chat', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const { sessionId, reset } = req.body || {};
    const sid = sessionId || 'default';
    bot.testConversations ||= new Map();
    if (reset) {
      bot.testConversations.delete(sid);
      return res.json({ success: true, reset: true });
    }

    const incomingMessage = String(req.body.message || '').trim();
    if (!incomingMessage) return res.status(400).json({ success: false, message: 'رسالة فارغة' });

    const isFirst = !bot.testConversations.has(sid);
    if (isFirst) bot.testConversations.set(sid, []);
    const history = bot.testConversations.get(sid);

    const instantReply = findAutoReply(bot.config, incomingMessage);
    if (instantReply) {
      history.push({ role: 'user', content: incomingMessage });
      history.push({ role: 'assistant', content: instantReply });
      return res.json({ success: true, reply: instantReply, source: 'keyword', historyLength: history.length });
    }

    const welcomeMode = bot.config.welcomeMode || 'inline';
    let welcomeShown = false;
    if (isFirst && welcomeMode === 'separate' && bot.config.welcomeMessage?.trim()) {
      history.push({ role: 'assistant', content: bot.config.welcomeMessage.trim() });
      welcomeShown = true;
    }

    history.push({ role: 'user', content: incomingMessage });
    const memSize = Math.max(2, parseInt(bot.config.memoryMessages, 10) || 50);
    if (history.length > memSize) history.splice(0, history.length - memSize);

    const aiReply = await bot.getAIReply(history, { maxRetries: 0, isFirstMsg: isFirst, latestUserText: incomingMessage });
    history.push({ role: 'assistant', content: aiReply });
    return res.json({ success: true, reply: aiReply, source: 'ai', historyLength: history.length, welcomeShown });
  }));
  app.post('/api/learn-style', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const result = await db.query(
      `SELECT content
       FROM messages
       WHERE user_id = $1
         AND direction = 'outbound'
         AND role = 'assistant'
         AND length(trim(content)) > 8
       ORDER BY created_at DESC
       LIMIT 80`,
      [req.session.userId],
    );
    const sample = result.rows.map(row => String(row.content || '').trim()).filter(Boolean).reverse();
    if (sample.length < 5) {
      return res.json({ success: false, message: `محادثات غير كافية (${sample.length} رد)` });
    }

    const { openai, model } = await bot.buildAIClient();
    const aiResult = await openai.chat.completions.create({
      model,
      max_tokens: 1400,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'أنت خبير في تحليل أسلوب ردود خدمة العملاء. استخرج تعليمات عملية دقيقة تجعل البوت يكتب بنفس الأسلوب، مع ذكر النبرة، اللهجة، طول الرد، الإيموجي، الترحيب، الخاتمة، والعبارات التي يجب تجنبها. أعد التعليمات فقط.' },
        { role: 'user', content: `${sample.length} رد سابق:\n\n${sample.map((reply, i) => `[${i + 1}] ${reply}`).join('\n\n')}` },
      ],
    });
    if (aiResult.usage) bot.recordUsage(model, aiResult.usage.prompt_tokens || 0, aiResult.usage.completion_tokens || 0);
    const instructions = aiResult.choices[0]?.message?.content?.trim();
    if (!instructions) return res.json({ success: false, message: 'فشل التحليل' });
    res.json({ success: true, instructions, sampledCount: sample.length });
  }));

  app.post('/api/enhance-text', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const { text, type, storeName } = req.body || {};
    const sourceText = String(text || '').trim();
    if (sourceText.length < 3) return res.status(400).json({ success: false, message: 'النص قصير' });

    const { openai, model } = await bot.buildAIClient();
    const prompts = {
      welcome: `حسّن رسالة الترحيب لمتجر "${storeName || bot.config.storeName || 'المتجر'}" لتكون واضحة وطبيعية ومناسبة لواتساب. لا تذكر AI أو بوت. أعد النص فقط.`,
      description: 'حوّل وصف المتجر إلى وصف واضح ومفيد للذكاء الاصطناعي: ماذا يبيع المتجر، لمن، أهم المزايا، وأي حدود مهمة. لا تجعله تسويقياً مبالغاً فيه. أعد الوصف فقط.',
      instructions: 'حوّل النص إلى تعليمات تشغيل دقيقة للذكاء الاصطناعي يفهم منها الحقائق والقواعد والحدود وطريقة الرد. لا تزيّن الكلام ولا تضف معلومات غير مذكورة. رتّبها كنقاط عملية واضحة. أعد التعليمات فقط.',
      reply: 'حسّن الرد ليكون طبيعياً وواضحاً على واتساب، بدون Markdown وبدون ادعاءات جديدة. أعد الرد فقط.',
      general: 'حسّن النص ليكون واضحاً وسهل الفهم للذكاء الاصطناعي، بدون إضافة معلومات غير موجودة. أعد النص فقط.',
    };
    const aiResult = await openai.chat.completions.create({
      model,
      max_tokens: 700,
      temperature: 0.4,
      messages: [
        { role: 'system', content: prompts[type] || prompts.general },
        { role: 'user', content: sourceText },
      ],
    });
    if (aiResult.usage) bot.recordUsage(model, aiResult.usage.prompt_tokens || 0, aiResult.usage.completion_tokens || 0);
    const enhanced = aiResult.choices[0]?.message?.content?.trim()?.replace(/^["'`]|["'`]$/g, '');
    if (!enhanced) return res.json({ success: false, message: 'فشل التحسين' });
    res.json({ success: true, text: enhanced });
  }));

  app.post('/api/scan-store', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const { url, sallaToken, zidToken, zidManagerToken } = req.body || {};
    if (!url || !String(url).startsWith('http')) return res.status(400).json({ success: false, message: 'رابط غير صحيح' });
    if (isPrivateUrl(url)) return res.status(400).json({ success: false, message: 'رابط غير مسموح' });
    const result = await storeScanner.scanStore(url, { sallaToken, zidToken, zidManagerToken, logger: bot.logger });
    res.json({ success: true, ...result });
  }));

  app.post('/api/train-analyze', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length < 10) return res.status(400).json({ success: false, message: 'يجب الإجابة على 10 أسئلة على الأقل' });

    const qa = answers.map((answer, i) => `س${i + 1}: ${answer.q}\nج${i + 1}: ${answer.a}`).join('\n\n');
    const { openai, model } = await bot.buildAIClient();
    const aiResult = await openai.chat.completions.create({
      model,
      max_tokens: 1800,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'أنت خبير في بناء تعليمات بوت واتساب لخدمة العملاء. بناء على إجابات صاحب المتجر، اكتب برومنت عملي واضح للذكاء الاصطناعي يشمل الشخصية، طريقة الترحيب، اللهجة، طول الرد، الإيموجي، التعامل مع الاعتراضات، الممنوعات، ومتى يتم التصعيد. أعد البرومنت فقط.' },
        { role: 'user', content: `إجابات صاحب المتجر:\n\n${qa}` },
      ],
    });
    if (aiResult.usage) bot.recordUsage(model, aiResult.usage.prompt_tokens || 0, aiResult.usage.completion_tokens || 0);
    const instructions = aiResult.choices[0]?.message?.content?.trim();
    if (!instructions) return res.json({ success: false, message: 'فشل التحليل' });
    res.json({ success: true, instructions });
  }));

  app.post('/api/health-check', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const userId = req.session.userId;
    const { aiReplies, outgoingWhatsapp } = getQueues();

    const redisPing = redis.pingShared().then(
      () => ({ ok: true, msg: 'متصل' }),
      err => ({ ok: false, msg: err.code === 'REDIS_NOT_CONFIGURED' ? 'غير مضبوط' : err.message }),
    );

    // Combined into one query — saves a round trip per dashboard click.
    const aiPipelineStats = db.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE direction = 'inbound'
             AND status = 'queued_for_ai'
             AND created_at < NOW() - interval '2 minutes'
         )::int AS stuck_count,
         MAX(created_at) FILTER (
           WHERE direction = 'outbound' AND role = 'assistant'
         ) AS last_reply_at
       FROM messages
       WHERE user_id = $1`,
      [userId],
    ).then(
      r => ({ stuckCount: r.rows[0]?.stuck_count || 0, lastReplyAt: r.rows[0]?.last_reply_at || null }),
      err => { console.warn(`[health-check] ai pipeline stats failed: ${err.message}`); return { stuckCount: 0, lastReplyAt: null }; },
    );

    const queueCounts = Promise.all([
      aiReplies.getWaitingCount(),
      aiReplies.getActiveCount(),
      aiReplies.getDelayedCount(),
      aiReplies.getFailedCount(),
      outgoingWhatsapp.getWaitingCount(),
      outgoingWhatsapp.getActiveCount(),
    ]).then(
      ([w, a, d, f, ow, oa]) => ({ aiWaiting: w, aiActive: a, aiDelayed: d, aiFailed: f, outWaiting: ow, outActive: oa }),
      err => { console.warn(`[health-check] queue counts failed: ${err.message}`); return { error: err.message }; },
    );

    const [redisResult, aiStats, queues] = await Promise.all([redisPing, aiPipelineStats, queueCounts]);

    const checks = [
      { name: 'قاعدة البيانات', ok: true, msg: 'PostgreSQL' },
      { name: 'الواتساب', ok: bot.appState.status === 'connected', msg: bot.appState.status },
      { name: 'Redis', ...redisResult },
    ];

    const aiPipelineOk = aiStats.stuckCount === 0;
    const aiMsg = aiStats.stuckCount > 0
      ? `${aiStats.stuckCount} رسالة عالقة بانتظار الذكاء الاصطناعي`
      : aiStats.lastReplyAt
        ? `يعمل — آخر رد: ${new Date(aiStats.lastReplyAt).toLocaleString('ar-SA')}`
        : 'لا توجد ردود بعد';
    checks.push({ name: 'معالجة الذكاء الاصطناعي', ok: aiPipelineOk, msg: aiMsg, stuckCount: aiStats.stuckCount });

    if (queues.error) {
      checks.push({ name: 'الطابور', ok: false, msg: queues.error });
    } else {
      const queueOk = (queues.aiFailed === 0 || queues.aiActive > 0) && queues.aiWaiting < 10;
      const aiParts = [`${queues.aiWaiting} انتظار`, `${queues.aiActive} نشط`];
      if (queues.aiDelayed > 0) aiParts.push(`${queues.aiDelayed} مؤجل`);
      if (queues.aiFailed > 0) aiParts.push(`${queues.aiFailed} فاشل`);
      checks.push({
        name: 'الطابور',
        ok: queueOk,
        msg: `AI: ${aiParts.join(' / ')} — إرسال: ${queues.outWaiting} انتظار / ${queues.outActive} نشط`,
        aiFailed: queues.aiFailed,
      });

      if (queues.aiFailed > 0) {
        try {
          const failedJobs = await aiReplies.getFailed(0, 0);
          if (failedJobs[0]?.failedReason) {
            checks.push({ name: 'آخر خطأ AI', ok: false, msg: failedJobs[0].failedReason });
          }
        } catch (err) {
          console.warn(`[health-check] getFailed failed: ${err.message}`);
        }
      }
    }

    const hasKey = !!(bot.config.googleApiKey?.trim() || bot.config.openrouterApiKey?.trim() || bot.config.openaiApiKey?.trim() || bot.config.anthropicApiKey?.trim());
    checks.push({ name: 'مفتاح API', ok: hasKey, msg: hasKey ? 'مضبوط' : 'لا يوجد مفتاح — أضف مفتاح في الإعدادات' });

    res.json({ success: true, checks });
  }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  });

  return app;
}

function syncBotLookup(userId) {
  const bot = botCache.get(userId);
  if (!bot) throw new Error('bot is not loaded yet');
  return bot;
}

function asyncRoute(fn) {
  return async (req, res, next) => {
    try {
      await getUserBot(req.session.userId);
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

async function retryMigrate(maxAttempts = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await migrate();
      console.log(`${new Date().toISOString()} [server] database migrations completed (attempt ${attempt})`);
      return;
    } catch (err) {
      console.error(`${new Date().toISOString()} [server] migration attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function runPostStartupTasks(startupState) {
  try {
    cleanupRuntimeStorage(DATA_DIR);
  } catch (err) {
    console.error(`${new Date().toISOString()} [server] runtime storage cleanup failed: ${err.message}`);
  }

  try {
    startupState.migration = 'running';
    await retryMigrate();
    startupState.migration = 'completed';
    const recovered = await recoverQueuedAiReplyJobs();
    if (recovered.recovered > 0) {
      console.log(`${new Date().toISOString()} [server] recovered ${recovered.recovered} queued AI reply jobs`);
    }
  } catch (err) {
    startupState.migration = 'failed';
    startupState.migrationError = err.message;
    console.error(`${new Date().toISOString()} [server] background migration failed: ${err.stack || err.message}`);
  }
}

function startAiRecoveryLoop() {
  if (AI_RECOVERY_INTERVAL_MS <= 0) return null;
  const timer = setInterval(() => {
    recoverQueuedAiReplyJobs().then((recovered) => {
      if (recovered.recovered > 0) {
        console.log(`${new Date().toISOString()} [server] recovered ${recovered.recovered} queued AI reply jobs`);
      }
    }).catch((err) => {
      console.error(`${new Date().toISOString()} [server] AI recovery loop failed: ${err.message}`);
    });
  }, AI_RECOVERY_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function main() {
  console.log(`${new Date().toISOString()} [server] starting Jwab server...`);

  const startupState = {
    app: null,
    ready: false,
    phase: 'starting',
  };
  const app = createStartupApp(startupState);
  const server = app.listen(PORT, () => console.log(`${new Date().toISOString()} [server] Jwab health listening on port ${PORT}`));
  let outgoingWorker = null;
  let aiRecoveryTimer = null;
  let healthMonitor = null;

  const shutdown = async (signal, exitCode = 0) => {
    console.log(`${new Date().toISOString()} [server] ${signal} shutdown`);
    if (aiRecoveryTimer) clearInterval(aiRecoveryTimer);
    healthMonitor?.stop?.();
    server.close(() => {});
    // Release WhatsApp connection leases so the next Railway replica can
    // acquire them immediately instead of waiting up to 2 minutes for the
    // lease TTL to expire. Bounded by an overall timeout so a misbehaving
    // bot can't block shutdown past Railway's SIGKILL window.
    const releaseDeadlineMs = parseInt(process.env.SHUTDOWN_LEASE_RELEASE_TIMEOUT_MS || '5000', 10);
    const releaseAll = Promise.allSettled(
      Array.from(botCache.values()).map(bot => bot.releaseConnectionLease()),
    );
    await Promise.race([
      releaseAll,
      new Promise(resolve => setTimeout(resolve, releaseDeadlineMs)),
    ]).catch(() => {});
    await outgoingWorker?.close?.().catch(() => {});
    await redis.closeShared().catch(() => {});
    await db.close().catch(() => {});
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    startupState.phase = 'loading_app';
    startupState.app = createApp();
    startupState.ready = true;
    startupState.phase = 'ready';
    console.log(`${new Date().toISOString()} [server] Jwab app ready on port ${PORT}`);
  } catch (err) {
    startupState.ready = false;
    startupState.phase = 'failed';
    startupState.error = err.message;
    console.error(`${new Date().toISOString()} [server] startup failed: ${err.stack || err.message}`);
    await shutdown('startup-failed', 1);
    return;
  }

  runPostStartupTasks(startupState).catch((err) => {
    console.error(`${new Date().toISOString()} [server] post-startup task failed: ${err.stack || err.message}`);
  });
  aiRecoveryTimer = startAiRecoveryLoop();

  // Start outgoing worker after the dashboard is available.
  if (process.env.OUTGOING_WORKER_DISABLED !== 'true') {
    try {
      outgoingWorker = createOutgoingWhatsappWorker({ getUserBot });
      console.log(`${new Date().toISOString()} [server] outgoing whatsapp worker started`);
    } catch (err) {
      console.error(`${new Date().toISOString()} [server] outgoing worker failed to start: ${err.message}`);
      // Don't crash — the web server should still serve healthchecks and the dashboard
    }
  }

  // Start the 24/7 health monitor: detects outages and alerts the owner.
  if (process.env.HEALTH_MONITOR_DISABLED !== 'true') {
    try {
      const dispatcher = createAlertDispatcher({
        getOwnerBot: resolveOwnerBot,
        mailer: createMailer(),
      });
      healthMonitor = new HealthMonitor({ getQueues, dispatcher });
      healthMonitor.start();
      setActiveMonitor(healthMonitor);
      console.log(`${new Date().toISOString()} [server] health monitor started`);
    } catch (err) {
      console.error(`${new Date().toISOString()} [server] health monitor failed to start: ${err.message}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, createStartupApp, getUserBot };
