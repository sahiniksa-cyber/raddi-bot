'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { verifyInstagramSignature } = require('../services/instagram/instagram-signature');
const defaultOauth = require('../services/instagram/instagram-oauth');
const defaultAccounts = require('../services/instagram/instagram-accounts');
const defaultIngest = require('../services/instagram/instagram-ingest');
const defaultGraph = require('../services/instagram/instagram-graph');
const defaultConfig = require('../services/instagram/instagram-config');
const { generateInstagramTestReply: defaultGenerateTestReply } = require('../services/instagram/instagram-test-reply');
const { humanPauseExpiry, resolvePauseMinutes } = require('../services/instagram/instagram-pause');
const defaultDb = require('../db/client');
const { enqueueOutgoingInstagram: defaultEnqueueOutgoing } = require('../queues/instagram-queue');

/**
 * Instagram routes: OAuth connect/callback, webhook (raw body + HMAC), status,
 * disconnect, config (seeded from WhatsApp), AI toggle, inbox, manual send.
 *
 * Every API route is gated behind INSTAGRAM_ENABLED (default off) → 503 when
 * disabled, so the feature is inert until switched on. The webhook GET
 * handshake works regardless (verify-token checked) so Meta setup can succeed;
 * the POST webhook verifies the HMAC signature and only ingests when enabled.
 *
 * All handlers are dependency-injectable for tests.
 */
