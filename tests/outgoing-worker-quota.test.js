'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'),
  'utf8',
);

test('outgoing worker imports decrementMessageQuota', () => {
  assert.match(workerSource, /decrementMessageQuota/);
  assert.match(workerSource, /require\(['"]\.\.\/services\/billing\/message-quota['"]\)/);
});

test('decrementMessageQuota is called after sendWhatsappReply', () => {
  const sendIdx = workerSource.indexOf('await sendWhatsappReply');
  const decIdx = workerSource.lastIndexOf('decrementMessageQuota');
  assert.ok(sendIdx > 0);
  assert.ok(decIdx > sendIdx, 'decrementMessageQuota must run AFTER sendWhatsappReply');
});

test('quotaRemainingAfter is recorded in markReplyMessage payload', () => {
  assert.match(workerSource, /quotaRemainingAfter/);
});
