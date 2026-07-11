'use strict';

/**
 * Daily sweep that refreshes each connected Instagram long-lived token (valid
 * ~60 days; must be refreshed within that window or the merchant must
 * re-authorize). Each account is refreshed independently — one failure logs
 * and continues, so a single bad token never blocks the rest, and nothing here
 * can affect WhatsApp.
 */

const defaultAccounts = require('./instagram-accounts');
const defaultOauth = require('./instagram-oauth');
const { logInstagram: defaultLog } = require('./instagram-logs');

async function refreshDueTokens(deps = {}) {
  const accounts = deps.accounts || defaultAccounts;
  const oauth = deps.oauth || defaultOauth;
  const logInstagram = deps.logInstagram || defaultLog;

  const rows = await accounts.listConnectedAccounts();
  for (const row of rows) {
    try {
      const token = await accounts.getAccountToken(row.user_id);
      if (!token) continue;
      const refreshed = await oauth.refreshLongLived(token);
      const acc = await accounts.getAccount(row.user_id);
      await accounts.upsertAccount(row.user_id, {
        igUserId: acc && acc.ig_user_id,
        igUsername: acc && acc.ig_username,
        token: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      });
    } catch (err) {
      await logInstagram(row.user_id, 'error', 'token_refresh', { message: err.message });
    }
  }
}

function startTokenRefreshTimer() {
  const ms = parseInt(process.env.INSTAGRAM_TOKEN_REFRESH_INTERVAL_MS || '86400000', 10);
  const timer = setInterval(() => { refreshDueTokens().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { refreshDueTokens, startTokenRefreshTimer };
