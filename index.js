const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

// ─── GLOBAL HELPERS ──────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function killChrome() {
  try { execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
  try { execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
  try { execSync('taskkill /F /IM msedge.exe /T 2>nul', { stdio: 'ignore' }); } catch (_) {}
}

function isPrivateUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1)/.test(hostname);
  } catch (_) { return true; }
}

function findChrome() {
  const paths = [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
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

// ─── USERS ───────────────────────────────────────────────────────────
const USERS_PATH = path.join(__dirname, 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch (_) { return { users: [] }; }
}
function saveUsers(data) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function findUser(email) {
  return loadUsers().users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

// ─── CONSTANTS ───────────────────────────────────────────────────────
const OWNER_PAUSE_MS = 3 * 60 * 60 * 1000;

const MODEL_PRICES = {
  'gpt-4o-mini':   { in: 0.15,  out: 0.60  },
  'gpt-4o':        { in: 2.50,  out: 10.00 },
  'gpt-4-turbo':   { in: 10.00, out: 30.00 },
  'gpt-3.5-turbo': { in: 0.50,  out: 1.50  },
  'o3-mini':       { in: 1.10,  out: 4.40  },
  'o1-mini':       { in: 3.00,  out: 12.00 },
  'anthropic/claude-opus-4':                        { in: 15.00, out: 75.00 },
  'anthropic/claude-sonnet-4-5':                    { in: 3.00,  out: 15.00 },
  'anthropic/claude-3-5-haiku':                     { in: 0.80,  out: 4.00  },
  'anthropic/claude-3-5-sonnet':                    { in: 3.00,  out: 15.00 },
  'anthropic/claude-3-opus':                        { in: 15.00, out: 75.00 },
  'anthropic/claude-3-haiku':                       { in: 0.25,  out: 1.25  },
  'google/gemini-2.5-pro':                          { in: 1.25,  out: 5.00  },
  'google/gemini-2.0-flash':                        { in: 0.10,  out: 0.40  },
  'google/gemini-2.0-flash:free':                   { in: 0,     out: 0     },
  'google/gemini-1.5-pro':                          { in: 1.25,  out: 5.00  },
  'google/gemini-1.5-flash':                        { in: 0.075, out: 0.30  },
  'google/gemini-1.5-flash:free':                   { in: 0,     out: 0     },
  'meta-llama/llama-3.3-70b-instruct':              { in: 0.12,  out: 0.30  },
  'meta-llama/llama-3.3-70b-instruct:free':         { in: 0,     out: 0     },
  'meta-llama/llama-4-maverick':                    { in: 0.18,  out: 0.60  },
  'meta-llama/llama-3.1-405b-instruct':             { in: 0.80,  out: 0.80  },
  'meta-llama/llama-3.1-8b-instruct:free':          { in: 0,     out: 0     },
  'deepseek/deepseek-chat':                         { in: 0.27,  out: 1.10  },
  'deepseek/deepseek-chat:free':                    { in: 0,     out: 0     },
  'deepseek/deepseek-r1':                           { in: 0.55,  out: 2.19  },
  'deepseek/deepseek-r1:free':                      { in: 0,     out: 0     },
  'mistralai/mistral-large-2411':                   { in: 2.00,  out: 6.00  },
  'mistralai/mistral-nemo:free':                    { in: 0,     out: 0     },
  'mistralai/mistral-small-3.1-24b-instruct:free':  { in: 0,     out: 0     },
  'qwen/qwen3-235b-a22b':                           { in: 0.14,  out: 0.60  },
  'qwen/qwen3-235b-a22b:free':                      { in: 0,     out: 0     },
  'qwen/qwen-2.5-72b-instruct':                     { in: 0.35,  out: 0.40  },
  'x-ai/grok-3-mini':                               { in: 0.30,  out: 0.50  },
  'x-ai/grok-3':                                    { in: 3.00,  out: 15.00 },
  'cohere/command-r-plus-08-2024':                  { in: 2.50,  out: 10.00 },
};

// ─── STORE SCANNING (shared/global) ──────────────────────────────────
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
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
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

const fetchPage = async (url) => (await fetchURL(url)).body;

function detectPlatform(url, html = '') {
  const u = url.toLowerCase();
  const isSalla = u.includes('.salla.sa') || u.includes('.salla.com') ||
    /name=["']generator["']\s+content=["']Salla/i.test(html) ||
    /salla\.config|cdn\.salla\.network|assets\.salla\.network|salla-store|"salla"/i.test(html);
  if (isSalla) return 'salla';
  const isZid = u.includes('.zid.sa') || u.includes('.zid.store') ||
    /name=["']generator["']\s+content=["']Zid/i.test(html) || /zid-app|cdn\.zid\.sa/i.test(html);
  if (isZid) return 'zid';
  if (/Shopify\.theme/i.test(html) || /cdn\.shopify\.com/i.test(html)) return 'shopify';
  if (/woocommerce/i.test(html)) return 'woocommerce';
  return 'generic';
}

function isValidProduct(name) {
  if (!name || name.length < 3 || name.length > 150) return false;
  const junk = ['الرئيسية','من نحن','تواصل','سياسة','شروط','تسجيل','عربي','english',
                 'home','about','contact','login','register','cart','wishlist','search',
                 'menu','navigation','header','footer','متجر','اشتراك','أشتراك'];
  const lower = name.trim().toLowerCase();
  return !junk.some(j => lower === j);
}

async function fetchSallaProducts(storeUrl, token) {
  const products = [];
  if (!token) return products;
  try {
    const { body } = await fetchURL('https://api.salla.dev/admin/v2/products?per_page=50', {
      'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
    });
    const data = JSON.parse(body);
    if (data?.data?.length) {
      for (const p of data.data) {
        products.push({
          name: p.name || '',
          price: (p.price?.amount || p.regular_price?.amount || '') + ' ' + (p.price?.currency || 'SAR'),
          description: (p.description || '').replace(/<[^>]+>/g, '').substring(0, 200),
        });
      }
    }
  } catch (e) { console.log('⚠️ Salla API: ' + e.message); }
  return products;
}

async function fetchZidProducts(storeUrl, token, managerToken) {
  const products = [];
  if (!token) return products;
  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Accept-Language': 'ar' };
    if (managerToken) headers['X-Manager-Token'] = managerToken;
    const { body } = await fetchURL('https://api.zid.sa/v1/products?page_size=50', headers);
    const data = JSON.parse(body);
    const list = data?.results || data?.products || data?.data || [];
    for (const p of list) {
      products.push({
        name: p.name?.ar || p.name?.en || p.name || '',
        price: (p.price || p.sale_price || '') + ' ' + (p.currency || 'SAR'),
        description: (p.description?.ar || p.description?.en || p.description || '').replace(/<[^>]+>/g, '').substring(0, 200),
      });
    }
  } catch (e) { console.log('⚠️ Zid API: ' + e.message); }
  return products;
}

async function fetchWithPuppeteer(url) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (_) {
    try { puppeteer = require('puppeteer-core'); } catch (_) { return null; }
  }
  const chromePath = findChrome();
  const opts = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] };
  if (chromePath) opts.executablePath = chromePath;
  let browser;
  try {
    browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
    return await page.content();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function extractFromHTML(html, url) {
  const $ = cheerio.load(html);
  const platform = detectPlatform(url, html);

  const storeName =
    $('meta[property="og:site_name"]').attr('content') ||
    $('meta[name="application-name"]').attr('content') ||
    $('title').text().split(/[|\-–—]/)[0].trim().substring(0, 80) || '';

  const storeDesc =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || '';

  const products = [];
  const seen = new Set();

  if (platform === 'salla') {
    $('script:not([src])').each((_, el) => {
      const txt = $(el).html() || '';
      const m = txt.match(/(?:window\.)?(?:salla|__NEXT_DATA__|__INITIAL_STATE__)\s*[=:]\s*({[\s\S]+?});/);
      if (!m) return;
      try {
        const obj = JSON.parse(m[1]);
        const findProducts = (o, depth = 0) => {
          if (depth > 6 || !o) return;
          if (Array.isArray(o)) { o.forEach(x => findProducts(x, depth + 1)); return; }
          if (typeof o !== 'object') return;
          if (o.name && (o.price !== undefined || o.regular_price !== undefined) && o.id) {
            const name = String(o.name).trim().substring(0, 120);
            if (name && !seen.has(name)) {
              seen.add(name);
              products.push({ name, price: String(o.price?.amount ?? o.price ?? o.regular_price ?? '') + (o.price?.currency || ' ر.س'), description: String(o.description || o.short_description || '').replace(/<[^>]+>/g, '').trim().substring(0, 200) });
            }
          }
          Object.values(o).forEach(v => findProducts(v, depth + 1));
        };
        findProducts(obj);
      } catch (_) {}
    });
    $('.product-entry, [data-product-id], .s-product-card-entry').each((_, el) => {
      const name = $(el).find('.s-product-card-content-title, .product-entry-title, h3, h2').first().text().trim().substring(0, 120);
      if (!name || seen.has(name)) return;
      seen.add(name);
      const price = $(el).find('.s-product-card-content-price, .product-entry-price, [class*="price"]').first().text().trim().replace(/\s+/g, ' ').substring(0, 60);
      products.push({ name, price, description: '' });
    });
  } else if (platform === 'zid') {
    $('.product-item, .product-card, [class*="product-item"]').each((_, el) => {
      const name = $(el).find('.product-item__name, .product-name, h2, h3').first().text().trim().substring(0, 120);
      if (!name || seen.has(name)) return;
      seen.add(name);
      const price = $(el).find('.product-item__price, .price, [class*="price"]').first().text().trim().replace(/\s+/g, ' ').substring(0, 60);
      products.push({ name, price, description: '' });
    });
  }

  $('script[src], style, noscript, iframe, link').remove();

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html().trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const list = item['@type'] === 'ItemList' ? (item.itemListElement || []).map(e => e.item || e) : [item];
        for (const p of list) {
          if (!p || (p['@type'] !== 'Product' && p.name === undefined)) continue;
          const name = (p.name || '').trim().substring(0, 120);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const price = p.offers?.price || p.offers?.lowPrice || '';
          const currency = p.offers?.priceCurrency || '';
          products.push({ name, price: price ? price + (currency ? ' ' + currency : '') : '', description: (p.description || '').replace(/<[^>]+>/g, '').trim().substring(0, 200) });
        }
      }
    } catch (_) {}
  });

  if (products.length < 3) {
    $('script:not([src])').each((_, el) => {
      try {
        const txt = $(el).html() || '';
        const patterns = [/window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/s, /window\.products\s*=\s*(\[.+?\]);/s, /"products"\s*:\s*(\[[\s\S]+?\])/, /var products\s*=\s*(\[[\s\S]+?\]);/];
        for (const pat of patterns) {
          const m = txt.match(pat);
          if (!m) continue;
          try {
            const obj = JSON.parse(m[1]);
            const arr = Array.isArray(obj) ? obj : (obj.products || obj.data || []);
            if (!Array.isArray(arr)) continue;
            for (const p of arr.slice(0, 50)) {
              const name = (p.name || p.title || p.product_name || '').trim().substring(0, 120);
              if (!name || seen.has(name)) continue;
              seen.add(name);
              products.push({ name, price: String(p.price || p.regular_price || p.sale_price || ''), description: (p.description || p.short_description || '').replace(/<[^>]+>/g, '').trim().substring(0, 200) });
            }
          } catch (_) {}
        }
      } catch (_) {}
    });
  }

  if (products.length < 3) {
    const sels = [
      { wrap: '.s-product-card,.product-card', name: '.s-product-card__title,.product-title,.title', price: '.s-product-card__price,.product-price,.price' },
      { wrap: '.product-item,.product__item', name: '.product-item__name,h3,h2', price: '.product-item__price,.price-item' },
      { wrap: 'li.product,.woocommerce-loop-product__link', name: '.woocommerce-loop-product__title,h2', price: '.price,.amount' },
      { wrap: '.product-card,.product-item,.grid__item', name: '.card__heading,.product-item__title,h3', price: '.price__regular,.money,.price' },
      { wrap: '.product-thumb,.product-layout', name: '.caption h4,.product-name', price: '.price' },
      { wrap: '[class*="product"][class*="card"],[class*="ProductCard"]', name: 'h1,h2,h3,h4,[class*="name"],[class*="title"]', price: '[class*="price"],[class*="Price"]' },
    ];
    for (const { wrap, name: ns, price: ps } of sels) {
      $(wrap).each((_, el) => {
        const name = $(el).find(ns).first().text().trim().replace(/\s+/g, ' ').substring(0, 120);
        if (!name || name.length < 2 || seen.has(name)) return;
        seen.add(name);
        const price = $(el).find(ps).first().text().trim().replace(/\s+/g, ' ').substring(0, 60);
        const desc = $(el).find('p,[class*="desc"],[class*="Desc"]').first().text().trim().replace(/\s+/g, ' ').substring(0, 200);
        products.push({ name, price, description: desc });
      });
      if (products.length >= 10) break;
    }
  }

  return { storeName, storeDesc, products: products.filter(p => isValidProduct(p.name)).slice(0, 60), platform };
}

