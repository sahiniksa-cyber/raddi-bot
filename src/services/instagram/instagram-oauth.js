'use strict';

/**
 * Instagram Business Login (OAuth) — pure helpers, no Express, no DB.
 * Path: "Instagram API with Instagram Login" (no Facebook Page required).
 * Scopes are the post-Jan-2025 strings. Hosts:
 *   authorize        -> https://www.instagram.com/oauth/authorize
 *   code -> short    -> https://api.instagram.com/oauth/access_token
 *   short -> long    -> https://graph.instagram.com/access_token
 *   refresh long     -> https://graph.instagram.com/refresh_access_token
 *
 * `fetchImpl` is injectable for tests (defaults to global fetch, Node >=18).
 */

const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

function cfg(env) {
  return {
    appId: env.INSTAGRAM_APP_ID,
    appSecret: env.INSTAGRAM_APP_SECRET,
    redirectUri: env.INSTAGRAM_REDIRECT_URI,
    version: env.INSTAGRAM_GRAPH_VERSION || 'v25.0',
  };
}

function buildAuthorizeUrl(state, { env = process.env } = {}) {
  const c = cfg(env);
  const params = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: state || '',
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, { env = process.env, fetchImpl = fetch } = {}) {
  const c = cfg(env);
  const body = new URLSearchParams({
    client_id: c.appId,
    client_secret: c.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: c.redirectUri,
    code,
  }).toString();
  const res = await fetchImpl('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`ig_code_exchange_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const entry = Array.isArray(json.data) ? json.data[0] : json;
  return { accessToken: entry.access_token, userId: String(entry.user_id), permissions: entry.permissions };
}

async function exchangeForLongLived(shortToken, { env = process.env, fetchImpl = fetch } = {}) {
  const c = cfg(env);
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: c.appSecret,
    access_token: shortToken,
  });
  const res = await fetchImpl(`https://graph.instagram.com/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_long_lived_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { accessToken: json.access_token, expiresAt: expiryFrom(json.expires_in) };
}

async function refreshLongLived(longToken, { env = process.env, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: longToken });
  const res = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`ig_refresh_failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { accessToken: json.access_token, expiresAt: expiryFrom(json.expires_in) };
}

function expiryFrom(expiresInSeconds) {
  const ms = (Number(expiresInSeconds) || 0) * 1000;
  return new Date(Date.now() + ms);
}

module.exports = { SCOPES, buildAuthorizeUrl, exchangeCodeForToken, exchangeForLongLived, refreshLongLived };
