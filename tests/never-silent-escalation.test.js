'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Production 2026-06-12 21:42 (hard evidence from escalation_log): the
// conversation hit the 3/24h cap, the 4th escalation was swallowed SILENTLY,
// and the bot told the customer "رسلت للإدارة". Owner's hard rule: the team
// must NEVER be left in the dark — every suppressed escalation (cooldown,
// min-gap, AND over-cap) forwards a "🔁 تحديث" to the group.

test('NO suppression branch is silent: over-cap also forwards the customer update', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  const block = src.slice(src.indexOf('escalation.ownerMessage'), src.indexOf('escalation_log', src.indexOf('escalation.ownerMessage')) + 4000);

  // The suppression condition must cover all three guards and lead to the update.
  assert.match(src, /cooldown\.rowCount > 0 \|\| tooSoon \|\| overCap/, 'all guards route to the update branch');
  // And there must be NO remaining silent over-cap branch.
  assert.ok(!/else if \(overCap\)/.test(src), 'the silent over-cap branch must be gone');
  assert.match(block, /buildCustomerUpdateText/, 'the update is what ships when suppressed');
});
