'use strict';

/**
 * Central phone normalization — the single source of truth for turning any phone
 * shape (WhatsApp JID, Salla mobile+code, merchant-typed number) into ONE
 * canonical key so the same person matches across channels.
 *
 * Canonical form = full international digits WITHOUT '+' (e.g. `966501234567`).
 * This deliberately matches the legacy `campaign_contacts.normalized_phone`
 * format so existing data lines up on backfill.
 *
 * Country handling is configurable via `defaultCountry` (ISO like 'SA' or a raw
 * calling code like '966'); Saudi is only the DEFAULT, never hardcoded in a way
 * that blocks international numbers — any input with an explicit `+CC`/`00CC`
 * prefix keeps its own country. (A full libphonenumber upgrade can slot in later
 * behind this same interface.)
 */

// ISO → calling code for the `defaultCountry` option (extend as needed).
const ISO_TO_CC = Object.freeze({
  SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968',
  EG: '20', JO: '962', KW_: '965', YE: '967', IQ: '964', US: '1', GB: '44',
});

// Known calling codes used to split an international number into CC + national.
// Longest-first matching so '966' wins before any 2-digit code.
const KNOWN_CC = Object.freeze([
  '966', '971', '965', '974', '973', '968', '967', '964', '962',
  '20', '44', '90', '1',
]);

function resolveDefaultCc(defaultCountry) {
  if (!defaultCountry) return '966';
  const s = String(defaultCountry).trim();
  if (/^\d{1,4}$/.test(s)) return s;
  return ISO_TO_CC[s.toUpperCase()] || '966';
}

function splitCountryCode(canonical, defaultCc) {
  for (const cc of KNOWN_CC) {
    if (canonical.startsWith(cc) && canonical.length - cc.length >= 4) {
      return { countryCode: cc, national: canonical.slice(cc.length) };
    }
  }
  if (canonical.startsWith(defaultCc) && canonical.length - defaultCc.length >= 4) {
    return { countryCode: defaultCc, national: canonical.slice(defaultCc.length) };
  }
  return { countryCode: null, national: canonical };
}

/**
 * @returns {{canonical:string, e164:string, national:string, countryCode:string|null}|null}
 */
function toCanonicalPhone(value, { defaultCountry = 'SA' } = {}) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;

  // A lid / group / broadcast JID is NOT a phone number — never coerce its
  // opaque digits into one.
  if (/@lid|@g\.us|@broadcast/i.test(s)) return null;
  // Strip a phone-JID suffix (@s.whatsapp.net / @c.us) if present.
  if (s.includes('@')) s = s.split('@')[0];

  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  const defaultCc = resolveDefaultCc(defaultCountry);

  let canonical;
  if (digits.startsWith('00')) {
    canonical = digits.slice(2); // 00<CC><national>
  } else if (hasPlus) {
    canonical = digits; // +<CC><national>
  } else if (digits.startsWith('0')) {
    canonical = defaultCc + digits.replace(/^0+/, ''); // national trunk
  } else if (digits.startsWith(defaultCc)) {
    canonical = digits; // already includes the default country code
  } else {
    canonical = defaultCc + digits; // bare national number
  }

  // E.164: 8–15 digits total.
  if (canonical.length < 8 || canonical.length > 15) return null;

  const { countryCode, national } = splitCountryCode(canonical, defaultCc);
  return { canonical, e164: '+' + canonical, national, countryCode };
}

// Quick helper: just the canonical digits, or null.
function canonicalDigits(value, opts) {
  const r = toCanonicalPhone(value, opts);
  return r ? r.canonical : null;
}

// True only when both inputs resolve to the same canonical phone.
function sameCanonicalPhone(a, b, opts) {
  const ca = canonicalDigits(a, opts);
  const cb = canonicalDigits(b, opts);
  return Boolean(ca && cb && ca === cb);
}

module.exports = { toCanonicalPhone, canonicalDigits, sameCanonicalPhone, resolveDefaultCc };
