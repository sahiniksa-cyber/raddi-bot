'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProhibitionsBlock, buildTenantPoliciesBlock } = require('../src/services/instruction-routing/policy-blocks');

test('empty → no block', () => {
  assert.equal(buildProhibitionsBlock([]), '');
  assert.equal(buildProhibitionsBlock(null), '');
  assert.equal(buildTenantPoliciesBlock([]), '');
});

test('prohibitions render as explicit do-nots', () => {
  const b = buildProhibitionsBlock([{ text: 'ممنوع تعطي سعر غير مؤكد' }, { text: 'لا تفتح موضوع تقسيط' }]);
  assert.match(b, /ممنوع|لا تفعل/);
  assert.ok(b.includes('سعر غير مؤكد'));
  assert.ok(b.includes('تقسيط'));
});

test('tenant policies render as store facts', () => {
  const b = buildTenantPoliciesBlock([{ text: 'الاسترجاع خلال 14 يوم' }]);
  assert.match(b, /سياسات|سياسة/);
  assert.ok(b.includes('الاسترجاع خلال 14 يوم'));
});
