'use strict';

const dns = require('dns').promises;
const net = require('net');

/**
 * SSRF protection helpers for outbound fetches initiated from user input.
 *
 * - isPrivateIp(ip): true if IP is loopback, private, link-local, ULA, etc.
 * - assertPublicUrl(url): throws if URL scheme is not http(s) or hostname resolves to a private IP.
 * - safeFetch(url, opts): wraps global fetch with: scheme check, DNS lookup,
 *   private-IP rejection, timeout, content-length cap, manual redirect re-validation.
 */

function isPrivateIp(ip) {
  if (!ip) return true;
  const lower = String(ip).toLowerCase();

  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(n => parseInt(n, 10));
    const [a, b] = parts;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // 127.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a >= 224) return true;                       // multicast / reserved
    return false;
  }

  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;        // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    // IPv4-mapped IPv6, textual form: ::ffff:a.b.c.d
    const v4mapped = lower.match(/^::ffff:([0-9.]+)$/i);
    if (v4mapped) return isPrivateIp(v4mapped[1]);
    // IPv4-mapped IPv6, hextet form: Node normalizes ::ffff:127.0.0.1 to
    // ::ffff:7f00:1, so rebuild the dotted IPv4 from the two low hextets and
    // re-check. Without this, a mapped loopback/private host slips through.
    const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4mappedHex) {
      const hi = parseInt(v4mappedHex[1], 16);
      const lo = parseInt(v4mappedHex[2], 16);
      const dotted = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
      return isPrivateIp(dotted);
    }
    return false;
  }

  // Hostnames like 'localhost', '0', etc.
  if (['localhost', '0', 'ip6-localhost', 'ip6-loopback'].includes(lower)) return true;
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) {
    const err = new Error('invalid_url');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const err = new Error('unsupported_protocol');
    err.code = 'UNSUPPORTED_PROTOCOL';
    throw err;
  }
  // parsed.hostname keeps the brackets for IPv6 literals ("[::1]"); strip them
  // so net.isIP recognizes the literal and we classify it directly WITHOUT a
  // DNS lookup — deterministic even where IPv6 resolution is unavailable (e.g.
  // CI runners), and closes the mapped-literal (::ffff:127.0.0.1) bypass.
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  // Direct IP literals
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      const err = new Error('private_address');
      err.code = 'PRIVATE_ADDRESS';
      throw err;
    }
    return { parsed, addresses: [host] };
  }

  // Hostname allowlist of "obvious bad" first
  if (['localhost', 'ip6-localhost', 'ip6-loopback'].includes(host)) {
    const err = new Error('private_address');
    err.code = 'PRIVATE_ADDRESS';
    throw err;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (e) {
    const err = new Error('dns_failed');
    err.code = 'DNS_FAILED';
    err.cause = e;
    throw err;
  }
  if (!addresses || addresses.length === 0) {
    const err = new Error('dns_empty');
    err.code = 'DNS_EMPTY';
    throw err;
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      const err = new Error('private_address');
      err.code = 'PRIVATE_ADDRESS';
      throw err;
    }
  }
  return { parsed, addresses: addresses.map(a => a.address) };
}

async function safeFetch(rawUrl, { timeoutMs = 5000, maxBytes = 5 * 1024 * 1024, maxRedirects = 3, headers = {} } = {}) {
  if (typeof globalThis.fetch !== 'function') {
    const err = new Error('fetch_unavailable');
    err.code = 'FETCH_UNAVAILABLE';
    throw err;
  }

  let currentUrl = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await globalThis.fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers,
      });
    } finally {
      clearTimeout(timer);
    }

    const cl = parseInt(response.headers.get('content-length') || '0', 10);
    if (cl && cl > maxBytes) {
      const err = new Error('response_too_large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) return response;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    return response;
  }
  const err = new Error('too_many_redirects');
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

module.exports = { isPrivateIp, assertPublicUrl, safeFetch };
