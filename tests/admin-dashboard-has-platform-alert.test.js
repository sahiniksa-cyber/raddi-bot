'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('admin.html has the platform alert phone + platform url controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'admin.html'), 'utf8');
  assert.match(html, /platformAlertPhone/);
  assert.match(html, /platformUrl/);
  assert.match(html, /\/api\/admin\/platform-alert/);
  // The labels the platform admin actually sees.
  assert.match(html, /رقم جوال تنبيهات المنصة/);
  assert.match(html, /رابط المنصة/);
});
