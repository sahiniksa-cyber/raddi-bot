'use strict';

/**
 * Policy-owned ISO 4217 alphabetic-code snapshot for this stabilization sprint.
 *
 * This module is deliberately static: policy validity must not change with the
 * host's ICU/CLDR build or operating-system locale data.
 */
const ISO_4217_CURRENCY_CODES = Object.freeze([
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU',
  'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR',
  'MWK', 'MXN', 'MXV', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD',
  'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS',
  'VED', 'VES', 'VND', 'VUV',
  'WST',
  'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XCG',
  'XDR', 'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX',
  'YER',
  'ZAR', 'ZMW', 'ZWG',
]);

const ZERO_MINOR_UNIT_CODES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_MINOR_UNIT_CODES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);
const FOUR_MINOR_UNIT_CODES = new Set(['CLF', 'UYW']);
const NO_MINOR_UNIT_CODES = new Set([
  'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XPD', 'XPT', 'XSU',
  'XTS', 'XUA', 'XXX',
]);

const codeSet = new Set(ISO_4217_CURRENCY_CODES);
const minorUnits = Object.freeze(Object.fromEntries(
  ISO_4217_CURRENCY_CODES.map((code) => {
    if (NO_MINOR_UNIT_CODES.has(code)) return [code, null];
    if (FOUR_MINOR_UNIT_CODES.has(code)) return [code, 4];
    if (THREE_MINOR_UNIT_CODES.has(code)) return [code, 3];
    if (ZERO_MINOR_UNIT_CODES.has(code)) return [code, 0];
    return [code, 2];
  }),
));

function isIso4217CurrencyCode(code) {
  return typeof code === 'string' && codeSet.has(code);
}

function minorUnitForCurrency(code) {
  return isIso4217CurrencyCode(code) ? minorUnits[code] : undefined;
}

module.exports = {
  ISO_4217_CURRENCY_CODES,
  isIso4217CurrencyCode,
  minorUnitForCurrency,
};
