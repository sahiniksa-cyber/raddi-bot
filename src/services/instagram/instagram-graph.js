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

module.exports = { sendDirectMessage, subscribeToMessages, getProfile, getUserProfile };
