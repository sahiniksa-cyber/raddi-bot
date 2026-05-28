'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Inject a fake db client BEFORE the service module loads.
const dbClientPath = require.resolve('../src/db/client');

class FakeDb {
  constructor() {
    this.billing_payments = new Map(); // provider_payment_id -> row
    this.billing_accounts = new Map(); // user_id -> row
    this.events = [];
    this.queries = [];
  }
  async _exec(text, params) {
    this.queries.push({ text, params });
    const t = text.trim();

    if (/SELECT user_id, status\s+FROM billing_payments/i.test(t)) {
      const row = this.billing_payments.get(params[1]);
      return { rows: row ? [{ user_id: row.user_id, status: row.status }] : [] };
    }
    if (/SELECT \* FROM billing_accounts/i.test(t)) {
      const row = this.billing_accounts.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO billing_payments/i.test(t)) {
      const userId = params[0];
      const providerPaymentId = params[1];
      const existing = this.billing_payments.get(providerPaymentId);
      // emulate the ON CONFLICT (provider, provider_payment_id) DO UPDATE branch
      if (existing) {
        existing.status = params[4] || existing.status;
        existing.webhook_verified_at = new Date();
        existing.webhook_signature = params[7];
      } else {
        this.billing_payments.set(providerPaymentId, {
          user_id: userId,
          provider: 'moyasar',
          provider_payment_id: providerPaymentId,
          amount_halalas: params[2],
          currency: params[3],
          status: params[4],
          method: params[5],
          webhook_verified_at: new Date(),
          webhook_signature: params[7],
        });
      }
      return { rows: [] };
    }
    if (/INSERT INTO billing_accounts/i.test(t)) {
      const userId = params[0];
      const prev = this.billing_accounts.get(userId) || { user_id: userId };
      const next = {
        ...prev,
        platform_access_status: 'active',
        activation_source: 'paid',
        access_activated_at: prev.access_activated_at || new Date(),
        access_suspended_at: null,
      };
      this.billing_accounts.set(userId, next);
      return { rows: [next] };
    }
    if (/UPDATE billing_accounts SET last_payment_at/i.test(t)) {
      const userId = params[0];
      const row = this.billing_accounts.get(userId);
      if (row) row.last_payment_at = new Date();
      return { rows: [] };
    }
    if (/INSERT INTO billing_events/i.test(t)) {
      this.events.push({ user_id: params[0], event_type: params[1], payload: params[2] });
      return { rows: [] };
    }
    if (/SELECT name, email FROM users/i.test(t)) {
      return { rows: [{ name: 'Test', email: 't@e.com' }] };
    }
    // default no-op
    return { rows: [] };
  }
  query(text, params = []) { return this._exec(text, params); }
  async transaction(fn) {
    const client = { query: (text, params = []) => this._exec(text, params) };
    return fn(client);
  }
  async withClient(fn) {
    const client = { query: (text, params = []) => this._exec(text, params) };
    return fn(client);
  }
}

const fake = new FakeDb();
require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true, exports: fake,
};

// stub excel-ledger to avoid filesystem writes during the test
const ledgerPath = require.resolve('../src/services/billing/excel-ledger');
require.cache[ledgerPath] = {
  id: ledgerPath, filename: ledgerPath, loaded: true,
  exports: { appendLedgerRow: async () => '/tmp/ledger.xlsx' },
};

delete require.cache[require.resolve('../src/services/billing/billing-service')];
const { handleMoyasarWebhookEvent } = require('../src/services/billing/billing-service');

function event({ id = 'pay_idem_1', userId = 'user-1', status = 'paid' } = {}) {
  return { data: { id, status, amount: 175000, currency: 'SAR', metadata: { user_id: userId } } };
}

test('handleMoyasarWebhookEvent activates the user on first paid event', async () => {
  const res = await handleMoyasarWebhookEvent(event(), 'sig-1');
  assert.equal(res.processed, true);
  assert.equal(res.activated, true);
  const acct = fake.billing_accounts.get('user-1');
  assert.equal(acct.platform_access_status, 'active');
  // exactly one access_active event
  assert.equal(fake.events.filter(e => e.event_type === 'access_active').length, 1);
});

test('handleMoyasarWebhookEvent is idempotent for replayed events (no double activation)', async () => {
  const before = fake.events.filter(e => e.event_type === 'access_active').length;
  const res2 = await handleMoyasarWebhookEvent(event(), 'sig-2');
  assert.equal(res2.processed, true);
  assert.equal(res2.alreadyProcessed, true);
  const after = fake.events.filter(e => e.event_type === 'access_active').length;
  assert.equal(after, before, 'no new access_active event emitted on replay');
  // billing_payments still has exactly one row for this id
  const row = fake.billing_payments.get('pay_idem_1');
  assert.ok(row);
  assert.equal(row.status, 'paid');
});

test('handleMoyasarWebhookEvent rejects an event whose metadata user mismatches existing row', async () => {
  await assert.rejects(
    handleMoyasarWebhookEvent(event({ userId: 'user-2' }), 'sig-3'),
    /already used by another account/,
  );
});

test('handleMoyasarWebhookEvent ignores non-paid statuses without activating', async () => {
  const res = await handleMoyasarWebhookEvent(event({ id: 'pay_pending', status: 'initiated' }), 'sig-4');
  assert.equal(res.processed, false);
  assert.match(String(res.reason || ''), /status_initiated/);
  assert.equal(fake.billing_accounts.has('pay_pending'), false);
});

test('handleMoyasarWebhookEvent rejects when metadata user_id is missing', async () => {
  await assert.rejects(
    handleMoyasarWebhookEvent({ data: { id: 'pay_anon', status: 'paid' } }, 'sig-5'),
    /Missing user_id/,
  );
});

test.after(() => {
  delete require.cache[dbClientPath];
  delete require.cache[ledgerPath];
  delete require.cache[require.resolve('../src/services/billing/billing-service')];
});
