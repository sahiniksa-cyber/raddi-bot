'use strict';

const test = require('node:test');
const assert = require('node:assert');
const graph = require('../src/services/instagram/instagram-graph');

const env = { INSTAGRAM_GRAPH_VERSION: 'v25.0' };

test('sendDirectMessage posts recipient+text with bearer token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ recipient_id: 'IGSID', message_id: 'mid.1' }) };
  };
  const r = await graph.sendDirectMessage({ token: 'LONG', recipientId: 'IGSID', text: 'hi' }, { env, fetchImpl });
  assert.ok(seen.url.includes('/v25.0/me/messages'));
  const body = JSON.parse(seen.opts.body);
  assert.strictEqual(body.recipient.id, 'IGSID');
  assert.strictEqual(body.message.text, 'hi');
  assert.ok(seen.opts.headers.Authorization.includes('LONG'));
  assert.strictEqual(r.messageId, 'mid.1');
});

test('sendDirectMessage throws on error response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'window_closed' });
  await assert.rejects(
    () => graph.sendDirectMessage({ token: 'x', recipientId: 'y', text: 'z' }, { env, fetchImpl }),
    /ig_send_failed/,
  );
});

test('subscribeToMessages posts subscribed_fields=messages', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, method: opts && opts.method };
    return { ok: true, json: async () => ({ success: true }) };
  };
  const r = await graph.subscribeToMessages({ token: 'LONG' }, { env, fetchImpl });
  assert.ok(seen.url.includes('me/subscribed_apps'));
  assert.ok(seen.url.includes('subscribed_fields=messages'));
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(r.success, true);
});

test('getProfile requests user_id and username', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes('fields=user_id%2Cusername') || url.includes('fields=user_id,username'));
    return { ok: true, json: async () => ({ user_id: '17841', username: 'shop' }) };
  };
  const r = await graph.getProfile({ token: 'LONG' }, { env, fetchImpl });
  assert.strictEqual(r.username, 'shop');
});

test('getUserProfile looks up a customer @username by IGSID', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes('/v25.0/1234567890?'), 'should hit the IGSID node');
    assert.ok(url.includes('fields=username') && url.includes('name'));
    return { ok: true, json: async () => ({ username: 'sara_q8', name: 'Sara' }) };
  };
  const r = await graph.getUserProfile({ token: 'LONG', igsid: '1234567890' }, { env, fetchImpl });
  assert.strictEqual(r.username, 'sara_q8');
});

test('getUserProfile throws on error response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'no access' });
  await assert.rejects(() => graph.getUserProfile({ token: 'x', igsid: 'y' }, { env, fetchImpl }), /ig_user_profile_failed/);
});
