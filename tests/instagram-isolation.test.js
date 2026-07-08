'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// Matches an actual import of baileys (require or import), ignoring comments.
const IMPORTS_BAILEYS = /(require\(|from\s+)['"][^'"]*baileys/i;
// Matches an actual import of a whatsapp service module.
const IMPORTS_WHATSAPP = /require\(['"][^'"]*(services\/whatsapp|workers\/(ai-worker|outgoing-whatsapp))/i;

test('instagram service code never imports baileys or whatsapp modules', () => {
  const dir = path.join(ROOT, 'src', 'services', 'instagram');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!IMPORTS_BAILEYS.test(src), `${f} must not import baileys`);
    assert.ok(!IMPORTS_WHATSAPP.test(src), `${f} must not import a whatsapp module`);
  }
});

test('instagram worker/queue/routes never import baileys', () => {
  for (const p of [
    'src/workers/instagram-worker.js',
    'src/queues/instagram-queue.js',
    'src/routes/instagram.routes.js',
  ]) {
    assert.ok(!IMPORTS_BAILEYS.test(read(p)), `${p} must not import baileys`);
  }
});

test('WhatsApp worker files were not modified to depend on instagram', () => {
  assert.ok(!/instagram/i.test(read('src/workers/ai-worker.js')), 'ai-worker must not reference instagram');
  assert.ok(!/instagram/i.test(read('src/workers/outgoing-whatsapp-worker.js')), 'outgoing whatsapp worker must not reference instagram');
});

test('instagram uses the SHARED quota functions (proves shared billing)', () => {
  const worker = read('src/workers/instagram-worker.js');
  assert.ok(worker.includes('checkMessageQuota'), 'must check shared quota');
  assert.ok(worker.includes('decrementMessageQuota'), 'must decrement shared quota');
  assert.ok(worker.includes("require('../services/billing/message-quota')"), 'must import the shared billing module');
});

test('everything is gated behind INSTAGRAM_ENABLED (default off)', () => {
  assert.ok(read('src/workers/instagram-worker.js').includes('INSTAGRAM_ENABLED'));
  assert.ok(read('src/routes/instagram.routes.js').includes('INSTAGRAM_ENABLED'));
  assert.ok(read('src/runtime/start-all.js').includes('INSTAGRAM_ENABLED'));
  assert.ok(read('src/server.js').includes('INSTAGRAM_ENABLED'));
});

test('instagram queues are separate names from WhatsApp queues', () => {
  const iq = read('src/queues/instagram-queue.js');
  assert.ok(iq.includes('incoming-instagram'));
  assert.ok(iq.includes('outgoing-instagram'));
  // must NOT reuse the WhatsApp queue names
  assert.ok(!iq.includes('outgoing-whatsapp'));
});

test('instagram migration tables do not FK into whatsapp tables', () => {
  const init = read('src/db/migrations/init.js');
  const block = init.slice(init.indexOf('Instagram DM module'));
  assert.ok(!block.includes('REFERENCES whatsapp_sessions'));
  assert.ok(!block.includes('REFERENCES conversations'));
  assert.ok(!block.includes('REFERENCES messages'));
});
