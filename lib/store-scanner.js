/**
 * lib/store-scanner.js — Store Product Scanner
 *
 * يفحص المتاجر (سلة، زد، شوبيفاي...) ويستخرج المنتجات
 * عبر: API مباشر، HTML parsing، Puppeteer
 */
'use strict';

const cheerio = require('cheerio');
const { fetchURL, findChrome } = require('./helpers');

// ─── Platform Detection ────────────────────────────────────────────
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

// ─── Product Name Validation ────────────────────────────────────────
function isValidProduct(name) {
  if (!name || name.length < 3 || name.length > 150) return false;
  const junk = ['الرئيسية','من نحن','تواصل','سياسة','شروط','تسجيل','عربي','english',
                 'home','about','contact','login','register','cart','wishlist','search',
                 'menu','navigation','header','footer','متجر','اشتراك','أشتراك'];
  const lower = name.trim().toLowerCase();
  return !junk.some(j => lower === j);
}

// ─── Salla API ──────────────────────────────────────────────────────
async function fetchSallaProducts(storeUrl, token) {
  const products = [];
  if (!token) return products;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
  const apiUrls = [
    'https://api.salla.dev/admin/v2/products?per_page=50',
    'https://api.salla.dev/admin/v2/products?page_size=50',
    'https://api.salla.dev/store/v2/products?per_page=50',
    'https://api.salla.dev/store/v1/products?per_page=50',
  ];
  for (const apiUrl of apiUrls) {
    try {
      const { body, status } = await fetchURL(apiUrl, headers);
      if (status === 200) {
        const data = JSON.parse(body);
        const items = data?.data || data?.products || [];
        if (Array.isArray(items) && items.length > 0) {
          for (const p of items) {
            const name = p.name || p.title || '';
            if (!name) continue;
            products.push({
              name,
              price: (p.price?.amount || p.regular_price?.amount || p.price || '') + ' ' + (p.price?.currency || 'SAR'),
              description: (p.description || p.short_description || '').replace(/<[^>]+>/g, '').substring(0, 200),
            });
          }
          console.log(`✅ Salla API: ${products.length} منتج من ${apiUrl}`);
          return products;
        }
      } else {
        console.log(`⚠️ Salla API HTTP ${status} من ${apiUrl}: ${body.substring(0, 200)}`);
      }
    } catch (e) { console.log('⚠️ Salla API خطأ: ' + e.message); }
  }
  if (storeUrl) {
    try {
      const base = new URL(storeUrl);
      const { body, status } = await fetchURL(base.origin + '/products', headers);
      if (status === 200) {
        const jsonMatches = body.match(/["']products["']\s*:\s*(\[[\s\S]{10,15000}?\])/g) || [];
        for (const match of jsonMatches) {
          try {
            const arr = JSON.parse(match.replace(/^["']products["']\s*:\s*/, ''));
            if (Array.isArray(arr) && arr.length > 0) {
              for (const p of arr.slice(0, 50)) {
                const name = p.name || p.title || '';
                if (name && name.length > 2) {
                  products.push({ name, price: String(p.price?.amount || p.price || ''), description: (p.description || '').replace(/<[^>]+>/g, '').substring(0, 200) });
                }
              }
              if (products.length > 0) { console.log(`✅ Salla صفحة: ${products.length} منتج`); return products; }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return products;
}

// ─── Zid API ────────────────────────────────────────────────────────
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

// ─── Storefront API (no token) ──────────────────────────────────────
async function tryStorefrontAPI(storeUrl) {
  try {
    const base = new URL(storeUrl);
    const candidates = [
      base.origin + '/api/products?per_page=50&status=sale',
      base.origin + '/api/products?per_page=50',
      base.origin + '/api/v2/products',
      base.origin + '/products.json?limit=50',
      base.origin + '/collections/all/products.json?limit=50',
    ];
    for (const ep of candidates) {
      try {
        const { body, status } = await fetchURL(ep, { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
        if (status !== 200) continue;
        const trimmed = body.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
        const data = JSON.parse(trimmed);
        const items = data?.data || data?.products || data?.items || (Array.isArray(data) ? data : []);
        if (Array.isArray(items) && items.length > 0) {
          console.log(`✅ Storefront API: ${items.length} منتج من ${ep}`);
          return items;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return [];
}

// ─── Puppeteer (headless browser) ───────────────────────────────────
async function fetchWithPuppeteer(url) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (_) {
    try { puppeteer = require('puppeteer-core'); } catch (_) { return null; }
  }
  const chromePath = findChrome();
  const opts = {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--disable-extensions','--disable-blink-features=AutomationControlled'],
  };
  if (chromePath) opts.executablePath = chromePath;
  let browser;
  try {
    browser = await puppeteer.launch(opts);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    const capturedProducts = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image','font','media','stylesheet'].includes(rt)) return req.abort();
      req.continue();
    });
    page.on('response', async (response) => {
      const resUrl = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (!/product|catalog|collection|item|inventory/i.test(resUrl)) return;
      try {
        const json = await response.json();
        const items = json?.data || json?.products || json?.items || json?.result?.data || [];
        if (Array.isArray(items) && items.length > 0) {
          capturedProducts.push(...items.slice(0, 60));
          console.log(`📡 XHR اعتراض: ${items.length} منتج من ${resUrl}`);
        }
      } catch (_) {}
    });

    const base = new URL(url);
    try { await page.goto(base.origin + '/products', { waitUntil: 'networkidle0', timeout: 40000 }); }
    catch (_) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (_) {} }
    await new Promise(r => setTimeout(r, 4000));

    if (capturedProducts.length > 0) {
      const fakeHtml = capturedProducts.slice(0, 60).map(p => {
        const name = (p.name || p.title || p.product_name || '').replace(/</g, '&lt;');
        const price = p.price?.amount || p.price?.regular?.amount || p.price || p.regular_price || '';
        const desc = (p.description || p.short_description || '').replace(/<[^>]+>/g, '').substring(0, 200);
        return `<div class="s-product-card" data-product-id="${p.id || ''}"><div class="s-product-card__title">${name}</div><div class="s-product-card__price">${price} SAR</div><p class="desc">${desc}</p></div>`;
      }).join('');
      return `<html><body>${fakeHtml}</body></html>`;
    }

    const sallaProducts = await page.evaluate(() => {
      try {
        const sources = [window?.salla?.store?.products, window?.salla?.collection?.products,
          window?.__STORE__?.products?.data, window?.__NEXT_DATA__?.props?.pageProps?.products,
          window?.__NUXT__?.data?.[0]?.products?.data];
        for (const src of sources) if (Array.isArray(src) && src.length > 0) return JSON.stringify(src.slice(0, 60));
      } catch (_) {}
      return null;
    }).catch(() => null);

    if (sallaProducts) {
      try {
        const prods = JSON.parse(sallaProducts);
        if (prods.length > 0) {
          const fakeHtml = prods.map(p =>
            `<div class="s-product-card"><div class="s-product-card__title">${(p.name || p.title || '').replace(/</g, '&lt;')}</div><div class="s-product-card__price">${p.price?.amount || p.price || ''} SAR</div></div>`
          ).join('');
          return `<html><body>${fakeHtml}</body></html>`;
        }
      } catch (_) {}
    }
    return await page.content();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── HTML Extraction ────────────────────────────────────────────────
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

// ─── Full Scan (orchestrator) ───────────────────────────────────────
async function scanStore(url, { sallaToken, zidToken, zidManagerToken, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  log.info('system', '🔍 فحص المتجر: ' + url);

  const fetchPage = async (u) => (await fetchURL(u)).body;

  let html = '';
  try { html = await fetchPage(url); } catch (e) { log.warn('system', 'الفحص الأولي فشل: ' + e.message); }

  const platform = detectPlatform(url, html);
  log.info('system', `📌 المنصة: ${platform}`);

  let apiProducts = [];
  if (platform === 'salla' && sallaToken) { log.info('system', '🔑 Salla API...'); apiProducts = await fetchSallaProducts(url, sallaToken); }
  else if (platform === 'zid' && zidToken) { log.info('system', '🔑 Zid API...'); apiProducts = await fetchZidProducts(url, zidToken, zidManagerToken); }

  let result = extractFromHTML(html, url);

  if (apiProducts.length > 0) {
    const seen = new Set(apiProducts.map(p => p.name));
    const merged = [...apiProducts];
    for (const p of result.products) if (!seen.has(p.name)) merged.push(p);
    result.products = merged.slice(0, 60);
    result.platform = platform;
    result.usedAPI = true;
  }

  // Try /products page
  if (result.products.length < 3) {
    try {
      const base = new URL(url);
      const prodPageUrl = base.origin + '/products';
      if (prodPageUrl !== url) {
        log.info('system', '📦 صفحة المنتجات: ' + prodPageUrl);
        const prodHtml = await fetchPage(prodPageUrl);
        const prodResult = extractFromHTML(prodHtml, prodPageUrl);
        if (prodResult.products.length > result.products.length) result.products = prodResult.products;
      }
    } catch (_) {}
  }

  // Storefront API
  if (result.products.length < 3) {
    log.info('system', '🔌 Storefront API...');
    try {
      const sfItems = await tryStorefrontAPI(url);
      if (sfItems.length > 0) {
        const sfProds = sfItems.slice(0, 60).map(p => ({
          name: p.name || p.title || p.product_name || '',
          price: String(p.price?.amount || p.price?.regular?.amount || p.price || p.regular_price || ''),
          description: (p.description || p.short_description || '').replace(/<[^>]+>/g, '').substring(0, 200),
        })).filter(p => isValidProduct(p.name));
        if (sfProds.length > result.products.length) {
          result.products = sfProds;
          result.usedAPI = true;
          log.info('system', `✅ Storefront API: ${sfProds.length} منتج`);
        }
      }
    } catch (e) { log.warn('system', 'Storefront API فشل: ' + e.message); }
  }

  // Puppeteer
  let usedPuppeteer = false;
  if (result.products.length < 3) {
    log.info('system', '⏳ فحص متقدم (Puppeteer + XHR)...');
    try {
      const puppeteerHtml = await fetchWithPuppeteer(url);
      if (puppeteerHtml) { result = extractFromHTML(puppeteerHtml, url); usedPuppeteer = true; }
    } catch (e) { log.warn('system', 'Puppeteer فشل: ' + e.message); }
  }

  log.info('system', `✅ تم — ${result.products.length} منتج${result.usedAPI ? ' (API)' : usedPuppeteer ? ' (متقدم)' : ''}`);
  return result;
}

module.exports = {
  detectPlatform,
  isValidProduct,
  fetchSallaProducts,
  fetchZidProducts,
  tryStorefrontAPI,
  fetchWithPuppeteer,
  extractFromHTML,
  scanStore,
};
