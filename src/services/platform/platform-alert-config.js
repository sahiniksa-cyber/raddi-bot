'use strict';

// Platform-level (NOT tenant-scoped) alert configuration: the phone number the
// platform-admin alerts are delivered to, and the platform URL used in those
// alerts. Both live in the generic `platform_settings` key/value store so they
// are configured from the platform admin panel — never hardcoded, never from a
// per-store config, and (by design) with NO environment-variable fallback: an
// empty value means "not configured", not "use a default".

const { getPlatformSetting, setPlatformSetting } = require('./platform-settings');

function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function normalizeUrl(value) {
  return String(value || '').trim();
}

// Stored values are objects ({ phone } / { url }) for forward compatibility, but
// tolerate a bare string if an older row ever held one.
function readField(setting, field) {
  if (setting && typeof setting === 'object') return setting[field];
  return setting;
}

async function getPlatformAlertPhone(opts = {}) {
  const setting = await getPlatformSetting('platformAlertPhone', opts);
  return normalizePhone(readField(setting, 'phone'));
}

async function setPlatformAlertPhone(phone, opts = {}) {
  const normalized = normalizePhone(phone);
  await setPlatformSetting('platformAlertPhone', { phone: normalized }, opts);
  return normalized;
}

async function getPlatformUrl(opts = {}) {
  const setting = await getPlatformSetting('platformUrl', opts);
  return normalizeUrl(readField(setting, 'url'));
}

async function setPlatformUrl(url, opts = {}) {
  const normalized = normalizeUrl(url);
  await setPlatformSetting('platformUrl', { url: normalized }, opts);
  return normalized;
}

module.exports = {
  getPlatformAlertPhone,
  setPlatformAlertPhone,
  getPlatformUrl,
  setPlatformUrl,
  normalizePhone,
  normalizeUrl,
};
