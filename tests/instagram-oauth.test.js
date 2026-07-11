'use strict';

const test = require('node:test');
const assert = require('node:assert');
const oauth = require('../src/services/instagram/instagram-oauth');

const env = {
  INSTAGRAM_APP_ID: 'APPID',
  INSTAGRAM_APP_SECRET: 'SECRET',
  INSTAGRAM_REDIRECT_URI: 'https://x/cb',
  INSTAGRAM_GRAPH_VERSION: 'v25.0',
};

test('buildAuthorizeUrl includes scope, redirect, state', () => {
  const url = oauth.buildAuthorizeUrl('state123', { env });
  assert.ok(url.startsWith('https://www.instagram.com/oauth/authorize?'));
  assert.ok(url.includes('client_id=APPID'));
  assert.ok(url.includes('response_type=code'));
  assert.ok(url.includes('instagram_business_basic'));
  assert.ok(url.includes('instagram_business_manage_messages'));
  assert.ok(url.includes('state=state123'));
  assert.ok(url.includes(encodeURIComponent('https://x/cb')));
});

test('exchangeCodeForToken posts form and returns first data entry', async () => {
  const fetchImpl = async (url, opts) => {
    assert.strictEqual(url, 'https://api.instagram.com/oauth/access_token');
    assert.ok(opts.body.includes('grant_type=authorization_code'));
    assert.ok(opts.body.includes('code=CODE'));
    return { ok: true, json: async () => ({ data: [{ access_token: 'SHORT', user_id: '17841', permissions: 'x' }] }) };
  };
  const r = await oauth.exchangeCodeForToken('CODE', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'SHORT');
  assert.strictEqual(r.userId, '17841');
});

test('exchangeForLongLived returns token + expiry date', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://graph.instagram.com/access_token?'));
    assert.ok(url.includes('grant_type=ig_exchange_token'));
    return { ok: true, json: async () => ({ access_token: 'LONG', expires_in: 5183944 }) };
  };
  const r = await oauth.exchangeForLongLived('SHORT', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'LONG');
  assert.ok(r.expiresAt instanceof Date);
  assert.ok(r.expiresAt.getTime() > Date.now());
});

test('refreshLongLived hits refresh endpoint', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://graph.instagram.com/refresh_access_token?'));
    assert.ok(url.includes('grant_type=ig_refresh_token'));
    return { ok: true, json: async () => ({ access_token: 'LONG2', expires_in: 5183944 }) };
  };
  const r = await oauth.refreshLongLived('LONG', { env, fetchImpl });
  assert.strictEqual(r.accessToken, 'LONG2');
});

test('exchangeCodeForToken throws on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(() => oauth.exchangeCodeForToken('CODE', { env, fetchImpl }), /ig_code_exchange_failed/);
});
