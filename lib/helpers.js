/**
 * lib/helpers.js — أدوات مشتركة
 *
 * وظائف عامة لا تتبع لمكون معين:
 * sleep, killChrome, findChrome, fetchURL, isPrivateUrl
 */
'use strict';

const fs   = require('fs');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ─── sleep ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Kill Chrome / Chromium processes ────────────────────────────────────
function killChrome() {
  if (process.platform === 'win32') {
    try { execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('taskkill /F /IM msedge.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { execSync('pkill -f "chromium|chrome|chromium-browser" 2>/dev/null || true', { stdio: 'ignore' }); } catch (_) {}
  }
}

// ─── Private URL check (SSRF protection) ─────────────────────────────────
function isPrivateUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1)/.test(hostname);
  } catch (_) { return true; }
}

// ─── Find Chrome / Chromium executable ───────────────────────────────────
function findChrome() {
  if (process.env.WA_USE_PUPPETEER_BUNDLED === 'true') {
    return null;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    try { if (fs.existsSync(p)) return p; } catch (_) {}
    console.error(`❌ PUPPETEER_EXECUTABLE_PATH="${p}" — المسار غير موجود! يتم البحث تلقائياً...`);
  }
  if (process.platform !== 'win32') {
    try {
      const found = execSync(
        'which chromium-browser chromium google-chrome google-chrome-stable 2>/dev/null | head -1',
        { stdio: 'pipe', timeout: 5000 }
      ).toString().trim();
      if (found) return found;
    } catch (_) {}
  }
  const paths = [
    '/nix/var/nix/profiles/default/bin/chromium',
    '/run/current-system/sw/bin/chromium',
    '/usr/local/bin/chromium',
    '/usr/local/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// ─── HTTP(S) fetch with redirect following ──────────────────────────────
function fetchURL(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        ...extraHeaders,
      },
      timeout: 25000,
    };
    const req = mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchURL(next, extraHeaders).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('انتهت مهلة الاتصال')); });
  });
}

module.exports = {
  sleep,
  killChrome,
  findChrome,
  isPrivateUrl,
  fetchURL,
};
