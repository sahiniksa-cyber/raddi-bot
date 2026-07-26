'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLocalDatabaseUrl,
  parseArgs,
  runMerchantPolicyMigration,
  summarizeMigrationResult,
} = require('../../scripts/migrate-merchant-policy');
const {
  migrateLegacyConfig,
} = require('../../src/policy/merchant-policy-migrator');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDatabase(rows) {
  const state = clone(rows);
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params: clone(params) });
      if (/^SELECT user_id, config FROM bot_configs ORDER BY user_id(?: FOR UPDATE)?/i.test(
        normalized,
      )) {
        return { rows: clone(state), rowCount: state.length };
      }
      if (/^UPDATE bot_configs SET config = \$2::jsonb/i.test(normalized)) {
        const row = state.find((candidate) => candidate.user_id === params[0]);
        row.config = clone(params[1]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };
  return {
    state,
    calls,
    database: {
      query: client.query.bind(client),
      async transaction(work) {
        const before = clone(state);
        calls.push({ sql: 'BEGIN', params: [] });
        try {
          const result = await work(client);
          calls.push({ sql: 'COMMIT', params: [] });
          return result;
        } catch (error) {
          state.splice(0, state.length, ...before);
          calls.push({ sql: 'ROLLBACK', params: [] });
          throw error;
        }
      },
    },
  };
}

test('arguments default to dry-run and only explicit --apply enables writes', () => {
  assert.deepEqual(parseArgs([]), { apply: false, databaseUrl: null, rollbackFile: null });
  assert.equal(parseArgs(['--dry-run']).apply, false);
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /mutually exclusive/);
});

test('dry-run preserves legacy fields and emits only merchant IDs needing review', async () => {
  const original = {
    user_id: 'merchant-review',
    config: {
      customLegacyField: { keep: true },
      botInstructions: 'Free-form facts need human review',
    },
  };
  const { database, state, calls } = makeDatabase([
    original,
    { user_id: 'merchant-clean', config: { products: [] } },
  ]);

  const result = await runMerchantPolicyMigration({ database });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, 0);
  assert.deepEqual(result.reviewIds, ['merchant-review']);
  assert.deepEqual(state[0], original);
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
  const reviewed = result.merchants.find((merchant) => merchant.userId === 'merchant-review');
  assert.deepEqual(reviewed.migratedConfig.customLegacyField, { keep: true });
  assert.equal(reviewed.migratedConfig.botInstructions, original.config.botInstructions);
  assert.equal(reviewed.reviewItems[0].code, 'untyped_bot_instructions');
  assert.deepEqual(reviewed.rollbackConfig, original.config);
});

test('dry-run needs only an injected query contract and never opens a configured database', async () => {
  const queryOnlyDatabase = {
    async query() {
      return { rows: [{ user_id: 'merchant-one', config: { products: [] } }] };
    },
  };

  const result = await runMerchantPolicyMigration({ database: queryOnlyDatabase });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, 0);
});

test('apply saves rollback payload before updating bot_configs and preserves legacy fields', async () => {
  const originalConfig = {
    customLegacyField: 'keep-me',
    products: [],
  };
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: originalConfig },
  ]);
  let rollbackPayload;

  const result = await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      calls.push({ sql: 'PRESERVE_ROLLBACK', params: [] });
      rollbackPayload = clone(payload);
    },
  });

  assert.equal(result.mode, 'apply');
  assert.equal(result.applied, 1);
  assert.deepEqual(rollbackPayload, {
    merchantConfigs: [{ userId: 'merchant-apply', config: originalConfig }],
  });
  assert.equal(state[0].config.customLegacyField, 'keep-me');
  assert.ok(state[0].config.merchantPolicy);
  assert.ok(
    calls.findIndex((call) => call.sql === 'PRESERVE_ROLLBACK')
      < calls.findIndex((call) => /^UPDATE bot_configs/i.test(call.sql)),
  );
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /SELECT user_id, config FROM bot_configs ORDER BY user_id FOR UPDATE/i);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('rollback payload preserves an existing merchantPolicy byte-for-byte', async () => {
  const originalConfig = migrateLegacyConfig({
    customLegacyField: 'keep-me',
    products: [],
  }).migratedConfig;
  const { database } = makeDatabase([
    { user_id: 'merchant-existing-policy', config: originalConfig },
  ]);
  let rollbackPayload;

  await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      rollbackPayload = clone(payload);
    },
  });

  assert.deepEqual(rollbackPayload, {
    merchantConfigs: [{
      userId: 'merchant-existing-policy',
      config: originalConfig,
    }],
  });
});

test('apply refuses missing rollback preservation and never falls back to a configured database', async () => {
  const { database, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: { products: [] } },
  ]);

  await assert.rejects(
    runMerchantPolicyMigration({ database, apply: true }),
    /rollbackSink/,
  );
  await assert.rejects(
    runMerchantPolicyMigration({ apply: true, rollbackSink: async () => {} }),
    /injected database/,
  );
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
});

test('rollback preservation failure aborts apply before any config update', async () => {
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: { products: [] } },
  ]);

  await assert.rejects(
    runMerchantPolicyMigration({
      database,
      apply: true,
      rollbackSink: async () => {
        throw new Error('rollback storage failed');
      },
    }),
    /rollback storage failed/,
  );

  assert.deepEqual(state[0].config, { products: [] });
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('CLI database guard accepts loopback only and rejects hosted connection strings', () => {
  assert.equal(
    assertLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/local'),
    'postgres://user:pass@127.0.0.1:5432/local',
  );
  assert.throws(
    () => assertLocalDatabaseUrl('postgres://user:pass@prod.railway.app:5432/main'),
    /local PostgreSQL/,
  );
});

test('CLI summary excludes full migrated and rollback configs', () => {
  const summary = summarizeMigrationResult({
    mode: 'dry-run',
    applied: 0,
    reviewIds: ['merchant-review'],
    merchants: [{
      userId: 'merchant-review',
      status: 'needs_review',
      reviewItems: [{ path: 'botInstructions', code: 'untyped_bot_instructions' }],
      migratedConfig: { openaiApiKey: 'secret-migrated' },
      rollbackConfig: { openaiApiKey: 'secret-rollback' },
    }],
  });

  assert.deepEqual(summary, {
    mode: 'dry-run',
    applied: 0,
    reviewIds: ['merchant-review'],
    merchants: [{
      userId: 'merchant-review',
      status: 'needs_review',
      reviewItems: [{ path: 'botInstructions', code: 'untyped_bot_instructions' }],
    }],
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});
