'use strict';

const PRODUCT_SECTION_RE = /(?:^|\n)#{1,3}\s*(?:المنتجات|المنتجات والأسعار|قائمة المنتجات)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|$)/i;

const KNOWN_ALIASES = [
  ['adobe', 'ادوبي'],
  ['أدوبي', 'ادوبي'],
  ['إدوبي', 'ادوبي'],
  ['ادوبى', 'ادوبي'],
  ['gemini', 'جيميني'],
  ['canva', 'كانفا'],
  ['office', 'اوفيس'],
  ['microsoft', 'مايكروسوفت'],
];

function normalizeProductText(value) {
  let text = String(value || '').toLowerCase();
  for (const [from, to] of KNOWN_ALIASES) {
    text = text.replace(new RegExp(from, 'gi'), to);
  }
  return text
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[ـ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// سطر "سعر صرف": يحوي رقماً ولا يتبقى منه حروف بعد إزالة الأرقام والعملة والفواصل.
// "120 ريال" → true ، "٩٠ ريال" → true ، "اشتراك 4 أشهر" → false (تبقى حروف).
function isPriceLikeLine(value) {
  const v = String(value || '');
  // دعم الأرقام العربية (٠-٩) والفارسية (۰-۹) إضافةً للـ ASCII
  if (!/[\d٠-٩۰-۹]/.test(v)) return false;
  const lettersLeft = v
    .replace(/ر\.?\s?س|ريال|درهم|sar|aed|usd|\$|﷼/gi, '')
    .replace(/[\d٠-٩۰-۹.,،\-\/\s]/g, '');
  return lettersLeft.length === 0;
}

function isProductNameLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  if (/^[-•]/.test(value)) return false;
  if (/[—:]/.test(value)) return false;
  if (isPriceLikeLine(value)) return false;
  if (value.length > 60) return false;
  if (/^(مثال|العميل|أنت|ممنوع|لا |وقت|بعد|طلب|السعر|المنتج|إنهاء|ما تعرف|خصم|عرض|التوصيل|الشحن|الدفع|الضمان|نوفر|يوجد|يمكنك|متوفر التوصيل)/.test(value)) return false;
  return true;
}

function extractProductSection(instructions) {
  const text = String(instructions || '');
  const match = text.match(PRODUCT_SECTION_RE);
  return match ? match[1] : '';
}

function parsePromptProducts(instructions) {
  const section = extractProductSection(instructions);
  if (!section) return [];

  const products = [];
  let current = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isProductNameLine(line)) {
      if (current) products.push(current);
      current = { name: line, descriptionLines: [], price: '', source: 'prompt' };
      continue;
    }
    if (current) {
      if (!current.price && isPriceLikeLine(line)) current.price = line;
      else current.descriptionLines.push(line);
    }
  }
  if (current) products.push(current);

  return products
    .map(product => ({
      name: product.name,
      description: product.descriptionLines.join('\n').trim(),
      price: product.price || '',
      source: product.source,
    }))
    .filter(product => product.name && (product.price || product.description));
}

function structuredProducts(products = []) {
  return (Array.isArray(products) ? products : [])
    .filter(product => String(product?.name || '').trim())
    .map(product => {
      const out = {
        name: String(product.name || '').trim(),
        description: String(product.description || '').trim(),
        price: String(product.price || '').trim(),
        source: product.source || 'fields',
      };
      if (Array.isArray(product.variants) && product.variants.length > 0) {
        out.variants = product.variants;
      }
      return out;
    });
}

function mergeProducts(products) {
  const byName = new Map();
  for (const product of products) {
    const key = normalizeProductText(product.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...product });
      continue;
    }
    byName.set(key, {
      ...existing,
      price: existing.price || product.price,
      description: [existing.description, product.description].filter(Boolean).join('\n').trim(),
      source: existing.source === 'fields' ? existing.source : (existing.source || product.source),
      variants: existing.variants || product.variants,
    });
  }
  return [...byName.values()];
}

function buildProductCatalog(config = {}) {
  return mergeProducts([
    ...structuredProducts(config.products),
    ...parsePromptProducts(config.botInstructions),
  ]);
}

function scoreProduct(product, customerText) {
  const query = normalizeProductText(customerText);
  const name = normalizeProductText(product.name);
  const details = normalizeProductText(`${product.name} ${product.description} ${product.price}`);
  if (!query || !name) return 0;
  if (query.includes(name) || name.includes(query)) return 100;

  const tokens = query.split(' ').filter(token => token.length >= 3);
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 20;
    else if (details.includes(token)) score += 4;
  }
  return score;
}

function findRelevantProducts(config = {}, customerText = '', limit = 4) {
  const scored = buildProductCatalog(config)
    .map(product => ({ product, score: scoreProduct(product, customerText) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const strong = scored.filter(item => item.score >= 20);
  return (strong.length ? strong : scored)
    .slice(0, limit)
    .map(item => item.product);
}

function formatProduct(product, index) {
  const lines = [`${index + 1}. ${product.name}`];
  if (product.price) lines.push(`السعر: ${product.price}`);
  if (product.description) lines.push(product.description);
  return lines.join('\n');
}

function buildRelevantProductContext({ config = {}, customerText = '' } = {}) {
  const catalog = buildProductCatalog(config);
  const relevant = findRelevantProducts(config, customerText);
  const selected = relevant.length ? relevant : catalog.slice(0, 8);
  if (!selected.length) return '';

  return [
    'فهرس المنتجات المطابقة من المنصة والبرومبت:',
    ...selected.map(formatProduct),
    '',
    'قاعدة مهمة: إذا ظهر المنتج هنا فهو موجود في معرفة المتجر، فلا تنف توفره إلا إذا النص نفسه يقول ذلك صراحة.',
  ].join('\n');
}

module.exports = {
  buildProductCatalog,
  buildRelevantProductContext,
  findRelevantProducts,
  normalizeProductText,
  parsePromptProducts,
};
