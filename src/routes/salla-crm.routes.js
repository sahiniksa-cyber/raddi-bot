'use strict';

const express = require('express');
const defaultRead = require('../services/identity/crm-read');
const { compileRules, QUICK_SEGMENTS } = require('../services/identity/segment-rules');
const defaultStores = require('../services/salla/salla-stores');
const defaultSync = require('../services/salla/salla-sync');
const defaultBackfill = require('../services/identity/backfill');
const defaultDb = require('../db/client');

/**
 * Authenticated CRM dashboard API (سلة → العملاء). All routes are scoped to the
 * session merchant (req.session.userId) and gated behind SALLA_CRM_ENABLED so
 * the feature ships dark until switched on. Dependency-injectable for tests.
 */
function createSallaCrmRoutes(deps = {}) {
  const env = deps.env || process.env;
  const read = deps.crmRead || defaultRead;
  const stores = deps.sallaStores || defaultStores;
  const sync = deps.sallaSync || defaultSync;
  const backfill = deps.backfill || defaultBackfill;
  const db = deps.database || defaultDb;
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  const router = express.Router();
  const enabled = () => env.SALLA_CRM_ENABLED === 'true';
  const guard = (req, res, next) => (enabled() ? next() : res.status(503).json({ error: 'salla_crm_disabled' }));
  const uid = (req) => req.session && req.session.userId;

  // Resolve the rules object for a request: explicit body.rules (validated),
  // a quick-segment key, a saved segment id, or everyone.
  async function resolveRules(req) {
    const body = req.body || {};
    const query = req.query || {};
    if (body.rules) { compileRules(body.rules); return body.rules; } // throws → 400 upstream
    const key = body.segment || query.segment;
    if (key) {
      const quick = QUICK_SEGMENTS.find((s) => s.key === key);
      if (quick) return quick.rules;
    }
    const segId = body.segmentId || query.segmentId;
    if (segId) {
      const r = await db.query('SELECT rules FROM crm_segments WHERE user_id = $1 AND id = $2', [uid(req), segId]);
      if (r.rows[0]) return r.rows[0].rules;
    }
    return { segment: 'all' };
  }

  // ── Quick segments (§24) ────────────────────────────────────────────────────
  router.get('/api/salla/quick-segments', guard, requireAuth, (req, res) => {
    res.json({ segments: QUICK_SEGMENTS.map((s) => ({ key: s.key, name: s.name })) });
  });

  // ── Customer list (quick segment or saved segment via query) ────────────────
  router.get('/api/salla/customers', guard, requireAuth, async (req, res, next) => {
    try {
      const rules = await resolveRules(req);
      const out = await read.listCustomers(uid(req), {
        rules, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 50, search: req.query.search,
      }, { database: db });
      res.json(out);
    } catch (err) { next(err); }
  });

  // ── Customer 360 ────────────────────────────────────────────────────────────
  router.get('/api/salla/customers/:id', guard, requireAuth, async (req, res, next) => {
    try {
      const profile = await read.getCustomer360(uid(req), req.params.id, { database: db });
      if (!profile) return res.status(404).json({ error: 'not_found' });
      res.json(profile);
    } catch (err) { next(err); }
  });

  // ── Unified search ──────────────────────────────────────────────────────────
  router.get('/api/salla/search', guard, requireAuth, async (req, res, next) => {
    try {
      res.json({ results: await read.searchCustomers(uid(req), req.query.q, { database: db }) });
    } catch (err) { next(err); }
  });

  // ── Audience builder: live count + preview (arbitrary AND/OR rules) ─────────
  router.post('/api/salla/audience/count', guard, requireAuth, async (req, res, next) => {
    try {
      const rules = await resolveRules(req);
      res.json({ count: await read.countSegment(uid(req), rules, { database: db }) });
    } catch (err) {
      if (/unknown_|bad_number|in_requires/.test(err.message)) return res.status(400).json({ error: 'bad_rules', detail: err.message });
      next(err);
    }
  });
  router.post('/api/salla/audience/preview', guard, requireAuth, async (req, res, next) => {
    try {
      const rules = await resolveRules(req);
      const out = await read.listCustomers(uid(req), { rules, page: Number((req.body || {}).page) || 1, pageSize: 25 }, { database: db });
      res.json(out);
    } catch (err) {
      if (/unknown_|bad_number|in_requires/.test(err.message)) return res.status(400).json({ error: 'bad_rules', detail: err.message });
      next(err);
    }
  });

  // ── Saved segments CRUD ─────────────────────────────────────────────────────
  router.get('/api/salla/segments', guard, requireAuth, async (req, res, next) => {
    try {
      const r = await db.query('SELECT id, name, rules, is_quick, updated_at FROM crm_segments WHERE user_id = $1 ORDER BY updated_at DESC', [uid(req)]);
      res.json({ segments: r.rows, quick: QUICK_SEGMENTS.map((s) => ({ key: s.key, name: s.name })) });
    } catch (err) { next(err); }
  });
  router.post('/api/salla/segments', guard, requireAuth, async (req, res, next) => {
    try {
      const { name, rules } = req.body || {};
      if (!name || !rules) return res.status(400).json({ error: 'name_and_rules_required' });
      compileRules(rules); // validate
      const r = await db.query(
        'INSERT INTO crm_segments (user_id, name, rules) VALUES ($1,$2,$3::jsonb) RETURNING id',
        [uid(req), String(name), JSON.stringify(rules)],
      );
      res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
      if (/unknown_|bad_number|in_requires/.test(err.message)) return res.status(400).json({ error: 'bad_rules', detail: err.message });
      next(err);
    }
  });
  router.delete('/api/salla/segments/:id', guard, requireAuth, async (req, res, next) => {
    try {
      await db.query('DELETE FROM crm_segments WHERE user_id = $1 AND id = $2', [uid(req), req.params.id]);
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // ── Store link + sync status/trigger ────────────────────────────────────────
  router.get('/api/salla/crm-status', guard, requireAuth, async (req, res, next) => {
    try {
      const linked = await db.query(
        `SELECT merchant_id, store_name, status, token_expires_at FROM salla_stores WHERE user_id = $1 LIMIT 1`, [uid(req)]);
      const job = await db.query(
        `SELECT status, phase, customers_done, customers_total, orders_done, carts_done, completed_at, last_error
           FROM salla_sync_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid(req)]);
      res.json({ store: linked.rows[0] || null, lastSync: job.rows[0] || null });
    } catch (err) { next(err); }
  });

  // Claim an authorized-but-unlinked store for this merchant account.
  router.post('/api/salla/link', guard, requireAuth, async (req, res, next) => {
    try {
      const merchantId = String((req.body || {}).merchantId || '').trim();
      if (!merchantId) return res.status(400).json({ error: 'merchant_id_required' });
      const store = await stores.getStore(merchantId, { database: db });
      if (!store) return res.status(404).json({ error: 'store_not_found' });
      if (store.user_id && store.user_id !== uid(req)) return res.status(409).json({ error: 'store_already_linked' });
      await stores.linkUser(merchantId, uid(req), { database: db });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // Trigger the initial sync (background) for this merchant's store.
  router.post('/api/salla/sync', guard, requireAuth, async (req, res, next) => {
    try {
      const store = await db.query('SELECT merchant_id FROM salla_stores WHERE user_id = $1 LIMIT 1', [uid(req)]);
      const merchantId = store.rows[0] && store.rows[0].merchant_id;
      if (!merchantId) return res.status(400).json({ error: 'no_linked_store' });
      // Fire-and-forget; progress is polled via /api/salla/crm-status.
      Promise.resolve(sync.runInitialSync(uid(req), merchantId, {}))
        .catch((e) => console.error(`${new Date().toISOString()} [salla-sync] user=${uid(req)} failed: ${e.message}`));
      res.status(202).json({ success: true, started: true });
    } catch (err) { next(err); }
  });

  // Backfill existing WhatsApp data into the canonical customer model (background).
  router.post('/api/salla/backfill', guard, requireAuth, async (req, res) => {
    Promise.resolve(backfill.backfillUser(uid(req), {}))
      .catch((e) => console.error(`${new Date().toISOString()} [salla-backfill] user=${uid(req)} failed: ${e.message}`));
    res.status(202).json({ success: true, started: true });
  });

  return router;
}

module.exports = { createSallaCrmRoutes };
