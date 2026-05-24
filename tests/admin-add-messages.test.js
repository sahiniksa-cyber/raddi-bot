'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createAdminRoutes } = require('../src/routes/admin.routes');

function startApp(routerOpts) {
  const app = express();
  app.use(express.json());
  if (routerOpts.requireAuth) app.use(routerOpts.requireAuth);
  app.use(createAdminRoutes({ ...routerOpts, dashboardDir: '/tmp' }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('POST add-messages rejects when messages is missing or zero', async () => {
  const { server, port } = await startApp({
    requireAuth: (req, _res, next) => { req.session = { isAdmin: true }; next(); },
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await postJson(port, '/api/admin/customers/u1/add-messages', { messages: 0, days: 30 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /عدد الرسائل/);
  } finally {
    server.close();
  }
});

test('POST add-messages rejects when days is missing or zero', async () => {
  const { server, port } = await startApp({
    requireAuth: (req, _res, next) => { req.session = { isAdmin: true }; next(); },
    billingSettings: { adminSecretPath: '/admin' },
  });
  try {
    const r = await postJson(port, '/api/admin/customers/u1/add-messages', { messages: 3000, days: 0 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /عدد الأيام/);
  } finally {
    server.close();
  }
});
