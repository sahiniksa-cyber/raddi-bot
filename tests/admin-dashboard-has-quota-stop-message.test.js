const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('admin.html has the quota stop message controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'admin.html'), 'utf8');
  assert.match(html, /quotaStopMessageEnabled/);
  assert.match(html, /quotaStopMessageText/);
  assert.match(html, /\/api\/admin\/quota-stop-message/);
});
