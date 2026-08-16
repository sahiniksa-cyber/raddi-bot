'use strict';

/**
 * Config PATCH semantics (PURE) — Platform-level.
 *
 * The dashboard's general settings save used to POST the ENTIRE config
 * (`{...config, ...form}`), so a stale page could overwrite fields changed
 * out-of-band (e.g. botInstructions edited via WhatsApp, or a structured pricing
 * rule) with old values. Sending only the fields that actually CHANGED versus
 * the snapshot the page loaded makes the save a partial patch: unchanged fields
 * are never sent, so the backend merge preserves whatever the server now holds.
 *
 * Backend defense-in-depth still strips endpoint-owned run-state fields
 * (see config.controller.mergeConfigForSave), so even a full stale POST cannot
 * flip the bot on/off.
 */

function sameValue(a, b) {
  if (a === b) return true;
  // Structural compare for arrays/objects (form rebuilds these each save).
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

/**
 * @param {object} snapshot - the config the page loaded (baseline).
 * @param {object} payload  - the full config the form would post.
 * @returns {object} only the keys whose value differs from the snapshot.
 */
function computeConfigPatch(snapshot, payload) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const pay = payload && typeof payload === 'object' ? payload : {};
  const patch = {};
  for (const k of Object.keys(pay)) {
    if (!sameValue(snap[k], pay[k])) patch[k] = pay[k];
  }
  return patch;
}

module.exports = { computeConfigPatch, sameValue };
