'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const oauth = require('../src/services/salla/salla-oauth');

function fakeFetch(handler) {
  return async (url, opts) => {
    const { status, body } = handler(url, opts);
    return { status: status || 200, json: async () => body };
  };
}

test('refreshAccessToken posts refresh grant and returns new tokens + expiry', async () => {
  let seen = {};
  const fetch = fakeFetch((url, opts) => {
    seen = { url, body: opts.body, method: opts.method };
    return { body: { access_token: 'NEW_A', refresh_token: 'NEW_R', expires_in: 1209600 } };
  });
  const now = 1000000;
  const r = await oauth.refreshAccessToken('OLD_R', { appId: 'app', appSecret: 'sec', fetch, now: () => now });
  assert.equal(seen.method, 'POST');
  assert.match(seen.url, /oauth2\/token/);
  const params = new URLSearchParams(seen.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'OLD_R');
  assert.equal(params.get('client_id'), 'app');
  assert.equal(r.accessToken, 'NEW_A');
  assert.equal(r.refreshToken, 'NEW_R');
  assert.equal(r.expiresAt.getTime(), now + 1209600 * 1000);
});

test('refreshAccessToken throws on error response', async () => {
  const fetch = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  await assert.rejects(() => oauth.refreshAccessToken('x', { appId: 'a', appSecret: 's', fetch }));
});

test('getValidToken returns the stored token when it is not near expiry', async () => {
  const now = 1_000_000_000_000;
  const stores = {
    getStore: async () => ({ token_expires_at: new Date(now + 10 * 24 * 3600 * 1000) }),
    getAccessToken: async () => 'STORED',
  };
  const t = await oauth.getValidToken('m1', { sallaStores: stores, now: () => now });
  assert.equal(t, 'STORED');
});

test('getValidToken refreshes and persists when the token is expired', async () => {
  const now = 1_000_000_000_000;
  let saved = null;
  const stores = {
    getStore: async () => ({ token_expires_at: new Date(now - 1000) }),
    getAccessToken: async () => 'OLD',
    getRefreshToken: async () => 'OLD_R',
    upsertStoreAuthorization: async (merchantId, payload) => { saved = { merchantId, payload }; },
  };
  const fetch = fakeFetch(() => ({ body: { access_token: 'FRESH', refresh_token: 'FRESH_R', expires_in: 3600 } }));
  const t = await oauth.getValidToken('m1', {
    sallaStores: stores, fetch, now: () => now, env: { SALLA_APP_ID: 'a', SALLA_APP_SECRET: 's' },
  });
  assert.equal(t, 'FRESH');
  assert.equal(saved.merchantId, 'm1');
  assert.equal(saved.payload.accessToken, 'FRESH');
  assert.equal(saved.payload.refreshToken, 'FRESH_R');
});
