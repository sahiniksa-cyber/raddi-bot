'use strict';

function requireDatabase(database) {
  if (!database || typeof database.query !== 'function') {
    throw new Error('catalog version database is required');
  }
  return database;
}

function requireTenantId(scopeOrTenant) {
  const tenantId = typeof scopeOrTenant === 'string'
    ? scopeOrTenant
    : scopeOrTenant?.tenantId;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required for catalog version access');
  }
  return tenantId;
}

function cloneJson(value, fallback = []) {
  const source = value == null ? fallback : value;
  return JSON.parse(JSON.stringify(source));
}

function mapRow(row) {
  if (!row) return null;
  return {
    tenantId: row.user_id,
    version: Number(row.version),
    products: cloneJson(row.products),
    previousProducts: cloneJson(row.previous_products),
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    source: row.source,
    createdAt: row.created_at,
  };
}

async function saveCatalogVersion({
  database,
  scope,
  products,
  actor,
  reason = null,
  source = 'unknown',
}) {
  requireDatabase(database);
  const tenantId = requireTenantId(scope);
  const nextProducts = cloneJson(products);
  const changedBy = String(actor || '').trim();
  if (!changedBy) throw new Error('actor is required for catalog version changes');

  const write = async (client) => {
    // Serialise version assignment per tenant. This prevents two dashboard
    // saves from receiving the same version under concurrent requests.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [tenantId],
    );
    const latestResult = await client.query(
      `SELECT user_id, version, products, previous_products, changed_by,
              change_reason, source, created_at
         FROM product_catalog_versions
        WHERE user_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId],
    );
    const latest = latestResult.rows[0] || null;
    if (latest && JSON.stringify(cloneJson(latest.products)) === JSON.stringify(nextProducts)) {
      return { ...mapRow(latest), unchanged: true };
    }
    const version = Number(latest?.version || 0) + 1;
    const previousProducts = cloneJson(latest?.products);
    const inserted = await client.query(
      `INSERT INTO product_catalog_versions
        (user_id, version, products, previous_products, changed_by, change_reason, source)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
       RETURNING user_id, version, products, previous_products, changed_by,
                 change_reason, source, created_at`,
      [
        tenantId,
        version,
        JSON.stringify(nextProducts),
        JSON.stringify(previousProducts),
        changedBy,
        reason == null ? null : String(reason),
        String(source || 'unknown'),
      ],
    );
    return { ...mapRow(inserted.rows[0]), unchanged: false };
  };
  return typeof database.transaction === 'function'
    ? database.transaction(write)
    : write(database);
}

async function loadCatalogVersion({ database, tenantId, version }) {
  requireDatabase(database);
  const scopedTenantId = requireTenantId(tenantId);
  const numericVersion = Number(version);
  if (!Number.isSafeInteger(numericVersion) || numericVersion <= 0) {
    throw new Error('positive catalog version is required');
  }
  const result = await database.query(
    `SELECT user_id, version, products, previous_products, changed_by,
            change_reason, source, created_at
       FROM product_catalog_versions
      WHERE user_id = $1 AND version = $2`,
    [scopedTenantId, numericVersion],
  );
  return mapRow(result.rows[0]);
}

async function loadLatestCatalogVersion({ database, tenantId }) {
  requireDatabase(database);
  const scopedTenantId = requireTenantId(tenantId);
  const result = await database.query(
    `SELECT user_id, version, products, previous_products, changed_by,
            change_reason, source, created_at
       FROM product_catalog_versions
      WHERE user_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [scopedTenantId],
  );
  return mapRow(result.rows[0]);
}

module.exports = {
  loadCatalogVersion,
  loadLatestCatalogVersion,
  saveCatalogVersion,
};
