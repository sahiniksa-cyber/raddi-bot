'use strict';

const express = require('express');
const { verifyInstagramSignature } = require('../services/instagram/instagram-signature');
const defaultOauth = require('../services/instagram/instagram-oauth');
const defaultAccounts = require('../services/instagram/instagram-accounts');
const defaultIngest = require('../services/instagram/instagram-ingest');
const defaultGraph = require('../services/instagram/instagram-graph');
const defaultConfig = require('../services/instagram/instagram-config');
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
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

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
    try {
      const body = JSON.parse(req.body.toString('utf8'));
      const items = ingest.extractMessages(body);
      for (const item of items) {
        if (item.echo || !item.text) continue;
        const userId = await accounts.findUserIdByIgAccount(item.igAccountId);
        if (userId) await ingest.ingestWebhookEntry(userId, item);
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} [instagram-webhook] ${err.message}`);
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
      try { await graph.subscribeToMessages({ token: long.accessToken }, { env }); } catch (_) { /* retryable later */ }
      res.redirect('/#instagram');
    } catch (err) { next(err); }
  });

  // ── Status ────────────────────────────────────────────────────────────────
  router.get('/api/instagram/status', guard, requireAuth, async (req, res, next) => {
    try {
      const acc = await accounts.getAccount(req.session.userId, { database: db });
      const settings = await cfg.resolveInstagramConfig(req.session.userId, { database: db });
      res.json({
        connected: Boolean(acc && acc.status === 'connected'),
        username: acc ? acc.ig_username : null,
        tokenExpiresAt: acc ? acc.token_expires_at : null,
        aiEnabled: settings.enabled === true,
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
