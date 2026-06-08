'use strict';

// Operator-initiated start (dashboard button / restart) must STEAL the
// connection lease. The deployment is single-replica, so a lease still pointing
// at a different instanceId is a dead previous container — waiting out its TTL
// is the "press start, nothing happens for ~2 minutes" bug from production logs
// ("WhatsApp lease is held by another instance; postponing manual").

const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

function fakeThis(queryRecorder) {
  return {
    userId: 'u1',
    instanceId: 'new-instance',
    leaseExpiresAt: () => new Date(),
    logger: { warn() {}, info() {} },
    scheduleLeaseRetry() { this._retried = true; },
    startLeaseRenewal() {},
    db: {
      query: async (sql, params) => {
        queryRecorder.push({ sql, params });
        // Simulate a row owned by ANOTHER instance: the polite guard (detected by
        // the "connection_owner IS NULL" clause, present only when NOT forced)
        // matches 0 rows; the forced query matches the row.
        const hasOwnerGuard = /connection_owner IS NULL/.test(sql);
        return { rows: hasOwnerGuard ? [] : [{ connection_owner: 'new-instance' }], rowCount: hasOwnerGuard ? 0 : 1 };
      },
    },
  };
}

test('force=true claims the lease even when another instance holds it', async () => {
  const queries = [];
  const ctx = fakeThis(queries);
  const ok = await RuntimeBot.prototype.acquireConnectionLease.call(ctx, 'manual', { force: true });
  assert.equal(ok, true, 'forced acquire must succeed (steal the lease)');
  assert.doesNotMatch(queries[0].sql, /connection_owner IS NULL/, 'forced query omits the owner guard');
  assert.equal(ctx._retried, undefined, 'must not fall back to polite retry');
});

test('default (polite) acquire backs off when another instance holds the lease', async () => {
  const queries = [];
  const ctx = fakeThis(queries);
  const ok = await RuntimeBot.prototype.acquireConnectionLease.call(ctx, 'auto_recover');
  assert.equal(ok, false, 'polite acquire yields to the current owner');
  assert.match(queries[0].sql, /connection_owner IS NULL/, 'polite query keeps the owner guard');
  assert.equal(ctx._retried, true, 'polite path schedules a retry');
});
