'use strict';

/**
 * Thin Instagram Graph API client (graph.instagram.com). Only what the DM
 * bot needs: send a text DM, subscribe the account to the `messages` webhook
 * field, and read the connected profile. `fetchImpl` is injectable for tests.
 */

function version(env) {
  return env.INSTAGRAM_GRAPH_VERSION || 'v25.0';
}

async function sendDirectMessage({ token, recipientId, text }, { env = process.env, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://graph.instagram.com/${version(env)}/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) throw new Error(`ig_send_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { recipientId: json.recipient_id, messageId: json.message_id };
}

async function subscribeToMessages({ token }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ subscribed_fields: 'messages', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/me/subscribed_apps?${params.toString()}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`ig_subscribe_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Read which webhook fields the connected Instagram account is subscribed to.
// If `messages` is missing here, Meta will NOT deliver DM webhooks — this is the
// single most useful check for "the bot never receives messages".
async function getSubscribedApps({ token }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/me/subscribed_apps?${params.toString()}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`ig_subscribed_apps_failed: ${res.status} ${text}`);
  let json = {};
  try { json = JSON.parse(text); } catch (_) { json = {}; }
  const fields = [];
  for (const row of (json.data || [])) {
    for (const f of (row.subscribed_fields || [])) fields.push(typeof f === 'string' ? f : f.name);
  }
  return { raw: json, fields, hasMessages: fields.includes('messages') };
}

async function getProfile({ token }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/me?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_profile_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Resolve the @username (and name) of a customer from their IGSID — the numeric
// scoped id Meta sends in the webhook. Instagram only gives us the id; the
// username must be looked up so the dashboard shows @handles, not numbers.
async function getUserProfile({ token, igsid }, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ fields: 'username,name', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/${version(env)}/${igsid}?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_user_profile_failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── App-LEVEL webhook subscription (graph.facebook.com, app access token) ────
// Separate from the account-level subscribed_apps: the APP itself must be
// subscribed to the `instagram` object's `messages` field or Meta delivers
// NOTHING, even when the account's subscribed_apps lists `messages`.
function fbVersion(env) {
  return env.INSTAGRAM_GRAPH_VERSION || 'v21.0';
}

async function getAppSubscriptions({ appId, appSecret }, { env = process.env, fetchImpl = fetch } = {}) {
  const token = `${appId}|${appSecret}`;
  const res = await fetchImpl(`https://graph.facebook.com/${fbVersion(env)}/${appId}/subscriptions?access_token=${encodeURIComponent(token)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`ig_app_subs_failed: ${res.status} ${text}`);
  let json = {};
  try { json = JSON.parse(text); } catch (_) { json = {}; }
  const ig = (json.data || []).find((d) => d.object === 'instagram');
  const fields = ig ? (ig.fields || []).map((f) => (typeof f === 'string' ? f : f.name)) : [];
  return { raw: json, hasInstagram: Boolean(ig), fields, hasMessages: fields.includes('messages'), active: ig ? ig.active : null };
}

async function subscribeAppToInstagram({ appId, appSecret, callbackUrl, verifyToken, fields = 'messages' }, { env = process.env, fetchImpl = fetch } = {}) {
  const token = `${appId}|${appSecret}`;
  const params = new URLSearchParams({ object: 'instagram', callback_url: callbackUrl, fields, verify_token: verifyToken, access_token: token });
  const res = await fetchImpl(`https://graph.facebook.com/${fbVersion(env)}/${appId}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ig_app_subscribe_failed: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

module.exports = {
  sendDirectMessage, subscribeToMessages, getSubscribedApps, getProfile, getUserProfile,
  getAppSubscriptions, subscribeAppToInstagram,
};
