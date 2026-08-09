'use strict';

// Install libsignal log throttle FIRST, before any require that might transitively
// load Baileys/libsignal. Once libsignal binds to console.error, our patch can't
// intercept the binding it captured. Explicit install() is required (no
// self-install at require time, so tests can re-require cleanly).
require('./runtime/libsignal-log-throttle').install();
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');

// helmet is required for CSP/security headers. Wrapped in try/catch so the
// server still boots in environments where the dependency is being installed
// for the first time (e.g. fresh worktrees before `npm install`). The real
// production path always has helmet present via package.json.
let helmet = null;
try { helmet = require('helmet'); } catch (_) {
  console.warn('[server] helmet not installed — CSP headers disabled. Run `npm install helmet`.');
}

const { createBotResolver } = require('./runtime/bot-resolver');
const { recoverRunningBots } = require('./runtime/boot-recovery');
const requireSameOrigin = require('./middleware/require-same-origin');
// Fallback keeps a stubbed/legacy middleware (no helper attached, e.g. in tests)
// working: default to the legacy allowlist decision.
const shouldEnforceSameOrigin = requireSameOrigin.shouldEnforceSameOrigin
  || (({ path, protectedPrefixes = [] }) => protectedPrefixes.some((p) => String(path).startsWith(p)));
const { assertPublicUrl } = require('./middleware/ssrf-guard');
const { checkMessageQuota, decrementMessageQuota } = require('./services/billing/message-quota');