// ─── USER BOT CLASS ──────────────────────────────────────────────────
class UserBot {
  constructor(userId) {
    this.userId = userId;
    this.dataDir = path.join(__dirname, 'data', userId);
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.configPath = path.join(this.dataDir, 'config.json');
    this.costsPath  = path.join(this.dataDir, 'costs.json');
    this.convPath   = path.join(this.dataDir, 'conversations.json');
    this.sessionPath = path.join(this.dataDir, 'session');

    this.conversations    = new Map();
    this.testConversations = new Map();
    this.ownerPausedChats = new Map();
    this.appState = { status: 'stopped', qrDataUrl: null, phone: null, activeChats: 0, error: null, logs: [] };
    this.client     = null;
    this.botRunning = false;
    this.lastAIDebug = null;
    this.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {}, resetAt: new Date().toISOString() };

    this.config = this._loadConfig();
    this._loadCosts();
    this._loadConversations();
  }

  // ── Config ──
  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (_) {}
    // New user — return completely empty config (never copy another user's data)
    return {
      storeName: '', storeDescription: '', workingHours: '', welcomeMessage: '',
      botInstructions: '', welcomeMode: 'inline', model: '', openaiApiKey: '',
      openrouterApiKey: '', replyDelayPreset: '30s', memoryMessages: 50,
      maxResponseLength: 300, products: [], autoReplyKeywords: {},
      replyStyle: { tone: 'ودي ومحترم', useDialect: true, dialect: 'السعودية الخفيفة', emojiLevel: 'medium', useShortReplies: false },
    };
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  // ── Logging ──
  log(msg) {
    const line = '[' + new Date().toLocaleTimeString('ar') + '] ' + msg;
    console.log(`[${this.userId.slice(0, 8)}] ${msg}`);
    this.appState.logs.unshift(line);
    if (this.appState.logs.length > 50) this.appState.logs.pop();
  }

  // ── Costs ──
  _loadCosts() {
    try { if (fs.existsSync(this.costsPath)) this.costsData = JSON.parse(fs.readFileSync(this.costsPath, 'utf8')); } catch (_) {}
  }

  _saveCosts() {
    try { fs.writeFileSync(this.costsPath, JSON.stringify(this.costsData), 'utf8'); } catch (_) {}
  }

  recordUsage(model, inputTokens, outputTokens) {
    const price = MODEL_PRICES[model] || { in: 0.50, out: 1.50 };
    const cost = (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
    this.costsData.totalCalls++;
    this.costsData.totalInputTokens  += inputTokens;
    this.costsData.totalOutputTokens += outputTokens;
    this.costsData.totalCostUSD = (this.costsData.totalCostUSD || 0) + cost;
    if (!this.costsData.byModel[model]) this.costsData.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    this.costsData.byModel[model].calls++;
    this.costsData.byModel[model].inputTokens  += inputTokens;
    this.costsData.byModel[model].outputTokens += outputTokens;
    this.costsData.byModel[model].costUSD = (this.costsData.byModel[model].costUSD || 0) + cost;
    this._saveCosts();
  }

  // ── Conversations ──
  _loadConversations() {
    try {
      if (!fs.existsSync(this.convPath)) return;
      const data = JSON.parse(fs.readFileSync(this.convPath, 'utf8'));
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        if (v.lastAt > cutoff && Array.isArray(v.msgs) && v.msgs.length > 0) {
          this.conversations.set(k, v.msgs);
          count++;
        }
      }
      if (count > 0) this.log(`📚 تم تحميل ${count} محادثة`);
    } catch (e) { this.log('⚠️ تعذر تحميل المحادثات: ' + e.message); }
  }

  saveConversations() {
    try {
      const obj = {};
      for (const [k, v] of this.conversations) obj[k] = { msgs: v, lastAt: Date.now() };
      fs.writeFileSync(this.convPath, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }

  // ── Owner Pause ──
  pauseChat(sender, reason = 'owner_replied') {
    this.ownerPausedChats.set(sender, { pausedAt: Date.now(), reason });
    this.log(`⏸ ${sender.replace('@c.us', '').replace('@lid', '')} — البوت موقوف (رد المالك)`);
  }

  isChatPaused(sender) {
    const p = this.ownerPausedChats.get(sender);
    if (!p) return false;
    if (Date.now() - p.pausedAt > OWNER_PAUSE_MS) { this.ownerPausedChats.delete(sender); return false; }
    return true;
  }

  // ── Reply Delay ──
  randomDelay() {
    const preset = this.config.replyDelayPreset || '30s';
    const presets = { instant:[0,0], '15s':[10,22], '30s':[22,40], '1min':[50,75], '1.5min':[75,105], '2min':[100,145], '3min':[160,200], 'random':[30,120] };
    if (this.config.replyDelayMin != null && this.config.replyDelayMax != null && !this.config.replyDelayPreset) {
      const min = Math.max(0, parseInt(this.config.replyDelayMin));
      const max = Math.max(min, parseInt(this.config.replyDelayMax));
      return Math.floor(Math.random() * (max - min + 1) + min);
    }
    const [min, max] = presets[preset] || presets['30s'];
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  async humanLikeReply(msg, text) {
    const delaySec = this.randomDelay();
    this.log(`⏳ سيرد بعد ${delaySec} ثانية (محاكاة إنسان)...`);
    try {
      const chat = await msg.getChat();
      if (delaySec > 0) await chat.sendStateTyping().catch(() => {});
      if (delaySec > 0) await sleep(delaySec * 1000);
      await chat.clearState().catch(() => {});
    } catch (_) {}
    await msg.reply(text);
  }

  // ── Keywords ──
  checkKeywords(text) {
    const lower = text.toLowerCase();
    for (const [kw, reply] of Object.entries(this.config.autoReplyKeywords || {}))
      if (lower.includes(kw.toLowerCase())) return reply;
    return null;
  }

  // ── AI ──
  buildAIClient() {
    const model = this.config.model || 'gpt-4o-mini';
    const isOpenAI = !model.includes('/');
    const apiKey = isOpenAI ? this.config.openaiApiKey : (this.config.openrouterApiKey || this.config.openaiApiKey);
    if (!apiKey || apiKey.length < 20) throw new Error('مفتاح API غير موجود — أضفه من الإعدادات');
    const clientOpts = { apiKey, baseURL: isOpenAI ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1' };
    if (!isOpenAI) clientOpts.defaultHeaders = { 'HTTP-Referer': 'https://raddi.app', 'X-Title': 'ردّي' };
    return { openai: new OpenAI(clientOpts), model };
  }

  buildSystemPrompt(history = [], opts = {}) {
    const r = this.config.replyStyle || {};
    const employeeName = r.employeeName || 'موظف خدمة العملاء';
    const avoid = r.avoidWords?.length ? r.avoidWords.join('، ') : 'AI، ذكاء اصطناعي، نموذج لغة، روبوت، ChatGPT، Claude';

    const productsBlock = this.config.products?.length
      ? this.config.products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n')
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، قل: "خلني أتأكد لك من التوفر")';

    const isFirstMsg = opts.isFirstMsg || history.filter(m => m.role === 'assistant').length === 0;
    const welcomeMode = this.config.welcomeMode || 'inline';
    const welcomeHint = (isFirstMsg && welcomeMode === 'inline' && this.config.welcomeMessage?.trim())
      ? `\n\n💬 توجيه خاص: هذه أول رسالة من العميل. ابدأ ردّك بترحيب طبيعي بنفس روح: "${this.config.welcomeMessage}" ثم أجب على سؤاله مباشرة في نفس الرسالة. (رسالة واحدة فقط)`
      : (isFirstMsg && welcomeMode === 'separate')
      ? '\n\n💬 ملاحظة: تم إرسال ترحيب للعميل — اكتب رد يجاوب على طلبه مباشرة.'
      : '';

    if (this.config.botInstructions && this.config.botInstructions.trim().length > 300) {
      return `${this.config.botInstructions.trim()}

---
📋 بيانات من لوحة التحكم (استخدمها مرجعاً):
- المتجر: ${this.config.storeName || '—'}${this.config.storeDescription ? ' — ' + this.config.storeDescription : ''}
- المنتجات المضافة في لوحة التحكم:
${productsBlock}
- كلمات ممنوعة: ${avoid}
- تنسيق الرد: نظّم المعلومات بأسطر منفصلة وترتيب واضح — استخدم الأسطر والنقاط (- أو •) لتسهيل القراءة. تجنب رموز Markdown (** ## --- |جداول|) لكن الأسطر الجديدة والنقاط مقبولة${welcomeHint}`;
    }

    const tone = r.tone || 'ودي ومحترم';
    const dialect = r.useDialect !== false ? (r.dialect || 'السعودية الخفيفة') : 'الفصحى السهلة';
    const emojiMap = { none: 'بدون إيموجي', light: 'إيموجي قليل (نادراً)', medium: 'إيموجي معتدل (1 عند الحاجة)', heavy: 'إيموجي كثير (2-3 لكل رد)' };
    const emojiInstruction = emojiMap[r.emojiLevel || 'medium'];
    const maxLen = Math.max(150, parseInt(this.config.maxResponseLength) || 300);

    return `أنت ${employeeName}، موظف خدمة عملاء بشري في متجر "${this.config.storeName || 'المتجر'}".
أنت إنسان حقيقي. لو سُئلت "هل أنت بوت؟" قل: "لا، أنا ${employeeName} من فريق ${this.config.storeName || 'المتجر'}".

🎯 مهمتك: اقرأ آخر رسالة من العميل وأجب عليها بدقة.

🏪 معلومات المتجر:
- الاسم: ${this.config.storeName || 'متجري'}
- الوصف: ${this.config.storeDescription || '—'}
- ساعات العمل: ${this.config.workingHours || '—'}

📦 المنتجات المتوفرة:
${productsBlock}

✏️ أسلوب الرد:
- نبرة: ${tone}
- لغة: ${dialect}
- إيموجي: ${emojiInstruction}
- ${r.useShortReplies ? 'ردود قصيرة (جملة-جملتين)' : `أقصى ${maxLen} حرف`}
- اكتب عفوي بشري: "ثانية بس"، "خلني أشوف"، "والله"

✏️ تنسيق الرد (مهم):
- نظّم المعلومات بأسطر منفصلة وترتيب واضح
- استخدم النقاط (- أو •) عند ذكر قائمة أسعار أو خيارات
- تجنب رموز Markdown الكتابية (** ## --- |جداول|)

🚫 ممنوع:
- قول هذه الكلمات أبداً: ${avoid}
- تكرار الترحيب إذا كنت رحبت في رسالة سابقة

⚡ مهم: ركّز على آخر رسالة من العميل وأجب عليها.${welcomeHint}`;
  }

  async getAIReply(history, opts = {}) {
    const { openai, model } = this.buildAIClient();
    const system = this.buildSystemPrompt(history, opts);
    const messages = [{ role: 'system', content: system }, ...history];

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      this.log(`📤 يُرسل للـ AI: "${lastUserMsg.content.substring(0, 60)}" | السجل: ${history.length} رسالة | system: ${system.length} حرف`);
    }

    this.lastAIDebug = {
      timestamp: new Date().toISOString(),
      model, systemPromptLength: system.length,
      systemPromptPreview: system.substring(0, 800),
      messagesCount: messages.length, historyLength: history.length,
      lastUserMessage: lastUserMsg?.content,
      historyPreview: history.slice(-8).map(m => ({ role: m.role, content: m.content.substring(0, 100) })),
    };

    try {
      const res = await openai.chat.completions.create({ model, max_tokens: 800, temperature: 0.7, messages });
      const reply = res.choices[0]?.message?.content || '';
      if (res.usage) this.recordUsage(model, res.usage.prompt_tokens || 0, res.usage.completion_tokens || 0);
      if (!reply.trim()) { this.log('⚠️ الـ AI رد بنص فارغ!'); this.lastAIDebug.error = 'empty reply'; }
      else { this.log(`📥 رد الـ AI: "${reply.substring(0, 80)}"`); }
      this.lastAIDebug.reply = reply;
      this.lastAIDebug.success = true;
      return reply;
    } catch (err) {
      this.log(`❌ خطأ AI: ${err.message}`);
      this.lastAIDebug.error = err.message;
      this.lastAIDebug.success = false;
      throw err;
    }
  }

  // ── Message Handler ──
  async handleMessage(msg) {
    if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.includes('@g.us')) return;
    const text = msg.body?.trim();
    if (!text) return;

    if (this.appState.status === 'connecting' || this.appState.status === 'disconnected') {
      this.appState.status = 'connected';
      if (!this.appState.phone && this.client?.info?.wid?.user) this.appState.phone = this.client.info.wid.user;
      this.log('✅ تم التأكد: البوت متصل ويستقبل الرسائل');
    }

    const sender = msg.from;
    if (this.isChatPaused(sender)) {
      this.log(`⏸ ${sender.replace('@c.us', '').replace('@lid', '')} — البوت صامت (المالك يرد)`);
      return;
    }

    this.log('📨 ' + sender.replace('@c.us', '').replace('@lid', '') + ': ' + text.substring(0, 60));

    try {
      const kw = this.checkKeywords(text);
      if (kw) {
        if (!this.conversations.has(sender)) this.conversations.set(sender, []);
        const h = this.conversations.get(sender);
        h.push({ role: 'user', content: text });
        h.push({ role: 'assistant', content: kw });
        await this.humanLikeReply(msg, kw);
        return;
      }

      const isFirstMsg = !this.conversations.has(sender);
      if (isFirstMsg) {
        this.conversations.set(sender, []);
        const welcomeMode = this.config.welcomeMode || 'inline';
        if (welcomeMode === 'separate' && this.config.welcomeMessage?.trim()) {
          await this.humanLikeReply(msg, this.config.welcomeMessage);
          this.conversations.get(sender).push({ role: 'assistant', content: this.config.welcomeMessage });
          await sleep(500);
        }
      }

      const history = this.conversations.get(sender);
      history.push({ role: 'user', content: text });

      const memSize = Math.max(2, parseInt(this.config.memoryMessages) || 50);
      if (history.length > memSize) history.splice(0, history.length - memSize);

      const reply = await this.getAIReply(history, { isFirstMsg });
      history.push({ role: 'assistant', content: reply });
      this.appState.activeChats = this.conversations.size;
      this.saveConversations();
      this.log(`💬 الذاكرة: ${history.length}/${memSize} رسالة`);
      await this.humanLikeReply(msg, reply);
      this.log('✅ رد: ' + reply.substring(0, 70));
    } catch (err) {
      this.log('❌ خطأ في الرد على ' + sender.replace('@c.us', '').replace('@lid', '') + ': ' + err.message);
      const fallback = this.config.errorMessage?.trim();
      if (fallback) try { await this.humanLikeReply(msg, fallback); } catch (_) {}
    }
  }

  // ── WhatsApp Client ──
  createClient() {
    const chromePath = findChrome();
    const cfg = {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu','--disable-extensions'],
    };
    if (chromePath) cfg.executablePath = chromePath;
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: cfg,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023223821.html',
      },
      qrMaxRetries: 5,
      takeoverOnConflict: false,
    });
  }

  startBot() {
    if (this.botRunning) { this.log('⚠️ البوت يعمل بالفعل'); return; }
    this.botRunning = true;
    this.appState.status = 'waiting_qr';
    this.appState.error = null;
    this.appState.qrDataUrl = null;
    this.log('🚀 جاري تشغيل البوت...');
    this.client = this.createClient();
    this.attachEvents(this.client);
    this.client.initialize().catch(err => {
      if (err.message && err.message.includes('already running')) {
        this.log('⚠️ Chrome قديم — يتم إغلاقه وإعادة المحاولة...');
        if (!anyBotRunning()) killChrome();
        this.botRunning = false;
        this.client = null;
        setTimeout(() => this.startBot(), 3000);
      } else {
        this.appState.status = 'error';
        this.appState.error = err.message;
        this.log('❌ ' + err.message);
        this.botRunning = false;
      }
    });
  }

  async stopBot() {
    if (!this.botRunning) return;
    this.botRunning = false;
    this.appState.status = 'stopped';
    this.appState.phone = null;
    this.appState.qrDataUrl = null;
    this.log('🛑 تم إيقاف البوت');
    if (this.client) {
      try { await this.client.destroy(); } catch (_) {}
      this.client = null;
    }
    // Note: do NOT call killChrome() here — would kill other users' Chrome instances
  }

  attachEvents(c) {
    c.on('qr', async (qr) => {
      this.log('📱 ظهر الباركود!');
      qrcodeTerminal.generate(qr, { small: true });
      try {
        this.appState.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' });
        this.appState.status = 'qr_ready';
        this.appState.error = null;
      } catch (e) { this.log('❌ خطأ QR: ' + e.message); }
    });

    c.on('loading_screen', (pct) => { this.appState.status = 'connecting'; this.appState.qrDataUrl = null; this.log('⏳ ' + pct + '%'); });
    c.on('authenticated', () => { this.appState.status = 'connecting'; this.appState.qrDataUrl = null; this.log('🔐 تم التحقق'); });

    c.on('ready', () => {
      this.appState.status = 'connected';
      this.appState.phone = c.info?.wid?.user || null;
      this.appState.qrDataUrl = null;
      this.appState.error = null;
      this.log('✅ متصل! رقم: +' + this.appState.phone);
    });

    c.on('auth_failure', (m) => {
      this.appState.status = 'error'; this.appState.error = 'فشل التحقق: ' + m; this.botRunning = false;
      this.log('❌ فشل التحقق — امسح الجلسة وحاول مجدداً');
      try { fs.rmSync(this.sessionPath, { recursive: true, force: true }); } catch (_) {}
    });

    c.on('disconnected', (r) => {
      this.appState.status = 'disconnected'; this.appState.phone = null;
      this.log('⚠️ انقطع (' + r + ') — إعادة الاتصال...');
      setTimeout(() => { try { if (this.client && this.botRunning) this.client.initialize(); } catch (_) {} }, 5000);
    });

    c.on('message', (msg) => this.handleMessage(msg));

    c.on('message_create', (msg) => {
      if (msg.fromMe && !msg.to?.includes('@g.us') && msg.to !== 'status@broadcast') {
        this.pauseChat(msg.to, 'owner_replied');
      }
    });
  }
}

