'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStartupApp } = require('../src/server');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('startup app answers health before the full app is ready', async () => {
  const app = createStartupApp({ ready: false, startedAt: 123 });
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.ready, false);
  } finally {
    await close(server);
  }
});

test('startup app holds non-health traffic until the full app is ready', async () => {
  const app = createStartupApp({ ready: false, startedAt: 123 });
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.equal(body.success, false);
  } finally {
    await close(server);
  }
});
