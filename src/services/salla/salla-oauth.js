'use strict';

/**
 * Salla OAuth token refresh. Salla access tokens live ~2 weeks; the refresh
 * token (granted with `offline_access`) buys a new pair. `getValidToken` is the
 * entry point callers use before hitting the Admin API — it returns the stored
 * token if still fresh, otherwise refreshes, persists, and returns the new one.
 *
 * HTTP + clock are injectable for tests.
 */

const defaultStores = require('./salla-stores');

const DEFAULT_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';
// Refresh a little before actual expiry so an in-flight request never 401s.
const EXPIRY_BUFFER_MS = 6 * 60 * 60 * 1000; // 6 hours

async function refreshAccessToken(refreshToken, { appId, appSecret, tokenUrl, fetch, now } = {}) {
  const doFetch = fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available');
  if (!refreshToken) throw new Error('salla_refresh_token_missing');
  const clock = now || Date.now;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appId || '',
    client_secret: appSecret || '',
  });
  const res = await doFetch(tokenUrl || DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (res.status >= 400 || !body || !body.access_token) {
    const e = new Error(`salla_refresh_failed_${res.status}`);
    e.code = 'SALLA_REFRESH_FAILED';
    e.status = res.status;
    throw e;
  }
  const expiresAt = body.expires_in ? new Date(clock() + Number(body.expires_in) * 1000) : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || refreshToken,
    expiresIn: body.expires_in || null,
    expiresAt,
    scope: body.scope || null,
  };
}

async function getValidToken(merchantId, deps = {}) {
  const stores = deps.sallaStores || defaultStores;
  const env = deps.env || process.env;
  const clock = deps.now || Date.now;
  const store = await stores.getStore(merchantId, deps);
  if (!store) return null;

  const exp = store.token_expires_at ? new Date(store.token_expires_at).getTime() : null;
  const fresh = !exp || exp > clock() + EXPIRY_BUFFER_MS;
  if (fresh) {
    return stores.getAccessToken(merchantId, deps);
  }

  // Expired / near-expiry → refresh and persist.
  const refreshToken = await stores.getRefreshToken(merchantId, deps);
  if (!refreshToken) return stores.getAccessToken(merchantId, deps); // nothing to refresh with
  const refreshed = await refreshAccessToken(refreshToken, {
    appId: env.SALLA_APP_ID,
    appSecret: env.SALLA_APP_SECRET,
    tokenUrl: env.SALLA_OAUTH_TOKEN_URL,
    fetch: deps.fetch,
    now: clock,
  });
  await stores.upsertStoreAuthorization(merchantId, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope,
  }, deps);
  return refreshed.accessToken;
}

module.exports = { refreshAccessToken, getValidToken, DEFAULT_TOKEN_URL, EXPIRY_BUFFER_MS };