// ─── BOT REGISTRY ────────────────────────────────────────────────────
const userBots = new Map();

function getUserBot(userId) {
  if (!userBots.has(userId)) userBots.set(userId, new UserBot(userId));
  return userBots.get(userId);
}

function anyBotRunning() {
  for (const b of userBots.values()) if (b.botRunning) return true;
  return false;
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────
const app = express();

const SESSION_SECRET = (() => {
  const f = path.join(__dirname, '.session-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) {
    const s = uuidv4() + uuidv4();
    fs.writeFileSync(f, s, 'utf8');
    return s;
  }
})();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'strict' },
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { success: false, message: 'كثير محاولات — انتظر 15 دقيقة' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 60,  message: { success: false, message: 'كثير طلبات — انتظر دقيقة' } });

app.use(bodyParser.json({ limit: '2mb' }));

// Public routes
app.use('/fonts', express.static(path.join(__dirname, 'dashboard/fonts')));
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard/login.html'));
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'غير مصرح — سجّل دخولك أولاً', redirect: '/login' });
  res.redirect('/login');
}

// Protected dashboard
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard/index.html')));

// ─── AUTH ROUTES ─────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.json({ success: false, message: 'جميع الحقول مطلوبة' });
    if (password.length < 8) return res.json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    const data = loadUsers();
    if (data.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
      return res.json({ success: false, message: 'هذا الإيميل مسجّل مسبقاً' });
    const hash = await bcrypt.hash(password, 12);
    const user = { id: uuidv4(), name, email: email.toLowerCase(), password: hash, createdAt: new Date().toISOString(), role: data.users.length === 0 ? 'admin' : 'user' };
    data.users.push(user);
    saveUsers(data);
    // Create isolated data directory and save empty config immediately
    const newBot = getUserBot(user.id);
    newBot.saveConfig();
    req.session.userId = user.id;
    req.session.userName = user.name;
    console.log(`👤 حساب جديد: ${name} (${email})`);
    res.json({ success: true, name: user.name, role: user.role });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'أدخل الإيميل وكلمة المرور' });
    const user = findUser(email);
    if (!user) return res.json({ success: false, message: 'الإيميل أو كلمة المرور غير صحيحة' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.json({ success: false, message: 'الإيميل أو كلمة المرور غير صحيحة' });
    req.session.userId = user.id;
    req.session.userName = user.name;
    getUserBot(user.id).log(`🔓 دخول: ${user.name}`);
    res.json({ success: true, name: user.name, role: user.role });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  // Logout destroys session ONLY — does NOT touch the bot or Chrome
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  const user = loadUsers().users.find(u => u.id === req.session.userId);
  res.json({ loggedIn: true, name: req.session.userName, role: user?.role || 'user' });
});

