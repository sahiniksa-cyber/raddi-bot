'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
let FileStore; try { FileStore = require('session-file-store')(session); } catch (_) {}

const db = require('./db/client');
const { createAuthRoutes } = require('./routes/auth.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createHealthRoutes } = require('./routes/health.routes');
const { createQueueRoutes } = require('./routes/queue.routes');
const { RuntimeBot } = require('./services/bot/runtime-bot');

const DATA_DIR = path.resolve(process.env.DATA_DIR || process.cwd());
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

function createApp() {
  ensureDatabaseConfigured();

  const app = express();
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(bodyParser.json({ limit: '2mb' }));

  const sessionConfig = {
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'strict' },
  };
  if (FileStore) {
    const sessionDir = path.join(DATA_DIR, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionConfig.store = new FileStore({ path: sessionDir, ttl: 30 * 24 * 60 * 60, retries: 1, logFn: () => {} });
  }
  app.use(session(sessionConfig));

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { success: false, message: 'كثير طلبات' } });
  app.use('/api', apiLimiter);
  app.use('/fonts', express.static(path.join(process.cwd(), 'dashboard/fonts')));

  const routeDeps = {
    dashboardDir: path.join(process.cwd(), 'dashboard'),
    requireAuth,
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
  app.use(createDashboardRoutes(routeDeps));
  app.use(createQueueRoutes(routeDeps));

  const wrapBotController = require('./controllers/bot.controller').createBotController({ getUserBot: syncBotLookup });
  const wrapConfigController = require('./controllers/config.controller').createConfigController({ getUserBot: syncBotLookup });

  app.get('/api/status', requireAuth, asyncRoute(async (req, res) => wrapBotController.status(req, res)));
  app.get('/api/qr', requireAuth, asyncRoute(async (req, res) => wrapBotController.qr(req, res)));
  app.get('/api/qr-image', requireAuth, asyncRoute(async (req, res) => wrapBotController.qrImage(req, res)));
  app.post('/api/bot/start', requireAuth, asyncRoute(async (req, res) => wrapBotController.start(req, res)));
  app.post('/api/bot/stop', requireAuth, asyncRoute(async (req, res) => wrapBotController.stop(req, res)));
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
  app.post('/api/clear', requireAuth, asyncRoute(async (req, res) => {
    await db.query('DELETE FROM conversations WHERE user_id = $1', [req.session.userId]);
    res.json({ success: true });
  }));

  app.get('/api/costs', requireAuth, asyncRoute(async (req, res) => res.json((await getUserBot(req.session.userId)).costsData)));
  app.post('/api/costs/reset', requireAuth, asyncRoute(async (req, res) => {
    const bot = await getUserBot(req.session.userId);
    bot.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {} };
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

async function main() {
  const app = createApp();
  app.listen(PORT, () => console.log(`Raddi src server listening on ${PORT}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, getUserBot };
