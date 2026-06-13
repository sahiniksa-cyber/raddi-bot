'use strict';

// Admin-side control of a SPECIFIC merchant's bot, resolved by :userId from the
// route (NOT req.session.userId). Reuses the exact same RuntimeBot methods the
// merchant's own dashboard uses — no behavior change for merchants, no shared
// state across tenants (every action is scoped to the target userId).
//
// IMPORTANT: getUserBot MUST be the async resolver (getUserBot), not the
// synchronous syncBotLookup — most merchants are not in botCache, and the async
// resolver creates+loads on demand. load() only auto-starts a connection when
// desired_state='running' (mirrors boot-recovery); a stopped merchant stays put.

function createAdminMerchantController({ getUserBot, database = null, services = {} } = {}) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');

  const db = database || (() => {
    try { return require('../db/client'); } catch (_) { return null; }
  })();

  const searchMerchants = services.searchMerchants || require('../services/admin/merchant-search').searchMerchants;
  const diagnostics = services.getMerchantDiagnostics || require('../services/admin/merchant-diagnostics').getMerchantDiagnostics;
  const forceReleaseLease = services.forceReleaseLease || require('../services/admin/merchant-diagnostics').forceReleaseLease;
  const logAdminAction = services.logAdminAction || require('../services/admin/admin-audit').logAdminAction;

  async function userExists(userId) {
    if (!db || typeof db.query !== 'function') return true; // can't check — fail open to bot resolver
    const r = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    return r.rows.length > 0;
  }

  function adminId(req) {
    return req.session?.userId || null;
  }

  async function audit(req, action, targetUserId, detail, result) {
    await logAdminAction(
      { adminUserId: adminId(req), action, targetUserId, detail: detail || {}, result: result || 'ok' },
      { db },
    );
  }

  // Wrap an action handler: validate the target user exists, resolve its bot,
  // run fn(bot), audit, and convert errors to a 500. `action` is the audit tag.
  function botAction(action, fn) {
    return async (req, res) => {
      const userId = String(req.params.userId || '').trim();
      try {
        if (!(await userExists(userId))) {
          return res.status(404).json({ success: false, message: 'التاجر غير موجود' });
        }
        const bot = await getUserBot(userId);
        const out = await fn(bot, req);
        await audit(req, action, userId, out?.detail || {}, 'ok');
        return res.json({ success: true, status: bot.appState?.status, ...(out?.body || {}) });
      } catch (err) {
        try { await audit(req, action, userId, { error: err.message }, 'error'); } catch (_) {}
        return res.status(500).json({ success: false, message: err.message });
      }
    };
  }

  return {
    async search(req, res) {
      try {
        const q = String(req.query.q || '').trim();
        const results = await searchMerchants(q, { db });
        res.json({ success: true, results });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async diagnostics(req, res) {
      const userId = String(req.params.userId || '').trim();
      try {
        const data = await diagnostics(userId, { db, getUserBot });
        if (!data) return res.status(404).json({ success: false, message: 'التاجر غير موجود' });
        res.json({ success: true, diagnostics: data });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async qrImage(req, res) {
      const userId = String(req.params.userId || '').trim();
      try {
        if (!(await userExists(userId))) return res.status(404).end();
        const bot = await getUserBot(userId);
        const qr = bot.appState?.qrString;
        if (!qr) return res.status(404).end();
        const QRCode = require('qrcode');
        const buf = await QRCode.toBuffer(qr, {
          width: 512, margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'H',
        });
        res.type('png').send(buf);
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    restart: botAction('bot_restart', async (bot) => {
      const started = await bot.restartBot();
      return { body: { started }, detail: { started } };
    }),

    stop: botAction('bot_stop', async (bot) => {
      await bot.stopBot();
      return {};
    }),

    clearSession: (req, res) => {
      // Destructive: wipes the WhatsApp link (merchant must re-scan QR). Require
      // an explicit confirm flag so a stray click can't unlink a merchant.
      if (req.body?.confirm !== true) {
        return res.status(400).json({ success: false, message: 'يتطلب تأكيداً صريحاً (confirm:true)' });
      }
      return botAction('bot_clear_session', async (bot) => {
        await bot.clearSession();
        return {};
      })(req, res);
    },

    releaseLease: async (req, res) => {
      const userId = String(req.params.userId || '').trim();
      try {
        if (!(await userExists(userId))) {
          return res.status(404).json({ success: false, message: 'التاجر غير موجود' });
        }
        const result = await forceReleaseLease(userId, { db });
        await audit(req, 'bot_release_lease', userId, result, 'ok');
        res.json({ success: true, ...result });
      } catch (err) {
        try { await audit(req, 'bot_release_lease', userId, { error: err.message }, 'error'); } catch (_) {}
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createAdminMerchantController };