// Rate limit + auth on all other API routes
app.use('/api', apiLimiter, requireAuth);

// ─── BOT STATUS ROUTES ────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json({ ...bot.appState, logs: bot.appState.logs.slice(0, 8) });
});

app.get('/api/debug-last', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json(bot.lastAIDebug || { message: 'لا يوجد استدعاء AI بعد' });
});

app.get('/api/qr', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json({ qr: bot.appState.qrDataUrl || null });
});

// ─── CONFIG ROUTES ────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json(bot.config);
});

app.post('/api/config', (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const incoming = req.body || {};

    // Merge: never lose existing data if a field wasn't sent
    const merged = { ...bot.config, ...incoming };

    // Protect API keys: never overwrite a stored key with blank
    if (!incoming.openaiApiKey?.trim() && bot.config.openaiApiKey?.trim())
      merged.openaiApiKey = bot.config.openaiApiKey;
    if (!incoming.openrouterApiKey?.trim() && bot.config.openrouterApiKey?.trim())
      merged.openrouterApiKey = bot.config.openrouterApiKey;

    bot.config = merged;
    bot.saveConfig();
    bot.log('✅ إعدادات محفوظة');
    res.json({ success: true });
  } catch (e) {
    console.error('❌ خطأ في حفظ الإعدادات:', e.message);
    res.status(500).json({ success: false, message: 'فشل الحفظ: ' + e.message });
  }
});

