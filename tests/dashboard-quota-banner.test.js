'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8'
);

test('dashboard has cv-banner-warn element for quota warning', () => {
  assert.ok(
    /id=["']cvQuotaBanner["']/.test(html),
    'expected #cvQuotaBanner element in dashboard'
  );
  assert.ok(
    /class=["'][^"']*cv-banner-warn[^"']*["']/.test(html),
    'expected .cv-banner-warn class on the banner element'
  );
});

test('dashboard defines yellow and red banner CSS', () => {
  assert.ok(/\.cv-banner-warn\.warn-yellow/.test(html), 'missing warn-yellow CSS');
  assert.ok(/\.cv-banner-warn\.warn-red/.test(html), 'missing warn-red CSS');
});

test('dashboard quota banner has threshold logic (<20 red, <100 yellow)', () => {
  assert.ok(/function\s+updateQuotaWarnBanner/.test(html), 'missing updateQuotaWarnBanner');
  assert.ok(/n\s*<\s*20/.test(html), 'missing <20 red threshold');
  assert.ok(/n\s*<\s*100/.test(html), 'missing <100 yellow threshold');
});

test('dashboard quota banner links to billing.html', () => {
  assert.ok(
    /href\s*=\s*['"]billing\.html['"]/.test(html),
    'expected link to billing.html inside banner'
  );
});

test('dashboard uses recursive setTimeout polling (no setInterval for polling)', () => {
  assert.ok(/function\s+startPolling\s*\(/.test(html), 'missing startPolling helper');
  // The original 4 setInterval polls must be gone.
  assert.ok(
    !/setInterval\([^)]*loadQuota/.test(html),
    'loadQuota must use startPolling, not setInterval'
  );
  assert.ok(
    !/setInterval\([^)]*loadConversations/.test(html),
    'loadConversations must use startPolling, not setInterval'
  );
  assert.ok(
    !/setInterval\([^)]*loadPausedChats/.test(html),
    'loadPausedChats must use startPolling, not setInterval'
  );
  assert.ok(
    !/setInterval\([^)]*\bpoll\(\)/.test(html),
    'poll() must use startPolling, not setInterval'
  );
});

test('clearAllConversations requires typing "مسح" to confirm', () => {
  assert.ok(
    /prompt\(['"]للتأكيد، اكتب: مسح['"]\)/.test(html),
    'clearAllConversations must double-confirm via prompt'
  );
  assert.ok(
    /v\s*!==\s*['"]مسح['"]/.test(html),
    'clearAllConversations must check value === "مسح"'
  );
});
