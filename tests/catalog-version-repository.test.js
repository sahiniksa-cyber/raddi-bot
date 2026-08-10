'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCatalogVersion,
  saveCatalogVersion,
} = require('../src/services/products/catalog-version-repository');

function makeDatabase() {
  const rows = [];
  const calls = [];
  let chain = Promise.resolve();
  return {
    rows,
    calls,
    transaction(callback) {
      const result = chain.then(() => callback({
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
          if (/ORDER BY version DESC/.test(sql)) {
            const latest = rows.filter(row => row.user_id === params[0]).at(-1);
            return { rows: latest ? [latest] : [] };
          }
          if (/INSERT INTO product_catalog_versions/.test(sql)) {
            const row = {
              user_id: params[0],
              version: params[1],
              products: JSON.parse(params[2]),
              previous_products: JSON.parse(params[3]),
              changed_by: params[4],
              change_reason: params[5],
              source: params[6],
              created_at: '2026-07-26T00:00:00.000Z',
            };
            rows.push(row);
            return { rows: [row] };
          }
          throw new Error(`unexpected transaction SQL: ${sql}`);
        },
      }));
      chain = result.then(() => undefined, () => undefined);
      return result;
    },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/WHERE user_id = \$1 AND version = \$2/.test(sql)) {
        return { rows: rows.filter(row => row.user_id === params[0] && row.version === params[1]) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('saveCatalogVersion stores immutable before/after snapshots with actor and reason', async () => {
  const database = makeDatabase();
  const first = await saveCatalogVersion({
    database,
    scope: { tenantId: 'tenant-1' },
    products: [{ id: 'adobe', price: '189' }],
    actor: 'merchant:user-1',
    reason: 'initial setup',
    source: 'dashboard',
  });
  const second = await saveCatalogVersion({
    database,
    scope: { tenantId: 'tenant-1' },
    products: [{ id: 'adobe', price: '199' }],
    actor: 'merchant:user-1',
    reason: 'price change',
    source: 'dashboard',
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.deepEqual(second.previousProducts, [{ id: 'adobe', price: '189' }]);
  assert.deepEqual(second.products, [{ id: 'adobe', price: '199' }]);
  assert.equal(second.changedBy, 'merchant:user-1');
  assert.equal(second.changeReason, 'price change');
  assert.ok(database.calls.some(call => /pg_advisory_xact_lock/.test(call.sql)));
});

test('concurrent catalog saves receive distinct monotonic versions', async () => {
  const database = makeDatabase();
  const results = await Promise.all([
    saveCatalogVersion({
      database,
      scope: { tenantId: 'tenant-1' },
      products: [{ id: 'adobe', price: '189' }],
      actor: 'merchant:user-1',
    }),
    saveCatalogVersion({
      database,
      scope: { tenantId: 'tenant-1' },
      products: [{ id: 'adobe', price: '199' }],
      actor: 'merchant:user-1',
    }),
  ]);

  assert.deepEqual(results.map(result => result.version), [1, 2]);
});

test('saving an unchanged catalog reuses the current version without audit noise', async () => {
  const database = makeDatabase();
  const input = {
    database,
    scope: { tenantId: 'tenant-1' },
    products: [{ id: 'adobe', price: '189' }],
    actor: 'merchant:user-1',
  };
  const first = await saveCatalogVersion(input);
  const second = await saveCatalogVersion(input);

  assert.equal(first.version, 1);
  assert.equal(second.version, 1);
  assert.equal(second.unchanged, true);
  assert.equal(database.rows.length, 1);
});

test('loadCatalogVersion always scopes by tenant and version', async () => {
  const database = makeDatabase();
  await saveCatalogVersion({
    database,
    scope: { tenantId: 'tenant-1' },
    products: [{ id: 'adobe', price: '189' }],
    actor: 'system',
  });
  const loaded = await loadCatalogVersion({
    database,
    tenantId: 'tenant-1',
    version: 1,
  });

  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.products, [{ id: 'adobe', price: '189' }]);
  const query = database.calls.at(-1);
  assert.deepEqual(query.params, ['tenant-1', 1]);
});

test('catalog repository rejects missing tenant scope before querying', async () => {
  const database = makeDatabase();
  await assert.rejects(
    saveCatalogVersion({ database, scope: {}, products: [], actor: 'system' }),
    /tenantId/,
  );
  assert.equal(database.calls.length, 0);
});
