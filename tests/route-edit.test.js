'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeEditBody } = require('../src/services/instruction-routing/route-edit');

test('pure style edit → null (legacy prompt path handles persona)', () => {
  assert.equal(routeEditBody('كن ودود ومختصر واستخدم لهجة سعودية', {}), null);
});

test('single resolvable escalation → store to escalationRules (NOT botInstructions)', () => {
  const config = { escalationContacts: [{ id: 'c1', name: 'سعود', phone: '966500000000' }] };
  const out = routeEditBody('لو سأل عن الاسترجاع حوّله لسعود', config);
  assert.equal(out.kind, 'store');
  assert.equal(out.field, 'escalationRules');
  assert.equal(out.value[0].target_contact_id, 'c1');
  assert.equal(out.value[0].trigger_value, 'الاسترجاع');
});

test('escalation to an unresolvable target → clarify (finish setup), store nothing', () => {
  const out = routeEditBody('حوّل الفواتير لسعود', { escalationContacts: [] });
  assert.equal(out.kind, 'clarify');
  assert.match(out.message, /سعود/);
});

test('SLA edit → store to slaPolicies', () => {
  const out = routeEditBody('التفعيل خلال 12 ساعة من الدفع', {});
  assert.equal(out.kind, 'store');
  assert.equal(out.field, 'slaPolicies');
});

test('mixed edit (style + escalation) → clarify: split it (nothing lost/misrouted)', () => {
  const config = { escalationContacts: [{ id: 'c1', name: 'سعود', phone: '9' }] };
  const out = routeEditBody('كن مختصر، ولو سأل عن الاسترجاع حوّله لسعود', config);
  assert.equal(out.kind, 'clarify');
  assert.match(out.message, /رسالة منفصلة/);
});

test('unknown single instruction → clarify, never botInstructions', () => {
  const out = routeEditBody('الطقس جميل اليوم', {});
  assert.equal(out.kind, 'clarify');
});