function createInstagramRoutes(deps = {}) {
  const env = deps.env || process.env;
  const oauth = deps.oauth || defaultOauth;
  const accounts = deps.accounts || defaultAccounts;
  const ingest = deps.ingest || defaultIngest;
  const graph = deps.graph || defaultGraph;
  const cfg = deps.config || defaultConfig;
  const db = deps.database || defaultDb;
  const enqueueOutgoing = deps.enqueueOutgoingInstagram || defaultEnqueueOutgoing;
  const generateTestReply = deps.generateInstagramTestReply || defaultGenerateTestReply;
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  // In-memory sandbox threads for the Instagram "جرّب البوت" box, keyed by
  // user+session. Ephemeral (lost on restart) — a dry-run playground, never
  // persisted and never sent, exactly like the WhatsApp test-chat.
  const igTestThreads = deps.igTestThreads || new Map();
  const IG_TEST_MEMORY = 50;

  const router = express.Router();
  const enabled = () => env.INSTAGRAM_ENABLED === 'true';
  const guard = (req, res, next) => (enabled() ? next() : res.status(503).json({ error: 'instagram_disabled' }));

  // ── Webhook verification handshake (GET) ──────────────────────────────────
  router.get('/instagram/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    return res.sendStatus(403);
  });

  // ── Webhook receive (POST) — raw body for HMAC (mirrors Moyasar) ───────────
  router.post('/instagram/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['x-hub-signature-256'];
    const sigOk = verifyInstagramSignature(req.body, sig, env.INSTAGRAM_APP_SECRET);
    // DB breadcrumb (fire-and-forget): proves whether Meta is POSTing at all and
    // whether the HMAC signature passes — visible via the DB without Railway logs.
    db.query(
      "INSERT INTO instagram_logs (user_id, level, event_type, detail) VALUES (NULL, $1, 'webhook_hit', $2::jsonb)",
      [sigOk ? 'info' : 'warn', JSON.stringify({ sigPresent: Boolean(sig), sigOk, bodyLen: req.body ? req.body.length : 0 })],
    ).catch(() => {});
    if (!sigOk) {
      return res.sendStatus(401);
    }
    if (!enabled()) return res.sendStatus(200);
    const ts = () => new Date().toISOString();
    try {
      const body = JSON.parse(req.body.toString('utf8'));
      const items = ingest.extractMessages(body);
      const inbound = items.filter((it) => !it.echo && it.text);
      const accountIds = [...new Set(items.map((i) => i.igAccountId))];
      // Event-type breakdown (message/echo/read/reaction/attachment/postback):
      // turns an opaque "inboundCount:0" into a diagnosable "these were read
      // receipts" vs "Meta sent an actual text we failed to parse".
      const types = typeof ingest.summarizeEventTypes === 'function'
        ? ingest.summarizeEventTypes(items) : {};
      // Always log receipt so Railway logs prove whether Meta is delivering at all.
      console.log(`${ts()} [instagram-webhook] received: ${items.length} event(s), ${inbound.length} inbound text, types=${JSON.stringify(types)} — ids=${accountIds.join(',')}`);
      db.query(
        "INSERT INTO instagram_logs (user_id, level, event_type, detail) VALUES (NULL, 'info', 'webhook_parsed', $1::jsonb)",
        [JSON.stringify({ itemCount: items.length, inboundCount: inbound.length, types, accountIds })],
      ).catch(() => {});
      for (const item of items) {
        if (item.echo || !item.text) continue;
        let userId = await accounts.findUserIdByIgAccount(item.igAccountId, { database: db });
        if (!userId) {
          // The id Meta sends (entry.id) can differ from the profile.user_id saved
          // at OAuth time — that would drop the message SILENTLY. If exactly one
          // merchant is connected, adopt it and heal the stored id so it routes
          // now and matches directly next time. (Multi-merchant → log only, safe.)
          try {
            const connected = await accounts.listConnectedAccounts({ database: db });
            if (connected.length === 1) {
              userId = connected[0].user_id;
              if (typeof accounts.setIgUserId === 'function') {
                await accounts.setIgUserId(userId, item.igAccountId, { database: db }).catch(() => {});
              }
              console.warn(`${ts()} [instagram-webhook] no exact match for igAccountId=${item.igAccountId}; adopted sole connected account user=${userId} and healed ig_user_id`);
            }
          } catch (e) {
            console.error(`${ts()} [instagram-webhook] fallback lookup failed: ${e.message}`);
          }
          if (!userId) {
            throw new Error(`no_matching_instagram_account:${item.igAccountId}`);
          }
        } else {
          console.log(`${ts()} [instagram-webhook] igAccountId=${item.igAccountId} → user=${userId}; ingesting message from ${item.participantId}`);
        }
        await ingest.ingestWebhookEntry(userId, item);
        // Resolve the @username so the inbox shows handles, not numeric ids.
        if (typeof ingest.ensureUsername === 'function') {
          await ingest.ensureUsername(userId, item.participantId).catch(() => {});
        }
      }
      // Return success only after the message is durable in Postgres and its AI
      // job is accepted by Redis. A non-2xx response makes Meta retry transient
      // failures; acknowledging before this point used to lose DMs forever.
      return res.sendStatus(200);
    } catch (err) {
      console.error(`${ts()} [instagram-webhook] ${err.message}`);
      db.query(
        "INSERT INTO instagram_logs (user_id, level, event_type, detail) VALUES (NULL, 'error', 'webhook_processing_failed', $1::jsonb)",
        [JSON.stringify({ message: err.message })],
      ).catch(() => {});
      return res.status(503).json({ error: 'instagram_webhook_processing_failed' });
    }
  });

  // ── OAuth: start ──────────────────────────────────────────────────────────
  router.get('/api/instagram/connect', guard, requireAuth, (req, res) => {
    const state = crypto.randomBytes(32).toString('hex');
    req.session.instagramOauthState = state;
    res.redirect(oauth.buildAuthorizeUrl(state, { env }));
  });

  // ── OAuth: callback ───────────────────────────────────────────────────────
  router.get('/instagram/auth/callback', guard, requireAuth, async (req, res, next) => {
    try {
      const expectedState = String(req.session.instagramOauthState || '');
      const actualState = String(req.query.state || '');
      if (!expectedState || !actualState || expectedState.length !== actualState.length ||
          !crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(actualState))) {
        return res.status(400).json({ error: 'invalid_oauth_state' });
      }
      delete req.session.instagramOauthState;
      if (!req.query.code) return res.status(400).json({ error: 'missing_oauth_code' });
      const short = await oauth.exchangeCodeForToken(req.query.code, { env });
      const long = await oauth.exchangeForLongLived(short.accessToken, { env });
      let profile = {};
      try { profile = await graph.getProfile({ token: long.accessToken }, { env }); } catch (_) { /* non-fatal */ }
      await accounts.upsertAccount(req.session.userId, {
        igUserId: profile.user_id || short.userId,
        igUsername: profile.username,
        token: long.accessToken,
        expiresAt: long.expiresAt,
      });
      // Subscribe the account to the `messages` webhook field. If THIS fails,
      // Meta never delivers DMs — so log the outcome instead of swallowing it.
      try {
        const sub = await graph.subscribeToMessages({ token: long.accessToken }, { env });
        console.log(`${new Date().toISOString()} [instagram-oauth] subscribed to messages for user=${req.session.userId}: ${JSON.stringify(sub)}`);
      } catch (e) {
        console.error(`${new Date().toISOString()} [instagram-oauth] subscribeToMessages FAILED for user=${req.session.userId}: ${e.message}`);
      }
      res.redirect('/#instagram');
    } catch (err) { next(err); }
  });

  // ── Status (+ live stats mirroring the WhatsApp header) ────────────────────
  router.get('/api/instagram/status', guard, requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId;
      const acc = await accounts.getAccount(userId, { database: db });
      const settings = await cfg.resolveInstagramConfig(userId, { database: db });
      let activeConversations = 0;
      let repliesCount = 0;
      try {
        const a = await db.query(
          "SELECT COUNT(*)::int AS n FROM instagram_conversations WHERE user_id = $1 AND status = 'active'",
          [userId],
        );
        activeConversations = a.rows[0] ? a.rows[0].n : 0;
        const r = await db.query(
          "SELECT COUNT(*)::int AS n FROM instagram_messages WHERE user_id = $1 AND direction = 'outbound' AND role = 'assistant' AND status = 'sent'",
          [userId],
        );
        repliesCount = r.rows[0] ? r.rows[0].n : 0;
      } catch (_) { /* stats are best-effort */ }
      res.json({
        connected: Boolean(acc && acc.status === 'connected'),
        username: acc ? acc.ig_username : null,
        tokenExpiresAt: acc ? acc.token_expires_at : null,
        aiEnabled: settings.enabled === true,
        activeConversations,
        repliesCount,
        model: (settings.config && settings.config.model) || 'gpt-4o',
      });
    } catch (err) { next(err); }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  router.post('/api/instagram/disconnect', guard, requireAuth, async (req, res, next) => {
    try {
      await accounts.disconnectAccount(req.session.userId, { database: db });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // ── Webhook subscription status ────────────────────────────────────────────
  // Reports whether the account is subscribed to the `messages` field. If not,
  // Meta won't deliver DMs — the #1 reason "the bot never receives messages".
  router.get('/api/instagram/subscription', guard, requireAuth, async (req, res, next) => {
    try {
      const token = await accounts.getAccountToken(req.session.userId, { database: db });
      if (!token) return res.json({ connected: false, hasMessages: false, fields: [] });
      const sub = await graph.getSubscribedApps({ token }, { env });
      res.json({ connected: true, hasMessages: sub.hasMessages, fields: sub.fields });
    } catch (err) {
      res.json({ connected: true, hasMessages: false, fields: [], error: err.message });
    }
  });

  // ── Re-subscribe to the `messages` webhook field (account + APP level) ──────
  // Self-serve fix. Subscribes BOTH levels and surfaces Meta's actual state/error
  // for each — because DM delivery needs the APP subscribed to instagram/messages
  // AND the account subscribed, and either can silently be missing.
  router.post('/api/instagram/resubscribe', guard, requireAuth, async (req, res) => {
    const out = { success: true };
    try {
      const token = await accounts.getAccountToken(req.session.userId, { database: db });
      if (!token) return res.status(400).json({ success: false, message: 'اربط حساب إنستقرام أولاً' });

      // 1) Account level (subscribed_apps on the IG account).
      try {
        await graph.subscribeToMessages({ token }, { env });
        const after = await graph.getSubscribedApps({ token }, { env });
        out.accountHasMessages = after.hasMessages;
        out.accountFields = after.fields;
      } catch (e) { out.accountError = e.message; }

      // 2) App level (the APP itself subscribed to the instagram object's messages
      //    field). Needs app credentials — present in the server env.
      // Instagram Login and the parent Meta app are different applications in
      // this deployment. graph.facebook.com requires the PARENT Meta app
      // credentials, never INSTAGRAM_APP_ID/SECRET used for OAuth and HMAC.
      const appId = env.INSTAGRAM_META_APP_ID;
      const appSecret = env.INSTAGRAM_META_APP_SECRET;
      const verifyToken = env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
      if (appId && appSecret && verifyToken) {
        const configuredCallback = env.INSTAGRAM_WEBHOOK_CALLBACK_URL ||
          (env.APP_BASE_URL ? `${String(env.APP_BASE_URL).replace(/\/$/, '')}/instagram/webhook` : '');
        let callbackUrl = '';
        try {
          const parsed = new URL(configuredCallback);
          if (parsed.protocol === 'https:') callbackUrl = parsed.toString();
        } catch (_) { /* surfaced below */ }
        if (!callbackUrl) {
          out.appError = 'اضبط INSTAGRAM_WEBHOOK_CALLBACK_URL بعنوان HTTPS ثابت';
        } else {
        out.callbackUrl = callbackUrl;
        try {
          await graph.subscribeAppToInstagram({ appId, appSecret, callbackUrl, verifyToken, fields: 'messages' }, { env });
          const appAfter = await graph.getAppSubscriptions({ appId, appSecret }, { env });
          out.appHasMessages = appAfter.hasMessages;
          out.appFields = appAfter.fields;
          out.appActive = appAfter.active;
        } catch (e) { out.appError = e.message; }
        }
      } else {
        out.appError = 'فحص مستوى التطبيق يحتاج INSTAGRAM_META_APP_ID / INSTAGRAM_META_APP_SECRET منفصلين عن مفاتيح Instagram Login';
      }

      out.hasMessages = Boolean(out.accountHasMessages && out.appHasMessages);
      console.log(`${new Date().toISOString()} [instagram-resubscribe] user=${req.session.userId} account=${out.accountHasMessages} app=${out.appHasMessages} acctErr=${out.accountError || '-'} appErr=${out.appError || '-'}`);
      res.json(out);
    } catch (err) {
      console.error(`${new Date().toISOString()} [instagram-resubscribe] FAILED user=${req.session.userId}: ${err.message}`);
      res.status(502).json({ success: false, message: err.message });
    }
  });

  // ── Config (seeded from WhatsApp on first read) ───────────────────────────
  router.get('/api/instagram/config', guard, requireAuth, async (req, res, next) => {
    try {
      const settings = await cfg.resolveInstagramConfig(req.session.userId, { database: db });
      res.json({ enabled: settings.enabled, seededFromWhatsapp: settings.seededFromWhatsapp, config: settings.config });
    } catch (err) { next(err); }
  });

  router.post('/api/instagram/config', guard, requireAuth, async (req, res, next) => {
    try {
      const { enabled: en, config } = req.body || {};
      await cfg.saveInstagramConfig(req.session.userId, { enabled: en, config }, { database: db });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  router.post('/api/instagram/ai-toggle', guard, requireAuth, async (req, res, next) => {
    try {
      await cfg.setAiEnabled(req.session.userId, (req.body || {}).enabled === true, { database: db });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // ── Sandbox "جرّب البوت" — dry-run reply using the Instagram brain ──────────
  // Mirrors /api/test-chat but powered by the merchant's INSTAGRAM config; never
  // sends a DM and never touches the shared quota.
  router.post('/api/instagram/test-chat', guard, requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId;
      const { sessionId, reset } = req.body || {};
      const key = `${userId}:${sessionId || 'default'}`;
      if (reset) {
        igTestThreads.delete(key);
        return res.json({ success: true, reset: true });
      }
      const message = String((req.body || {}).message || '').trim();
      if (!message) return res.status(400).json({ success: false, message: 'رسالة فارغة' });

      const history = igTestThreads.get(key) || [];
      history.push({ role: 'user', content: message });
      if (history.length > IG_TEST_MEMORY) history.splice(0, history.length - IG_TEST_MEMORY);

      const { reply, aiEnabled } = await generateTestReply(userId, history, { database: db });
      if (!reply) {
        // Roll back the pushed user turn so a failed generation doesn't poison memory.
        history.pop();
        return res.json({ success: true, reply: '', empty: true, aiEnabled, historyLength: history.length });
      }
      history.push({ role: 'assistant', content: reply });
      igTestThreads.set(key, history);
      res.json({ success: true, reply, aiEnabled, historyLength: history.length });
    } catch (err) { next(err); }
  });

  // ── Inbox ─────────────────────────────────────────────────────────────────
  router.get('/api/instagram/conversations', guard, requireAuth, async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT id, participant_id, participant_username, last_message_at, ai_paused
           FROM instagram_conversations WHERE user_id = $1
          ORDER BY last_message_at DESC NULLS LAST LIMIT 100`,
        [req.session.userId],
      );
      res.json({ conversations: result.rows });
    } catch (err) { next(err); }
  });

  router.get('/api/instagram/conversations/:id/messages', guard, requireAuth, async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT id, direction, role, content, status, created_at
           FROM instagram_messages WHERE conversation_id = $1 AND user_id = $2
          ORDER BY created_at ASC LIMIT 200`,
        [req.params.id, req.session.userId],
      );
      res.json({ messages: result.rows });
    } catch (err) { next(err); }
  });

  // ── Manual reply (still decrements the shared quota on send) ───────────────
  router.post('/api/instagram/conversations/:id/send', guard, requireAuth, async (req, res, next) => {
    try {
      const text = ((req.body || {}).text || '').trim();
      if (!text) return res.status(400).json({ error: 'empty_text' });
      const conv = await db.query(
        `SELECT participant_id, window_expires_at > NOW() AS window_open
           FROM instagram_conversations WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.session.userId],
      );
      if (!conv.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (!conv.rows[0].window_open) {
        return res.status(409).json({ error: 'instagram_window_closed' });
      }
      const participantId = conv.rows[0].participant_id;
      const stored = await db.query(
        `INSERT INTO instagram_messages
           (conversation_id, user_id, participant_id, direction, role, content, status)
         VALUES ($1,$2,$3,'outbound','assistant',$4,'queued_for_send') RETURNING id`,
        [req.params.id, req.session.userId, participantId, text],
      );
      await enqueueOutgoing({
        userId: req.session.userId,
        conversationId: req.params.id,
        participantId,
        recipientId: participantId,
        text,
        replyMessageId: stored.rows[0].id,
      });
      // A human agent just replied — pause the bot on this conversation so the
      // customer isn't answered by two voices. Mirrors the WhatsApp owner-pause
      // (conversations.escalated_until). Best-effort: never fail the send on it.
      try {
        const expiry = humanPauseExpiry(resolvePauseMinutes(env), Date.now());
        if (expiry) {
          await db.query(
            `UPDATE instagram_conversations SET escalated_until = $3 WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.session.userId, expiry],
          );
        }
      } catch (_) { /* pause is best-effort */ }
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createInstagramRoutes };
