'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpersPath = require.resolve('../lib/helpers');
const scannerPath = require.resolve('../lib/store-scanner');

function loadScannerWithFetch(fetchURL) {
  const helpers = require(helpersPath);
  const originalHelpers = require.cache[helpersPath].exports;
  const originalScanner = require.cache[scannerPath];
  require.cache[helpersPath].exports = { ...helpers, fetchURL };
  delete require.cache[scannerPath];
  const scanner = require(scannerPath);
  return {
    scanner,
    restore() {
      require.cache[helpersPath].exports = originalHelpers;
      if (originalScanner) require.cache[scannerPath] = originalScanner;
      else delete require.cache[scannerPath];
    },
  };
}

test('scanner launches its injected browser boundary with the configured executable', async () => {
  const { fetchWithPuppeteer } = require('../lib/store-scanner');
  let launchOptions;
  let closed = false;
  const dynamicHtml = '<html><body><article class="product-card"><h2 class="product-title">Dynamic product</h2><span class="price">99 SAR</span></article></body></html>';
  const page = {
    async setUserAgent() {},
    async setViewport() {},
    async setRequestInterception() {},
    on() {},
    async goto() {},
    async evaluate() { return null; },
    async content() { return dynamicHtml; },
  };
  const puppeteer = {
    async launch(options) {
      launchOptions = options;
      return { newPage: async () => page, close: async () => { closed = true; } };
    },
  };

  const html = await fetchWithPuppeteer('https://shop.example', {
    puppeteer,
    executablePath: '/scanner/chromium',
    settleMs: 0,
  });

  assert.equal(html, dynamicHtml);
  assert.equal(launchOptions.executablePath, '/scanner/chromium');
  assert.equal(closed, true);
});

test('scanner uses the browser fallback when static HTML and storefront API have no products', async () => {
  const harness = loadScannerWithFetch(async () => ({ body: '<html><title>Empty shop</title></html>', status: 404 }));
  let browserCalls = 0;
  try {
    const result = await harness.scanner.scanStore('https://shop.example', {
      browserFetcher: async () => {
        browserCalls += 1;
        return `
          <html><body>
            <article class="product-card"><h2 class="product-title">Dynamic one</h2><span class="price">10 SAR</span></article>
            <article class="product-card"><h2 class="product-title">Dynamic two</h2><span class="price">20 SAR</span></article>
            <article class="product-card"><h2 class="product-title">Dynamic three</h2><span class="price">30 SAR</span></article>
          </body></html>`;
      },
    });
    assert.equal(browserCalls, 1);
    assert.deepEqual(result.products.map(product => product.name), ['Dynamic one', 'Dynamic two', 'Dynamic three']);
  } finally {
    harness.restore();
  }
});
