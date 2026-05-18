'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const db = require('./db/client');
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
const { createOutgoingWhatsappWorker } = require('./workers/outgoing-whatsapp-worker');

function resolveDataDir() {
  const configured = (process.env.DATA_DIR || '').trim();
  const railwayVolume = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  if (railwayVolume && (!configured || configured === './' || configured === '.')) return path.resolve(railwayVolume);
  return path.resolve(configured || railwayVolume || process.cwd());
}

const DATA_DIR = resolveDataDir();
const PORT = process.env.PORT || 3000;
const botCache = new Map();

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

async function getUserBot(userId) {
  if (!botCache.has(userId)) {
    const bot = new RuntimeBot(userId, { dataDir: DATA_DIR });
    await bot.load();
    botCache.set(userId, bot);
  }
  return botCache.get(userId);
}

function createStartupApp(state = {}) {
  const app = express();
  app.set('trust proxy', 1);

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      ready: !!state.ready,
      phase: state.phase || 'starting',
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

  const wrapBotController = require('./controllers/bot.controller').createBotController({ getUserBot: syncBotLookup });
  const wrapConfigController = require('./controllers/config.controller').createConfigController({ getUserBot: syncBotLookup });

  app.get('/api/status', requireAuth, asyncRoute(async (req, res) => wrapBotController.status(req, res)));
  app.get('/api/qr', requireAuth, asyncRoute(async (req, res) => wrapBotController.qr(req, res)));
  app.get('/api/qr-image', requireAuth, asyncRoute(async (req, res) => wrapBotController.qrImage(req, res)));
  app.post('/api/bot/start', requireAuth, asyncRoute(async (req, res) => wrapBotController.start(req, res)));
  app.post('/api/bot/stop', requireAuth, asyncRoute(async (req, res) => wrapBotController.stop(req, res)));
  app.post('/api/bot/restart', requireAuth, asyncRoute(async (req, res) => wrapBotController.restart(req, res)));
  app.post('/api/bot/clear-session', requireAuth, asyncRoute(async (req, res) => wrapBotController.clearSession(req, res)));
  app.post('/api/send-message', requireAuth, asyncRoute(async (req, res) => wrapBotController.sendMessage(req, res)));
  app.get('/api/config', requireAuth, asyncRoute(async (req, res) => wrapConfigController.getConfig(req, res)));
  app.post('/api/config', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    const incoming = req.body || {};
    const merged = { ...bot.config, ...incoming };
    if (!incoming.openaiApiKey?.trim() && bot.config.openaiApiKey?.trim()) merged.openaiApiKey = bot.config.openaiApiKey;
    if (!incoming.openrouterApiKey?.trim() && bot.config.openrouterApiKey?.trim()) merged.openrouterApiKey = bot.config.openrouterApiKey;
    if (!incoming.googleApiKey?.trim() && bot.config.googleApiKey?.trim()) merged.googleApiKey = bot.config.googleApiKey;
    if (!incoming.anthropicApiKey?.trim() && bot.config.anthropicApiKey?.trim()) merged.anthropicApiKey = bot.config.anthropicApiKey;
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
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ success: false, message: 'رسالة فارغة' });
    const reply = await bot.getAIReply([{ role: 'user', content: message }], { maxRetries: 0, isFirstMsg: true });
    res.json({ success: true, reply, source: 'ai', historyLength: 2 });
  }));
  app.post('/api/health-check', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    res.json({ success: true, checks: [
      { name: 'قاعدة البيانات', ok: true, msg: 'PostgreSQL' },
      { name: 'الواتساب', ok: bot.appState.status === 'connected', msg: bot.appState.status },
      { name: 'الطابور', ok: true, msg: 'BullMQ configured' },
    ] });
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

  const shutdown = async (signal, exitCode = 0) => {
    console.log(`${new Date().toISOString()} [server] ${signal} shutdown`);
    server.close(() => {});
    await outgoingWorker?.close?.().catch(() => {});
    await db.close().catch(() => {});
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    startupState.phase = 'migrating';
    await retryMigrate();

    startupState.phase = 'loading_app';
    cleanupRuntimeStorage(DATA_DIR);
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
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, createStartupApp, getUserBot };
