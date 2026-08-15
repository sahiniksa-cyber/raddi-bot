'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTenantTimezone,
  formatDateTime,
  formatClock,
  buildCurrentTimeBlock,
  withTimestampPrefix,
} = require('../src/services/ai/time-context');

// A fixed instant: 2026-08-15T18:30:00Z → 21:30 in Riyadh (UTC+3), 22:30 in Dubai (UTC+4).
const INSTANT = new Date('2026-08-15T18:30:00Z');

test('resolveTenantTimezone reads each tenant config, no hardcoded per-store value', () => {
  assert.equal(resolveTenantTimezone({ timezone: 'Asia/Dubai' }), 'Asia/Dubai');
  assert.equal(resolveTenantTimezone({ tenantTimezone: 'Africa/Cairo' }), 'Africa/Cairo');
  // Falls back to a platform default when the tenant hasn't set one.
  assert.equal(typeof resolveTenantTimezone({}), 'string');
});

test('formatDateTime / formatClock render the SAME instant differently per tenant timezone', () => {
  assert.equal(formatDateTime(INSTANT, 'Asia/Riyadh'), '2026-08-15 21:30');
  assert.equal(formatDateTime(INSTANT, 'Asia/Dubai'), '2026-08-15 22:30');
  assert.equal(formatClock(INSTANT, 'Asia/Riyadh'), '21:30');
  assert.equal(formatClock(INSTANT, 'Asia/Dubai'), '22:30');
});

test('buildCurrentTimeBlock states the current time in the tenant timezone', () => {
  const block = buildCurrentTimeBlock({ now: INSTANT, timezone: 'Asia/Riyadh' });
  assert.match(block, /2026-08-15 21:30/);
  // Must instruct the model that bracketed times are reference-only (not echoed).
  assert.match(block, /\[.*\]|الأقواس|مرجع/);
});

test('withTimestampPrefix prefixes content with the message clock time; no ts → unchanged', () => {
  assert.equal(withTimestampPrefix('متى يتفعل؟', INSTANT, 'Asia/Riyadh'), '[21:30] متى يتفعل؟');
  assert.equal(withTimestampPrefix('متى يتفعل؟', null, 'Asia/Riyadh'), 'متى يتفعل؟');
});

test('two tenants: same UTC instant, different local clock (isolation of tenant timezone)', () => {
  const tzA = resolveTenantTimezone({ timezone: 'Asia/Riyadh' });
  const tzB = resolveTenantTimezone({ timezone: 'Asia/Dubai' });
  assert.notEqual(formatClock(INSTANT, tzA), formatClock(INSTANT, tzB));
});
