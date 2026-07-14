'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

function get(server, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
  });
}

test('startup app answers health before the full app is ready', async () => {
  const app = createStartupApp({ ready: false, startedAt: 123 });
  const server = await listen(app);
  try {
    const res = await get(server, '/health');
    const body = res.json();

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
    const res = await get(server, '/api/status');
    const body = res.json();

    assert.equal(res.status, 503);
    assert.equal(body.success, false);
  } finally {
    await close(server);
  }
});

test('startup app delegates non-health traffic after the full app is attached', async () => {
  const state = { ready: true, startedAt: 123 };
  state.app = (req, res) => res.status(204).end();
  const app = createStartupApp(state);
  const server = await listen(app);
  try {
    const res = await get(server, '/api/status');

    assert.equal(res.status, 204);
  } finally {
    await close(server);
  }
});
