'use strict';

/**
 * SQL-backed implementation of the customer-store interface used by
 * identity-resolver. One row per canonical customer in `crm_customers`, with
 * `crm_identities` as the resolution index. The resolver holds all the
 * matching/merge POLICY (unit-tested against an in-memory fake); this module is
 * the thin, careful persistence layer.
 *
 * Concurrency: DB unique indexes (`uniq_crm_customers_user_phone`,
 * `crm_identities (user_id, identity_type, identity_value)`) are the real
 * guarantee against duplicates under races; createCustomer/addIdentity recover
 * from a 23505 by returning the winning row.
 */

const db = require('../../db/client');

// Tables that carry a nullable customer_id link and must follow a merge.
const LINKED_TABLES = Object.freeze([
  'crm_orders', 'crm_carts', 'crm_timeline_events',
  'conversations', 'campaign_contacts', 'customer_product_signals', 'campaign_recipients',
]);

async function findCustomerIdByIdentity(userId, type, value, deps = {}) {
  const database = deps.database || db;
  const r = await database.query(
    'SELECT customer_id FROM crm_identities WHERE user_id = $1 AND identity_type = $2 AND identity_value = $3',
    [userId, type, value],
  );
  return r.rows[0] ? r.rows[0].customer_id : null;
}

async function createCustomer(userId, f = {}, deps = {}) {
  const database = deps.database || db;
  const params = [userId, f.canonical_phone || null, f.email || null, f.salla_customer_id || null, f.display_name || null, f.first_seen_at || null];
  try {
    const r = await database.query(
      `INSERT INTO crm_customers (user_id, canonical_phone, email, salla_customer_id, display_name, first_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      params,
    );
    return r.rows[0].id;
  } catch (e) {
    if (e && e.code === '23505') {
      // Lost a race on the phone/salla unique index — return the winner.
      const r = await database.query(
        `SELECT id FROM crm_customers
          WHERE user_id = $1
            AND ((canonical_phone IS NOT NULL AND canonical_phone = $2)
              OR (salla_customer_id IS NOT NULL AND salla_customer_id = $3))
          LIMIT 1`,
        [userId, f.canonical_phone || null, f.salla_customer_id || null],
      );
      if (r.rows[0]) return r.rows[0].id;
    }
    throw e;
  }
}

async function addIdentity(userId, customerId, type, value, reason, confidence, deps = {}) {
  const database = deps.database || db;
  const r = await database.query(
    `INSERT INTO crm_identities (user_id, customer_id, identity_type, identity_value, match_reason, confidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, identity_type, identity_value) DO NOTHING
     RETURNING customer_id`,
    [userId, customerId, type, value, reason || null, confidence != null ? confidence : 0.5],
  );
  if (r.rows[0]) return r.rows[0].customer_id;
  const existing = await findCustomerIdByIdentity(userId, type, value, deps);
  return existing || customerId;
}

async function getCustomer(userId, id, deps = {}) {
  const database = deps.database || db;
  const r = await database.query('SELECT * FROM crm_customers WHERE user_id = $1 AND id = $2', [userId, id]);
  return r.rows[0] || null;
}

async function updateCustomerFields(userId, id, f = {}, deps = {}) {
  const database = deps.database || db;
  // Fill only-if-empty (keep the first strong value); first_seen_at keeps the
  // EARLIEST. Never overwrites an existing phone/salla id with a different one —
  // conflicting values go through the resolver's merge/suggestion path instead.
  await database.query(
    `UPDATE crm_customers SET
       canonical_phone   = COALESCE(canonical_phone, $3),
       email             = COALESCE(email, $4),
       salla_customer_id = COALESCE(salla_customer_id, $5),
       display_name      = COALESCE(display_name, $6),
       first_seen_at     = CASE
                             WHEN $7::timestamptz IS NOT NULL AND (first_seen_at IS NULL OR $7 < first_seen_at)
                             THEN $7 ELSE first_seen_at END
     WHERE user_id = $1 AND id = $2`,
    [userId, id, f.canonical_phone || null, f.email || null, f.salla_customer_id || null, f.display_name || null, f.first_seen_at || null],
  );
}

async function mergeCustomers(userId, keepId, mergeId, reason, matchedOn, deps = {}) {
  const database = deps.database || db;
  if (keepId === mergeId) return;
  await database.transaction(async (client) => {
    // Drop merged identities that would collide with keep's on the unique index.
    await client.query(
      `DELETE FROM crm_identities m
        WHERE m.customer_id = $2
          AND EXISTS (SELECT 1 FROM crm_identities k
                       WHERE k.user_id = m.user_id AND k.identity_type = m.identity_type
                         AND k.identity_value = m.identity_value AND k.customer_id = $1)`,
      [keepId, mergeId],
    );
    await client.query('UPDATE crm_identities SET customer_id = $1 WHERE customer_id = $2', [keepId, mergeId]);
    for (const table of LINKED_TABLES) {
      await client.query(`UPDATE ${table} SET customer_id = $1 WHERE customer_id = $2`, [keepId, mergeId]);
    }
    // Merged metrics are dropped (keep's will be recomputed from raw sources).
    await client.query('DELETE FROM crm_customer_metrics WHERE customer_id = $1', [mergeId]);
    await client.query(
      `UPDATE crm_customers k SET
         canonical_phone   = COALESCE(k.canonical_phone, m.canonical_phone),
         email             = COALESCE(k.email, m.email),
         salla_customer_id = COALESCE(k.salla_customer_id, m.salla_customer_id),
         display_name      = COALESCE(k.display_name, m.display_name),
         first_seen_at     = LEAST(k.first_seen_at, m.first_seen_at)
       FROM crm_customers m WHERE k.id = $1 AND m.id = $2`,
      [keepId, mergeId],
    );
    await client.query(
      `INSERT INTO crm_merge_history (user_id, kept_customer_id, merged_customer_id, reason, matched_on)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [userId, keepId, mergeId, reason || 'merge', JSON.stringify(matchedOn || {})],
    );
    await client.query('DELETE FROM crm_customers WHERE id = $1', [mergeId]);
  });
}

module.exports = {
  findCustomerIdByIdentity,
  createCustomer,
  addIdentity,
  getCustomer,
  updateCustomerFields,
  mergeCustomers,
  LINKED_TABLES,
};
