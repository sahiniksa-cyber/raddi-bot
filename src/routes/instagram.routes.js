'use strict';

const express = require('express');
const { verifyInstagramSignature } = require('../services/instagram/instagram-signature');
const defaultOauth = require('../services/instagram/instagram-oauth');
const defaultAccounts = require('../services/instagram/instagram-accounts');
const defaultIngest = require('../services/instagram/instagram-ingest');
const defaultGraph = require('../services/instagram/instagram-graph');
const defaultConfig = require('../services/instagram/instagram-config');
const { generateInstagramTestReply: defaultGenerateTestReply } = require('../services/instagram/instagram-test-reply');
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
    if (!verifyInstagramSignature(req.body, sig, env.INSTAGRAM_APP_SECRET)) {
      return res.sendStatus(401);
    }
    // Acknowledge immediately so a slow DB never times out Meta's delivery.
    res.sendStatus(200);
    if (!enabled()) return;
    const ts = () => new Date().toISOString();
    try {
      const body = JSON.parse(req.body.toString('utf8'));
      const items = ingest.extractMessages(body);
      const inbound = items.filter((it) => !it.echo && it.text);
      // Always log receipt so Railway logs prove whether Meta is delivering at all.
      console.log(`${ts()} [instagram-webhook] received: ${items.length} event(s), ${inbound.length} inbound text — ids=${[...new Set(items.map((i) => i.igAccountId))].join(',')}`);
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
            console.warn(`${ts()} [instagram-webhook] NO MATCHING ACCOUNT for igAccountId=${item.igAccountId} — message from ${item.participantId} dropped`);
            continue;
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
    } catch (err) {
      console.error(`${ts()} [instagram-webhook] ${err.message}`);
    }
  });

  // ── OAuth: start ──────────────────────────────────────────────────────────
  router.get('/api/instagram/connect', guard, requireAuth, (req, res) => {
    const state = req.session && req.session.userId;
    res.redirect(oauth.buildAuthorizeUrl(state, { env }));
  });

  // ── OAuth: callback ───────────────────────────────────────────────────────
  router.get('/instagram/auth/callback', guard, requireAuth, async (req, res, next) => {
    try {
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

  // ── Re-subscribe to the `messages` webhook field ───────────────────────────
  // Self-serve fix when the subscription didn't take at connect time. Surfaces
  // Meta's actual response/error instead of swallowing it.
  router.post('/api/instagram/resubscribe', guard, requireAuth, async (req, res) => {
    try {
      const token = await accounts.getAccountToken(req.session.userId, { database: db });
      if (!token) return res.status(400).json({ success: false, message: 'اربط حساب إنستقرام أولاً' });
      const result = await graph.subscribeToMessages({ token }, { env });
      let after = null;
      try { after = await graph.getSubscribedApps({ token }, { env }); } catch (_) { /* best-effort */ }
      console.log(`${new Date().toISOString()} [instagram-resubscribe] user=${req.session.userId} result=${JSON.stringify(result)} fields=${after ? after.fields.join(',') : '?'}`);
      res.json({ success: true, result, hasMessages: after ? after.hasMessages : null, fields: after ? after.fields : [] });
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
        `SELECT participant_id FROM instagram_conversations WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.session.userId],
      );
      if (!conv.rows[0]) return res.status(404).json({ error: 'not_found' });
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
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createInstagramRoutes };