const db = require('./db/client');
const redis = require('./queues/redis');
const { migrate } = require('./db/migrations/init');
const { PostgresSessionStore } = require('./db/session-store');
const { createAuthRoutes } = require('./routes/auth.routes');
const { createAdminRoutes } = require('./routes/admin.routes');
const { createBillingRoutes } = require('./routes/billing.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createHealthRoutes } = require('./routes/health.routes');
const { detectApiKeyError } = require('./controllers/health.controller');
const { createQueueRoutes } = require('./routes/queue.routes');
const { createInstagramRoutes } = require('./routes/instagram.routes');
const { createCampaignRoutes } = require('./routes/campaign.routes');
const { RuntimeBot, cleanupRuntimeStorage, resolveConfigForAI } = require('./services/bot/runtime-bot');
const { createBillingAccessGate, createBillingApiGate } = require('./middleware/billing-access');
const { getBillingSettings } = require('./services/billing/billing-settings');
const { organizeProductsForConfig } = require('./services/products/product-import');
const { findAutoReply, collectInstantReplies, combineCannedAndAi } = require('./services/bot/platform-features');
const { listPausedChats, resumePausedChat } = require('./services/bot/paused-chats');
const { startRetentionLoop } = require('./services/maintenance/db-retention');
const { runLearningPass, listLearnedReplies, setLearnedReplyStatus, updateLearnedReply } = require('./services/learning/owner-reply-learner');
const {
  buildTrainAnalyzeRequest,
  buildEnhanceInstructionsRequest,
  buildLearnStyleRequest,
} = require('./services/ai/meta-prompts');
const { createOutgoingWhatsappWorker, startOutgoingRequeueLoop } = require('./workers/outgoing-whatsapp-worker');
const { createCampaignWorker, recoverCampaignDeliveries } = require('./workers/campaign-worker');
const { closeCampaignQueue } = require('./queues/campaign-queue');
const { recoverQueuedAiReplyJobs } = require('./workers/ai-recovery');
const { getQueues } = require('./queues/message-queue');
const { HealthMonitor, setActiveMonitor } = require('./services/monitoring/health-monitor');
const { createAlertDispatcher } = require('./services/monitoring/alerts');
const { configureUnlinkAlerts } = require('./services/monitoring/unlink-alert');
const { installProcessSafetyNet } = require('./runtime/process-safety');
const { prepareEscalation } = require('./workers/escalation-routing');
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
const AI_RECOVERY_INTERVAL_MS = parseInt(process.env.AI_RECOVERY_INTERVAL_MS || '30000', 10);

function ensureDatabaseConfigured() {
  if (!db.isConfigured()) throw new Error('DATABASE_URL is required for src server');
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // No SESSION_SECRET: fall back to a per-disk random secret. This is fine for
  // single-replica/local dev, but on multi-replica deploys each replica reads a
  // different file, invalidating sessions across replicas (and across restarts
  // if the disk is ephemeral). Set SESSION_SECRET in production.
  console.warn(
    '[server] SESSION_SECRET is not set — using a random on-disk fallback secret. ' +
    'Sessions will NOT survive across replicas or across restarts on ephemeral disks. ' +
    'Set SESSION_SECRET in production.',
  );
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

// Single-flight resolver: concurrent boot-time callers (dashboard + health
// monitor + outgoing worker) for the SAME user now share one creation instead
// of each building their own RuntimeBot. Multiple RuntimeBots per number opened
// competing WhatsApp sockets that fought and triggered 440 (seen in production
// logs as the same userId "auto recovering" 3× at once). Resolved bots still
// live in botCache so the shutdown loop and syncBotLookup read it unchanged.
const resolveUserBot = createBotResolver({
  cache: botCache,
  create: async (userId) => {
    const bot = new RuntimeBot(userId, { dataDir: DATA_DIR });
    await bot.load();
    return bot;
  },
});

function getUserBot(userId) {
  return resolveUserBot(userId);
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
      workers: state.workers || {},
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

  // Security headers via helmet (CSP, COOP, etc). Falls back to the manual
  // headers below when helmet is unavailable.
  if (helmet) {
    app.use(helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          // Lucide and other CDN scripts used by billing/admin dashboards.
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
          // Helmet 7 defaults script-src-attr to 'none' which blocks the
          // dashboard's 69 inline onclick handlers. We allow them explicitly
          // until the dashboard is refactored to addEventListener.
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      // Disable COEP — would block third-party Lucide scripts without CORP headers.
      crossOriginEmbedderPolicy: false,
      // Keep referrer policy consistent with previous behaviour.
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
  } else {
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });
  }
  // Skip global JSON body parsing for webhook paths that need the raw body
  // for HMAC signature verification (e.g. /billing/moyasar/webhook). Those
  // routes attach their own express.raw() parser inline.
  const RAW_BODY_PATHS = new Set([
    '/billing/moyasar/webhook',
    '/instagram/webhook',
  ]);
  app.use((req, res, next) => {
    if (RAW_BODY_PATHS.has(req.path)) return next();
    return bodyParser.json({ limit: '2mb' })(req, res, next);
  });

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

  // Lightweight CSRF protection: enforce same-origin for state-changing
  // requests on sensitive routes. Webhooks (e.g. Moyasar) must NOT be mounted
  // under these paths, or must be added to the skip-list below.
  const CSRF_PROTECTED_PREFIXES = [
    '/api/admin/',
    '/api/config',
    '/api/send-message',
    '/api/clear',
    '/api/bot/',
    '/api/campaigns',
  ];
  const CSRF_SKIP_PATHS = new Set([
    // Add explicit webhook paths here, e.g. '/api/billing/webhook/moyasar'
  ]);
  // Phase 10: opt-in strict (default-deny) CSRF. When STABILITY_STRICT_CSRF=true
  // EVERY mutating /api request is same-origin checked (except webhooks/skips),
  // not just the allowlisted prefixes. Off by default so production behavior is
  // unchanged until validated.
  const STRICT_CSRF = process.env.STABILITY_STRICT_CSRF === 'true';
  app.use((req, res, next) => {
    if (shouldEnforceSameOrigin({
      method: req.method,
      path: req.path,
      strict: STRICT_CSRF,
      protectedPrefixes: CSRF_PROTECTED_PREFIXES,
      skipPaths: CSRF_SKIP_PATHS,
    })) {
      return requireSameOrigin(req, res, next);
    }
    return next();
  });

  // Register rate-limit: 10 attempts per IP per hour.
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'محاولات تسجيل كثيرة، حاول لاحقاً' },
  });
  app.use('/api/auth/register', registerLimiter);

  // AI endpoint rate-limit: 10/min per session user (falls back to IP).
  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    // Use the library's ipKeyGenerator for the IP fallback so IPv6 addresses are
    // normalized (subnet-masked) instead of used raw — raw req.ip lets IPv6
    // clients bypass the limit and trips express-rate-limit's ERR_ERL_KEY_GEN_IPV6
    // validation on every boot.
    keyGenerator: (req) => req.session?.userId || rateLimit.ipKeyGenerator(req.ip),
    message: { success: false, message: 'استخدم الذكاء الاصطناعي ببطء أكثر' },
  });

  // Quota gate for AI endpoints. Checks quota before invoking the AI and
  // decrements only after the route succeeds.
  async function aiQuotaGate(req, res, next) {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ success: false, message: 'غير مصرح' });
      const state = await checkMessageQuota(userId);
      if (!state.canReply) {
        return res.status(402).json({ success: false, message: 'انتهت رصيد الرسائل', reason: state.reason });
      }
      // Decrement on response finish, but only on 2xx.
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          decrementMessageQuota(userId).catch(err =>
            console.warn(`[ai-quota] decrement failed for ${userId}: ${err.message}`)
          );
        }
      });
      return next();
    } catch (err) {
      return next(err);
    }
  }
  app.use('/fonts', express.static(path.join(process.cwd(), 'dashboard/fonts')));
  // Brand/static images (e.g. the جواب logo) — public, like fonts, so the login
  // page can show them too.
  app.use('/assets', express.static(path.join(process.cwd(), 'dashboard/assets')));
  app.get('/fatima-font.css', (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'fatima-font.css')));
  app.get('/conversations.css', (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'conversations.css')));
  app.get('/instagram.js', (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'instagram.js')));
  app.get('/campaigns.js', requireAuth, (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'campaigns.js')));
  // Public legal pages required by Meta to publish the app. No auth: they must
  // be reachable by Meta's reviewers and by end users.
  app.get('/privacy', (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'privacy.html')));
  app.get('/data-deletion', (req, res) => res.redirect('/privacy#data-deletion'));
  app.get('/terms', (req, res) => res.sendFile(path.join(process.cwd(), 'dashboard', 'terms.html')));

  const routeDeps = {
    dashboardDir: path.join(process.cwd(), 'dashboard'),
    requireAuth,
    billingSettings,
    // Async bot resolver for the admin per-merchant control panel. MUST be the
    // async getUserBot (creates+loads on demand) — NOT syncBotLookup, which
    // throws for any merchant not already in botCache.
    getUserBot,
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
  app.use(createCampaignRoutes({ ...routeDeps, database: db }));
  // Instagram module (isolated; every route self-guards on INSTAGRAM_ENABLED).
  // The webhook is in RAW_BODY_PATHS above and mounts its own express.raw.
  app.use(createInstagramRoutes(routeDeps));

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
  app.post('/api/bot/auto-reply', requireAuth, asyncRoute(async (req, res) => wrapBotController.setAutoReply(req, res)));
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
  app.get('/api/paused-chats', requireAuth, asyncRoute(async (req, res) => {
    const paused = await listPausedChats(db, req.session.userId);
    res.json({ success: true, paused });
  }));
  app.post('/api/paused-chats/resume', requireAuth, asyncRoute(async (req, res) => {
    const sender = (req.body && typeof req.body.sender === 'string' && req.body.sender.trim()) ? req.body.sender.trim() : null;
    const resumed = await resumePausedChat(db, req.session.userId, sender);
    res.json({ success: true, resumed });
  }));
  app.get('/api/learned-replies', requireAuth, asyncRoute(async (req, res) => {
    const learned = await listLearnedReplies({ userId: req.session.userId });
    res.json({ success: true, learned });
  }));
  app.post('/api/learned-replies/toggle', requireAuth, asyncRoute(async (req, res) => {
    const id = req.body?.id;
    const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
    const updated = await setLearnedReplyStatus({ userId: req.session.userId, id, status });
    res.json({ success: true, updated });
  }));
  app.post('/api/learned-replies/update', requireAuth, asyncRoute(async (req, res) => {
    const { id, question, answer } = req.body || {};
    const result = await updateLearnedReply({ userId: req.session.userId, id, question, answer });
    res.json({ success: (result.updated || 0) > 0, ...result });
  }));
  app.post('/api/test-chat', requireAuth, aiLimiter, aiQuotaGate, asyncRoute(async (req, res) => {
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

    // Mirror the WhatsApp worker: a bare trigger → canned reply only (fast path);
    // a trigger PLUS a real question → send the canned reply verbatim AND let the
    // AI answer the rest (combine mode), so the customer's question is never lost.
    const { matched: instantMatched, hasExtraQuestion } = collectInstantReplies(bot.config, incomingMessage);
    const cannedPrefix = instantMatched.map(m => m.reply).join('\n');
    if (cannedPrefix && !hasExtraQuestion) {
      history.push({ role: 'user', content: incomingMessage });
      history.push({ role: 'assistant', content: cannedPrefix });
      return res.json({ success: true, reply: cannedPrefix, source: 'keyword', historyLength: history.length });
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

    const aiRaw = await bot.getAIReply(history, { maxRetries: 0, isFirstMsg: isFirst, latestUserText: incomingMessage, instantAnswered: cannedPrefix });
    let reply = String(aiRaw || '').trim();

    // The sandbox never sends to the group — but it must SHOW what the real
    // pipeline would escalate (and strip the raw [تحويل:...] marker), otherwise
    // the owner thinks escalation is broken when testing here.
    const escalation = prepareEscalation({
      reply,
      config: bot.config,
      customerSender: 'sandbox@test',
      inboundText: incomingMessage,
    });
    reply = String(escalation.customerReply || '').trim() || reply;
    const escalationPreview = escalation.ownerMessage
      ? {
          target: escalation.ownerMessage.contact?.name || escalation.ownerMessage.sender,
          targetJid: escalation.ownerMessage.sender,
          summary: escalation.ownerMessage.summary,
        }
      : null;

    if (cannedPrefix) {
      reply = combineCannedAndAi(cannedPrefix, reply);
    }
    history.push({ role: 'assistant', content: reply });
    return res.json({ success: true, reply, source: cannedPrefix ? 'keyword+ai' : 'ai', historyLength: history.length, welcomeShown, escalationPreview });
  }));
  app.post('/api/learn-style', requireAuth, aiLimiter, aiQuotaGate, asyncRoute(async (req, res) => {
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
    const request = buildLearnStyleRequest({
      samples: sample,
      storeName: bot.config?.storeName,
    });
    const aiResult = await openai.chat.completions.create({
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages,
    });
    if (aiResult.usage) bot.recordUsage(model, aiResult.usage.prompt_tokens || 0, aiResult.usage.completion_tokens || 0);
    const instructions = aiResult.choices[0]?.message?.content?.trim();
    if (!instructions) return res.json({ success: false, message: 'فشل التحليل' });
    res.json({ success: true, instructions, sampledCount: sample.length });
  }));

  app.post('/api/enhance-text', requireAuth, aiLimiter, aiQuotaGate, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const { text, type, storeName } = req.body || {};
    const sourceText = String(text || '').trim();
    if (sourceText.length < 3) return res.status(400).json({ success: false, message: 'النص قصير' });

    const { openai, model } = await bot.buildAIClient();

    let aiResult;
    if (type === 'instructions') {
      const request = buildEnhanceInstructionsRequest({
        currentText: sourceText,
        storeName: storeName || bot.config.storeName,
      });
      aiResult = await openai.chat.completions.create({
        model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        messages: request.messages,
      });
    } else {
      const prompts = {
        welcome: `حسّن رسالة الترحيب لمتجر "${storeName || bot.config.storeName || 'المتجر'}" لتكون واضحة وطبيعية ومناسبة لواتساب. لا تذكر AI أو بوت. أعد النص فقط.`,
        description: 'حوّل وصف المتجر إلى وصف واضح ومفيد للذكاء الاصطناعي: ماذا يبيع المتجر، لمن، أهم المزايا، وأي حدود مهمة. لا تجعله تسويقياً مبالغاً فيه. أعد الوصف فقط.',
        reply: 'حسّن الرد ليكون طبيعياً وواضحاً على واتساب، بدون Markdown وبدون ادعاءات جديدة. أعد الرد فقط.',
        general: 'حسّن النص ليكون واضحاً وسهل الفهم للذكاء الاصطناعي، بدون إضافة معلومات غير موجودة. أعد النص فقط.',
      };
      aiResult = await openai.chat.completions.create({
        model,
        max_tokens: 700,
        temperature: 0.4,
        messages: [
          { role: 'system', content: prompts[type] || prompts.general },
          { role: 'user', content: sourceText },
        ],
      });
    }
    if (aiResult.usage) bot.recordUsage(model, aiResult.usage.prompt_tokens || 0, aiResult.usage.completion_tokens || 0);
    const enhanced = aiResult.choices[0]?.message?.content?.trim()?.replace(/^["'`]|["'`]$/g, '');
    if (!enhanced) return res.json({ success: false, message: 'فشل التحسين' });
    res.json({ success: true, text: enhanced });
  }));

  app.post('/api/scan-store', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const { url, sallaToken, zidToken, zidManagerToken } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, message: 'رابط غير صحيح' });
    }
    // Full SSRF validation: scheme + DNS resolution + private-IP check.
    try {
      await assertPublicUrl(url);
    } catch (err) {
      const code = err.code || 'INVALID_URL';
      const msg = code === 'PRIVATE_ADDRESS' ? 'رابط غير مسموح'
        : code === 'UNSUPPORTED_PROTOCOL' ? 'بروتوكول غير مدعوم'
        : code === 'DNS_FAILED' || code === 'DNS_EMPTY' ? 'تعذّر حل اسم النطاق'
        : 'رابط غير صحيح';
      return res.status(400).json({ success: false, message: msg, code });
    }
    const result = await storeScanner.scanStore(url, { sallaToken, zidToken, zidManagerToken, logger: bot.logger });
    res.json({ success: true, ...result });
  }));

  app.post('/api/train-analyze', requireAuth, aiLimiter, aiQuotaGate, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length < 10) return res.status(400).json({ success: false, message: 'يجب الإجابة على 10 أسئلة على الأقل' });

    const { openai, model } = await bot.buildAIClient();
    const request = buildTrainAnalyzeRequest({
      answers,
      storeName: bot.config?.storeName,
    });
    const aiResult = await openai.chat.completions.create({
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      messages: request.messages,
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

    // Real DB probe — the health card must reflect the actual DB state, not a
    // hardcoded "ok" (otherwise a down database still shows green).
    const dbPing = db.query('SELECT 1').then(
      () => ({ ok: true, msg: 'PostgreSQL' }),
      err => ({ ok: false, msg: err.message }),
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

    // Surface API-key/auth problems prominently: when the AI worker can't
    // reach the provider it marks the inbound message `ai_failed` and stores a
    // clear error in raw_payload.error, then sends a generic filler. The owner
    // needs to see the *cause*, not just the filler.
    const recentAiFailures = db.query(
      `SELECT raw_payload->>'error' AS error
       FROM messages
       WHERE user_id = $1
         AND status = 'ai_failed'
         AND created_at > NOW() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId],
    ).then(
      r => r.rows.map(row => row.error).filter(Boolean),
      err => { console.warn(`[health-check] recent ai failures query failed: ${err.message}`); return []; },
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

    const [redisResult, dbResult, aiStats, queues, aiFailureErrors] = await Promise.all([redisPing, dbPing, aiPipelineStats, queueCounts, recentAiFailures]);

    const checks = [
      { name: 'قاعدة البيانات', ...dbResult },
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
      // Benign no-ops (the worker correctly skipping an empty/stale/expired message)
      // are NOT real errors. Don't count them as "فاشل" and don't surface them as
      // "آخر خطأ AI" — otherwise the health check cries wolf on normal behaviour
      // (the merchant sees a red error while the bot is working fine).
      const BENIGN_FAIL_RE = /empty inbound|no pending inbound|stale|expired/i;
      let realFailed = queues.aiFailed;
      let lastRealError = null;
      if (queues.aiFailed > 0) {
        try {
          const failedJobs = await aiReplies.getFailed(0, 49);
          const realOnes = failedJobs.filter(j => !BENIGN_FAIL_RE.test(String(j?.failedReason || '')));
          realFailed = realOnes.length;
          lastRealError = realOnes[0]?.failedReason || null;
        } catch (err) {
          console.warn(`[health-check] getFailed failed: ${err.message}`);
        }
      }

      const queueOk = (realFailed === 0 || queues.aiActive > 0) && queues.aiWaiting < 10;
      const aiParts = [`${queues.aiWaiting} انتظار`, `${queues.aiActive} نشط`];
      if (queues.aiDelayed > 0) aiParts.push(`${queues.aiDelayed} مؤجل`);
      if (realFailed > 0) aiParts.push(`${realFailed} فاشل`);
      checks.push({
        name: 'الطابور',
        ok: queueOk,
        msg: `AI: ${aiParts.join(' / ')} — إرسال: ${queues.outWaiting} انتظار / ${queues.outActive} نشط`,
        aiFailed: realFailed,
      });

      if (lastRealError) {
        checks.push({ name: 'آخر خطأ AI', ok: false, msg: lastRealError });
      }
    }

    // Report the EFFECTIVE key the AI worker actually uses — i.e. the resolved
    // config that merges the global admin key + per-customer key, not the raw
    // bot.config (which never contains admin keys). Otherwise an owner who set
    // a single global admin key for everyone would always see a false
    // "لا يوجد مفتاح" here even though the AI is using it.
    let effectiveConfig = bot.config;
    try {
      effectiveConfig = await resolveConfigForAI(userId);
    } catch (keyErr) {
      console.warn(`[health-check] resolveConfigForAI failed: ${keyErr.message}`);
    }
    const hasKey = !!(effectiveConfig.googleApiKey?.trim() || effectiveConfig.openrouterApiKey?.trim() || effectiveConfig.openaiApiKey?.trim() || effectiveConfig.anthropicApiKey?.trim());
    checks.push({ name: 'مفتاح API', ok: hasKey, msg: hasKey ? 'مضبوط' : 'لا يوجد مفتاح — أضف مفتاح عام في الأدمن أو مفتاح خاص للعميل' });

    // Dedicated, prominent flag when recent ai_failed messages point to a
    // missing/invalid API key — so the cause isn't buried behind the filler.
    const apiKeyProblem = detectApiKeyError(aiFailureErrors);
    if (apiKeyProblem) {
      const apiKeyMessage = 'مفتاح API ناقص أو غير صحيح — راجع إعدادات المفتاح';
      checks.push({ name: 'مفتاح API', ok: false, msg: apiKeyMessage });
      return res.json({ success: true, checks, apiKeyProblem: true, apiKeyMessage });
    }

    res.json({ success: true, checks, apiKeyProblem: false });
  }));

  app.use((err, req, res, next) => {
    // Never leak err.message or stack to the client. Tag with a correlation id
    // so support can match the client-visible code to a server log line.
    const code = randomUUID();
    console.error(`[error ${code}] ${req.method} ${req.originalUrl} — ${err.stack || err.message}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: 'internal_error', code });
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

async function runRequiredStartupMigration(startupState) {
  startupState.phase = 'migrating';
  startupState.migration = 'running';
  await retryMigrate();
  startupState.migration = 'completed';
}

async function runPostStartupTasks(startupState) {
  try {
    cleanupRuntimeStorage(DATA_DIR);
  } catch (err) {
    console.error(`${new Date().toISOString()} [server] runtime storage cleanup failed: ${err.message}`);
  }

  try {
    const recovered = await recoverQueuedAiReplyJobs();
    if (recovered.recovered > 0) {
      console.log(`${new Date().toISOString()} [server] recovered ${recovered.recovered} queued AI reply jobs`);
    }
    // Reconnect every bot that was running before this restart, WITHOUT waiting
    // for someone to open its dashboard. Without this, each merchant's bot stays
    // offline after a deploy until visited.
    await recoverRunningBots({
      db,
      resolveBot: getUserBot,
      log: (m) => console.log(`${new Date().toISOString()} [server] ${m}`),
    });
  } catch (err) {
    startupState.recovery = 'failed';
    startupState.recoveryError = err.message;
    console.error(`${new Date().toISOString()} [server] post-startup recovery failed: ${err.stack || err.message}`);
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

// Phase-1 self-learning pass: harvest Q→A pairs from the owner's manual
// replies every LEARNING_PASS_INTERVAL_MS (default 6h), plus one warm-up run
// shortly after boot. LEARNED_REPLIES_ENABLED=false disables both the pass
// and the injection (checked inside the learner module).
const LEARNING_PASS_INTERVAL_MS = parseInt(process.env.LEARNING_PASS_INTERVAL_MS || '21600000', 10);

function startLearningLoop() {
  if (LEARNING_PASS_INTERVAL_MS <= 0) return null;
  const run = () => {
    runLearningPass().then((result) => {
      if (result.learned > 0) {
        console.log(`${new Date().toISOString()} [server] learning pass: learned ${result.learned} replies across ${result.users} users`);
      }
    }).catch((err) => {
      console.error(`${new Date().toISOString()} [server] learning pass failed: ${err.message}`);
    });
  };
  const warmup = setTimeout(run, 2 * 60 * 1000);
  if (typeof warmup.unref === 'function') warmup.unref();
  const timer = setInterval(run, LEARNING_PASS_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function main() {
  installProcessSafetyNet({ processName: 'web' });
  console.log(`${new Date().toISOString()} [server] starting Jwab server...`);

  const startupState = {
    app: null,
    ready: false,
    phase: 'starting',
    workers: { outgoingWhatsapp: 'starting', campaignDeliveries: 'starting' },
  };
  const app = createStartupApp(startupState);
  const server = app.listen(PORT, () => console.log(`${new Date().toISOString()} [server] Jwab health listening on port ${PORT}`));
  let outgoingWorker = null;
  let campaignWorker = null;
  let aiRecoveryTimer = null;
  let campaignRecoveryTimer = null;
  let healthMonitor = null;

  const shutdown = async (signal, exitCode = 0) => {
    console.log(`${new Date().toISOString()} [server] ${signal} shutdown`);
    if (aiRecoveryTimer) clearInterval(aiRecoveryTimer);
    if (campaignRecoveryTimer) clearInterval(campaignRecoveryTimer);
    healthMonitor?.stop?.();
    server.close(() => {});
    // Release WhatsApp connection leases so the next Railway replica can
    // acquire them immediately instead of waiting up to 2 minutes for the
    // lease TTL to expire. Bounded by an overall timeout so a misbehaving
    // bot can't block shutdown past Railway's SIGKILL window.
    const releaseDeadlineMs = parseInt(process.env.SHUTDOWN_LEASE_RELEASE_TIMEOUT_MS || '5000', 10);
    const releaseAll = Promise.allSettled(
      // Close the live WhatsApp socket AND free the lease. Releasing only the
      // DB lease (without closing the socket) left the old container connected
      // until SIGKILL, colliding with the new replica's session → WhatsApp 440.
      Array.from(botCache.values()).map(bot => bot.releaseForShutdown()),
    );
    await Promise.race([
      releaseAll,
      new Promise(resolve => setTimeout(resolve, releaseDeadlineMs)),
    ]).catch(() => {});
    await outgoingWorker?.close?.().catch(() => {});
    await campaignWorker?.close?.().catch(() => {});
    await closeCampaignQueue().catch(() => {});
    await redis.closeShared().catch(() => {});
    await db.close().catch(() => {});
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    // Load-bearing startup gate: schema changes must commit before createApp,
    // bot recovery, or any sending worker can observe the new code.
    await runRequiredStartupMigration(startupState);
    startupState.phase = 'loading_app';
    startupState.app = createApp();
    startupState.ready = true;
    startupState.phase = 'ready';
    console.log(`${new Date().toISOString()} [server] Jwab app ready on port ${PORT}`);
  } catch (err) {
    startupState.ready = false;
    startupState.phase = 'failed';
    startupState.error = err.message;
    if (startupState.migration === 'running') {
      startupState.migration = 'failed';
      startupState.migrationError = err.message;
    }
    console.error(`${new Date().toISOString()} [server] startup failed: ${err.stack || err.message}`);
    await shutdown('startup-failed', 1);
    return;
  }

  runPostStartupTasks(startupState).catch((err) => {
    console.error(`${new Date().toISOString()} [server] post-startup task failed: ${err.stack || err.message}`);
  });
  aiRecoveryTimer = startAiRecoveryLoop();
  startLearningLoop();
  // Phase 1 stability: bounded DB retention/cleanup (env-gated, single-instance
  // via advisory lock, batched). Prevents the unbounded messages/jobs growth
  // that caused the 2026-07-07 disk-full outage. Timer is unref'd.
  startRetentionLoop({ db });

  // Start outgoing worker after the dashboard is available.
  if (process.env.OUTGOING_WORKER_DISABLED !== 'true') {
    try {
      outgoingWorker = createOutgoingWhatsappWorker({ getUserBot });
      await outgoingWorker.waitUntilReady();
      // Phase 4 stability: periodically re-enqueue outgoing replies stranded by a
      // reconnect window (additive; the per-send dedup guard still applies).
      startOutgoingRequeueLoop({});
      startupState.workers.outgoingWhatsapp = 'ready';
      console.log(`${new Date().toISOString()} [server] outgoing whatsapp worker started`);
    } catch (err) {
      startupState.workers.outgoingWhatsapp = 'failed';
      console.error(`${new Date().toISOString()} [server] outgoing worker failed to start: ${err.message}`);
      // Don't crash — the web server should still serve healthchecks and the dashboard
    }
  }

  // Campaigns use a dedicated single-concurrency worker. This isolation keeps
  // bulk sends from consuming the normal customer-reply queue.
  if (process.env.CAMPAIGN_WORKER_DISABLED !== 'true') {
    try {
      campaignWorker = createCampaignWorker({ getUserBot });
      await campaignWorker.waitUntilReady();
      startupState.workers.campaignDeliveries = 'ready';
      console.log(`${new Date().toISOString()} [server] campaign worker started`);
      const recover = async () => {
        const result = await recoverCampaignDeliveries();
        if (result.staleSending || result.missingJobs || result.scheduled) {
          console.log(`${new Date().toISOString()} [campaign-recovery] stale=${result.staleSending} missing=${result.missingJobs} scheduled=${result.scheduled}`);
        }
      };
      await recover().catch(err => {
        console.error(`${new Date().toISOString()} [campaign-recovery] initial pass failed: ${err.message}`);
      });
      campaignRecoveryTimer = setInterval(() => recover().catch(err => {
        console.error(`${new Date().toISOString()} [campaign-recovery] failed: ${err.message}`);
      }), Math.max(30000, parseInt(process.env.CAMPAIGN_RECOVERY_INTERVAL_MS || '60000', 10)));
      campaignRecoveryTimer.unref?.();
    } catch (err) {
      startupState.workers.campaignDeliveries = 'failed';
      console.error(`${new Date().toISOString()} [server] campaign worker failed to start: ${err.message}`);
    }
  }

  // Instagram token-refresh timer — only when the feature is on. Wrapped so a
  // failure here can never affect the web server or WhatsApp.
  if (process.env.INSTAGRAM_ENABLED === 'true') {
    try {
      require('./services/instagram/token-refresh').startTokenRefreshTimer();
      console.log(`${new Date().toISOString()} [server] instagram token refresh timer started`);
    } catch (err) {
      console.error(`${new Date().toISOString()} [server] instagram refresh timer failed: ${err.message}`);
    }
  }

  // Start the 24/7 health monitor: detects outages and alerts the owner.
  if (process.env.HEALTH_MONITOR_DISABLED !== 'true') {
    try {
      const dispatcher = createAlertDispatcher({
        getOwnerBot: resolveOwnerBot,
        mailer: createMailer(),
      });
      // Instant unlink (loggedOut) alerts share the same channels.
      configureUnlinkAlerts({ getOwnerBot: resolveOwnerBot, mailer: createMailer() });
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
