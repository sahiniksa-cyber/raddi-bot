'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const root = process.env.RUNTIME_MODULE_ROOT || path.join(__dirname, '..');
const serverPath = path.join(root, 'src', 'server.js');

test('production server bootstrap never loads the retired legacy connection manager', () => {
  const originalLoad = Module._load;
  const previousEngine = process.env.WA_ENGINE;
  let legacyManagerRequested = false;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (request === '../whatsapp/connection-manager' || request.endsWith('/whatsapp/connection-manager')) {
      legacyManagerRequested = true;
      throw new Error('retired legacy connection manager was requested');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    process.env.WA_ENGINE = 'whatsapp-web';
    delete require.cache[require.resolve(serverPath)];
    assert.doesNotThrow(() => require(serverPath));
    assert.equal(legacyManagerRequested, false);
  } finally {
    Module._load = originalLoad;
    if (previousEngine === undefined) delete process.env.WA_ENGINE;
    else process.env.WA_ENGINE = previousEngine;
  }
});
