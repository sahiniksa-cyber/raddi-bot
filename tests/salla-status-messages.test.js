'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../src/services/salla/salla-status-messages');
const ingest = require('../src/services/salla/salla-ingest');

test('renderMessage interpolates known variables and blanks unknown ones', () => {
  const out = sm.renderMessage('هلا {customer_name} 👋 طلبك {order_id} حالته {order_status} من {store_name}. {nope}', {
    customer_name: 'محمد', order_id: '28192', order_status: 'shipped', store_name: 'بروستور',
  });
  assert.equal(out, 'هلا محمد 👋 طلبك 28192 حالته shipped من بروستور. ');
});

test('listStatusMessages merges the standard statuses with saved rows + custom slugs', async () => {
  const db = { query: async () => ({ rows: [
    { status_slug: 'shipped', enabled: true, message_text: 'طلبك تشحّن' },
    { status_slug: 'my_custom', enabled: true, message_text: 'حالة مخصصة' },
  ] }) };
  const list = await sm.listStatusMessages('u1', { database: db });
  const shipped = list.find((s) => s.slug === 'shipped');
  assert.equal(shipped.enabled, true);
  assert.equal(shipped.message, 'طلبك تشحّن');
  assert.equal(shipped.label, 'تم الشحن');
  const pending = list.find((s) => s.slug === 'payment_pending');
  assert.equal(pending.enabled, false); // not saved → default off
  assert.ok(list.some((s) => s.slug === 'my_custom'), 'custom slug is included');
});

test('upsertStatusMessage writes enabled + trimmed message', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await sm.upsertStatusMessage('u1', 'shipped', { enabled: true, message: 'x' }, { database: db });
  assert.match(calls[0].sql, /INSERT INTO salla_status_messages/);
  assert.deepEqual(calls[0].params, ['u1', 'shipped', true, 'x']);
  await assert.rejects(() => sm.upsertStatusMessage('u1', '', {}, { database: db }));
});

test('resolveForStatus returns the message only when enabled and non-empty', async () => {
  const on = { query: async () => ({ rows: [{ enabled: true, message_text: 'مرحبا' }] }) };
  const off = { query: async () => ({ rows: [{ enabled: false, message_text: 'مرحبا' }] }) };
  const blank = { query: async () => ({ rows: [{ enabled: true, message_text: '   ' }] }) };
  assert.equal(await sm.resolveForStatus('u1', 'shipped', { database: on }), 'مرحبا');
  assert.equal(await sm.resolveForStatus('u1', 'shipped', { database: off }), null);
  assert.equal(await sm.resolveForStatus('u1', 'shipped', { database: blank }), null);
});

test('order.status.updated dispatches the rendered ready-made message', async () => {
  const sent = [];
  const deps = {
    database: { query: async () => ({ rows: [] }) },
    resolver: { resolveCustomer: async () => ({ customerId: 'c1' }) },
    metrics: { isQualifiedPurchase: () => true, recomputeCustomer: async () => {} },
    statusMessages: { resolveForStatus: async () => 'طلبك {order_id} حالته {order_status}', renderMessage: sm.renderMessage },
    sendStatusMessage: async (m) => { sent.push(m); },
    storeName: 'بروستور',
  };
  const body = { event: 'order.status.updated', data: { id: 28192, reference_id: 'R9', status: { slug: 'shipped' }, total: { amount: 1 }, customer: { id: 7, name: 'محمد', mobile_code: '966', mobile: '501234567' } } };
  const res = await ingest.ingestWebhookEvent('u1', body, deps);
  assert.equal(res.kind, 'order');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '966501234567');
  assert.equal(sent[0].text, 'طلبك R9 حالته shipped');
});

test('no dispatch when the merchant has not wired a sender (inert seam)', async () => {
  const deps = {
    database: { query: async () => ({ rows: [] }) },
    resolver: { resolveCustomer: async () => ({ customerId: 'c1' }) },
    metrics: { isQualifiedPurchase: () => true, recomputeCustomer: async () => {} },
    statusMessages: { resolveForStatus: async () => 'x', renderMessage: sm.renderMessage },
    // no sendStatusMessage
  };
  const r = await ingest.maybeSendStatusMessage('u1', { id: 1, status: { slug: 'shipped' }, customer: { mobile_code: '966', mobile: '5' } }, deps);
  assert.equal(r, null);
});