// ─── BOT CONTROL ─────────────────────────────────────────────────────
app.post('/api/clear', (req, res) => {
  const bot = getUserBot(req.session.userId);
  bot.conversations.clear();
  bot.appState.activeChats = 0;
  res.json({ success: true });
});

app.post('/api/bot/start', (req, res) => {
  const bot = getUserBot(req.session.userId);
  bot.startBot();
  res.json({ success: true });
});

app.post('/api/bot/stop', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  await bot.stopBot();
  res.json({ success: true });
});

// ─── TOKEN TEST ───────────────────────────────────────────────────────
app.post('/api/test-token', async (req, res) => {
  const { type, token, managerToken } = req.body;
  if (!token || token.length < 10) return res.json({ success: false, message: 'التوكن قصير جداً' });
  try {
    if (type === 'salla') {
      const { body, status } = await fetchURL('https://api.salla.dev/admin/v2/store/info', { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' });
      if (status === 200) {
        let storeName = '';
        try { storeName = JSON.parse(body)?.data?.name || ''; } catch (_) {}
        return res.json({ success: true, message: 'توكن سلة صحيح ✓', storeName });
      }
      return res.json({ success: false, message: 'توكن سلة غير صحيح أو منتهي (HTTP ' + status + ')' });
    }
    if (type === 'zid') {
      const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
      if (managerToken) headers['X-Manager-Token'] = managerToken;
      const { body, status } = await fetchURL('https://api.zid.sa/v1/managers/account/profile', headers);
      if (status === 200) return res.json({ success: true, message: 'توكن زد صحيح ✓' });
      return res.json({ success: false, message: 'توكن زد غير صحيح أو منتهي (HTTP ' + status + ')' });
    }
    res.status(400).json({ success: false, message: 'نوع غير معروف' });
  } catch (e) { res.status(500).json({ success: false, message: 'خطأ: ' + e.message }); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────
app.post('/api/health-check', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const checks = [];
  const add = (name, ok, msg, hint) => checks.push({ name, ok, msg, hint });

  add('اسم المتجر', !!bot.config.storeName, bot.config.storeName || 'غير محدد', 'أضف اسم متجرك في "معلومات المتجر"');
  add('رسالة الترحيب', !!(bot.config.welcomeMessage?.trim()), bot.config.welcomeMessage ? '"' + bot.config.welcomeMessage.substring(0, 40) + '..."' : 'فارغة', 'أضف رسالة ترحيب');

  const model = bot.config.model || 'gpt-4o-mini';
  const isOpenAI = !model.includes('/');
  const apiKey = isOpenAI ? bot.config.openaiApiKey : bot.config.openrouterApiKey;
  add('مفتاح ' + (isOpenAI ? 'OpenAI' : 'OpenRouter'), !!(apiKey && apiKey.length > 20), apiKey ? 'موجود (' + apiKey.substring(0, 8) + '...)' : 'غير موجود', 'أضف المفتاح في قسم "الذكاء الاصطناعي"');

  if (apiKey && apiKey.length > 20) {
    try {
      const { openai } = bot.buildAIClient();
      const t0 = Date.now();
      const test = await openai.chat.completions.create({ model, max_tokens: 8, messages: [{ role: 'user', content: 'قل: مرحبا' }] });
      const ms = Date.now() - t0;
      const ok = !!test.choices?.[0]?.message?.content;
      add('النموذج: ' + model, ok, ok ? 'يعمل (' + ms + 'ms)' : 'لم يرد', '');
    } catch (e) { add('النموذج: ' + model, false, e.message.substring(0, 80), 'تأكد أن النموذج صحيح والمفتاح يعمل'); }
  } else {
    add('النموذج: ' + model, false, 'لا يمكن الفحص (لا يوجد مفتاح)', '');
  }

  add('الواتس أب', bot.appState.status === 'connected',
    bot.appState.status === 'connected' ? 'متصل (+' + bot.appState.phone + ')' :
    bot.appState.status === 'qr_ready' ? 'في انتظار مسح الباركود' :
    bot.appState.status === 'stopped' ? 'متوقف — اضغط تشغيل' : bot.appState.status,
    bot.appState.status === 'stopped' ? 'اذهب لصفحة الربط واضغط تشغيل' : '');

  add('تعليمات البوت', !!(bot.config.botInstructions?.trim()), bot.config.botInstructions ? bot.config.botInstructions.length + ' حرف' : 'فارغة', 'تعليمات أكثر = ردود أفضل');
  const prodCount = bot.config.products?.length || 0;
  add('المنتجات', prodCount > 0, prodCount + ' منتج', prodCount === 0 ? 'أضف منتجات أو افحص متجرك' : '');
  add('تأخير الرد', !!bot.config.replyDelayPreset && bot.config.replyDelayPreset !== 'instant', bot.config.replyDelayPreset || 'فوري (غير موصى به)', bot.config.replyDelayPreset === 'instant' ? 'الرد الفوري قد يسبب حظر الواتس!' : '');

  res.json({ success: true, checks });
});

// ─── TEST CHAT ────────────────────────────────────────────────────────
app.post('/api/test-chat', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { message, sessionId, reset } = req.body;
    const sid = sessionId || 'default';
    if (reset) { bot.testConversations.delete(sid); return res.json({ success: true, reset: true }); }
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'رسالة فارغة' });

    const isFirst = !bot.testConversations.has(sid);
    if (isFirst) bot.testConversations.set(sid, []);
    const hist = bot.testConversations.get(sid);

    const kw = bot.checkKeywords(message);
    if (kw) {
      hist.push({ role: 'user', content: message });
      hist.push({ role: 'assistant', content: kw });
      return res.json({ success: true, reply: kw, source: 'keyword', historyLength: hist.length });
    }

    const welcomeMode = bot.config.welcomeMode || 'inline';
    let welcomeShown = false;
    if (isFirst && welcomeMode === 'separate' && bot.config.welcomeMessage?.trim()) {
      hist.push({ role: 'assistant', content: bot.config.welcomeMessage });
      welcomeShown = true;
    }

    hist.push({ role: 'user', content: message });
    const memSize = Math.max(2, parseInt(bot.config.memoryMessages) || 50);
    if (hist.length > memSize) hist.splice(0, hist.length - memSize);

    const reply = await bot.getAIReply(hist, { isFirstMsg: isFirst });
    hist.push({ role: 'assistant', content: reply });
    res.json({ success: true, reply, source: 'ai', historyLength: hist.length, welcomeShown });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── LEARN STYLE ──────────────────────────────────────────────────────
app.post('/api/learn-style', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const allReplies = [];

    for (const [, msgs] of bot.conversations) {
      for (const m of msgs) {
        if (m.role === 'assistant' && m.content?.trim().length > 8) allReplies.push(m.content.trim());
      }
    }

    if (allReplies.length < 5) {
      try {
        const data = JSON.parse(fs.readFileSync(bot.convPath, 'utf8'));
        for (const v of Object.values(data)) {
          if (Array.isArray(v.msgs)) {
            for (const m of v.msgs) {
              if (m.role === 'assistant' && m.content?.trim().length > 8) allReplies.push(m.content.trim());
            }
          }
        }
      } catch (_) {}
    }

    if (allReplies.length < 5) {
      return res.json({ success: false, message: `لا توجد محادثات كافية (${allReplies.length} رد فقط) — يحتاج على الأقل 5 ردود` });
    }

    const sample = allReplies.slice(-80);
    bot.log(`🎓 تحليل الأسلوب من ${sample.length} رد...`);

    const { openai, model } = bot.buildAIClient();
    const result = await openai.chat.completions.create({
      model, max_tokens: 1400, temperature: 0.3,
      messages: [
        { role: 'system', content: `أنت خبير في تحليل أسلوب الكتابة. مهمتك: تحليل هذه الردود الحقيقية من محادثات واتساب واستخراج تعليمات دقيقة ومفصلة للبوت حتى يكتب بنفس الأسلوب بالضبط.\n\nالتعليمات يجب أن تشمل:\n1. طريقة الترحيب والإنهاء\n2. الكلمات والعبارات المميزة المتكررة\n3. طول الردود وهيكلها\n4. استخدام الإيموجي\n5. النبرة واللهجة\n6. أسلوب الإجابة على الأسئلة\n\nاكتب التعليمات بصيغة "أنت موظف خدمة عملاء..." وكأنك تخاطب البوت.` },
        { role: 'user', content: `هذه ${sample.length} رداً حقيقية. حلل الأسلوب وأكتب تعليمات للبوت:\n\n${sample.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')}` }
      ]
    });

    const instructions = result.choices[0]?.message?.content?.trim();
    if (!instructions) return res.json({ success: false, message: 'لم يتمكن الذكاء الاصطناعي من تحليل الأسلوب' });
    bot.log(`✅ تم تحليل الأسلوب من ${sample.length} رد`);
    res.json({ success: true, instructions, sampledCount: sample.length });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ENHANCE TEXT ─────────────────────────────────────────────────────
app.post('/api/enhance-text', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { text, type, storeName } = req.body;
    if (!text || text.trim().length < 3) return res.status(400).json({ success: false, message: 'النص قصير جداً' });
    const { openai, model } = bot.buildAIClient();
    const prompts = {
      welcome: `حسّن رسالة الترحيب التالية لتبدو طبيعية وودية وبشرية كأنها من موظف حقيقي في متجر "${storeName || 'المتجر'}". يجب ألا تبدو AI أبداً. لا تستخدم تنسيق Markdown. أعد رسالة الترحيب فقط:`,
      instructions: `حسّن وفصّل تعليمات البوت التالية لتكون أوضح وأكثر تفصيلاً. اجعلها تعليمات منظمة ومفصلة. أعد التعليمات المحسّنة فقط:`,
      reply: `حسّن هذا الرد ليبدو طبيعياً كأن إنساناً كتبه. أزل أي تنسيق Markdown. أعد الرد المحسّن فقط:`,
      general: `حسّن النص التالي ليبدو طبيعياً وبشرياً وأكثر ودّاً. لا تستخدم Markdown. أعد النص المحسّن فقط:`,
    };
    const result = await openai.chat.completions.create({
      model, max_tokens: 600, temperature: 0.8,
      messages: [{ role: 'system', content: prompts[type] || prompts.general }, { role: 'user', content: text }],
    });
    const enhanced = result.choices[0].message.content.trim().replace(/^["'`]|["'`]$/g, '');
    res.json({ success: true, text: enhanced });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── SCAN STORE ───────────────────────────────────────────────────────
app.post('/api/scan-store', async (req, res) => {
  const bot = getUserBot(req.session.userId);
  const { url, sallaToken, zidToken, zidManagerToken } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ success: false, message: 'رابط غير صحيح' });
  if (isPrivateUrl(url)) return res.status(400).json({ success: false, message: 'رابط غير مسموح' });
  try {
    bot.log('🔍 فحص المتجر: ' + url);
    let html = '';
    try { html = await fetchPage(url); } catch (e) { bot.log('⚠️ الفحص الأولي فشل: ' + e.message); }
    const platform = detectPlatform(url, html);
    bot.log(`📌 المنصة: ${platform}`);

    let apiProducts = [];
    if (platform === 'salla' && sallaToken) { bot.log('🔑 استخدام Salla API...'); apiProducts = await fetchSallaProducts(url, sallaToken); }
    else if (platform === 'zid' && zidToken) { bot.log('🔑 استخدام Zid API...'); apiProducts = await fetchZidProducts(url, zidToken, zidManagerToken); }

    let result = extractFromHTML(html, url);

    if (apiProducts.length > 0) {
      const seen = new Set(apiProducts.map(p => p.name));
      const merged = [...apiProducts];
      for (const p of result.products) if (!seen.has(p.name)) merged.push(p);
      result.products = merged.slice(0, 60);
      result.platform = platform;
      result.usedAPI = true;
    }

    if (result.products.length < 3) {
      try {
        const base = new URL(url);
        const prodPageUrl = base.origin + '/products';
        if (prodPageUrl !== url) {
          bot.log('📦 جاري محاولة صفحة المنتجات: ' + prodPageUrl);
          const prodHtml = await fetchPage(prodPageUrl);
          const prodResult = extractFromHTML(prodHtml, prodPageUrl);
          if (prodResult.products.length > result.products.length) result.products = prodResult.products;
        }
      } catch (_) {}
    }

    let usedPuppeteer = false;
    if (result.products.length === 0) {
      bot.log('⏳ جاري الفحص المتقدم (Puppeteer)...');
      try {
        const puppeteerHtml = await fetchWithPuppeteer(url);
        if (puppeteerHtml) { result = extractFromHTML(puppeteerHtml, url); usedPuppeteer = true; }
      } catch (e) { bot.log('⚠️ Puppeteer فشل: ' + e.message); }
    }

    bot.log(`✅ تم الفحص — ${result.products.length} منتج${result.usedAPI ? ' (API)' : usedPuppeteer ? ' (متقدم)' : ''}`);
    res.json({ success: true, ...result });
  } catch (e) {
    bot.log('❌ فشل فحص المتجر: ' + e.message);
    res.status(500).json({ success: false, message: 'تعذر الوصول للموقع: ' + e.message });
  }
});

// ─── PAUSED CHATS ─────────────────────────────────────────────────────
app.get('/api/paused-chats', (req, res) => {
  const bot = getUserBot(req.session.userId);
  const list = [];
  for (const [sender, data] of bot.ownerPausedChats) {
    if (Date.now() - data.pausedAt < OWNER_PAUSE_MS) {
      list.push({ sender: sender.replace('@c.us', '').replace('@lid', ''), pausedAt: data.pausedAt, remainingMin: Math.round((OWNER_PAUSE_MS - (Date.now() - data.pausedAt)) / 60000) });
    }
  }
  res.json({ success: true, paused: list });
});

app.post('/api/paused-chats/resume', (req, res) => {
  const bot = getUserBot(req.session.userId);
  const { sender } = req.body;
  if (sender) {
    bot.ownerPausedChats.delete(sender + '@c.us');
    bot.ownerPausedChats.delete(sender + '@lid');
    bot.ownerPausedChats.delete(sender);
  } else {
    bot.ownerPausedChats.clear();
  }
  res.json({ success: true });
});

// ─── COSTS ────────────────────────────────────────────────────────────
app.get('/api/costs', (req, res) => {
  const bot = getUserBot(req.session.userId);
  res.json(bot.costsData);
});

app.post('/api/costs/reset', (req, res) => {
  const bot = getUserBot(req.session.userId);
  bot.costsData = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byModel: {}, resetAt: new Date().toISOString() };
  bot._saveCosts();
  res.json({ success: true });
});

// ─── TRAIN ANALYZE ────────────────────────────────────────────────────
app.post('/api/train-analyze', async (req, res) => {
  try {
    const bot = getUserBot(req.session.userId);
    const { answers } = req.body;
    if (!answers || answers.length < 10) return res.status(400).json({ success: false, message: 'يجب الإجابة على الأسئلة أولاً (10 على الأقل)' });
    const { openai, model } = bot.buildAIClient();
    const qa = answers.map((a, i) => `س${i + 1}: ${a.q}\nج${i + 1}: ${a.a}`).join('\n\n');
    const result = await openai.chat.completions.create({
      model, max_tokens: 1600, temperature: 0.3,
      messages: [
        { role: 'system', content: `أنت خبير في كتابة تعليمات بوتات واتساب لخدمة العملاء. مهمتك: بناءً على إجابات صاحب المتجر، اكتب تعليمات شاملة ودقيقة للبوت.\n\nالقواعد:\n- ابدأ بـ "أنت موظف خدمة عملاء في متجر..."\n- استخدم العبارات الحرفية من إجابات صاحب المتجر\n- نظّم التعليمات في أقسام: الهوية، أسلوب الرد، الحالات الشائعة، ما يُقال وما لا يُقال\n- لا تخترع شيئاً` },
        { role: 'user', content: `هذه إجابات صاحب المتجر. اكتب تعليمات البوت:\n\n${qa}` }
      ]
    });
    const instructions = result.choices[0]?.message?.content?.trim();
    if (result.usage) bot.recordUsage(model, result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0);
    if (!instructions) return res.json({ success: false, message: 'لم يتمكن الذكاء من تحليل الإجابات' });
    bot.log(`✅ دربني: تم إنشاء البرومنت من ${answers.length} إجابة`);
    res.json({ success: true, instructions });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── SERVER START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🌐 ردّي — لوحة التحكم: http://localhost:' + PORT));
console.log('🚀 ردّي جاهز — اضغط "تشغيل البوت" للبدء');

// ─── AUTO-FIX CONNECTING STATUS ───────────────────────────────────────
setInterval(() => {
  for (const bot of userBots.values()) {
    if (bot.botRunning && bot.client && bot.appState.status === 'connecting' && bot.client.info?.wid?.user) {
      bot.appState.status = 'connected';
      bot.appState.phone = bot.client.info.wid.user;
      bot.log('✅ تم تصحيح الحالة تلقائياً → متصل');
    }
  }
}, 8000);
