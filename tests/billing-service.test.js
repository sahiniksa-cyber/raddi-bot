'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdminCustomerRow,
  isActiveAccess,
  isValidActivationCode,
  normalizeAccessStatus,
  paymentAlreadyUsedByAnotherUser,
} = require('../src/services/billing/billing-service');

test('normalizeAccessStatus accepts only known access states', () => {
  assert.equal(normalizeAccessStatus('active'), 'active');
  assert.equal(normalizeAccessStatus('free'), 'free');
  assert.equal(normalizeAccessStatus('suspended'), 'suspended');
  assert.equal(normalizeAccessStatus('anything'), 'unpaid');
});

test('isActiveAccess treats active and free as usable access', () => {
  assert.equal(isActiveAccess('active'), true);
  assert.equal(isActiveAccess('free'), true);
  assert.equal(isActiveAccess('unpaid'), false);
  assert.equal(isActiveAccess('suspended'), false);
});

test('buildAdminCustomerRow formats billing and connection fields for owner table', () => {
  const row = buildAdminCustomerRow({
    id: 'user-1',
    name: 'Mohammed',
    email: 'M@Example.COM',
    role: 'user',
    created_at: '2026-05-13T10:00:00.000Z',
    platform_access_status: 'active',
    activation_source: 'paid',
    receivable_halalas: 2500,
    message_price_halalas: 12,
    internal_note: 'VIP',
    last_payment_at: '2026-05-13T11:00:00.000Z',
    whatsapp_status: 'connected',
    whatsapp_phone: '966500000000',
  });

  assert.equal(row.userId, 'user-1');
  assert.equal(row.email, 'm@example.com');
  assert.equal(row.accessStatus, 'active');
  assert.equal(row.accessActive, true);
  assert.equal(row.receivableSar, '25.00');
  assert.equal(row.messagePriceSar, '0.12');
  assert.equal(row.whatsappStatus, 'connected');
});

test('isValidActivationCode matches configured codes exactly after trimming', () => {
  assert.equal(isValidActivationCode(' FREE123 ', { activationCodes: ['FREE123'] }), true);
  assert.equal(isValidActivationCode('free123', { activationCodes: ['FREE123'] }), false);
  assert.equal(isValidActivationCode('', { activationCodes: ['FREE123'] }), false);
});

test('paymentAlreadyUsedByAnotherUser detects reused provider payment ids', () => {
  assert.equal(paymentAlreadyUsedByAnotherUser(null, 'user-1'), false);
  assert.equal(paymentAlreadyUsedByAnotherUser({ user_id: 'user-1' }, 'user-1'), false);
  assert.equal(paymentAlreadyUsedByAnotherUser({ user_id: 'user-2' }, 'user-1'), true);
});

test('buildAdminCustomerRow exposes quota fields with effective remaining', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const expired = new Date(Date.now() - 86400000);
  const row = buildAdminCustomerRow({
    id: 'u1',
    email: 'a@b.com',
    messages_remaining: 100,
    quota_expires_at: expired.toISOString(),
    expire_resets_quota: true,
    last_topup_amount: 3000,
    last_topup_at: expired.toISOString(),
  });
  assert.equal(row.messagesRemaining, 100);
  assert.equal(row.effectiveRemaining, 0); // expired + flag = 0
  assert.equal(row.quotaStatus, 'expired');
  assert.equal(row.lastTopupAmount, 3000);
});

test('buildAdminCustomerRow returns quotaStatus=active when remaining>0 and not expired', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const future = new Date(Date.now() + 86400000);
  const row = buildAdminCustomerRow({
    id: 'u1', email: 'a@b.com',
    messages_remaining: 100,
    quota_expires_at: future.toISOString(),
    expire_resets_quota: true,
  });
  assert.equal(row.quotaStatus, 'active');
  assert.equal(row.effectiveRemaining, 100);
});

test('buildAdminCustomerRow returns quotaStatus=never_topped_up when last_topup_at is null', () => {
  const { buildAdminCustomerRow } = require('../src/services/billing/billing-service');
  const row = buildAdminCustomerRow({ id: 'u1', email: 'a@b.com', messages_remaining: 0 });
  assert.equal(row.quotaStatus, 'never_topped_up');
});
